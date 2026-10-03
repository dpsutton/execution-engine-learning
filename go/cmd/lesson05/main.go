// Lesson 5 demo: build B+trees, watch them split, and count how much of a table an index saves.
package main

import (
	"fmt"
	"strings"

	. "execengine/lesson05"
)

func main() {
	section("An index on orders.customer_id (toy, order 3)")
	fmt.Println("  orders: (10,cust 1) (11,cust 1) (12,cust 3) (13,cust 4) (14,cust 9)")
	fmt.Println("  Leaves map key → row ids (positions in the table). Order 3 = at most 2 keys per node.")
	fmt.Println()
	fmt.Print(indent(BuildIndex(ToyOrders, 1, 3).String()))

	section("Watching splits: inserting 1..12 into an order-4 tree")
	tree := NewBPlusTree(4)
	for k := 1; k <= 12; k++ {
		tree.Insert(int64(k), k)
		if k == 3 || k == 4 || k == 7 || k == 12 {
			fmt.Printf("\n  after inserting %d (height %d):\n", k, tree.Height())
			fmt.Print(indent(tree.String()))
		}
	}
	fmt.Println("\n  Leaf splits copy the first key of the new leaf up; internal splits move the middle key up.")
	fmt.Println("  The root splitting is the only way the tree grows taller.")

	section("WHERE customer_id = 7 on 5000 generated orders")
	customers, _, orders := Generate()
	idx := BuildIndex(orders, 1, 32)
	scan := &Scan{T: orders}
	full := Collect(&Filter{Child: scan, Pred: func(r Row) bool { return r[1] == int64(7) }})
	before := idx.NodeVisits
	is := &IndexScan{T: orders, Index: idx, Eq: int64(7)}
	Collect(is)
	fmt.Printf("  full scan : read %d rows to find %d\n", scan.RowsRead, len(full))
	fmt.Printf("  index scan: visited %d tree nodes (height %d), fetched %d rows\n",
		idx.NodeVisits-before, idx.Height(), is.RowsFetched)

	section("Range: WHERE day BETWEEN 100 AND 102")
	dayIdx := BuildIndex(orders, 4, 32)
	before = dayIdx.NodeVisits
	rs := &IndexScan{T: orders, Index: dayIdx, Lo: &Bound{Key: int64(100), Inclusive: true}, Hi: &Bound{Key: int64(102), Inclusive: true}}
	rows := Collect(rs)
	fmt.Printf("  %d rows; %d node visits (one descent, then along the leaf chain)\n", len(rows), dayIdx.NodeVisits-before)
	for _, r := range rows[:4] {
		fmt.Println("    " + FormatRow(r))
	}
	fmt.Println("    …  (in key order — an index scan is also a free ORDER BY day)")

	section("Index nested-loop join: Seattle customers ⋈ orders")
	seattle := &Filter{Child: &Scan{T: customers}, Pred: func(r Row) bool { return r[2] == "Seattle" }}
	before = idx.NodeVisits
	j := &IndexNLJoin{Outer: seattle, OuterKey: 0, Inner: orders, Index: idx}
	joined := Collect(j)
	fmt.Printf("  %d Seattle customers → %d index lookups, %d node visits, %d rows out\n",
		j.Lookups, j.Lookups, idx.NodeVisits-before, len(joined))
	fmt.Printf("  A hash join would read all %d orders to build its table; a plain nested loop would\n", len(orders.Rows))
	fmt.Printf("  compare %d × %d pairs. Small outer side + indexed inner side = index NL join wins.\n", j.Lookups, len(orders.Rows))
}

func section(title string) {
	fmt.Printf("\n━━ %s %s\n", title, strings.Repeat("━", max(3, 74-len([]rune(title)))))
}

func indent(s string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	return "    " + strings.Join(lines, "\n    ") + "\n"
}
