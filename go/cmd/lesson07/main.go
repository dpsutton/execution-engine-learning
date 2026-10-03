// Lesson 7 demo: compile a plan to bytecode, run it, pause it, serialize it, resume it.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	. "execengine/lesson07"
)

func main() {
	db := ToyDB()
	plan := Limit{N: 2, Child: Sort{Keys: []SortKey{{E: C("units"), Desc: true}}, Child: Aggregate{
		GroupBy: []Expr{C("customers.name")},
		Aggs:    []AggCall{{Fn: "sum", Arg: C("orders.qty")}},
		Names:   []string{"name", "units"},
		Child: HashJoin{
			Left:    Filter{Child: Scan{Table: "customers"}, Pred: B(">", C("customers.age"), L(30))},
			Right:   Scan{Table: "orders"},
			LeftKey: C("customers.id"), RightKey: C("orders.customer_id")}}}}

	section("The query")
	fmt.Println("  SELECT c.name, sum(o.qty) AS units")
	fmt.Println("  FROM customers c JOIN orders o ON o.customer_id = c.id")
	fmt.Println("  WHERE c.age > 30 GROUP BY c.name ORDER BY units DESC LIMIT 2")
	fmt.Println()
	fmt.Println("  Plan: Limit 2 ← Sort ← Aggregate ← HashJoin(probe: Filter ← Scan customers, build: Scan orders)")

	section("Compiled (like SQLite's EXPLAIN)")
	prog := Compile(plan, db)
	fmt.Print(indent(prog.Listing()))
	fmt.Printf("  %d instructions, %d registers, %d cursors, 1 hash table, 1 aggregate table, 1 sorter.\n",
		len(prog.Instrs), prog.NumRegs, prog.NumCursors)
	fmt.Println("  Read it as four loops in sequence: build the hash table from orders; scan customers and")
	fmt.Println("  probe (the join's matches loop is nested inside); walk the groups into the sorter; walk the")
	fmt.Println("  sorted rows out through ResultRow, with LIMIT's countdown right after it.")

	section("Run to completion")
	vm := NewVM(prog, db)
	want := vm.Run()
	for _, r := range want {
		fmt.Println("  " + FormatRow(r))
	}
	fmt.Printf("  (%d instructions executed)\n", vm.S.Steps)

	section("Run with a fuel budget of 40 instructions")
	vm = NewVM(prog, db)
	row, st := vm.Step(40)
	fmt.Printf("  Step(40) → %v (row: %v).  The VM stopped at %s.\n", st, row != nil, vm)
	fmt.Printf("  Instruction %d is %s — we're partway through probing the customers.\n",
		vm.S.PC, prog.Instrs[vm.S.PC].Op)

	snap, _ := vm.Snapshot()
	var pretty bytes.Buffer
	json.Indent(&pretty, snap, "    ", "  ")
	fmt.Printf("\n  Its entire state, as JSON (%d bytes):\n    %s\n", len(snap), compact(pretty.String()))

	section("Restore into a brand-new VM and finish")
	resumed, err := Restore(prog, db, snap)
	if err != nil {
		panic(err)
	}
	got := resumed.Run()
	for _, r := range got {
		fmt.Println("  " + FormatRow(r))
	}
	fmt.Printf("  Same rows as the uninterrupted run: %v\n", rowsEqual(got, want))

	section("Generated data: slice a 5000-row join into 1999-instruction pieces")
	gdb := GeneratedDB()
	big := Sort{Keys: []SortKey{{E: C("city")}}, Child: Aggregate{
		GroupBy: []Expr{C("customers.city")},
		Aggs:    []AggCall{{Fn: "count"}, {Fn: "sum", Arg: C("orders.qty")}},
		Names:   []string{"city", "orders", "units"},
		Child: HashJoin{Left: Scan{Table: "orders"}, Right: Scan{Table: "customers"},
			LeftKey: C("orders.customer_id"), RightKey: C("customers.id")}}}
	gprog := Compile(big, gdb)
	gwant := NewVM(gprog, gdb).Run()

	fmt.Println("  Every slice: Step(1999), Snapshot() to JSON, throw the VM away, Restore() a new one.")
	fmt.Println()
	fmt.Println("  slice   pc  instructions  snapshot")
	gvm := NewVM(gprog, gdb)
	var rows []Row
	for slice := 1; ; slice++ {
		row, st := gvm.Step(1999)
		if st == StatusRow {
			rows = append(rows, row)
		}
		snap, _ := gvm.Snapshot()
		if slice%5 == 1 || st != StatusOutOfFuel {
			fmt.Printf("  %5d %4d  %12d  %6.1f KB  %s\n", slice, gvm.S.PC, gvm.S.Steps, float64(len(snap))/1024, st)
		}
		if st == StatusDone {
			break
		}
		gvm, _ = Restore(gprog, gdb, snap)
	}
	fmt.Println()
	for _, r := range rows {
		fmt.Println("  " + FormatRow(r))
	}
	fmt.Printf("  Matches the uninterrupted run: %v\n", rowsEqual(rows, gwant))
	fmt.Println("\n  The snapshot is small while scanning (a few cursors and registers) and grows with")
	fmt.Println("  what the pipeline breakers hold: the hash table on customers, then the groups.")
}

func rowsEqual(a, b []Row) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if FormatRow(a[i]) != FormatRow(b[i]) {
			return false
		}
	}
	return true
}

// compact collapses the small arrays of the pretty JSON onto single lines so it fits on screen.
func compact(s string) string {
	var b strings.Builder
	inArray := 0
	for _, line := range strings.Split(s, "\n") {
		t := strings.TrimSpace(line)
		switch {
		case inArray > 0:
			b.WriteString(" " + t)
			if strings.HasPrefix(t, "]") {
				inArray--
				if inArray == 0 {
					b.WriteString("\n")
				}
			} else if strings.HasSuffix(t, "[") {
				inArray++
			}
		case strings.HasSuffix(t, "[") && !strings.Contains(t, "Buckets"):
			b.WriteString(line)
			inArray = 1
		default:
			b.WriteString(line + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func section(title string) {
	fmt.Printf("\n━━ %s %s\n", title, strings.Repeat("━", max(3, 74-len([]rune(title)))))
}

func indent(s string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	return "  " + strings.Join(lines, "\n  ") + "\n"
}
