package engine

import (
	"flag"
	"math/rand"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/golden.out")

const goldenSQL = "../../queries/golden.sql"
const goldenOut = "testdata/golden.out"

var shared = New()

// Every golden query must produce identical output on both executors, and match the checked-in
// expected output (which the Clojure engine must also match byte for byte).
func TestGolden(t *testing.T) {
	queries, err := ReadGolden(goldenSQL)
	if err != nil {
		t.Fatal(err)
	}
	volcano, err := shared.Golden(queries, false)
	if err != nil {
		t.Fatal(err)
	}
	vm, err := shared.Golden(queries, true)
	if err != nil {
		t.Fatal(err)
	}
	if volcano != vm {
		t.Fatalf("volcano and VM disagree:\n--- volcano\n%s\n--- vm\n%s", volcano, vm)
	}
	if *update {
		if err := os.WriteFile(goldenOut, []byte(volcano), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(goldenOut)
	if err != nil {
		t.Fatalf("%v (run go test ./engine -update to create it)", err)
	}
	if string(want) != volcano {
		t.Fatalf("golden output changed; diff against %s (rerun with -update if intended)", goldenOut)
	}
}

// Running the VM a few instructions at a time, snapshotting to JSON and restoring into a brand new
// VM after every Step, must give exactly the same rows as an uninterrupted run.
func TestSnapshotRestore(t *testing.T) {
	queries, err := ReadGolden(goldenSQL)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range queries {
		p, err := shared.Prepare(q)
		if err != nil {
			t.Fatal(err)
		}
		prog, err := p.Program()
		if err != nil {
			t.Fatal(err)
		}
		want, err := RunVM(prog, shared.DB)
		if err != nil {
			t.Fatal(err)
		}

		var got [][]Value
		vm := NewVM(prog, shared.DB)
		for steps := 0; ; steps++ {
			row, st, err := vm.Step(97)
			if err != nil {
				t.Fatal(err)
			}
			if st == StatusRow {
				got = append(got, row)
			}
			if st == StatusDone {
				break
			}
			snap, err := vm.Snapshot()
			if err != nil {
				t.Fatal(err)
			}
			if vm, err = RestoreVM(prog, shared.DB, snap); err != nil {
				t.Fatal(err)
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: resumed run differs\n got %v\nwant %v", q, got, want)
		}
	}
}

func TestQueryErrors(t *testing.T) {
	cases := map[string]string{
		"SELECT nope FROM customers":                                 "unknown column nope",
		"SELECT id FROM customers c, orders o":                       "ambiguous",
		"SELECT name, count(*) FROM customers":                       "must appear in GROUP BY",
		"SELECT id FROM nowhere":                                     "no such table",
		"SELECT id FROM customers WHERE count(*) > 1":                "not allowed in WHERE",
		"SELECT id FROM customers c JOIN customers c ON c.id = c.id": "used twice",
		"SELECT x.id FROM customers c":                               "unknown table or alias x",
		"SELECT id FROM customers WHERE name > 3":                    "cannot compare",
		"SELECT sum(name) FROM customers":                            "cannot apply +",
	}
	for sql, want := range cases {
		_, err := shared.Query(sql, false)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got error %v, want one containing %q", sql, err, want)
		}
	}
}

func TestSemantics(t *testing.T) {
	cases := []struct{ sql, want string }{
		{"SELECT 7 / 2, 7 - 2 * 3, 1 / 0 FROM products LIMIT 1", "3.50 | 1 | NULL"},
		{"SELECT NULL = NULL, NULL OR true, NULL AND false, NOT NULL FROM products LIMIT 1", "NULL | true | false | NULL"},
		{"SELECT count(*), sum(age), avg(age) FROM customers WHERE id > 1000", "0 | NULL | NULL"},
		{"SELECT lower('AbC'), length('héllo'), abs(-3), coalesce(NULL, NULL, 2) FROM products LIMIT 1", "abc | 5 | 3 | 2"},
		{"SELECT id FROM customers WHERE age IS NULL ORDER BY id LIMIT 2", "17"},
		{"SELECT age FROM customers ORDER BY age DESC LIMIT 1", "76"},
		{"SELECT count(*) FROM customers c, orders o WHERE o.customer_id = c.id", "5000"},
	}
	for _, vm := range []bool{false, true} {
		for _, c := range cases {
			res, err := shared.Query(c.sql, vm)
			if err != nil {
				t.Fatalf("%s: %v", c.sql, err)
			}
			lines := strings.Split(res.Canonical(), "\n")
			if lines[1] != c.want {
				t.Errorf("vm=%v %s: got %q, want %q", vm, c.sql, lines[1], c.want)
			}
		}
	}
}

// The generator is part of the cross-language contract; pin a few values.
func TestGeneratedData(t *testing.T) {
	db := shared.DB
	c := db.Tables["customers"]
	if got := c.Rows[0]; !reflect.DeepEqual(got, []Value{int64(1), "cust1", "Austin", int64(44)}) {
		t.Errorf("customers[0] = %v", got)
	}
	if got := c.Rows[16][3]; got != nil { // id 17 → NULL age
		t.Errorf("customer 17 age = %v, want NULL", got)
	}
	o := db.Tables["orders"]
	if len(o.Rows) != 5000 || len(db.Tables["products"].Rows) != 50 || len(c.Rows) != 200 {
		t.Fatal("wrong table sizes")
	}
	r := NewLCG(42)
	if a, b := r.Next(), r.Next(); a != 1220265334 || b != 484179026 {
		t.Errorf("LCG(42) first draws = %d, %d", a, b)
	}
}

func TestStats(t *testing.T) {
	db := shared.DB
	cs := db.Tables["customers"].Stats
	if cs.Rows != 200 || cs.Cols["age"].Nulls != 11 || cs.Cols["id"].NDV != 200 {
		t.Errorf("customers stats: %+v %+v", cs.Cols["age"], cs.Cols["id"])
	}
	if ndv := cs.Cols["city"].NDV; ndv < 2 || ndv > 8 {
		t.Errorf("city ndv = %d", ndv)
	}
	for _, name := range db.Order {
		tbl := db.Tables[name]
		for col, s := range tbl.Stats.Cols {
			total := 0
			for _, b := range s.Hist {
				total += b.Count
			}
			if total != s.Rows-s.Nulls || len(s.Hist) != HistBuckets {
				t.Errorf("%s.%s histogram: %d buckets totalling %d, want %d over %d", name, col, len(s.Hist), total, HistBuckets, s.Rows-s.Nulls)
			}
		}
	}
	// A range estimate on a uniform column should be close to the truth.
	sel := db.Tables["orders"].Stats.Cols["day"].RangeSel("<=", int64(100))
	if sel < 0.24 || sel > 0.31 {
		t.Errorf("sel(day <= 100) = %.3f, want ≈ 0.27", sel)
	}
}

func TestPlannerChoices(t *testing.T) {
	cases := map[string]string{
		"SELECT * FROM orders WHERE customer_id = 7":                                     "IndexScan orders USING orders(customer_id)",
		"SELECT * FROM customers WHERE id <= 5":                                          "IndexScan customers USING customers(id) WHERE id <= 5",
		"SELECT * FROM orders WHERE qty = 3":                                             "Scan orders",
		"SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.id = 3": "IndexNestedLoopJoin",
		"SELECT * FROM orders o, products p WHERE o.product_id = p.id":                   "IndexNestedLoopJoin orders AS o USING orders(product_id)",
		"SELECT * FROM customers c, orders o WHERE o.qty = c.id":                         "HashJoin",
	}
	for sql, want := range cases {
		p, err := shared.Prepare(sql)
		if err != nil {
			t.Fatal(err)
		}
		if plan := Explain(p.Plan); !strings.Contains(plan, want) {
			t.Errorf("%s: plan lacks %q:\n%s", sql, want, plan)
		}
	}
}

func TestBTree(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	tree := NewBTree(4)
	truth := map[int64][]int{}
	for id := range 2000 {
		k := int64(rng.Intn(300))
		tree.Insert(k, id)
		truth[k] = append(truth[k], id)
	}
	for k := int64(-1); k <= 301; k++ {
		if got := tree.Search(k); !reflect.DeepEqual(got, truth[k]) {
			t.Fatalf("Search(%d) = %v, want %v", k, got, truth[k])
		}
	}
	var want []int
	for k := int64(50); k < 120; k++ {
		want = append(want, truth[k]...)
	}
	if got := tree.Range(int64(50), int64(120), true, false); !reflect.DeepEqual(got, want) {
		t.Fatalf("Range [50,120) wrong: %d ids, want %d", len(got), len(want))
	}
	all := tree.Range(nil, nil, false, false)
	sort.Ints(all)
	if len(all) != 2000 || all[0] != 0 || all[1999] != 1999 {
		t.Fatal("full range scan lost rows")
	}
	if tree.Height < 4 {
		t.Errorf("order-4 tree over 300 keys should be deep, got height %d", tree.Height)
	}
}
