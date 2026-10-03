package engine

import (
	"fmt"
	"strings"
)

// Node is a physical plan operator. Both executors (volcano.go, compile.go) consume these.
type Node interface {
	Schema() []string // output column names; join outputs are "alias.col"
	Children() []Node
	Est() *Estimate
	describe() string // one line for EXPLAIN
}

// Estimate is the planner's guess for a node: output rows, and total cost of the subtree.
type Estimate struct{ Rows, Cost float64 }

func (e *Estimate) Est() *Estimate { return e }

type (
	// Scan reads every row of a table.
	Scan struct {
		Estimate
		Alias string
		Table *Table
	}
	// IndexScan reads only the rows an index says match: col = Lo, or a range between Lo and Hi.
	IndexScan struct {
		Estimate
		Alias          string
		Table          *Table
		Col            string
		Eq             bool
		Lo, Hi         Value // nil = unbounded
		LoIncl, HiIncl bool
	}
	Filter struct {
		Estimate
		Child Node
		Pred  Expr
	}
	Project struct {
		Estimate
		Child Node
		Exprs []Expr
		Names []string
	}
	// NLJoin: for each left row, scan all of Right. Pred may be nil (cross product).
	NLJoin struct {
		Estimate
		Left, Right Node
		Pred        Expr
	}
	// HashJoin builds a hash table on Right keyed by RightKey, then probes it with each Left row.
	HashJoin struct {
		Estimate
		Left, Right       Node
		LeftKey, RightKey Expr
		Residual          Expr // other join predicates, checked per match
	}
	// IndexNLJoin: for each left row, look OuterKey up in Table's index on Col.
	IndexNLJoin struct {
		Estimate
		Left     Node
		Alias    string
		Table    *Table
		Col      string
		OuterKey Expr
		Residual Expr // the inner table's own filters, plus other join predicates
	}
	// HashAggregate groups by Keys and computes Aggs; output is "#g0".."#gN", "#a0".."#aM".
	HashAggregate struct {
		Estimate
		Child Node
		Keys  []Expr
		Aggs  []Agg
	}
	Sort struct {
		Estimate
		Child Node
		Keys  []SortKey
	}
	Limit struct {
		Estimate
		Child Node
		N     int64
	}
)

func tableSchema(alias string, t *Table) []string {
	out := make([]string, len(t.Columns))
	for i, c := range t.Columns {
		out[i] = alias + "." + c
	}
	return out
}

func concat(a, b []string) []string { return append(append([]string(nil), a...), b...) }

func (n *Scan) Schema() []string      { return tableSchema(n.Alias, n.Table) }
func (n *IndexScan) Schema() []string { return tableSchema(n.Alias, n.Table) }
func (n *Filter) Schema() []string    { return n.Child.Schema() }
func (n *Project) Schema() []string   { return n.Names }
func (n *NLJoin) Schema() []string    { return concat(n.Left.Schema(), n.Right.Schema()) }
func (n *HashJoin) Schema() []string  { return concat(n.Left.Schema(), n.Right.Schema()) }
func (n *IndexNLJoin) Schema() []string {
	return concat(n.Left.Schema(), tableSchema(n.Alias, n.Table))
}
func (n *Sort) Schema() []string  { return n.Child.Schema() }
func (n *Limit) Schema() []string { return n.Child.Schema() }
func (n *HashAggregate) Schema() []string {
	var out []string
	for i := range n.Keys {
		out = append(out, fmt.Sprintf("#g%d", i))
	}
	for i := range n.Aggs {
		out = append(out, fmt.Sprintf("#a%d", i))
	}
	return out
}

func (n *Scan) Children() []Node          { return nil }
func (n *IndexScan) Children() []Node     { return nil }
func (n *Filter) Children() []Node        { return []Node{n.Child} }
func (n *Project) Children() []Node       { return []Node{n.Child} }
func (n *NLJoin) Children() []Node        { return []Node{n.Left, n.Right} }
func (n *HashJoin) Children() []Node      { return []Node{n.Left, n.Right} }
func (n *IndexNLJoin) Children() []Node   { return []Node{n.Left} }
func (n *HashAggregate) Children() []Node { return []Node{n.Child} }
func (n *Sort) Children() []Node          { return []Node{n.Child} }
func (n *Limit) Children() []Node         { return []Node{n.Child} }

func tableLabel(alias string, t *Table) string {
	if alias == t.Name {
		return t.Name
	}
	return t.Name + " AS " + alias
}

func (n *Scan) describe() string { return "Scan " + tableLabel(n.Alias, n.Table) }

func (n *IndexScan) describe() string {
	return fmt.Sprintf("IndexScan %s USING %s(%s) WHERE %s", tableLabel(n.Alias, n.Table), n.Table.Name, n.Col, n.rangeText())
}

func (n *IndexScan) rangeText() string {
	if n.Eq {
		return fmt.Sprintf("%s = %s", n.Col, Render(Lit{n.Lo}))
	}
	var parts []string
	if n.Lo != nil {
		op := ">"
		if n.LoIncl {
			op = ">="
		}
		parts = append(parts, fmt.Sprintf("%s %s %s", n.Col, op, Render(Lit{n.Lo})))
	}
	if n.Hi != nil {
		op := "<"
		if n.HiIncl {
			op = "<="
		}
		parts = append(parts, fmt.Sprintf("%s %s %s", n.Col, op, Render(Lit{n.Hi})))
	}
	return strings.Join(parts, " AND ")
}

func (n *Filter) describe() string { return "Filter " + Render(n.Pred) }

func (n *Project) describe() string {
	parts := make([]string, len(n.Exprs))
	for i, e := range n.Exprs {
		parts[i] = Render(e)
		if n.Names[i] != parts[i] {
			parts[i] += " AS " + n.Names[i]
		}
	}
	return "Project " + strings.Join(parts, ", ")
}

func (n *NLJoin) describe() string {
	if n.Pred == nil {
		return "NestedLoopJoin (cross product)"
	}
	return "NestedLoopJoin ON " + Render(n.Pred)
}

func (n *HashJoin) describe() string {
	s := fmt.Sprintf("HashJoin probe %s = build %s", Render(n.LeftKey), Render(n.RightKey))
	if n.Residual != nil {
		s += " AND " + Render(n.Residual)
	}
	return s
}

func (n *IndexNLJoin) describe() string {
	s := fmt.Sprintf("IndexNestedLoopJoin %s USING %s(%s) = %s", tableLabel(n.Alias, n.Table), n.Table.Name, n.Col, Render(n.OuterKey))
	if n.Residual != nil {
		s += " WHERE " + Render(n.Residual)
	}
	return s
}

func (n *HashAggregate) describe() string {
	var parts []string
	for i, k := range n.Keys {
		parts = append(parts, fmt.Sprintf("#g%d=%s", i, Render(k)))
	}
	for i, a := range n.Aggs {
		parts = append(parts, fmt.Sprintf("#a%d=%s", i, Render(a)))
	}
	return "HashAggregate " + strings.Join(parts, ", ")
}

func (n *Sort) describe() string {
	schema := n.Child.Schema()
	parts := make([]string, len(n.Keys))
	for i, k := range n.Keys {
		parts[i] = schema[k.Idx]
		if k.Desc {
			parts[i] += " DESC"
		}
	}
	return "Sort " + strings.Join(parts, ", ")
}

func (n *Limit) describe() string { return fmt.Sprintf("Limit %d", n.N) }

// Explain renders a plan tree with estimates, one node per line.
func Explain(n Node) string {
	var b strings.Builder
	var rec func(n Node, depth int)
	rec = func(n Node, depth int) {
		e := n.Est()
		fmt.Fprintf(&b, "%s%s  (rows≈%s cost≈%s)\n", strings.Repeat("  ", depth), n.describe(),
			roundNum(e.Rows), roundNum(e.Cost))
		for _, c := range n.Children() {
			rec(c, depth+1)
		}
	}
	rec(n, 0)
	return b.String()
}

func roundNum(f float64) string {
	if f >= 100 {
		return fmt.Sprintf("%.0f", f)
	}
	return fmt.Sprintf("%.1f", f)
}
