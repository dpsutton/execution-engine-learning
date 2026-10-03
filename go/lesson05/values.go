package lesson05

// Copied (compact) from earlier lessons so this lesson stands alone.

import (
	"fmt"
	"strings"
)

type Value = any
type Row = []Value

func Format(v Value) string {
	switch v := v.(type) {
	case nil:
		return "NULL"
	case float64:
		return fmt.Sprintf("%.2f", v)
	}
	return fmt.Sprint(v)
}

func FormatRow(r Row) string {
	parts := make([]string, len(r))
	for i, v := range r {
		parts[i] = Format(v)
	}
	return strings.Join(parts, " | ")
}

// Compare orders two non-NULL values: -1, 0, 1.
func Compare(a, b Value) int {
	switch x := a.(type) {
	case int64:
		if y, ok := b.(int64); ok {
			return cmp3(x < y, x > y)
		}
		return cmpF(float64(x), toFloat(b))
	case float64:
		return cmpF(x, toFloat(b))
	case string:
		y := b.(string)
		return cmp3(x < y, x > y)
	case bool:
		y := b.(bool)
		return cmp3(!x && y, x && !y)
	}
	panic(fmt.Sprintf("cannot compare %v and %v", a, b))
}

func toFloat(v Value) float64 {
	if i, ok := v.(int64); ok {
		return float64(i)
	}
	return v.(float64)
}
func cmpF(a, b float64) int { return cmp3(a < b, a > b) }
func cmp3(less, greater bool) int {
	if less {
		return -1
	}
	if greater {
		return 1
	}
	return 0
}

type Operator interface {
	Open()
	Next() (Row, bool)
	Close()
	Schema() []string
}

// Scan reads every row of a table, in storage order.
type Scan struct {
	T        *Table
	pos      int
	RowsRead int
}

func (s *Scan) Open()            { s.pos = 0 }
func (s *Scan) Close()           {}
func (s *Scan) Schema() []string { return s.T.Cols }
func (s *Scan) Next() (Row, bool) {
	if s.pos >= len(s.T.Rows) {
		return nil, false
	}
	s.pos++
	s.RowsRead++
	return s.T.Rows[s.pos-1], true
}

// Filter keeps rows where Pred is true.
type Filter struct {
	Child Operator
	Pred  func(Row) bool
}

func (f *Filter) Open()            { f.Child.Open() }
func (f *Filter) Close()           { f.Child.Close() }
func (f *Filter) Schema() []string { return f.Child.Schema() }
func (f *Filter) Next() (Row, bool) {
	for {
		r, ok := f.Child.Next()
		if !ok || f.Pred(r) {
			return r, ok
		}
	}
}

func Collect(op Operator) []Row {
	op.Open()
	defer op.Close()
	var out []Row
	for {
		r, ok := op.Next()
		if !ok {
			return out
		}
		out = append(out, r)
	}
}

var ToyOrders = &Table{Name: "orders",
	Cols: []string{"orders.id", "orders.customer_id", "orders.product_id", "orders.qty"},
	Rows: []Row{
		{int64(10), int64(1), int64(100), int64(2)},
		{int64(11), int64(1), int64(101), int64(1)},
		{int64(12), int64(3), int64(100), int64(5)},
		{int64(13), int64(4), int64(102), int64(1)},
		{int64(14), int64(9), int64(101), int64(3)},
	}}
