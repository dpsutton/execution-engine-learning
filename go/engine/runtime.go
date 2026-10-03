package engine

import "sort"

// Runtime data structures shared by both executors: the hash table behind hash joins, the sorter,
// and the aggregation table. They're plain data (exported fields, Vals for values) so the VM can
// snapshot them to JSON mid-query and pick up again later.

// ---------------------------------------------------------------- hash table (joins)

// HashTable maps a join key to the rows inserted with it, and remembers an in-progress lookup
// (Cur/Pos) so the VM can iterate matches one instruction at a time.
type HashTable struct {
	Rows    []Vals           `json:"rows"`
	Buckets map[string][]int `json:"buckets"`
	Cur     []int            `json:"cur,omitempty"` // row indexes matching the last Seek
	Pos     int              `json:"pos"`
}

func NewHashTable() *HashTable { return &HashTable{Buckets: map[string][]int{}} }

// Insert adds a row under key. NULL keys are dropped: they can never match.
func (h *HashTable) Insert(key Value, row []Value) {
	if key == nil {
		return
	}
	k := HashKey(key)
	h.Buckets[k] = append(h.Buckets[k], len(h.Rows))
	h.Rows = append(h.Rows, append(Vals(nil), row...))
}

// Seek positions on the first row matching key; false if there is none.
func (h *HashTable) Seek(key Value) bool {
	h.Cur, h.Pos = nil, 0
	if key == nil {
		return false
	}
	h.Cur = h.Buckets[HashKey(key)]
	return len(h.Cur) > 0
}

// Advance moves to the next match; false when exhausted.
func (h *HashTable) Advance() bool {
	h.Pos++
	return h.Pos < len(h.Cur)
}

func (h *HashTable) Current() Vals { return h.Rows[h.Cur[h.Pos]] }

// ---------------------------------------------------------------- sorter

// Sorter collects rows, sorts them by Keys, and then hands them back in order.
type Sorter struct {
	Keys []SortKey `json:"keys"`
	Rows []Vals    `json:"rows"`
	Pos  int       `json:"pos"`
}

func (s *Sorter) Insert(row []Value) { s.Rows = append(s.Rows, append(Vals(nil), row...)) }

func (s *Sorter) Sort() {
	sort.SliceStable(s.Rows, func(i, j int) bool { return compareRows(s.Rows[i], s.Rows[j], s.Keys) < 0 })
	s.Pos = 0
}

// compareRows orders rows by the sort keys. NULLs sort last in both directions.
func compareRows(a, b []Value, keys []SortKey) int {
	for _, k := range keys {
		x, y := a[k.Idx], b[k.Idx]
		var c int
		switch {
		case x == nil && y == nil:
			c = 0
		case x == nil:
			return 1
		case y == nil:
			return -1
		default:
			c = Compare(x, y)
			if k.Desc {
				c = -c
			}
		}
		if c != 0 {
			return c
		}
	}
	return 0
}

// ---------------------------------------------------------------- aggregation

// AggSpec describes the aggregates an AggTable computes.
type AggSpec struct {
	NKeys int     `json:"nkeys"`
	Fns   []AggFn `json:"fns"`
}

type AggFn struct {
	Fn   string `json:"fn"`
	Star bool   `json:"star,omitempty"`
}

// AggTable is a hash aggregate's state: one entry per group, in first-seen order, each holding the
// group's key values and one small accumulator per aggregate.
type AggTable struct {
	Spec   AggSpec        `json:"spec"`
	Index  map[string]int `json:"index"` // HashKey(group key) → group number
	Keys   []Vals         `json:"keys"`
	Accs   [][]Vals       `json:"accs"`
	Pos    int            `json:"pos"`
	Closed bool           `json:"closed"`
}

func NewAggTable(spec AggSpec) *AggTable { return &AggTable{Spec: spec, Index: map[string]int{}} }

// Step folds one input row (its group key and each aggregate's argument) into the table.
func (t *AggTable) Step(keys, args []Value) {
	k := HashKey(keys...)
	g, ok := t.Index[k]
	if !ok {
		g = t.newGroup(keys)
		t.Index[k] = g
	}
	for i, fn := range t.Spec.Fns {
		accStep(fn, t.Accs[g][i], args[i])
	}
}

func (t *AggTable) newGroup(keys []Value) int {
	accs := make([]Vals, len(t.Spec.Fns))
	for i, fn := range t.Spec.Fns {
		accs[i] = accInit(fn)
	}
	t.Keys = append(t.Keys, append(Vals(nil), keys...))
	t.Accs = append(t.Accs, accs)
	return len(t.Keys) - 1
}

// Finish ends input. With no GROUP BY, an empty input still produces one row (count(*) = 0).
func (t *AggTable) Finish() {
	if !t.Closed && t.Spec.NKeys == 0 && len(t.Keys) == 0 {
		t.newGroup(nil)
	}
	t.Closed, t.Pos = true, 0
}

// Row returns group g as an output row: key values, then finalized aggregates.
func (t *AggTable) Row(g int) []Value {
	out := append([]Value(nil), t.Keys[g]...)
	for i, fn := range t.Spec.Fns {
		out = append(out, accFinal(fn, t.Accs[g][i]))
	}
	return out
}

// Accumulators are tiny Vals so they serialize like everything else:
//
//	count: [n]   sum: [total or NULL]   min/max: [best or NULL]   avg: [float sum, n]
func accInit(fn AggFn) Vals {
	switch fn.Fn {
	case "count":
		return Vals{int64(0)}
	case "avg":
		return Vals{float64(0), int64(0)}
	}
	return Vals{nil}
}

func accStep(fn AggFn, st Vals, v Value) {
	if v == nil && !fn.Star {
		return // aggregates skip NULLs
	}
	switch fn.Fn {
	case "count":
		st[0] = st[0].(int64) + 1
	case "sum":
		if st[0] == nil {
			st[0] = v
		} else {
			st[0] = Arith("+", st[0], v)
		}
	case "min":
		if st[0] == nil || Compare(v, st[0]) < 0 {
			st[0] = v
		}
	case "max":
		if st[0] == nil || Compare(v, st[0]) > 0 {
			st[0] = v
		}
	case "avg":
		f, ok := toFloat(v)
		if !ok {
			fail("avg expects numbers, got %s", kindOf(v))
		}
		st[0] = st[0].(float64) + f
		st[1] = st[1].(int64) + 1
	default:
		fail("unknown aggregate %s", fn.Fn)
	}
}

func accFinal(fn AggFn, st Vals) Value {
	if fn.Fn == "avg" {
		if st[1].(int64) == 0 {
			return nil
		}
		return st[0].(float64) / float64(st[1].(int64))
	}
	return st[0]
}

func aggSpecFor(keys int, aggs []Agg) AggSpec {
	spec := AggSpec{NKeys: keys}
	for _, a := range aggs {
		spec.Fns = append(spec.Fns, AggFn{Fn: a.Fn, Star: a.Star})
	}
	return spec
}
