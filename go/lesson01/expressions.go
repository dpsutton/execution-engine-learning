// Package lesson01 is part 1 of the series: rows, values, and evaluating an expression tree.
//
// A query engine spends most of its time asking one question over and over: "given this row, what
// is the value of this expression?" This file answers it twice:
//
//  1. Eval walks the tree for every row (a tree-walking interpreter).
//  2. Compile walks the tree once and returns a Go closure; running the closure per row does no
//     tree inspection and no column-name lookups at all.
//
// Errors in this teaching code (unknown column, adding a string to a number) panic. A real engine
// reports them during planning; here a panic keeps every signature small.
package lesson01

import (
	"fmt"
	"strings"
)

// Value is one SQL value: nil (NULL), int64, float64, string, or bool.
type Value = any

// Row is positional: row[i] is the value of schema[i].
type Row = []Value

// Schema names each position of a row, qualified as "table.col".
type Schema = []string

// ---------------------------------------------------------------------------------------------
// The expression tree
// ---------------------------------------------------------------------------------------------

// Expr is any node of an expression tree.
type Expr interface{ String() string }

// Col reads a column by name, e.g. Col{"orders.qty"}.
type Col struct{ Name string }

// Lit is a constant.
type Lit struct{ V Value }

// Bin is a binary operator: + - * / = != < <= > >= and or.
type Bin struct {
	Op   string
	L, R Expr
}

// Not is logical negation (three-valued).
type Not struct{ E Expr }

// IsNull is `e IS NULL`, or `e IS NOT NULL` when Negate is set.
type IsNull struct {
	E      Expr
	Negate bool
}

// Func is a scalar function call: lower, upper, length, coalesce, abs.
type Func struct {
	Name string
	Args []Expr
}

func (c Col) String() string { return c.Name }
func (l Lit) String() string {
	if s, ok := l.V.(string); ok {
		return "'" + s + "'"
	}
	return Format(l.V)
}
func (b Bin) String() string {
	return "(" + b.L.String() + " " + strings.ToUpper(b.Op) + " " + b.R.String() + ")"
}
func (n Not) String() string { return "NOT " + n.E.String() }
func (n IsNull) String() string {
	if n.Negate {
		return n.E.String() + " IS NOT NULL"
	}
	return n.E.String() + " IS NULL"
}
func (f Func) String() string {
	args := make([]string, len(f.Args))
	for i, a := range f.Args {
		args[i] = a.String()
	}
	return f.Name + "(" + strings.Join(args, ", ") + ")"
}

// ---------------------------------------------------------------------------------------------
// Strategy 1: the tree-walking interpreter
// ---------------------------------------------------------------------------------------------

// Eval computes the value of e for one row. Note what it does on *every* call: a type switch per
// node and, for each column, a linear search of the schema by name.
func Eval(e Expr, schema Schema, row Row) Value {
	switch e := e.(type) {
	case Col:
		return row[ColumnIndex(schema, e.Name)]
	case Lit:
		return e.V
	case Not:
		return Not3(Eval(e.E, schema, row))
	case IsNull:
		return (Eval(e.E, schema, row) == nil) != e.Negate
	case Func:
		args := make([]Value, len(e.Args))
		for i, a := range e.Args {
			args[i] = Eval(a, schema, row)
		}
		return CallFunc(e.Name, args)
	case Bin:
		return evalBinary(e, schema, row)
	}
	panic(fmt.Sprintf("unknown expression %T", e))
}

// evalBinary evaluates both children (recursively), then combines them.
func evalBinary(e Bin, schema Schema, row Row) Value {
	// EXERCISE(eval-binary): Evaluate both sides with Eval, then combine them: AND/OR use
	// three-valued logic (Logic3); every other operator goes through ApplyBinary.
	l, r := Eval(e.L, schema, row), Eval(e.R, schema, row)
	if e.Op == "and" || e.Op == "or" {
		return Logic3(e.Op, l, r)
	}
	return ApplyBinary(e.Op, l, r)
	// END EXERCISE
}

// ColumnIndex finds a column's position. Unqualified names ("qty") match "anything.qty".
func ColumnIndex(schema Schema, name string) int {
	for i, c := range schema {
		if c == name {
			return i
		}
	}
	for i, c := range schema {
		if strings.HasSuffix(c, "."+name) {
			return i
		}
	}
	panic("unknown column " + name)
}

// ---------------------------------------------------------------------------------------------
// Strategy 2: closure compilation
// ---------------------------------------------------------------------------------------------

// Compiled is an expression turned into a plain function of a row.
type Compiled func(Row) Value

// Compile walks the tree once, resolving column names to positions and choosing the operator
// function up front. The returned closure only does the arithmetic.
func Compile(e Expr, schema Schema) Compiled {
	// EXERCISE(compile-closures): Walk the tree once and return a closure per node. Resolve column
	// names to positions now, so the returned function only indexes into the row.
	switch e := e.(type) {
	case Col:
		i := ColumnIndex(schema, e.Name) // resolved once, not per row
		return func(r Row) Value { return r[i] }
	case Lit:
		v := e.V
		return func(Row) Value { return v }
	case Not:
		inner := Compile(e.E, schema)
		return func(r Row) Value { return Not3(inner(r)) }
	case IsNull:
		inner, negate := Compile(e.E, schema), e.Negate
		return func(r Row) Value { return (inner(r) == nil) != negate }
	case Func:
		args := make([]Compiled, len(e.Args))
		for i, a := range e.Args {
			args[i] = Compile(a, schema)
		}
		name := e.Name
		return func(r Row) Value {
			vals := make([]Value, len(args))
			for i, a := range args {
				vals[i] = a(r)
			}
			return CallFunc(name, vals)
		}
	case Bin:
		l, r := Compile(e.L, schema), Compile(e.R, schema)
		switch e.Op {
		case "and":
			return func(row Row) Value { return And3(l(row), r(row)) }
		case "or":
			return func(row Row) Value { return Or3(l(row), r(row)) }
		}
		op := e.Op
		return func(row Row) Value { return ApplyBinary(op, l(row), r(row)) }
	}
	panic(fmt.Sprintf("unknown expression %T", e))
	// END EXERCISE
}

// Passes is the WHERE-clause rule: a row survives only if the predicate is exactly true.
// NULL ("unknown") filters the row out, the same as false.
func Passes(v Value) bool { b, ok := v.(bool); return ok && b }

// ---------------------------------------------------------------------------------------------
// Three-valued logic. NULL means "unknown", so the answer is NULL unless the known side decides it.
// ---------------------------------------------------------------------------------------------

// And3 and Or3 are SQL's AND and OR over true, false and NULL.
func And3(a, b Value) Value { return Logic3("and", a, b) }
func Or3(a, b Value) Value  { return Logic3("or", a, b) }

// Logic3 implements both: for AND, false wins over everything (false AND unknown = false); for
// OR, true wins (true OR unknown = true). Otherwise NULL is contagious.
func Logic3(op string, a, b Value) Value {
	// EXERCISE(and-or-3vl): Return the deciding value if either side has it (false for AND, true
	// for OR); otherwise NULL if either side is NULL; otherwise the ordinary boolean answer.
	decider := op == "or" // true decides OR, false decides AND
	if a == decider || b == decider {
		return decider
	}
	if a == nil || b == nil {
		return nil
	}
	return !decider
	// END EXERCISE
}

// Not3: NOT unknown is still unknown.
func Not3(a Value) Value {
	if a == nil {
		return nil
	}
	return !a.(bool)
}

// ---------------------------------------------------------------------------------------------
// Operators on values
// ---------------------------------------------------------------------------------------------

// ApplyBinary applies an arithmetic or comparison operator. NULL in, NULL out.
func ApplyBinary(op string, a, b Value) Value {
	if a == nil || b == nil {
		return nil
	}
	switch op {
	case "+", "-", "*", "/":
		return arith(op, a, b)
	}
	c := Compare(a, b)
	switch op {
	case "=":
		return c == 0
	case "!=":
		return c != 0
	case "<":
		return c < 0
	case "<=":
		return c <= 0
	case ">":
		return c > 0
	case ">=":
		return c >= 0
	}
	panic("unknown operator " + op)
}

func arith(op string, a, b Value) Value {
	ai, aInt := a.(int64)
	bi, bInt := b.(int64)
	if aInt && bInt && op != "/" { // int ∘ int stays int; "/" always produces a float
		switch op {
		case "+":
			return ai + bi
		case "-":
			return ai - bi
		case "*":
			return ai * bi
		}
	}
	x, y := toFloat(a), toFloat(b)
	switch op {
	case "+":
		return x + y
	case "-":
		return x - y
	case "*":
		return x * y
	default:
		if y == 0 {
			return nil // division by zero is NULL in this engine
		}
		return x / y
	}
}

func toFloat(v Value) float64 {
	switch v := v.(type) {
	case int64:
		return float64(v)
	case float64:
		return v
	}
	panic(fmt.Sprintf("not a number: %v", v))
}

// Compare orders two non-NULL values: -1, 0, or 1. Numbers compare numerically across int/float.
func Compare(a, b Value) int {
	switch x := a.(type) {
	case int64, float64:
		if xi, ok := x.(int64); ok {
			if yi, ok := b.(int64); ok {
				return cmp3(xi < yi, xi > yi)
			}
		}
		fa, fb := toFloat(a), toFloat(b)
		return cmp3(fa < fb, fa > fb)
	case string:
		y := b.(string)
		return cmp3(x < y, x > y)
	case bool:
		y := b.(bool)
		return cmp3(!x && y, x && !y)
	}
	panic(fmt.Sprintf("cannot compare %v and %v", a, b))
}

func cmp3(less, greater bool) int {
	if less {
		return -1
	}
	if greater {
		return 1
	}
	return 0
}

// CallFunc runs a scalar function. Everything but coalesce returns NULL for a NULL argument.
func CallFunc(name string, args []Value) Value {
	if name == "coalesce" {
		for _, a := range args {
			if a != nil {
				return a
			}
		}
		return nil
	}
	if args[0] == nil {
		return nil
	}
	switch name {
	case "lower":
		return strings.ToLower(args[0].(string))
	case "upper":
		return strings.ToUpper(args[0].(string))
	case "length":
		return int64(len(args[0].(string)))
	case "abs":
		switch v := args[0].(type) {
		case int64:
			if v < 0 {
				return -v
			}
			return v
		case float64:
			if v < 0 {
				return -v
			}
			return v
		}
	}
	panic("unknown function " + name)
}

// Format prints a value the way every engine in this project does: NULL, ints, floats with %.2f.
func Format(v Value) string {
	switch v := v.(type) {
	case nil:
		return "NULL"
	case float64:
		return fmt.Sprintf("%.2f", v)
	}
	return fmt.Sprint(v)
}

// ---------------------------------------------------------------------------------------------
// The toy dataset
// ---------------------------------------------------------------------------------------------

// CustomersSchema and Customers are the toy customers table from DESIGN.md.
var CustomersSchema = Schema{"customers.id", "customers.name", "customers.city", "customers.age"}

var Customers = []Row{
	{int64(1), "Ada", "Austin", int64(36)},
	{int64(2), "Bo", "Boston", nil},
	{int64(3), "Cy", "Austin", int64(52)},
	{int64(4), "Di", "Denver", int64(29)},
}

// ---------------------------------------------------------------------------------------------
// Constructors: short names so trees read like the SQL they came from.
// ---------------------------------------------------------------------------------------------

// C is a column reference.
func C(name string) Expr { return Col{Name: name} }

// L is a literal; Go ints become int64 so callers can write L(30).
func L(v Value) Expr {
	if i, ok := v.(int); ok {
		v = int64(i)
	}
	return Lit{V: v}
}

// B is a binary operator node.
func B(op string, l, r Expr) Expr { return Bin{Op: op, L: l, R: r} }

// F is a function call node.
func F(name string, args ...Expr) Expr { return Func{Name: name, Args: args} }
