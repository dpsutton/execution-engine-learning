package engine

// The Volcano executor: every plan node becomes an Operator with Open/Next/Close, and each Next
// call pulls just enough rows from its children to produce one row of its own.

type Operator interface {
	Open()
	Next() ([]Value, bool)
	Close()
}

// compiled is an expression turned into a Go closure over a row (lesson 1's closure compilation):
// column names are resolved to positions once, not per row.
type compiled func(row []Value) Value

func compileExpr(e Expr, schema []string) compiled {
	switch x := e.(type) {
	case nil:
		return func([]Value) Value { return true }
	case Col:
		i := indexOf(schema, x.Name)
		return func(row []Value) Value { return row[i] }
	case Lit:
		v := x.V
		return func([]Value) Value { return v }
	case Bin:
		l, r := compileExpr(x.L, schema), compileExpr(x.R, schema)
		op := x.Op
		switch op {
		case "and":
			return func(row []Value) Value { return And3(l(row), r(row)) }
		case "or":
			return func(row []Value) Value { return Or3(l(row), r(row)) }
		case "+", "-", "*", "/":
			return func(row []Value) Value { return Arith(op, l(row), r(row)) }
		}
		return func(row []Value) Value { return CmpOp(op, l(row), r(row)) }
	case Not:
		inner := compileExpr(x.E, schema)
		return func(row []Value) Value { return Not3(inner(row)) }
	case IsNull:
		inner, neg := compileExpr(x.E, schema), x.Negate
		return func(row []Value) Value { return (inner(row) == nil) != neg }
	case Func:
		args := make([]compiled, len(x.Args))
		for i, a := range x.Args {
			args[i] = compileExpr(a, schema)
		}
		name := x.Name
		return func(row []Value) Value {
			vals := make([]Value, len(args))
			for i, a := range args {
				vals[i] = a(row)
			}
			return CallFunc(name, vals)
		}
	case Agg:
		fail("aggregate %s outside of an aggregation", Render(x))
	}
	fail("cannot compile %T", e)
	return nil
}

func indexOf(schema []string, name string) int {
	for i, s := range schema {
		if s == name {
			return i
		}
	}
	fail("unknown column %s (have %v)", name, schema)
	return -1
}

// Build turns a physical plan into a tree of operators.
func Build(n Node, db *DB) Operator {
	switch x := n.(type) {
	case *Scan:
		return &scanOp{table: x.Table}
	case *IndexScan:
		return &indexScanOp{node: x}
	case *Filter:
		return &filterOp{child: Build(x.Child, db), pred: compileExpr(x.Pred, x.Child.Schema())}
	case *Project:
		schema := x.Child.Schema()
		exprs := make([]compiled, len(x.Exprs))
		for i, e := range x.Exprs {
			exprs[i] = compileExpr(e, schema)
		}
		return &projectOp{child: Build(x.Child, db), exprs: exprs}
	case *NLJoin:
		return &nlJoinOp{left: Build(x.Left, db), right: Build(x.Right, db), pred: compileExpr(x.Pred, x.Schema())}
	case *HashJoin:
		return &hashJoinOp{
			probe: Build(x.Left, db), build: Build(x.Right, db),
			probeKey: compileExpr(x.LeftKey, x.Left.Schema()), buildKey: compileExpr(x.RightKey, x.Right.Schema()),
			residual: compileExpr(x.Residual, x.Schema()),
		}
	case *IndexNLJoin:
		return &indexNLJoinOp{
			outer: Build(x.Left, db), table: x.Table, index: x.Table.Indexes[x.Col],
			key: compileExpr(x.OuterKey, x.Left.Schema()), residual: compileExpr(x.Residual, x.Schema()),
		}
	case *HashAggregate:
		schema := x.Child.Schema()
		op := &hashAggOp{child: Build(x.Child, db), spec: aggSpecFor(len(x.Keys), x.Aggs)}
		for _, k := range x.Keys {
			op.keys = append(op.keys, compileExpr(k, schema))
		}
		for _, a := range x.Aggs {
			if a.Star {
				op.args = append(op.args, func([]Value) Value { return nil })
			} else {
				op.args = append(op.args, compileExpr(a.Arg, schema))
			}
		}
		return op
	case *Sort:
		return &sortOp{child: Build(x.Child, db), keys: x.Keys}
	case *Limit:
		return &limitOp{child: Build(x.Child, db), n: x.N}
	}
	fail("no operator for %T", n)
	return nil
}

// ---------------------------------------------------------------- leaves

type scanOp struct {
	table *Table
	pos   int
}

func (o *scanOp) Open() { o.pos = 0 }
func (o *scanOp) Next() ([]Value, bool) {
	if o.pos >= len(o.table.Rows) {
		return nil, false
	}
	o.pos++
	return o.table.Rows[o.pos-1], true
}
func (o *scanOp) Close() {}

type indexScanOp struct {
	node *IndexScan
	ids  []int
	pos  int
}

func (o *indexScanOp) Open() {
	n := o.node
	idx := n.Table.Indexes[n.Col]
	if n.Eq {
		o.ids = idx.Search(n.Lo)
	} else {
		o.ids = idx.Range(n.Lo, n.Hi, n.LoIncl, n.HiIncl)
	}
	o.pos = 0
}
func (o *indexScanOp) Next() ([]Value, bool) {
	if o.pos >= len(o.ids) {
		return nil, false
	}
	o.pos++
	return o.node.Table.Rows[o.ids[o.pos-1]], true
}
func (o *indexScanOp) Close() {}

// ---------------------------------------------------------------- streaming operators

type filterOp struct {
	child Operator
	pred  compiled
}

func (o *filterOp) Open() { o.child.Open() }
func (o *filterOp) Next() ([]Value, bool) {
	for {
		row, ok := o.child.Next()
		if !ok {
			return nil, false
		}
		if Truthy(o.pred(row)) {
			return row, true
		}
	}
}
func (o *filterOp) Close() { o.child.Close() }

type projectOp struct {
	child Operator
	exprs []compiled
}

func (o *projectOp) Open() { o.child.Open() }
func (o *projectOp) Next() ([]Value, bool) {
	row, ok := o.child.Next()
	if !ok {
		return nil, false
	}
	out := make([]Value, len(o.exprs))
	for i, e := range o.exprs {
		out[i] = e(row)
	}
	return out, true
}
func (o *projectOp) Close() { o.child.Close() }

type limitOp struct {
	child Operator
	n     int64
	seen  int64
}

func (o *limitOp) Open() { o.seen = 0; o.child.Open() }
func (o *limitOp) Next() ([]Value, bool) {
	if o.seen >= o.n {
		return nil, false // stop pulling: the child never computes rows nobody wants
	}
	row, ok := o.child.Next()
	if ok {
		o.seen++
	}
	return row, ok
}
func (o *limitOp) Close() { o.child.Close() }

// ---------------------------------------------------------------- joins

func joinRows(l, r []Value) []Value {
	out := make([]Value, 0, len(l)+len(r))
	return append(append(out, l...), r...)
}

type nlJoinOp struct {
	left, right Operator
	pred        compiled
	cur         []Value // current outer row; nil = need a new one
}

func (o *nlJoinOp) Open() { o.left.Open(); o.cur = nil }
func (o *nlJoinOp) Next() ([]Value, bool) {
	for {
		if o.cur == nil {
			row, ok := o.left.Next()
			if !ok {
				return nil, false
			}
			o.cur = row
			o.right.Open() // rewind the inner side for every outer row
		}
		r, ok := o.right.Next()
		if !ok {
			o.right.Close()
			o.cur = nil
			continue
		}
		joined := joinRows(o.cur, r)
		if Truthy(o.pred(joined)) {
			return joined, true
		}
	}
}
func (o *nlJoinOp) Close() { o.left.Close() }

type hashJoinOp struct {
	probe, build       Operator
	probeKey, buildKey compiled
	residual           compiled
	ht                 *HashTable
	cur                []Value
	matching           bool
}

// Open drains the build side into a hash table: a pipeline breaker.
func (o *hashJoinOp) Open() {
	o.ht = NewHashTable()
	o.build.Open()
	for {
		row, ok := o.build.Next()
		if !ok {
			break
		}
		o.ht.Insert(o.buildKey(row), row)
	}
	o.build.Close()
	o.probe.Open()
	o.matching = false
}

func (o *hashJoinOp) Next() ([]Value, bool) {
	for {
		if !o.matching {
			row, ok := o.probe.Next()
			if !ok {
				return nil, false
			}
			o.cur = row
			o.matching = o.ht.Seek(o.probeKey(row))
			if !o.matching {
				continue
			}
		} else if !o.ht.Advance() {
			o.matching = false
			continue
		}
		joined := joinRows(o.cur, o.ht.Current())
		if Truthy(o.residual(joined)) {
			return joined, true
		}
	}
}
func (o *hashJoinOp) Close() { o.probe.Close() }

type indexNLJoinOp struct {
	outer    Operator
	table    *Table
	index    *BTree
	key      compiled
	residual compiled
	cur      []Value
	ids      []int
	pos      int
}

func (o *indexNLJoinOp) Open() { o.outer.Open(); o.ids, o.pos = nil, 0 }
func (o *indexNLJoinOp) Next() ([]Value, bool) {
	for {
		if o.pos >= len(o.ids) {
			row, ok := o.outer.Next()
			if !ok {
				return nil, false
			}
			o.cur, o.pos, o.ids = row, 0, nil
			if k := o.key(row); k != nil {
				o.ids = o.index.Search(k)
			}
			continue
		}
		joined := joinRows(o.cur, o.table.Rows[o.ids[o.pos]])
		o.pos++
		if Truthy(o.residual(joined)) {
			return joined, true
		}
	}
}
func (o *indexNLJoinOp) Close() { o.outer.Close() }

// ---------------------------------------------------------------- pipeline breakers

type hashAggOp struct {
	child Operator
	spec  AggSpec
	keys  []compiled
	args  []compiled
	table *AggTable
}

func (o *hashAggOp) Open() {
	o.table = NewAggTable(o.spec)
	o.child.Open()
	for {
		row, ok := o.child.Next()
		if !ok {
			break
		}
		keys := make([]Value, len(o.keys))
		for i, k := range o.keys {
			keys[i] = k(row)
		}
		args := make([]Value, len(o.args))
		for i, a := range o.args {
			args[i] = a(row)
		}
		o.table.Step(keys, args)
	}
	o.child.Close()
	o.table.Finish()
}

func (o *hashAggOp) Next() ([]Value, bool) {
	t := o.table
	if t.Pos >= len(t.Keys) {
		return nil, false
	}
	t.Pos++
	return t.Row(t.Pos - 1), true
}
func (o *hashAggOp) Close() {}

type sortOp struct {
	child  Operator
	keys   []SortKey
	sorter *Sorter
}

func (o *sortOp) Open() {
	o.sorter = &Sorter{Keys: o.keys}
	o.child.Open()
	for {
		row, ok := o.child.Next()
		if !ok {
			break
		}
		o.sorter.Insert(row)
	}
	o.child.Close()
	o.sorter.Sort()
}

func (o *sortOp) Next() ([]Value, bool) {
	s := o.sorter
	if s.Pos >= len(s.Rows) {
		return nil, false
	}
	s.Pos++
	return s.Rows[s.Pos-1], true
}
func (o *sortOp) Close() {}

// RunVolcano executes a plan to completion and returns all rows.
func RunVolcano(plan Node, db *DB) (rows [][]Value, err error) {
	defer recoverEval(&err)
	op := Build(plan, db)
	op.Open()
	defer op.Close()
	for {
		row, ok := op.Next()
		if !ok {
			return rows, nil
		}
		rows = append(rows, append([]Value(nil), row...))
	}
}

func recoverEval(err *error) {
	if r := recover(); r != nil {
		e, ok := r.(EvalError)
		if !ok {
			panic(r)
		}
		*err = e
	}
}
