// Lesson 2 demo: watch the pull protocol, and watch Limit stop the scan early.
package main

import (
	"fmt"
	"os"
	"strings"

	"execengine/lesson02"
)

type Row = lesson02.Row
type Value = lesson02.Value

// age > 30, compiled by hand (lesson 1's Compile would produce the same thing).
func ageOver30(r Row) bool { a, ok := r[3].(int64); return ok && a > 30 }

func main() {
	section("SELECT name, city FROM customers WHERE age > 30 LIMIT 1")
	fmt.Println("  Plan:  Limit(1) ← Project(name, city) ← Filter(age > 30) ← Scan(customers)")
	fmt.Println("  Each operator is wrapped in a tracer. Read top to bottom: calls go down, rows come up.")
	fmt.Println()

	scan := &lesson02.Scan{Table: "customers", Cols: lesson02.CustomersSchema, Rows: lesson02.Customers}
	trace := func(op lesson02.Operator, label string, depth int) lesson02.Operator {
		return &lesson02.Trace{Child: op, Label: label, Depth: depth, Out: os.Stdout}
	}
	plan := trace(&lesson02.Limit{N: 1,
		Child: trace(&lesson02.Project{
			Names: []string{"name", "city"},
			Exprs: []func(Row) Value{func(r Row) Value { return r[1] }, func(r Row) Value { return r[2] }},
			Child: trace(&lesson02.Filter{Pred: ageOver30,
				Child: trace(scan, "Scan", 3)}, "Filter", 2)}, "Project", 1)}, "Limit", 0)

	rows := lesson02.Collect(plan)
	fmt.Printf("\n  Result: %d row(s): %v\n", len(rows), rows)
	fmt.Printf("  The scan produced %d of %d rows. Limit never asked for more, so Bo, Cy and Di were never read.\n",
		scan.RowsRead, len(lesson02.Customers))

	section("Same query, LIMIT 2")
	scan2 := &lesson02.Scan{Table: "customers", Cols: lesson02.CustomersSchema, Rows: lesson02.Customers}
	rows = lesson02.Collect(&lesson02.Limit{N: 2, Child: &lesson02.Filter{Pred: ageOver30, Child: scan2}})
	fmt.Printf("  %d rows; scan read %d of %d (Bo failed the filter, Cy satisfied the limit)\n",
		len(rows), scan2.RowsRead, len(lesson02.Customers))

	section("Without LIMIT")
	scan3 := &lesson02.Scan{Table: "customers", Cols: lesson02.CustomersSchema, Rows: lesson02.Customers}
	rows = lesson02.Collect(&lesson02.Filter{Pred: ageOver30, Child: scan3})
	fmt.Printf("  %d rows; scan read %d of %d — the filter has to see every row to know it's done\n",
		len(rows), scan3.RowsRead, len(lesson02.Customers))
}

func section(title string) {
	fmt.Printf("\n━━ %s %s\n", title, strings.Repeat("━", max(0, 70-len(title))))
}
