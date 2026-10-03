package engine

import (
	"fmt"
	"sort"
	"strconv"
)

// Table is a heap of rows plus whatever indexes and statistics we've built on it.
type Table struct {
	Name    string
	Columns []string
	Rows    [][]Value
	Indexes map[string]*BTree // column name → index
	Stats   *TableStats
}

// ColIndex returns the position of a column, or -1.
func (t *Table) ColIndex(name string) int {
	for i, c := range t.Columns {
		if c == name {
			return i
		}
	}
	return -1
}

// CreateIndex builds a B+tree over one column, mapping value → row ids. NULLs are not indexed.
func (t *Table) CreateIndex(col string, order int) {
	ci := t.ColIndex(col)
	if ci < 0 {
		panic("no column " + col)
	}
	tree := NewBTree(order)
	for id, row := range t.Rows {
		if row[ci] != nil {
			tree.Insert(row[ci], id)
		}
	}
	if t.Indexes == nil {
		t.Indexes = map[string]*BTree{}
	}
	t.Indexes[col] = tree
}

// DB is a set of named tables.
type DB struct {
	Tables map[string]*Table
	Order  []string // creation order, for stable listings
}

func NewDB() *DB { return &DB{Tables: map[string]*Table{}} }

func (db *DB) Add(t *Table) {
	db.Tables[t.Name] = t
	db.Order = append(db.Order, t.Name)
}

// Table looks up a table or panics with an EvalError.
func (db *DB) Table(name string) *Table {
	t, ok := db.Tables[name]
	if !ok {
		fail("no such table %s", name)
	}
	return t
}

// Analyze (re)computes statistics for every table.
func (db *DB) Analyze() {
	for _, name := range db.Order {
		t := db.Tables[name]
		t.Stats = Analyze(t)
	}
}

// IndexNames lists "table.col" for every index, sorted.
func (db *DB) IndexNames() []string {
	var out []string
	for _, name := range db.Order {
		for col := range db.Tables[name].Indexes {
			out = append(out, name+"."+col)
		}
	}
	sort.Strings(out)
	return out
}

// LCG is the 64-bit linear congruential generator from DESIGN.md. The Clojure engine implements the
// same recurrence, so both generate bit-identical datasets.
type LCG struct{ state uint64 }

func NewLCG(seed uint64) *LCG { return &LCG{state: seed} }

func (r *LCG) Next() uint64 {
	r.state = r.state*6364136223846793005 + 1442695040888963407 // wraps mod 2^64
	return r.state >> 33
}

func (r *LCG) Intn(n int) int64 { return int64(r.Next() % uint64(n)) }

var (
	cities     = []string{"Austin", "Boston", "Chicago", "Denver", "Miami", "Oakland", "Portland", "Seattle"}
	categories = []string{"books", "games", "garden", "music", "tools"}
)

// IndexOrder is the B+tree order (max children per node) for the generated dataset.
const IndexOrder = 32

// Generate builds the synthetic dataset from DESIGN.md: 200 customers, 50 products, 5000 orders,
// with skew (40% of customers in Austin; half of all orders from customers 1–20) so statistics
// have something to say. It also builds the indexes and runs Analyze.
func Generate(seed uint64) *DB {
	r := NewLCG(seed)
	db := NewDB()

	customers := &Table{Name: "customers", Columns: []string{"id", "name", "city", "age"}}
	for id := int64(1); id <= 200; id++ {
		name := "cust" + strconv.FormatInt(id, 10)
		x := r.Intn(100)
		var city string
		switch {
		case x < 40:
			city = cities[0]
		case x < 60:
			city = cities[1]
		case x < 72:
			city = cities[2]
		default:
			city = cities[3+r.Intn(5)]
		}
		var age Value = 18 + r.Intn(60) // drawn even when we then NULL it out
		if id%17 == 0 {
			age = nil
		}
		customers.Rows = append(customers.Rows, []Value{id, name, city, age})
	}

	products := &Table{Name: "products", Columns: []string{"id", "name", "category", "price"}}
	for id := int64(1); id <= 50; id++ {
		name := "prod" + strconv.FormatInt(id, 10)
		category := categories[r.Intn(5)]
		price := float64(100+r.Intn(9900)) / 100.0
		products.Rows = append(products.Rows, []Value{id, name, category, price})
	}

	orders := &Table{Name: "orders", Columns: []string{"id", "customer_id", "product_id", "qty", "day"}}
	for id := int64(1); id <= 5000; id++ {
		var customerID int64
		if r.Intn(100) < 50 {
			customerID = 1 + r.Intn(20)
		} else {
			customerID = 1 + r.Intn(200)
		}
		productID := 1 + r.Intn(50)
		qty := 1 + r.Intn(5)
		day := 1 + r.Intn(365)
		orders.Rows = append(orders.Rows, []Value{id, customerID, productID, qty, day})
	}

	db.Add(customers)
	db.Add(products)
	db.Add(orders)

	customers.CreateIndex("id", IndexOrder)
	products.CreateIndex("id", IndexOrder)
	orders.CreateIndex("id", IndexOrder)
	orders.CreateIndex("customer_id", IndexOrder)
	orders.CreateIndex("product_id", IndexOrder)

	db.Analyze()
	return db
}

// Describe gives a one-line summary of the database, for the REPL banner.
func (db *DB) Describe() string {
	s := ""
	for i, name := range db.Order {
		if i > 0 {
			s += ", "
		}
		s += fmt.Sprintf("%s (%d rows)", name, len(db.Tables[name].Rows))
	}
	return s
}
