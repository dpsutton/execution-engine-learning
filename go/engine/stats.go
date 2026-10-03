package engine

import (
	"fmt"
	"sort"
	"strings"
)

// HistBuckets is how many equi-depth buckets each column histogram gets.
const HistBuckets = 8

// Bucket is one equi-depth histogram bucket: Count non-null values ≤ Upper (and > the previous
// bucket's Upper).
type Bucket struct {
	Upper Value
	Count int
}

// ColumnStats is what ANALYZE learns about one column.
type ColumnStats struct {
	Rows, Nulls, NDV int
	Min, Max         Value
	Hist             []Bucket
}

// TableStats is ANALYZE's output for a table.
type TableStats struct {
	Rows int
	Cols map[string]*ColumnStats
}

// Analyze scans a table once per column: count NULLs and distinct values, sort the rest, and cut
// the sorted list into HistBuckets equal-sized pieces.
func Analyze(t *Table) *TableStats {
	ts := &TableStats{Rows: len(t.Rows), Cols: map[string]*ColumnStats{}}
	for ci, name := range t.Columns {
		cs := &ColumnStats{Rows: len(t.Rows)}
		var vals []Value
		distinct := map[string]bool{}
		for _, row := range t.Rows {
			v := row[ci]
			if v == nil {
				cs.Nulls++
				continue
			}
			vals = append(vals, v)
			distinct[HashKey(v)] = true
		}
		cs.NDV = len(distinct)
		if len(vals) > 0 {
			sort.SliceStable(vals, func(i, j int) bool { return Compare(vals[i], vals[j]) < 0 })
			cs.Min, cs.Max = vals[0], vals[len(vals)-1]
			n := len(vals)
			prev := 0
			for b := 1; b <= HistBuckets; b++ {
				end := b * n / HistBuckets
				if end <= prev {
					continue
				}
				cs.Hist = append(cs.Hist, Bucket{Upper: vals[end-1], Count: end - prev})
				prev = end
			}
		}
		ts.Cols[name] = cs
	}
	return ts
}

func (cs *ColumnStats) nonNullFrac() float64 {
	if cs.Rows == 0 {
		return 0
	}
	return float64(cs.Rows-cs.Nulls) / float64(cs.Rows)
}

// EqSel estimates the fraction of rows where col = constant: one distinct value's share.
func (cs *ColumnStats) EqSel() float64 {
	if cs.NDV == 0 {
		return 0
	}
	return cs.nonNullFrac() / float64(cs.NDV)
}

// lessFrac estimates the fraction of non-null values below v (≤ v when incl), walking the
// histogram and interpolating linearly inside the bucket v falls in.
func (cs *ColumnStats) lessFrac(v Value, incl bool) float64 {
	total := cs.Rows - cs.Nulls
	if total == 0 || len(cs.Hist) == 0 {
		return 0
	}
	acc := 0.0
	lower := cs.Min
	for i, b := range cs.Hist {
		if i == 0 {
			if c := Compare(v, cs.Min); c < 0 || (c == 0 && !incl) {
				return 0
			}
		}
		if c := Compare(v, b.Upper); c > 0 || (c == 0 && incl) {
			acc += float64(b.Count)
			lower = b.Upper
			continue
		}
		// v lies inside this bucket.
		lf, ok1 := toFloat(lower)
		uf, ok2 := toFloat(b.Upper)
		vf, ok3 := toFloat(v)
		frac := 0.5 // non-numeric: assume halfway
		if ok1 && ok2 && ok3 {
			if uf > lf {
				frac = (vf - lf) / (uf - lf)
			} else {
				frac = 0
			}
			frac = max(0, min(1, frac))
		}
		acc += frac * float64(b.Count)
		break
	}
	return acc / float64(total)
}

// RangeSel estimates the fraction of rows where `col op v` for op in < <= > >=.
func (cs *ColumnStats) RangeSel(op string, v Value) float64 {
	nn := cs.nonNullFrac()
	switch op {
	case "<":
		return nn * cs.lessFrac(v, false)
	case "<=":
		return nn * cs.lessFrac(v, true)
	case ">":
		return nn * (1 - cs.lessFrac(v, true))
	case ">=":
		return nn * (1 - cs.lessFrac(v, false))
	}
	return 1.0 / 3
}

// Format renders stats for the REPL's \stats command.
func (ts *TableStats) Format(t *Table) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %d rows\n", t.Name, ts.Rows)
	for _, name := range t.Columns {
		cs := ts.Cols[name]
		idx := ""
		if _, ok := t.Indexes[name]; ok {
			idx = "  [indexed]"
		}
		fmt.Fprintf(&b, "  %-12s nulls=%-4d ndv=%-5d min=%-8s max=%-8s%s\n", name, cs.Nulls, cs.NDV,
			FormatValue(cs.Min), FormatValue(cs.Max), idx)
		var parts []string
		for _, bk := range cs.Hist {
			parts = append(parts, fmt.Sprintf("≤%s:%d", FormatValue(bk.Upper), bk.Count))
		}
		fmt.Fprintf(&b, "  %-12s histogram %s\n", "", strings.Join(parts, " "))
	}
	return b.String()
}
