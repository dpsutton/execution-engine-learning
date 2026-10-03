// Lesson 6 demo: statistics → selectivity → cardinality → cost → join order, then run the plan
// and see how good the guesses were.
package main

import (
	"fmt"
	"strings"

	. "execengine/lesson06"
)

func main() {
	cat := NewCatalog()

	section("ANALYZE: what the planner knows")
	for _, col := range []string{"customers.city", "customers.age", "orders.customer_id", "orders.day"} {
		cs := cat.Stats[strings.Split(col, ".")[0]].Cols[col]
		fmt.Printf("  %-20s rows=%-5d nulls=%-3d ndv=%-4d min=%-7s max=%s\n",
			col, cs.Rows, cs.Nulls, cs.NDV, Format(cs.Min), Format(cs.Max))
	}
	fmt.Println("\n  Equi-depth histogram of orders.customer_id (8 buckets, ~625 rows each):")
	fmt.Print(cat.Stats["orders"].Cols["orders.customer_id"].HistogramString())
	fmt.Println("  Half of all orders belong to customers 1–20, so the first buckets are narrow and dense.")

	section("Selectivity: estimated vs. actual")
	preds := []Expr{
		B("=", C("customers.city"), L("Austin")),
		B("=", C("customers.city"), L("Seattle")),
		B("<=", C("orders.customer_id"), L(20)),
		B(">", C("orders.customer_id"), L(150)),
		B("=", C("orders.customer_id"), L(7)),
		B(">", C("orders.day"), L(300)),
		B(">", C("customers.age"), L(60)),
		IsNull{E: C("customers.age")},
		B("and", B("=", C("customers.city"), L("Austin")), B("<", C("customers.age"), L(30))),
		B("or", B("=", C("orders.qty"), L(5)), B("=", C("orders.qty"), L(1))),
	}
	fmt.Printf("  %-46s %9s %9s  %s\n", "predicate", "estimate", "actual", "")
	for _, p := range preds {
		table := cat.Tables[strings.Split(Columns(p)[0], ".")[0]]
		est := cat.Selectivity(p) * float64(len(table.Rows))
		act := countWhere(table, p)
		fmt.Printf("  %-46s %9.0f %9d  %s\n", p, est, act, verdict(est, float64(act)))
	}
	fmt.Println("\n  city = 'Austin' is way off: ndv=8 says each city is 1/8 of customers, but 40% live in Austin.")
	fmt.Println("  Equality uses only NDV (the uniformity assumption). Ranges use the histogram and do far better.")
	fmt.Println("  (Real systems also keep a list of most-common values for exactly this case.)")

	section("Join cardinality: customers ⋈ orders ON orders.customer_id = customers.id")
	j := B("=", C("orders.customer_id"), C("customers.id"))
	fmt.Printf("  |customers| · |orders| / max(ndv) = 200 · 5000 / %d = %.0f rows (actual: 5000)\n",
		max(cat.Stats["customers"].Cols["customers.id"].NDV, cat.Stats["orders"].Cols["orders.customer_id"].NDV),
		cat.Selectivity(j)*200*5000)

	query := Query{
		Tables: []string{"orders", "customers", "products"},
		Where: []Expr{
			B("=", C("orders.customer_id"), C("customers.id")),
			B("=", C("orders.product_id"), C("products.id")),
			B("=", C("customers.city"), L("Seattle")),
			B("=", C("products.category"), L("games")),
			B(">=", C("orders.qty"), L(4)),
		},
	}
	section("Planning a three-way join")
	fmt.Println("  SELECT * FROM orders, customers, products")
	fmt.Println("  WHERE orders.customer_id = customers.id AND orders.product_id = products.id")
	fmt.Println("    AND customers.city = 'Seattle' AND products.category = 'games' AND orders.qty >= 4")
	planner, plan := cat.Plan(query)
	fmt.Println("\n  The DP table — cheapest plan for every subset, built smallest first:")
	for _, s := range planner.Subsets() {
		b := planner.Best[s]
		fmt.Printf("    %-34s cost %8.0f  est %6.0f rows   %s\n", planner.SubsetName(s), b.Cost, b.EstRows, Shape(b))
	}
	fmt.Printf("  %d candidate plans costed.\n", planner.Considered)

	section("EXPLAIN")
	fmt.Print(indent(Explain(plan, false)))

	section("EXPLAIN ANALYZE (ran it)")
	rows := Run(plan)
	fmt.Print(indent(Explain(plan, true)))
	fmt.Printf("  %d rows. Where estimates drift, it's the city='Seattle' uniformity guess and the\n", len(rows))
	fmt.Println("  independence assumption compounding up the tree — the errors multiply.")

	section("A point lookup: the planner picks the index")
	_, plan = cat.Plan(Query{Tables: []string{"orders"}, Where: []Expr{
		B("=", C("orders.customer_id"), L(7)), B(">", C("orders.day"), L(300))}})
	Run(plan)
	fmt.Print(indent(Explain(plan, true)))
}

func countWhere(t *Table, p Expr) int {
	f := Compile(p, t.Cols)
	n := 0
	for _, r := range t.Rows {
		if f(r) == true {
			n++
		}
	}
	return n
}

func verdict(est, act float64) string {
	if act == 0 {
		return ""
	}
	r := est / act
	switch {
	case r > 2:
		return fmt.Sprintf("← %.1fx too high", r)
	case r < 0.5:
		return fmt.Sprintf("← %.1fx too low", 1/r)
	}
	return "✓"
}

func section(title string) {
	fmt.Printf("\n━━ %s %s\n", title, strings.Repeat("━", max(3, 74-len([]rune(title)))))
}

func indent(s string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	return "  " + strings.Join(lines, "\n  ") + "\n"
}
