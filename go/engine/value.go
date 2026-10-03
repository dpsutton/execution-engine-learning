// Package engine is the integrated execution engine: SQL text in, rows out.
//
// The pipeline, file by file:
//
//	lexer.go, parser.go   SQL text → SelectStmt (an AST of Exprs)
//	binder.go             names → qualified columns; aggregates, GROUP BY, ORDER BY resolved → Query
//	stats.go              ANALYZE: row counts, NDV, min/max, equi-depth histograms
//	planner.go, plan.go   Query + stats → physical plan (access paths, join order, join algorithms)
//	volcano.go            executes a plan with pull iterators (Open/Next/Close)
//	compile.go, vm.go     compiles a plan to register bytecode and runs it on a resumable VM
//	engine.go             the facade the CLI and tests use
//
// Everything is in memory and single-threaded. It is meant to be read.
package engine

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Value is a SQL value: nil (NULL), int64, float64, string, or bool.
type Value = any

// EvalError is raised (via panic) for runtime type errors; executors recover it into an error.
type EvalError struct{ Msg string }

func (e EvalError) Error() string { return e.Msg }

func fail(format string, args ...any) { panic(EvalError{fmt.Sprintf(format, args...)}) }

func toFloat(v Value) (float64, bool) {
	switch x := v.(type) {
	case int64:
		return float64(x), true
	case float64:
		return x, true
	}
	return 0, false
}

func kindOf(v Value) string {
	switch v.(type) {
	case nil:
		return "null"
	case int64:
		return "integer"
	case float64:
		return "float"
	case string:
		return "string"
	case bool:
		return "boolean"
	}
	return fmt.Sprintf("%T", v)
}

// Arith applies + - * /. int∘int stays int except for /, which always returns float.
// NULL in → NULL out; division by zero → NULL.
func Arith(op string, a, b Value) Value {
	if a == nil || b == nil {
		return nil
	}
	fa, okA := toFloat(a)
	fb, okB := toFloat(b)
	if !okA || !okB {
		fail("cannot apply %s to %s and %s", op, kindOf(a), kindOf(b))
	}
	if op == "/" {
		if fb == 0 {
			return nil
		}
		return fa / fb
	}
	ai, aInt := a.(int64)
	bi, bInt := b.(int64)
	if aInt && bInt {
		switch op {
		case "+":
			return ai + bi
		case "-":
			return ai - bi
		case "*":
			return ai * bi
		}
	}
	switch op {
	case "+":
		return fa + fb
	case "-":
		return fa - fb
	case "*":
		return fa * fb
	}
	fail("unknown arithmetic operator %s", op)
	return nil
}

// Compare orders two non-NULL values: numbers numerically, strings bytewise, false < true.
func Compare(a, b Value) int {
	switch x := a.(type) {
	case int64:
		if y, ok := b.(int64); ok {
			return cmp3(x < y, x > y)
		}
	case string:
		if y, ok := b.(string); ok {
			return strings.Compare(x, y)
		}
		fail("cannot compare %s and %s", kindOf(a), kindOf(b))
	case bool:
		if y, ok := b.(bool); ok {
			return cmp3(!x && y, x && !y)
		}
		fail("cannot compare %s and %s", kindOf(a), kindOf(b))
	}
	fa, okA := toFloat(a)
	fb, okB := toFloat(b)
	if !okA || !okB {
		fail("cannot compare %s and %s", kindOf(a), kindOf(b))
	}
	return cmp3(fa < fb, fa > fb)
}

func cmp3(less, greater bool) int {
	switch {
	case less:
		return -1
	case greater:
		return 1
	}
	return 0
}

// CmpOp evaluates a comparison with SQL semantics: NULL if either side is NULL.
func CmpOp(op string, a, b Value) Value {
	if a == nil || b == nil {
		return nil
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
	fail("unknown comparison %s", op)
	return nil
}

func asBool(v Value) Value {
	if v == nil {
		return nil
	}
	b, ok := v.(bool)
	if !ok {
		fail("expected boolean, got %s", kindOf(v))
	}
	return b
}

// And3 / Or3 / Not3 implement SQL's three-valued logic.
func And3(a, b Value) Value {
	a, b = asBool(a), asBool(b)
	if a == false || b == false {
		return false
	}
	if a == nil || b == nil {
		return nil
	}
	return true
}

func Or3(a, b Value) Value {
	a, b = asBool(a), asBool(b)
	if a == true || b == true {
		return true
	}
	if a == nil || b == nil {
		return nil
	}
	return false
}

func Not3(a Value) Value {
	a = asBool(a)
	if a == nil {
		return nil
	}
	return !a.(bool)
}

// Truthy is the WHERE rule: a row passes only if the predicate is exactly true.
func Truthy(v Value) bool {
	b, ok := v.(bool)
	return ok && b
}

// CallFunc runs a scalar function. NULL in → NULL out, except coalesce.
func CallFunc(name string, args []Value) Value {
	if name == "coalesce" {
		for _, a := range args {
			if a != nil {
				return a
			}
		}
		return nil
	}
	if len(args) != 1 {
		fail("%s takes 1 argument, got %d", name, len(args))
	}
	a := args[0]
	if a == nil {
		return nil
	}
	switch name {
	case "lower", "upper", "length":
		s, ok := a.(string)
		if !ok {
			fail("%s expects a string, got %s", name, kindOf(a))
		}
		switch name {
		case "lower":
			return strings.ToLower(s)
		case "upper":
			return strings.ToUpper(s)
		default:
			return int64(utf8.RuneCountInString(s))
		}
	case "abs":
		switch x := a.(type) {
		case int64:
			if x < 0 {
				return -x
			}
			return x
		case float64:
			return math.Abs(x)
		}
		fail("abs expects a number, got %s", kindOf(a))
	}
	fail("unknown function %s", name)
	return nil
}

// FormatValue is the canonical text form used by golden output.
func FormatValue(v Value) string {
	switch x := v.(type) {
	case nil:
		return "NULL"
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return strconv.FormatFloat(x, 'f', 2, 64)
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	}
	return fmt.Sprint(v)
}

// HashKey encodes values for hash tables (joins, GROUP BY). Integral floats encode like ints so
// that 1 and 1.0 land in the same bucket. NULL encodes as "n": GROUP BY puts NULLs together; joins
// must check for NULL keys themselves (NULL never equals NULL in a join).
func HashKey(vals ...Value) string {
	var b strings.Builder
	for i, v := range vals {
		if i > 0 {
			b.WriteByte(0)
		}
		switch x := v.(type) {
		case nil:
			b.WriteString("n")
		case int64:
			b.WriteString("i" + strconv.FormatInt(x, 10))
		case float64:
			if x == math.Trunc(x) && math.Abs(x) < 1<<53 {
				b.WriteString("i" + strconv.FormatInt(int64(x), 10))
			} else {
				b.WriteString("f" + strconv.FormatFloat(x, 'g', -1, 64))
			}
		case string:
			b.WriteString("s" + x)
		case bool:
			b.WriteString("b" + strconv.FormatBool(x))
		}
	}
	return b.String()
}

// Vals is a list of Values that survives a JSON round trip with its types intact (plain JSON would
// turn every int64 into a float64). Used everywhere VM state holds values, so Snapshot/Restore is
// exact.
type Vals []Value

func (vs Vals) MarshalJSON() ([]byte, error) {
	out := make([]any, len(vs))
	for i, v := range vs {
		switch x := v.(type) {
		case nil:
			out[i] = nil
		case int64:
			out[i] = map[string]string{"i": strconv.FormatInt(x, 10)}
		case float64:
			out[i] = map[string]float64{"f": x}
		case string:
			out[i] = map[string]string{"s": x}
		case bool:
			out[i] = map[string]bool{"b": x}
		default:
			return nil, fmt.Errorf("cannot encode %T", v)
		}
	}
	return json.Marshal(out)
}

func (vs *Vals) UnmarshalJSON(data []byte) error {
	var raw []map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	out := make(Vals, len(raw))
	for i, m := range raw {
		for tag, msg := range m {
			switch tag {
			case "i":
				var s string
				if err := json.Unmarshal(msg, &s); err != nil {
					return err
				}
				n, err := strconv.ParseInt(s, 10, 64)
				if err != nil {
					return err
				}
				out[i] = n
			case "f":
				var f float64
				if err := json.Unmarshal(msg, &f); err != nil {
					return err
				}
				out[i] = f
			case "s":
				var s string
				if err := json.Unmarshal(msg, &s); err != nil {
					return err
				}
				out[i] = s
			case "b":
				var b bool
				if err := json.Unmarshal(msg, &b); err != nil {
					return err
				}
				out[i] = b
			}
		}
	}
	*vs = out
	return nil
}
