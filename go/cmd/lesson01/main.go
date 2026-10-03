// Lesson 1 demo: evaluate expressions over the toy customers table, show three-valued logic, and
// compare the tree-walker with closure compilation.
package main

import (
	"fmt"
	"strings"
	"time"

	. "execengine/lesson01"
)

func main() {
	section("The table")
	printRows(CustomersSchema, Customers)

	section("Evaluating one expression against every row")
	exprs := []Expr{
		B(">", C("age"), L(30)),
		B("and", B(">", C("age"), L(30)), B("=", C("city"), L("Austin"))),
		B("or", B(">", C("age"), L(30)), B("=", C("city"), L("Boston"))),
		B("/", C("age"), L(2)),
		F("coalesce", C("age"), L(0)),
	}
	for _, e := range exprs {
		fmt.Printf("\n  %s\n", e)
		isPredicate := false // does this expression produce booleans (a WHERE clause)?
		for _, r := range Customers {
			if _, ok := Eval(e, CustomersSchema, r).(bool); ok {
				isPredicate = true
			}
		}
		for _, r := range Customers {
			v := Eval(e, CustomersSchema, r)
			mark := ""
			if isPredicate {
				if Passes(v) {
					mark = "  ✓ passes WHERE"
				} else {
					mark = "  ✗ filtered out"
				}
			}
			fmt.Printf("    %-4s age=%-5s → %-6s%s\n", r[1], Format(r[3]), Format(v), mark)
		}
	}
	fmt.Println("\n  Bo's age is NULL, so `age > 30` is NULL (unknown) — not false. WHERE drops it either way,")
	fmt.Println("  but OR with a true side rescues it: true OR unknown = true.")

	section("Three-valued logic truth tables")
	vals := []Value{true, false, nil}
	fmt.Println("    a      b      | a AND b  a OR b")
	for _, a := range vals {
		for _, b := range vals {
			fmt.Printf("    %-6s %-6s | %-8s %-6s\n", Format(a), Format(b), Format(And3(a, b)), Format(Or3(a, b)))
		}
	}

	section("Tree walking vs. closure compilation")
	e := exprs[1]
	compiled := Compile(e, CustomersSchema)
	const n = 2_000_000
	start := time.Now()
	for i := 0; i < n; i++ {
		Eval(e, CustomersSchema, Customers[i%4])
	}
	walk := time.Since(start)
	start = time.Now()
	for i := 0; i < n; i++ {
		compiled(Customers[i%4])
	}
	comp := time.Since(start)
	fmt.Printf("  %d evaluations of %s\n", n, e)
	fmt.Printf("    Eval (tree walk, name lookup per column): %v\n", walk.Round(time.Millisecond))
	fmt.Printf("    Compile → closure (lookups done once):    %v  (%.1fx)\n",
		comp.Round(time.Millisecond), float64(walk)/float64(comp))
}

func section(title string) {
	fmt.Printf("\n━━ %s %s\n", title, strings.Repeat("━", max(0, 70-len(title))))
}

func printRows(schema Schema, rows []Row) {
	fmt.Println("  " + strings.Join(schema, " | "))
	for _, r := range rows {
		parts := make([]string, len(r))
		for i, v := range r {
			parts[i] = Format(v)
		}
		fmt.Println("  " + strings.Join(parts, " | "))
	}
}
