package lesson06

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// ---------------------------------------------------------------------------------------------
// Statistics: what ANALYZE collects. A few numbers per column, plus a histogram.
// ---------------------------------------------------------------------------------------------

// Bucket is one bar of an equi-depth histogram: Count non-NULL values ≤ Upper (and greater than the
// previous bucket's Upper). Equi-depth means every bucket holds about the same number of rows, so
// buckets are *narrow* where data is dense — that's how a histogram captures skew.
type Bucket struct {
	Upper Value
	Count int
}

// ColumnStats summarizes one column.
type ColumnStats struct {
	Rows, Nulls, NDV int // NDV = number of distinct (non-NULL) values
	Min, Max         Value
	Hist             []Bucket
}

// TableStats is ANALYZE's output for one table.
type TableStats struct {
	Rows int
	Cols map[string]*ColumnStats // by qualified column name
}

const histogramBuckets = 8

// Analyze scans a table once (plus a sort per column) and computes every column's stats.
func Analyze(t *Table) *TableStats {
	ts := &TableStats{Rows: len(t.Rows), Cols: map[string]*ColumnStats{}}
	for ci, name := range t.Cols {
		cs := &ColumnStats{Rows: len(t.Rows)}
		var vals []Value
		for _, r := range t.Rows {
			if r[ci] == nil {
				cs.Nulls++
			} else {
				vals = append(vals, r[ci])
			}
		}
		sort.SliceStable(vals, func(i, j int) bool { return Compare(vals[i], vals[j]) < 0 })
		for i, v := range vals {
			if i == 0 || Compare(v, vals[i-1]) != 0 {
				cs.NDV++
			}
		}
		if len(vals) > 0 {
			cs.Min, cs.Max = vals[0], vals[len(vals)-1]
			n := len(vals)
			for b := 0; b < histogramBuckets; b++ {
				lo, hi := b*n/histogramBuckets, (b+1)*n/histogramBuckets
				if hi > lo {
					cs.Hist = append(cs.Hist, Bucket{Upper: vals[hi-1], Count: hi - lo})
				}
			}
		}
		ts.Cols[name] = cs
	}
	return ts
}

// Catalog is everything the planner knows: per-table stats and which columns are indexed.
type Catalog struct {
	Tables  map[string]*Table
	Stats   map[string]*TableStats
	Indexes map[string]*Index // by qualified column name
}

func (c *Catalog) column(name string) *ColumnStats {
	return c.Stats[tableOf(name)].Cols[name]
}

func tableOf(col string) string { return col[:strings.IndexByte(col, '.')] }

// ---------------------------------------------------------------------------------------------
// Selectivity: the fraction of rows a predicate keeps. Rules from DESIGN.md.
// ---------------------------------------------------------------------------------------------

const unknownSelectivity = 1.0 / 3.0 // the traditional guess when we can't do better

// Selectivity estimates what fraction of rows pass e.
func (c *Catalog) Selectivity(e Expr) float64 {
	switch e := e.(type) {
	case Bin:
		switch e.Op {
		case "and": // assumes independence — the classic source of underestimates
			return c.Selectivity(e.L) * c.Selectivity(e.R)
		case "or":
			a, b := c.Selectivity(e.L), c.Selectivity(e.R)
			return a + b - a*b
		}
		lcol, lok := e.L.(Col)
		rcol, rok := e.R.(Col)
		if lok && rok && e.Op == "=" { // join predicate a.x = b.y
			return c.JoinSelectivity(lcol.Name, rcol.Name)
		}
		col, lit, op, ok := colOpLit(e)
		if !ok {
			return unknownSelectivity
		}
		cs := c.column(col)
		if cs.Rows == 0 {
			return 0
		}
		nonNull := float64(cs.Rows-cs.Nulls) / float64(cs.Rows)
		switch op {
		case "=":
			return cs.EqSelectivity()
		case "!=":
			return nonNull - cs.EqSelectivity()
		case "<":
			return cs.fractionBelow(lit, false)
		case "<=":
			return cs.fractionBelow(lit, true)
		case ">":
			return nonNull - cs.fractionBelow(lit, true)
		case ">=":
			return nonNull - cs.fractionBelow(lit, false)
		}
	case Not:
		return 1 - c.Selectivity(e.E)
	case IsNull:
		if col, ok := e.E.(Col); ok {
			cs := c.column(col.Name)
			s := float64(cs.Nulls) / float64(max(1, cs.Rows))
			if e.Negate {
				return 1 - s
			}
			return s
		}
	}
	return unknownSelectivity
}

// EqSelectivity estimates the fraction of all rows with col = some constant.
func (cs *ColumnStats) EqSelectivity() float64 {
	// EXERCISE(eq-selectivity): Assume uniformity: every distinct value is equally common, and
	// NULLs never match. Use Rows, Nulls and NDV; guard against an empty or all-NULL column.
	if cs.Rows == 0 || cs.NDV == 0 {
		return 0
	}
	nonNull := float64(cs.Rows-cs.Nulls) / float64(cs.Rows)
	return nonNull / float64(cs.NDV)
	// END EXERCISE
}

// JoinSelectivity estimates the fraction of the cross product that survives `a = b`. Times
// |L|·|R| it's the join's cardinality.
func (c *Catalog) JoinSelectivity(a, b string) float64 {
	// EXERCISE(join-cardinality): Every value on the side with fewer distinct values finds a
	// partner on the other side (containment), so each row matches 1/max(ndv(a), ndv(b)) of the
	// other side's rows.
	return 1 / math.Max(float64(max(1, c.column(a).NDV)), float64(max(1, c.column(b).NDV)))
	// END EXERCISE
}

// colOpLit recognizes `col op literal` (or `literal op col`, flipping the operator).
func colOpLit(b Bin) (col string, lit Value, op string, ok bool) {
	if c, isCol := b.L.(Col); isCol {
		if l, isLit := b.R.(Lit); isLit {
			return c.Name, l.V, b.Op, true
		}
	}
	if c, isCol := b.R.(Col); isCol {
		if l, isLit := b.L.(Lit); isLit {
			flip := map[string]string{"<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=", "!=": "!="}
			return c.Name, l.V, flip[b.Op], true
		}
	}
	return "", nil, "", false
}

// fractionBelow estimates the fraction of *all* rows with value < v (or ≤ v), from the histogram.
// Whole buckets below v count fully; the bucket containing v counts proportionally (linear
// interpolation for numbers, half for strings).
func (cs *ColumnStats) fractionBelow(v Value, inclusive bool) float64 {
	// EXERCISE(range-selectivity): Walk the equi-depth histogram: buckets entirely below v count fully; the bucket that
	// contains v counts in proportion to where v falls inside it. Return a fraction of all rows.
	if len(cs.Hist) == 0 {
		return 0
	}
	total := 0.0
	lo := cs.Min
	for i, b := range cs.Hist {
		c := Compare(b.Upper, v)
		if c < 0 || (c == 0 && inclusive) {
			total += float64(b.Count) // the whole bucket is below v
			lo = b.Upper
			continue
		}
		// v falls inside this bucket (between lo and Upper).
		if i == 0 && Compare(v, cs.Min) < 0 {
			break
		}
		if isNumber(v) && isNumber(lo) && isNumber(b.Upper) {
			width := toFloat(b.Upper) - toFloat(lo)
			if width > 0 {
				total += float64(b.Count) * math.Max(0, math.Min(1, (toFloat(v)-toFloat(lo))/width))
			}
		} else {
			total += float64(b.Count) / 2
		}
		break
	}
	return total / float64(cs.Rows)
	// END EXERCISE
}

func isNumber(v Value) bool {
	switch v.(type) {
	case int64, float64:
		return true
	}
	return false
}

// HistogramString draws the histogram as text. Every bucket holds about the same number of rows,
// so the interesting part is the *range* each covers: the bar shows density (rows per unit of
// value), long where values are packed together.
func (cs *ColumnStats) HistogramString() string {
	var b strings.Builder
	lo := cs.Min
	densities := make([]float64, len(cs.Hist))
	maxD := 0.0
	for i, bk := range cs.Hist {
		width := 1.0
		if isNumber(lo) && isNumber(bk.Upper) {
			width = math.Max(1, toFloat(bk.Upper)-toFloat(lo))
		}
		densities[i] = float64(bk.Count) / width
		maxD = math.Max(maxD, densities[i])
		lo = bk.Upper
	}
	lo = cs.Min
	for i, bk := range cs.Hist {
		bar := strings.Repeat("▇", max(1, int(math.Round(30*densities[i]/maxD))))
		fmt.Fprintf(&b, "    (%5s, %5s]  %4d rows  %s\n", Format(lo), Format(bk.Upper), bk.Count, bar)
		lo = bk.Upper
	}
	return b.String()
}
