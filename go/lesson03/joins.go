// Package lesson03 is part 3: joins. Three algorithms that produce the same rows at very
// different costs.
//
//   - NLJoin: for each left row, scan all of the right. Works for any condition. O(L·R).
//   - HashJoin: build a hash table on the right's key, probe it with each left row. Equality only.
//     O(L+R) plus memory for the table.
//   - MergeJoin: both inputs sorted on the key; walk them in step like merging two sorted lists.
//     Equality (or range) only. O(L+R) after sorting.
//
// Each join counts its work so the demo can compare them.
package lesson03

// JoinKind selects inner or left outer.
type JoinKind int

const (
	Inner JoinKind = iota
	LeftOuter
)

func concat(l, r Row) Row {
	out := make(Row, 0, len(l)+len(r))
	return append(append(out, l...), r...)
}

func nulls(n int) Row { return make(Row, n) } // a row of n NULLs, for outer-join padding

// ---------------------------------------------------------------------------------------------
// Nested loop join
// ---------------------------------------------------------------------------------------------

// NLJoin: outer = Left, inner = Right. The inner side is rewound (Close + Open) for every outer
// row. Pred sees the concatenated row (left columns, then right columns).
type NLJoin struct {
	Left, Right Operator
	Pred        func(Row) bool
	Kind        JoinKind

	Comparisons int // predicate evaluations

	cur     Row  // current outer row
	matched bool // did cur match anything yet? (for LEFT OUTER)
}

func (j *NLJoin) Schema() []string {
	return append(append([]string{}, j.Left.Schema()...), j.Right.Schema()...)
}
func (j *NLJoin) Open()  { j.Left.Open(); j.cur = nil }
func (j *NLJoin) Close() { j.Left.Close(); j.Right.Close() }

func (j *NLJoin) Next() (Row, bool) {
	// EXERCISE(nl-join-next): For each outer row, rewind and walk the whole inner side, emitting concatenated rows that
	// pass Pred; for LEFT OUTER, emit the outer row padded with NULLs if nothing matched.
	for {
		if j.cur == nil { // need a new outer row
			l, ok := j.Left.Next()
			if !ok {
				return nil, false
			}
			j.cur, j.matched = l, false
			j.Right.Close()
			j.Right.Open() // rewind the inner side
		}
		r, ok := j.Right.Next()
		if !ok { // inner exhausted for this outer row
			l := j.cur
			j.cur = nil
			if j.Kind == LeftOuter && !j.matched {
				return concat(l, nulls(len(j.Right.Schema()))), true
			}
			continue
		}
		j.Comparisons++
		row := concat(j.cur, r)
		if j.Pred(row) {
			j.matched = true
			return row, true
		}
	}
	// END EXERCISE
}

// ---------------------------------------------------------------------------------------------
// Hash join
// ---------------------------------------------------------------------------------------------

// HashJoin: build = Right, probe = Left (DESIGN.md). Open reads the whole right side into a hash
// table keyed on RightKey; Next streams the left side and looks each row's LeftKey up.
// Output order: probe order, and for each probe row its matches in build insertion order.
type HashJoin struct {
	Left, Right       Operator
	LeftKey, RightKey int // column indexes of the equi-join keys
	Kind              JoinKind

	BuildRows   int // rows inserted into the hash table
	Probes      int // hash lookups
	Comparisons int // key comparisons inside matching buckets

	table   map[string][]Row
	cur     Row
	matches []Row
}

func (j *HashJoin) Schema() []string {
	return append(append([]string{}, j.Left.Schema()...), j.Right.Schema()...)
}
func (j *HashJoin) Close() { j.Left.Close(); j.table = nil }

func (j *HashJoin) Open() {
	// EXERCISE(hash-join-build): Read the entire right side into a hash table keyed on RightKey (skipping NULL keys),
	// counting BuildRows; then open the left side for probing.
	// Build phase: a pipeline breaker. Nothing comes out until the right side is fully read.
	j.table = map[string][]Row{}
	for _, r := range Collect(j.Right) {
		k := r[j.RightKey]
		if k == nil {
			continue // a NULL key can never match; don't even store it
		}
		h := hashKey(k)
		j.table[h] = append(j.table[h], r)
		j.BuildRows++
	}
	j.Left.Open()
	j.cur, j.matches = nil, nil
	// END EXERCISE
}

func (j *HashJoin) Next() (Row, bool) {
	// EXERCISE(hash-join-probe): For the current probe row, look its key up in the table built in Open and emit one joined
	// row per match; pad with NULLs for left outer when nothing matched.
	for {
		if len(j.matches) > 0 { // still emitting matches for the current probe row
			m := j.matches[0]
			j.matches = j.matches[1:]
			return concat(j.cur, m), true
		}
		l, ok := j.Left.Next() // probe phase: stream the left side
		if !ok {
			return nil, false
		}
		j.cur, j.matches = l, nil
		if k := l[j.LeftKey]; k != nil {
			j.Probes++
			for _, r := range j.table[hashKey(k)] {
				j.Comparisons++ // real hash tables can collide; confirm equality
				if KeysEqual(k, r[j.RightKey]) {
					j.matches = append(j.matches, r)
				}
			}
		}
		if len(j.matches) == 0 && j.Kind == LeftOuter {
			return concat(l, nulls(len(j.Right.Schema()))), true
		}
	}
	// END EXERCISE
}

// ---------------------------------------------------------------------------------------------
// Sort-merge join (inner only)
// ---------------------------------------------------------------------------------------------

// MergeJoin requires both inputs sorted ascending on their keys, NULLs last (wrap them in Sort).
// It walks both sides forward together. Duplicate keys on the right are buffered as a "group" so
// every left row with that key can pair with all of them.
type MergeJoin struct {
	Left, Right       Operator
	LeftKey, RightKey int

	Comparisons int

	right    Row   // lookahead: the next unconsumed right row (nil when exhausted)
	group    []Row // right rows sharing groupKey
	groupKey Value
	cur      Row // current left row
	gi       int // next index into group for cur
}

func (j *MergeJoin) Schema() []string {
	return append(append([]string{}, j.Left.Schema()...), j.Right.Schema()...)
}
func (j *MergeJoin) Close() { j.Left.Close(); j.Right.Close() }
func (j *MergeJoin) Open() {
	j.Left.Open()
	j.Right.Open()
	j.right, _ = j.Right.Next()
	j.group, j.groupKey, j.cur, j.gi = nil, nil, nil, 0
}

func (j *MergeJoin) Next() (Row, bool) {
	// EXERCISE(merge-join-next): Both inputs are sorted on the key. Advance whichever side is behind; when keys are equal,
	// buffer the right side's group of equal keys and pair it with every left row carrying that key.
	for {
		// 1. Pair the current left row with the rest of its matching group.
		if j.cur != nil && j.gi < len(j.group) && KeysEqual(j.cur[j.LeftKey], j.groupKey) {
			j.gi++
			return concat(j.cur, j.group[j.gi-1]), true
		}
		// 2. Advance the left side.
		l, ok := j.Left.Next()
		if !ok {
			return nil, false
		}
		j.cur, j.gi = l, 0
		lk := l[j.LeftKey]
		if lk == nil {
			return nil, false // NULLs sort last: every remaining left key is NULL, nothing can match
		}
		if j.group != nil {
			j.Comparisons++
			if Compare(lk, j.groupKey) == 0 {
				continue // same key as the previous left row: reuse the buffered group
			}
		}
		// 3. Advance the right side past keys smaller than lk.
		j.group = nil
		for j.right != nil && j.right[j.RightKey] != nil {
			j.Comparisons++
			if Compare(j.right[j.RightKey], lk) >= 0 {
				break
			}
			j.right, _ = j.Right.Next()
		}
		// 4. If the right side sits on lk, buffer every right row with that key.
		if j.right == nil || j.right[j.RightKey] == nil {
			continue // right exhausted (or only NULLs left): no more matches, drain left
		}
		j.Comparisons++
		if Compare(j.right[j.RightKey], lk) == 0 {
			j.groupKey = lk
			for j.right != nil && KeysEqual(j.right[j.RightKey], lk) {
				j.Comparisons++
				j.group = append(j.group, j.right)
				j.right, _ = j.Right.Next()
			}
		}
	}
	// END EXERCISE
}

// ---------------------------------------------------------------------------------------------
// The toy tables
// ---------------------------------------------------------------------------------------------

var ToyCustomers = &Table{Name: "customers",
	Cols: []string{"customers.id", "customers.name", "customers.city", "customers.age"},
	Rows: []Row{
		{int64(1), "Ada", "Austin", int64(36)},
		{int64(2), "Bo", "Boston", nil},
		{int64(3), "Cy", "Austin", int64(52)},
		{int64(4), "Di", "Denver", int64(29)},
	}}

var ToyOrders = &Table{Name: "orders",
	Cols: []string{"orders.id", "orders.customer_id", "orders.product_id", "orders.qty"},
	Rows: []Row{
		{int64(10), int64(1), int64(100), int64(2)},
		{int64(11), int64(1), int64(101), int64(1)},
		{int64(12), int64(3), int64(100), int64(5)},
		{int64(13), int64(4), int64(102), int64(1)},
		{int64(14), int64(9), int64(101), int64(3)},
	}}
