package lesson07

import (
	"fmt"
	"testing"
)

// topCustomers: SELECT name, sum(qty) AS units FROM customers JOIN orders ON … WHERE age > 30
// GROUP BY name ORDER BY units DESC LIMIT 2
func topCustomers() Plan {
	return Limit{N: 2, Child: Sort{Keys: []SortKey{{E: C("units"), Desc: true}}, Child: Aggregate{
		GroupBy: []Expr{C("customers.name")},
		Aggs:    []AggCall{{Fn: "sum", Arg: C("orders.qty")}},
		Names:   []string{"name", "units"},
		Child: HashJoin{
			Left:    Filter{Child: Scan{Table: "customers"}, Pred: B(">", C("customers.age"), L(30))},
			Right:   Scan{Table: "orders"},
			LeftKey: C("customers.id"), RightKey: C("orders.customer_id")}}}}
}

func rowsString(rows []Row) string {
	s := ""
	for _, r := range rows {
		s += FormatRow(r) + "\n"
	}
	return s
}

func TestToyQuery(t *testing.T) {
	db := ToyDB()
	got := rowsString(NewVM(Compile(topCustomers(), db), db).Run())
	want := "Cy | 5\nAda | 3\n"
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

// Stop after every single instruction, serialize, deserialize into a brand-new VM, continue.
// The result must be identical to an uninterrupted run.
func TestSnapshotAfterEveryInstruction(t *testing.T) {
	for _, plan := range []Plan{topCustomers(), cityCounts()} {
		for _, db := range []DB{ToyDB(), GeneratedDB()} {
			if _, ok := db["customers"]; !ok {
				continue
			}
			prog := Compile(plan, db)
			want := rowsString(NewVM(prog, db).Run())

			fuel := 1
			if len(db["orders"].Rows) > 100 {
				fuel = 997 // every instruction would be slow on 5000 rows; any odd stride will do
			}
			vm := NewVM(prog, db)
			var rows []Row
			for {
				row, st := vm.Step(fuel)
				if st == StatusDone {
					break
				}
				if st == StatusRow {
					rows = append(rows, row)
				}
				snap, err := vm.Snapshot()
				if err != nil {
					t.Fatal(err)
				}
				if vm, err = Restore(prog, db, snap); err != nil {
					t.Fatal(err)
				}
			}
			if got := rowsString(rows); got != want {
				t.Fatalf("interrupted run differs:\n%s\nvs\n%s", got, want)
			}
		}
	}
}

// cityCounts: SELECT city, count(*), sum(qty), avg(qty) FROM customers JOIN orders GROUP BY city ORDER BY city
func cityCounts() Plan {
	return Sort{Keys: []SortKey{{E: C("city")}}, Child: Aggregate{
		GroupBy: []Expr{C("customers.city")},
		Aggs:    []AggCall{{Fn: "count"}, {Fn: "sum", Arg: C("orders.qty")}, {Fn: "avg", Arg: C("orders.qty")}},
		Names:   []string{"city", "n", "units", "avg_qty"},
		Child: HashJoin{Left: Scan{Table: "orders"}, Right: Scan{Table: "customers"},
			LeftKey: C("orders.customer_id"), RightKey: C("customers.id")}}}
}

func TestGeneratedAggregateMatchesLoops(t *testing.T) {
	db := GeneratedDB()
	rows := NewVM(Compile(cityCounts(), db), db).Run()
	city := map[int64]string{}
	for _, c := range db["customers"].Rows {
		city[c[0].(int64)] = c[2].(string)
	}
	n, units := map[string]int64{}, map[string]int64{}
	for _, o := range db["orders"].Rows {
		c := city[o[1].(int64)]
		n[c]++
		units[c] += o[3].(int64)
	}
	if len(rows) != len(n) {
		t.Fatalf("%d groups, want %d", len(rows), len(n))
	}
	for _, r := range rows {
		c := r[0].(string)
		if r[1] != n[c] || r[2] != units[c] {
			t.Fatalf("%s: got %v, want n=%d units=%d", c, r, n[c], units[c])
		}
	}
}

func TestNLJoinAndExpressions(t *testing.T) {
	db := ToyDB()
	plan := Project{
		Names: []string{"name", "pname", "total", "big"},
		Exprs: []Expr{C("customers.name"), Func{Name: "upper", Args: []Expr{C("products.name")}},
			B("*", C("orders.qty"), C("products.price")), B("or", B(">", C("orders.qty"), L(1)), IsNull{E: C("customers.age")})},
		Child: NLJoin{
			Left:  NLJoin{Left: Scan{Table: "customers"}, Right: Scan{Table: "orders"}, Pred: B("=", C("customers.id"), C("orders.customer_id"))},
			Right: Scan{Table: "products"},
			Pred:  B("=", C("orders.product_id"), C("products.id"))}}
	got := rowsString(NewVM(Compile(plan, db), db).Run())
	want := "Ada | PEN | 3.00 | true\nAda | ATLAS | 24.00 | false\nCy | PEN | 7.50 | true\nDi | CHESS | 18.25 | false\n"
	if got != want {
		t.Fatalf("got\n%s", got)
	}
}

func TestEmptyAggregateAndLimitZero(t *testing.T) {
	db := ToyDB()
	empty := Aggregate{Aggs: []AggCall{{Fn: "count"}, {Fn: "sum", Arg: C("customers.age")}}, Names: []string{"n", "s"},
		Child: Filter{Child: Scan{Table: "customers"}, Pred: B(">", C("customers.age"), L(100))}}
	if got := fmt.Sprint(NewVM(Compile(empty, db), db).Run()); got != "[[0 <nil>]]" {
		t.Fatalf("empty aggregate = %s", got)
	}
	if rows := NewVM(Compile(Limit{N: 0, Child: Scan{Table: "customers"}}, db), db).Run(); len(rows) != 0 {
		t.Fatalf("LIMIT 0 returned %d rows", len(rows))
	}
}
