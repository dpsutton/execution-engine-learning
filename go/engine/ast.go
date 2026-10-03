package engine

import (
	"strconv"
	"strings"
)

// Expr is an expression tree node. The parser produces these with column names as written ("age",
// "c.name"); the binder rewrites every Col to a fully qualified "alias.col" name.
type Expr interface{ exprNode() }

type (
	Col struct{ Name string }
	Lit struct{ V Value }
	Bin struct {
		Op   string // + - * / = != < <= > >= and or
		L, R Expr
	}
	Not    struct{ E Expr }
	IsNull struct {
		E      Expr
		Negate bool // IS NOT NULL
	}
	Func struct {
		Name string
		Args []Expr
	}
	Agg struct {
		Fn   string // count sum min max avg
		Arg  Expr   // nil for count(*)
		Star bool
	}
)

func (Col) exprNode()    {}
func (Lit) exprNode()    {}
func (Bin) exprNode()    {}
func (Not) exprNode()    {}
func (IsNull) exprNode() {}
func (Func) exprNode()   {}
func (Agg) exprNode()    {}

// SelectStmt is the parsed form of a query.
type SelectStmt struct {
	Explain bool
	Star    bool
	Items   []SelectItem
	From    []TableRef
	Where   Expr
	GroupBy []Expr
	Having  Expr
	OrderBy []OrderItem
	Limit   int64 // -1 = none
}

type SelectItem struct {
	E     Expr
	Alias string
}

type TableRef struct {
	Table string
	Alias string
	On    Expr // JOIN … ON; nil for the first table and comma joins
}

type OrderItem struct {
	E    Expr
	Desc bool
}

func precedence(op string) int {
	switch op {
	case "or":
		return 1
	case "and":
		return 2
	case "=", "!=", "<", "<=", ">", ">=":
		return 3
	case "+", "-":
		return 4
	case "*", "/":
		return 5
	}
	return 6
}

// Render prints an expression as SQL. It doubles as structural identity: two bound expressions are
// "the same" (for GROUP BY matching, ORDER BY matching) when they render the same.
func Render(e Expr) string {
	switch x := e.(type) {
	case nil:
		return ""
	case Col:
		return x.Name
	case Lit:
		if s, ok := x.V.(string); ok {
			return "'" + strings.ReplaceAll(s, "'", "''") + "'"
		}
		if f, ok := x.V.(float64); ok {
			return strconv.FormatFloat(f, 'g', -1, 64)
		}
		return FormatValue(x.V)
	case Bin:
		p := precedence(x.Op)
		l, r := Render(x.L), Render(x.R)
		if b, ok := x.L.(Bin); ok && precedence(b.Op) < p {
			l = "(" + l + ")"
		}
		if b, ok := x.R.(Bin); ok && precedence(b.Op) <= p {
			r = "(" + r + ")"
		}
		op := x.Op
		if op == "and" || op == "or" {
			op = strings.ToUpper(op)
		}
		return l + " " + op + " " + r
	case Not:
		return "NOT " + wrap(x.E)
	case IsNull:
		if x.Negate {
			return wrap(x.E) + " IS NOT NULL"
		}
		return wrap(x.E) + " IS NULL"
	case Func:
		args := make([]string, len(x.Args))
		for i, a := range x.Args {
			args[i] = Render(a)
		}
		return x.Name + "(" + strings.Join(args, ", ") + ")"
	case Agg:
		if x.Star {
			return x.Fn + "(*)"
		}
		return x.Fn + "(" + Render(x.Arg) + ")"
	}
	return "?"
}

func wrap(e Expr) string {
	if _, ok := e.(Bin); ok {
		return "(" + Render(e) + ")"
	}
	return Render(e)
}

// walk visits e and every sub-expression, pre-order.
func walk(e Expr, f func(Expr)) {
	if e == nil {
		return
	}
	f(e)
	switch x := e.(type) {
	case Bin:
		walk(x.L, f)
		walk(x.R, f)
	case Not:
		walk(x.E, f)
	case IsNull:
		walk(x.E, f)
	case Func:
		for _, a := range x.Args {
			walk(a, f)
		}
	case Agg:
		walk(x.Arg, f)
	}
}

// rewrite rebuilds e bottom-up-ish: f sees each node first and may replace it (returning true to
// stop descending).
func rewrite(e Expr, f func(Expr) (Expr, bool)) Expr {
	if e == nil {
		return nil
	}
	if r, done := f(e); done {
		return r
	}
	switch x := e.(type) {
	case Bin:
		return Bin{x.Op, rewrite(x.L, f), rewrite(x.R, f)}
	case Not:
		return Not{rewrite(x.E, f)}
	case IsNull:
		return IsNull{rewrite(x.E, f), x.Negate}
	case Func:
		args := make([]Expr, len(x.Args))
		for i, a := range x.Args {
			args[i] = rewrite(a, f)
		}
		return Func{x.Name, args}
	case Agg:
		return Agg{x.Fn, rewrite(x.Arg, f), x.Star}
	}
	return e
}

// splitAnd flattens a AND b AND c into [a b c].
func splitAnd(e Expr) []Expr {
	if e == nil {
		return nil
	}
	if b, ok := e.(Bin); ok && b.Op == "and" {
		return append(splitAnd(b.L), splitAnd(b.R)...)
	}
	return []Expr{e}
}

func joinAnd(es []Expr) Expr {
	var out Expr
	for _, e := range es {
		if out == nil {
			out = e
		} else {
			out = Bin{"and", out, e}
		}
	}
	return out
}

// aliasesOf returns the set of table aliases a (bound) expression references.
func aliasesOf(e Expr) map[string]bool {
	out := map[string]bool{}
	walk(e, func(n Expr) {
		if c, ok := n.(Col); ok {
			if i := strings.IndexByte(c.Name, '.'); i > 0 {
				out[c.Name[:i]] = true
			}
		}
	})
	return out
}

func hasAgg(e Expr) bool {
	found := false
	walk(e, func(n Expr) {
		if _, ok := n.(Agg); ok {
			found = true
		}
	})
	return found
}
