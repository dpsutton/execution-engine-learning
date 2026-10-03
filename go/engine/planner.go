package engine

import (
	"fmt"
	"math"
	"math/bits"
)

// The planner turns a bound Query into a physical plan. It works bottom-up:
//
//  1. Classify each WHERE/ON conjunct by the tables it mentions: one table → pushed down to that
//     table's access path; several → a join predicate, applied at the join that brings in the last
//     of them; none → a constant filter on top.
//  2. Pick an access path per table: full Scan, or IndexScan when an indexed column is compared to
//     a constant and that's cheaper.
//  3. Order the joins with Selinger-style dynamic programming over subsets of tables (left-deep:
//     the right input of every join is a single table), choosing hash / nested-loop / index
//     nested-loop for each join by estimated cost.
//  4. Stack aggregation, HAVING, projection, sort, and limit on top.
//
// Estimates come from stats.go. Cost units are "rows touched", deliberately crude:
//
//	scan = rows, filter = input rows, hash join = 2·build + probe, NL join = outer · inner,
//	index NL join = outer · (log₂ inner + matches per outer row), sort = n·log₂ n, aggregate = input.
type planner struct {
	q     *Query
	db    *DB
	alias map[string]int // alias → position in q.Rels
}

// PlanQuery builds the cheapest physical plan the planner can find.
func PlanQuery(q *Query, db *DB) (root Node, err error) {
	defer func() {
		if r := recover(); r != nil {
			e, ok := r.(EvalError)
			if !ok {
				panic(r)
			}
			root, err = nil, e
		}
	}()
	pl := &planner{q: q, db: db, alias: map[string]int{}}
	for i, r := range q.Rels {
		pl.alias[r.Alias] = i
	}

	root = pl.joins()

	if q.Grouped {
		agg := &HashAggregate{Child: root, Keys: q.GroupBy, Aggs: q.Aggs}
		agg.Rows = pl.groupCount(root.Est().Rows, q.GroupBy)
		agg.Cost = root.Est().Cost + root.Est().Rows
		root = agg
		if q.Having != nil {
			f := &Filter{Child: root, Pred: q.Having}
			f.Rows = atLeast1(agg.Rows / 3)
			f.Cost = agg.Cost + agg.Rows
			root = f
		}
	}

	names := append([]string(nil), q.Headers...)
	for i := len(names); i < len(q.Out); i++ {
		names = append(names, fmt.Sprintf("#h%d", i-len(q.Headers)))
	}
	proj := &Project{Child: root, Exprs: q.Out, Names: names}
	proj.Estimate = *root.Est()
	root = proj

	if len(q.Order) > 0 {
		s := &Sort{Child: root, Keys: q.Order}
		n := root.Est().Rows
		s.Rows = n
		s.Cost = root.Est().Cost + n*math.Log2(math.Max(n, 2))
		root = s
	}
	if q.Limit >= 0 {
		l := &Limit{Child: root, N: q.Limit}
		l.Rows = math.Min(float64(q.Limit), root.Est().Rows)
		l.Cost = root.Est().Cost
		root = l
	}
	return root, nil
}

func atLeast1(f float64) float64 { return math.Max(f, 1) }

// joins plans the FROM clause: access paths, then join order.
func (pl *planner) joins() Node {
	n := len(pl.q.Rels)
	local := make([][]Expr, n)
	var multi, consts []Expr
	for _, p := range pl.q.Preds {
		as := aliasesOf(p)
		switch len(as) {
		case 0:
			consts = append(consts, p)
		case 1:
			for a := range as {
				local[pl.alias[a]] = append(local[pl.alias[a]], p)
			}
		default:
			multi = append(multi, p)
		}
	}

	base := make([]Node, n)
	for i := range base {
		base[i] = pl.accessPath(i, local[i])
	}

	// best[mask] is the cheapest plan joining exactly the tables in mask. Every proper subset of a
	// mask is numerically smaller, so counting upward visits subsets first.
	best := make([]Node, 1<<n)
	for i := range n {
		best[1<<i] = base[i]
	}
	for mask := 1; mask < 1<<n; mask++ {
		if bits.OnesCount(uint(mask)) < 2 {
			continue
		}
		// First pass: only joins with a predicate connecting the new table. Second pass (only if
		// the first found nothing): allow a cross product.
		for _, allowCross := range []bool{false, true} {
			for i := range n {
				bit := 1 << i
				if mask&bit == 0 || best[mask&^bit] == nil {
					continue
				}
				preds := pl.connecting(multi, mask, i)
				if len(preds) == 0 && !allowCross {
					continue
				}
				for _, cand := range pl.joinCandidates(best[mask&^bit], mask&^bit, i, base[i], local[i], preds) {
					if best[mask] == nil || cand.Est().Cost < best[mask].Est().Cost {
						best[mask] = cand
					}
				}
			}
			if best[mask] != nil {
				break
			}
		}
	}

	root := best[(1<<n)-1]
	if len(consts) > 0 {
		f := &Filter{Child: root, Pred: joinAnd(consts)}
		f.Rows = root.Est().Rows * pl.sel(f.Pred)
		f.Cost = root.Est().Cost + root.Est().Rows
		root = f
	}
	return root
}

func (pl *planner) maskOf(as map[string]bool) int {
	m := 0
	for a := range as {
		m |= 1 << pl.alias[a]
	}
	return m
}

// connecting returns the multi-table predicates that become applicable exactly when table i joins
// the tables already in mask&^(1<<i).
func (pl *planner) connecting(multi []Expr, mask, i int) []Expr {
	var out []Expr
	for _, p := range multi {
		m := pl.maskOf(aliasesOf(p))
		if m&^mask == 0 && m&(1<<i) != 0 {
			out = append(out, p)
		}
	}
	return out
}

// joinCandidates builds every way to join `left` (covering leftMask) with table i.
func (pl *planner) joinCandidates(left Node, leftMask, i int, right Node, rightLocal, preds []Expr) []Node {
	L, R := left.Est(), right.Est()
	card := L.Rows * R.Rows
	for _, p := range preds {
		card *= pl.sel(p)
	}
	card = atLeast1(card)
	var out []Node

	// Equi-join predicates: one side only mentions table i, the other only tables already joined.
	type equi struct {
		idx          int
		outer, inner Expr
	}
	var equis []equi
	for k, p := range preds {
		b, ok := p.(Bin)
		if !ok || b.Op != "=" {
			continue
		}
		lm, rm := pl.maskOf(aliasesOf(b.L)), pl.maskOf(aliasesOf(b.R))
		switch {
		case rm == 1<<i && lm != 0 && lm&^leftMask == 0:
			equis = append(equis, equi{k, b.L, b.R})
		case lm == 1<<i && rm != 0 && rm&^leftMask == 0:
			equis = append(equis, equi{k, b.R, b.L})
		}
	}
	without := func(k int, extra []Expr) Expr {
		var rest []Expr
		rest = append(rest, extra...)
		for j, p := range preds {
			if j != k {
				rest = append(rest, p)
			}
		}
		return joinAnd(rest)
	}

	if len(equis) > 0 {
		e := equis[0]
		hj := &HashJoin{Left: left, Right: right, LeftKey: e.outer, RightKey: e.inner, Residual: without(e.idx, nil)}
		hj.Rows = card
		hj.Cost = L.Cost + R.Cost + 2*R.Rows + L.Rows
		out = append(out, hj)
	}

	rel := pl.q.Rels[i]
	for _, e := range equis {
		c, ok := e.inner.(Col)
		if !ok {
			continue
		}
		col := c.Name[len(rel.Alias)+1:]
		if _, indexed := rel.Table.Indexes[col]; !indexed {
			continue
		}
		innerRows := float64(len(rel.Table.Rows))
		perOuter := innerRows
		if cs := rel.Table.Stats.Cols[col]; cs != nil && cs.NDV > 0 {
			perOuter = innerRows / float64(cs.NDV)
		}
		ij := &IndexNLJoin{Left: left, Alias: rel.Alias, Table: rel.Table, Col: col, OuterKey: e.outer,
			Residual: without(e.idx, rightLocal)}
		ij.Rows = card
		ij.Cost = L.Cost + L.Rows*(math.Log2(math.Max(innerRows, 2))+perOuter)
		out = append(out, ij)
	}

	nl := &NLJoin{Left: left, Right: right, Pred: joinAnd(preds)}
	nl.Rows = card
	nl.Cost = L.Cost + R.Cost + L.Rows*R.Rows
	out = append(out, nl)
	return out
}

// accessPath picks how to read table i given the predicates that only mention it.
func (pl *planner) accessPath(i int, preds []Expr) Node {
	rel := pl.q.Rels[i]
	rows := float64(len(rel.Table.Rows))
	selAll := 1.0
	for _, p := range preds {
		selAll *= pl.sel(p)
	}

	scan := &Scan{Alias: rel.Alias, Table: rel.Table}
	scan.Rows, scan.Cost = rows, rows
	var best Node = scan
	if len(preds) > 0 {
		f := &Filter{Child: scan, Pred: joinAnd(preds)}
		f.Rows, f.Cost = atLeast1(rows*selAll), scan.Cost+rows
		best = f
	}

	for j, p := range preds {
		col, op, val, ok := pl.indexable(rel, p)
		if !ok {
			continue
		}
		is := &IndexScan{Alias: rel.Alias, Table: rel.Table, Col: col}
		switch op {
		case "=":
			is.Eq, is.Lo, is.Hi, is.LoIncl, is.HiIncl = true, val, val, true, true
		case "<":
			is.Hi = val
		case "<=":
			is.Hi, is.HiIncl = val, true
		case ">":
			is.Lo = val
		case ">=":
			is.Lo, is.LoIncl = val, true
		}
		matched := rows * pl.sel(p)
		is.Rows = atLeast1(matched)
		is.Cost = math.Log2(math.Max(rows, 2)) + matched
		var node Node = is
		var rest []Expr
		for k, q := range preds {
			if k != j {
				rest = append(rest, q)
			}
		}
		if len(rest) > 0 {
			f := &Filter{Child: is, Pred: joinAnd(rest)}
			f.Rows, f.Cost = atLeast1(rows*selAll), is.Cost+is.Rows
			node = f
		}
		if node.Est().Cost < best.Est().Cost {
			best = node
		}
	}
	return best
}

// indexable recognizes `col op constant` (either way round) on an indexed column of rel.
func (pl *planner) indexable(rel Rel, p Expr) (col, op string, val Value, ok bool) {
	b, isBin := p.(Bin)
	if !isBin {
		return
	}
	name, lit, op, found := colLit(b)
	if !found || lit == nil {
		return
	}
	switch op {
	case "=", "<", "<=", ">", ">=":
	default:
		return
	}
	col = name[len(rel.Alias)+1:]
	if _, indexed := rel.Table.Indexes[col]; !indexed {
		return
	}
	// The constant must be comparable with the column's values, or the index can't be searched.
	if cs := rel.Table.Stats.Cols[col]; cs != nil && cs.Min != nil && !comparable(cs.Min, lit) {
		return
	}
	return col, op, lit, true
}

func comparable(a, b Value) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	Compare(a, b)
	return true
}

var flipped = map[string]string{"=": "=", "!=": "!=", "<": ">", "<=": ">=", ">": "<", ">=": "<="}

// colLit matches `Col op Lit` or `Lit op Col`, normalizing to column-on-the-left.
func colLit(b Bin) (col string, lit Value, op string, ok bool) {
	if _, cmp := flipped[b.Op]; !cmp {
		return
	}
	if c, isCol := b.L.(Col); isCol {
		if l, isLit := b.R.(Lit); isLit {
			return c.Name, l.V, b.Op, true
		}
	}
	if c, isCol := b.R.(Col); isCol {
		if l, isLit := b.L.(Lit); isLit {
			return c.Name, l.V, flipped[b.Op], true
		}
	}
	return
}

// colStats finds statistics for a qualified column ("c.age"), or nil.
func (pl *planner) colStats(name string) *ColumnStats {
	for _, r := range pl.q.Rels {
		if len(name) > len(r.Alias) && name[:len(r.Alias)] == r.Alias && name[len(r.Alias)] == '.' {
			if r.Table.Stats == nil {
				return nil
			}
			return r.Table.Stats.Cols[name[len(r.Alias)+1:]]
		}
	}
	return nil
}

// sel estimates the fraction of rows a predicate keeps. Unknown shapes get the classic 1/3.
func (pl *planner) sel(e Expr) float64 {
	const unknown = 1.0 / 3
	switch x := e.(type) {
	case Bin:
		switch x.Op {
		case "and":
			return pl.sel(x.L) * pl.sel(x.R) // assumes independence — often wrong, always simple
		case "or":
			a, b := pl.sel(x.L), pl.sel(x.R)
			return a + b - a*b
		}
		if name, lit, op, ok := colLit(x); ok {
			cs := pl.colStats(name)
			if cs == nil {
				return unknown
			}
			if lit == nil {
				return 0 // comparing with NULL is never true
			}
			switch op {
			case "=":
				return cs.EqSel()
			case "!=":
				return cs.nonNullFrac() - cs.EqSel()
			}
			if !comparable(lit, lit) || (cs.Min != nil && !comparable(cs.Min, lit)) {
				return unknown
			}
			return cs.RangeSel(op, lit)
		}
		if x.Op == "=" { // column = column: the textbook 1 / max(ndv)
			lc, lok := x.L.(Col)
			rc, rok := x.R.(Col)
			if lok && rok {
				a, b := pl.colStats(lc.Name), pl.colStats(rc.Name)
				if a != nil && b != nil && max(a.NDV, b.NDV) > 0 {
					return 1 / float64(max(a.NDV, b.NDV))
				}
			}
		}
		return unknown
	case Not:
		return 1 - pl.sel(x.E)
	case IsNull:
		if c, ok := x.E.(Col); ok {
			if cs := pl.colStats(c.Name); cs != nil && cs.Rows > 0 {
				s := float64(cs.Nulls) / float64(cs.Rows)
				if x.Negate {
					return 1 - s
				}
				return s
			}
		}
		return unknown
	case Lit:
		if Truthy(x.V) {
			return 1
		}
		return 0
	}
	return unknown
}

// groupCount estimates how many groups GROUP BY produces: the product of the key columns' NDVs,
// capped by the input size.
func (pl *planner) groupCount(inRows float64, keys []Expr) float64 {
	if len(keys) == 0 {
		return 1
	}
	g := 1.0
	for _, k := range keys {
		c, ok := k.(Col)
		cs := (*ColumnStats)(nil)
		if ok {
			cs = pl.colStats(c.Name)
		}
		if cs == nil {
			g *= math.Max(inRows/10, 1)
		} else {
			g *= float64(max(cs.NDV, 1))
		}
	}
	return atLeast1(math.Min(g, inRows))
}
