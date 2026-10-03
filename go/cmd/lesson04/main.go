// Lesson 4 demo: grouping two ways, sorting three ways.
package main

import (
	"fmt"
	"strings"

	. "execengine/lesson04"
)

func main() {
	section("SELECT customer_id, count(*), sum(qty) FROM orders GROUP BY customer_id  (toy)")
	aggs := []AggSpec{{Fn: "count", Col: -1}, {Fn: "sum", Col: 3}}
	names := []string{"customer_id", "count", "sum_qty"}
	hash := &HashAggregate{Child: &Scan{T: ToyOrders}, GroupBy: []int{1}, Aggs: aggs, Names: names}
	printRows(names, Collect(hash))
	fmt.Println("\n  HashAggregate: groups come out in first-seen order; all of them were in memory at the end.")

	section("Same query with SortAggregate (input sorted on customer_id first)")
	sorted := &SortAggregate{Child: &Sort{Child: &Scan{T: ToyOrders}, Keys: []SortKey{{Col: 1}}},
		GroupBy: []int{1}, Aggs: aggs, Names: names}
	printRows(names, Collect(sorted))

	section("Memory: GROUP BY day over 5000 generated orders")
	_, _, orders := Generate()
	byDay := []AggSpec{{Fn: "count", Col: -1}, {Fn: "sum", Col: 3}}
	h := &HashAggregate{Child: &Scan{T: orders}, GroupBy: []int{4}, Aggs: byDay}
	s := &SortAggregate{Child: &Sort{Child: &Scan{T: orders}, Keys: []SortKey{{Col: 4}}}, GroupBy: []int{4}, Aggs: byDay}
	nh, ns := len(Collect(h)), len(Collect(s))
	fmt.Printf("  HashAggregate: %d groups out, %d accumulators held at once\n", nh, h.MaxGroups)
	fmt.Printf("  SortAggregate: %d groups out, %d accumulator held at once (but someone had to sort)\n", ns, s.MaxGroups)

	section("External merge sort: ORDER BY day DESC, qty with room for 500 rows")
	keys := []SortKey{{Col: 4, Desc: true}, {Col: 3}}
	ext := &ExternalSort{Child: &Scan{T: orders}, Keys: keys, RunSize: 500}
	rows := Collect(ext)
	fmt.Printf("  Phase 1: %d rows → %d sorted runs of ≤500 rows each (\"spilled to disk\")\n", len(rows), ext.Runs)
	fmt.Printf("  Phase 2: one %d-way merge; heap holds %d rows; %d heap comparisons\n", ext.Runs, ext.Runs, ext.MergeComparisons)
	fmt.Println("  first 3 rows:")
	for _, r := range rows[:3] {
		fmt.Println("    " + FormatRow(r))
	}

	section("Top-N: ORDER BY qty DESC, day LIMIT 5")
	top := &TopN{Child: &Scan{T: orders}, Keys: []SortKey{{Col: 3, Desc: true}, {Col: 4}}, N: 5}
	printRows([]string{"id", "customer_id", "product_id", "qty", "day"}, Collect(top))
	fmt.Printf("\n  Never held more than 5 rows; %d times a better row displaced the worst one kept.\n", top.Evictions)
	fmt.Println("  A full sort would have ordered all 5000 to throw away 4995.")
}

func section(title string) {
	fmt.Printf("\n━━ %s %s\n", title, strings.Repeat("━", max(3, 74-len([]rune(title)))))
}

func printRows(names []string, rows []Row) {
	fmt.Println("  " + strings.Join(names, " | "))
	for _, r := range rows {
		fmt.Println("  " + FormatRow(r))
	}
}
