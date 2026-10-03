package lesson07

// The input to the compiler: an expression tree (compact copy of lesson 1's) and physical plan
// nodes (the operators of lessons 2–4, minus their execution code — that's the compiler's job now).

import (
	"fmt"
	"strings"
)

type Value = any
type Row = []Value

// ---------------------------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------------------------

type Expr interface{ String() string }

type Col struct{ Name string }
type Lit struct{ V Value }
type Bin struct {
	Op   string
	L, R Expr
}
type Not struct{ E Expr }
type IsNull struct {
	E      Expr
	Negate bool
}
type Func struct {
	Name string
	Args []Expr
}

func C(name string) Expr { return Col{Name: name} }
func L(v Value) Expr {
	if i, ok := v.(int); ok {
		v = int64(i)
	}
	return Lit{V: v}
}
func B(op string, l, r Expr) Expr { return Bin{Op: op, L: l, R: r} }

func (c Col) String() string { return c.Name }
func (l Lit) String() string {
	if s, ok := l.V.(string); ok {
		return "'" + s + "'"
	}
	return Format(l.V)
}
func (b Bin) String() string { return b.L.String() + " " + strings.ToUpper(b.Op) + " " + b.R.String() }
func (n Not) String() string { return "NOT " + n.E.String() }
func (n IsNull) String() string {
	if n.Negate {
		return n.E.String() + " IS NOT NULL"
	}
	return n.E.String() + " IS NULL"
}
func (f Func) String() string {
	parts := make([]string, len(f.Args))
	for i, a := range f.Args {
		parts[i] = a.String()
	}
	return f.Name + "(" + strings.Join(parts, ", ") + ")"
}

// ---------------------------------------------------------------------------------------------
// Physical plan nodes
// ---------------------------------------------------------------------------------------------

type Plan interface{ Schema(db DB) []string }

type Scan struct{ Table string }
type Filter struct {
	Child Plan
	Pred  Expr
}
type Project struct {
	Child Plan
	Exprs []Expr
	Names []string
}
type NLJoin struct {
	Left, Right Plan
	Pred        Expr // nil = cross product
}

// HashJoin builds on Right, probes with Left (DESIGN.md).
type HashJoin struct {
	Left, Right       Plan
	LeftKey, RightKey Expr
}

// AggCall is one aggregate: Fn ∈ count, sum, min, max, avg; Arg nil means count(*).
type AggCall struct {
	Fn  string
	Arg Expr
}

// Aggregate is a hash aggregate. Output: group-by values, then aggregates, named by Names.
type Aggregate struct {
	Child   Plan
	GroupBy []Expr
	Aggs    []AggCall
	Names   []string
}

type SortKey struct {
	E    Expr
	Desc bool
}
type Sort struct {
	Child Plan
	Keys  []SortKey
}
type Limit struct {
	Child Plan
	N     int
}

func (s Scan) Schema(db DB) []string    { return db[s.Table].Cols }
func (f Filter) Schema(db DB) []string  { return f.Child.Schema(db) }
func (p Project) Schema(db DB) []string { return p.Names }
func (j NLJoin) Schema(db DB) []string {
	return append(append([]string{}, j.Left.Schema(db)...), j.Right.Schema(db)...)
}
func (j HashJoin) Schema(db DB) []string {
	return append(append([]string{}, j.Left.Schema(db)...), j.Right.Schema(db)...)
}
func (a Aggregate) Schema(db DB) []string { return a.Names }
func (s Sort) Schema(db DB) []string      { return s.Child.Schema(db) }
func (l Limit) Schema(db DB) []string     { return l.Child.Schema(db) }

// DB maps table names to tables.
type DB map[string]*Table

// ---------------------------------------------------------------------------------------------
// Values (compact copy)
// ---------------------------------------------------------------------------------------------

func Format(v Value) string {
	switch v := v.(type) {
	case nil:
		return "NULL"
	case float64:
		return fmt.Sprintf("%.2f", v)
	}
	return fmt.Sprint(v)
}

func FormatRow(r Row) string {
	parts := make([]string, len(r))
	for i, v := range r {
		parts[i] = Format(v)
	}
	return strings.Join(parts, " | ")
}

func Compare(a, b Value) int {
	switch x := a.(type) {
	case int64:
		if y, ok := b.(int64); ok {
			return cmp3(x < y, x > y)
		}
		return cmpF(float64(x), toFloat(b))
	case float64:
		return cmpF(x, toFloat(b))
	case string:
		y := b.(string)
		return cmp3(x < y, x > y)
	case bool:
		y := b.(bool)
		return cmp3(!x && y, x && !y)
	}
	panic(fmt.Sprintf("cannot compare %v and %v", a, b))
}

func toFloat(v Value) float64 {
	if i, ok := v.(int64); ok {
		return float64(i)
	}
	return v.(float64)
}
func cmpF(a, b float64) int { return cmp3(a < b, a > b) }
func cmp3(less, greater bool) int {
	if less {
		return -1
	}
	if greater {
		return 1
	}
	return 0
}

// keyString turns values into a map key: numbers normalize, NULL is its own key (GROUP BY rule).
func keyString(vals []Value) string {
	var b strings.Builder
	for _, v := range vals {
		switch v := v.(type) {
		case int64:
			fmt.Fprintf(&b, "n:%v|", float64(v))
		case float64:
			fmt.Fprintf(&b, "n:%v|", v)
		default:
			fmt.Fprintf(&b, "%T:%v|", v, v)
		}
	}
	return b.String()
}

// ToyDB is the toy dataset from DESIGN.md.
func ToyDB() DB {
	return DB{
		"customers": {Name: "customers", Cols: []string{"customers.id", "customers.name", "customers.city", "customers.age"},
			Rows: []Row{
				{int64(1), "Ada", "Austin", int64(36)},
				{int64(2), "Bo", "Boston", nil},
				{int64(3), "Cy", "Austin", int64(52)},
				{int64(4), "Di", "Denver", int64(29)},
			}},
		"orders": {Name: "orders", Cols: []string{"orders.id", "orders.customer_id", "orders.product_id", "orders.qty"},
			Rows: []Row{
				{int64(10), int64(1), int64(100), int64(2)},
				{int64(11), int64(1), int64(101), int64(1)},
				{int64(12), int64(3), int64(100), int64(5)},
				{int64(13), int64(4), int64(102), int64(1)},
				{int64(14), int64(9), int64(101), int64(3)},
			}},
		"products": {Name: "products", Cols: []string{"products.id", "products.name", "products.category", "products.price"},
			Rows: []Row{
				{int64(100), "Pen", "tools", 1.50},
				{int64(101), "Atlas", "books", 24.00},
				{int64(102), "Chess", "games", 18.25},
			}},
	}
}

// GeneratedDB is the generated dataset from DESIGN.md.
func GeneratedDB() DB {
	c, p, o := Generate()
	return DB{"customers": c, "products": p, "orders": o}
}
