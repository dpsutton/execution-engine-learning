// Lesson 3 demo: one join, three algorithms, very different amounts of work.
package main

import (
	"fmt"
	"strings"

	. "execengine/lesson03"
)

func main() {
	section("customers ⋈ orders ON customers.id = orders.customer_id  (toy data)")

	// Concatenated row: customers (4 cols) then orders (4 cols); customer_id is column 5.
	nl := &NLJoin{Left: &Scan{T: ToyCustomers}, Right: &Scan{T: ToyOrders},
		Pred: func(r Row) bool { return KeysEqual(r[0], r[5]) }}
	hash := &HashJoin{Left: &Scan{T: ToyCustomers}, Right: &Scan{T: ToyOrders}, LeftKey: 0, RightKey: 1}
	merge := &MergeJoin{Left: &Sort{Child: &Scan{T: ToyCustomers}, Key: 0},
		Right: &Sort{Child: &Scan{T: ToyOrders}, Key: 1}, LeftKey: 0, RightKey: 1}

	printRows("c.id | c.name | c.city | c.age || o.id | o.cust | o.prod | o.qty", Collect(hash))
	nlRows, mergeRows := Collect(nl), Collect(merge)
	fmt.Printf("\n  Nested loop: %d rows, merge: %d rows. The work each algorithm did:\n", len(nlRows), len(mergeRows))
	fmt.Printf("    nested loop : %3d predicate evaluations (4 customers × 5 orders)\n", nl.Comparisons)
	fmt.Printf("    hash        : %3d rows built, %d probes, %d key comparisons\n", hash.BuildRows, hash.Probes, hash.Comparisons)
	fmt.Printf("    merge       : %3d key comparisons (after sorting both sides)\n", merge.Comparisons)

	section("customers LEFT JOIN orders — Bo has no orders")
	printRows("c.id | c.name | c.city | c.age || o.id | o.cust | o.prod | o.qty", Collect(&HashJoin{Left: &Scan{T: ToyCustomers}, Right: &Scan{T: ToyOrders}, LeftKey: 0, RightKey: 1, Kind: LeftOuter}))
	fmt.Println("\n  Bo survives, padded with NULLs on the orders side. Order 14 (customer 9) is gone:")
	fmt.Println("  it's on the right, and only unmatched LEFT rows are kept.")

	section("orders LEFT JOIN customers — order 14's customer doesn't exist")
	printRows("o.id | o.cust | o.prod | o.qty || c.id | c.name | c.city | c.age", Collect(&NLJoin{Left: &Scan{T: ToyOrders}, Right: &Scan{T: ToyCustomers},
		Pred: func(r Row) bool { return KeysEqual(r[1], r[4]) }, Kind: LeftOuter}))

	section("The same join on generated data: 200 customers × 5000 orders")
	c, _, o := Generate()
	nl = &NLJoin{Left: &Scan{T: c}, Right: &Scan{T: o}, Pred: func(r Row) bool { return KeysEqual(r[0], r[5]) }}
	hash = &HashJoin{Left: &Scan{T: c}, Right: &Scan{T: o}, LeftKey: 0, RightKey: 1}
	merge = &MergeJoin{Left: &Sort{Child: &Scan{T: c}, Key: 0}, Right: &Sort{Child: &Scan{T: o}, Key: 1}, LeftKey: 0, RightKey: 1}
	n1, n2, n3 := len(Collect(nl)), len(Collect(hash)), len(Collect(merge))
	fmt.Printf("  rows out: nested loop %d, hash %d, merge %d\n\n", n1, n2, n3)
	fmt.Printf("    nested loop : %9d predicate evaluations\n", nl.Comparisons)
	fmt.Printf("    hash        : %9d build rows + %d probes + %d comparisons\n", hash.BuildRows, hash.Probes, hash.Comparisons)
	fmt.Printf("    merge       : %9d comparisons (+ two sorts)\n", merge.Comparisons)
	swapped := &HashJoin{Left: &Scan{T: o}, Right: &Scan{T: c}, LeftKey: 1, RightKey: 0}
	Collect(swapped)
	fmt.Printf("    hash, sides swapped (build on customers): %d build rows + %d probes\n",
		swapped.BuildRows, swapped.Probes)
	fmt.Println("\n  Nested loop does L×R work no matter what. Hash and merge do roughly L+R.")
	fmt.Println("  Same work either way for hash, but the swapped plan keeps a 200-row table in memory")
	fmt.Println("  instead of 5000 — build on the smaller side. Choosing that is the planner's job (lesson 6).")
}

func section(title string) {
	fmt.Printf("\n━━ %s %s\n", title, strings.Repeat("━", max(3, 74-len([]rune(title)))))
}

func printRows(header string, rows []Row) {
	fmt.Println("  " + header)
	for _, r := range rows {
		fmt.Println("  " + FormatRow(r))
	}
}
