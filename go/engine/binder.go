package engine

import (
	"fmt"
	"strings"
)

// Rel is one table in the FROM clause, under its alias.
type Rel struct {
	Alias string
	Table *Table
}

// SortKey orders by column Idx of the input.
type SortKey struct {
	Idx  int  `json:"idx"`
	Desc bool `json:"desc,omitempty"`
}

// Query is a bound SELECT: every column reference is qualified ("alias.col"), the WHERE and ON
// clauses are flattened into one list of conjuncts, and everything above the joins refers to the
// aggregate's output ("#g0", "#a0", …) when the query aggregates.
//
// The shape it describes, bottom to top:
//
//	joins of Rels filtered by Preds
//	→ [aggregate by GroupBy computing Aggs] → [filter Having]
//	→ project Out (visible columns, then hidden ones ORDER BY needs)
//	→ [sort by Order] → [limit]
type Query struct {
	Rels    []Rel
	Preds   []Expr
	Grouped bool
	GroupBy []Expr
	Aggs    []Agg
	Having  Expr
	Out     []Expr
	Headers []string // names of the visible output columns
	Order   []SortKey
	Limit   int64
	Explain bool
}

// Visible is how many leading Out columns the user sees; the rest exist only for ORDER BY.
func (q *Query) Visible() int { return len(q.Headers) }

type binder struct {
	db   *DB
	rels []Rel
}

func bindErr(format string, args ...any) { panic(ParseError{fmt.Sprintf(format, args...), -1}) }

// Bind resolves names in a parsed statement against the database.
func Bind(s *SelectStmt, db *DB) (q *Query, err error) {
	defer func() {
		if r := recover(); r != nil {
			switch e := r.(type) {
			case ParseError:
				q, err = nil, e
			case EvalError:
				q, err = nil, ParseError{e.Msg, -1}
			default:
				panic(r)
			}
		}
	}()
	b := &binder{db: db}
	q = &Query{Limit: s.Limit, Explain: s.Explain}

	// FROM: register every table under its alias; ON conditions are just more conjuncts.
	var conj []Expr
	for _, ref := range s.From {
		t, ok := db.Tables[ref.Table]
		if !ok {
			bindErr("no such table %s", ref.Table)
		}
		for _, r := range b.rels {
			if r.Alias == ref.Alias {
				bindErr("table alias %s used twice", ref.Alias)
			}
		}
		b.rels = append(b.rels, Rel{ref.Alias, t})
		conj = append(conj, splitAnd(ref.On)...)
	}
	q.Rels = b.rels
	conj = append(conj, splitAnd(s.Where)...)
	for _, c := range conj {
		bc := b.bind(c)
		if hasAgg(bc) {
			bindErr("aggregates are not allowed in WHERE or ON: %s", Render(c))
		}
		q.Preds = append(q.Preds, bc)
	}

	// SELECT list (bound, still over base columns for now).
	var out []Expr
	if s.Star {
		for _, r := range b.rels {
			for _, c := range r.Table.Columns {
				out = append(out, Col{r.Alias + "." + c})
				q.Headers = append(q.Headers, c)
			}
		}
	} else {
		for _, item := range s.Items {
			out = append(out, b.bind(item.E))
			q.Headers = append(q.Headers, headerFor(item))
		}
	}

	for _, g := range s.GroupBy {
		bg := b.bind(g)
		if hasAgg(bg) {
			bindErr("aggregates are not allowed in GROUP BY")
		}
		q.GroupBy = append(q.GroupBy, bg)
	}
	var having Expr
	if s.Having != nil {
		having = b.bind(s.Having)
	}

	// ORDER BY: an unqualified name matching an output column refers to that column (so ORDER BY n
	// works for "count(*) AS n"); an expression identical to a SELECT item reuses it; anything else
	// becomes a hidden extra output column.
	for _, o := range s.OrderBy {
		idx := -1
		if c, ok := o.E.(Col); ok && !strings.Contains(c.Name, ".") {
			for i, h := range q.Headers {
				if h == c.Name {
					idx = i
					break
				}
			}
		}
		if idx < 0 {
			be := b.bind(o.E)
			for i, e := range out {
				if Render(e) == Render(be) {
					idx = i
					break
				}
			}
			if idx < 0 {
				out = append(out, be)
				idx = len(out) - 1
			}
		}
		q.Order = append(q.Order, SortKey{Idx: idx, Desc: o.Desc})
	}

	// Aggregation: collect every distinct aggregate, then rewrite the expressions that run above the
	// aggregate to read its output columns instead.
	q.Grouped = len(q.GroupBy) > 0 || having != nil
	for _, e := range out {
		q.Grouped = q.Grouped || hasAgg(e)
	}
	if q.Grouped {
		seen := map[string]int{}
		collect := func(e Expr) {
			walk(e, func(n Expr) {
				if a, ok := n.(Agg); ok {
					if hasAgg(a.Arg) {
						bindErr("nested aggregates are not allowed: %s", Render(a))
					}
					if _, dup := seen[Render(a)]; !dup {
						seen[Render(a)] = len(q.Aggs)
						q.Aggs = append(q.Aggs, a)
					}
				}
			})
		}
		for _, e := range out {
			collect(e)
		}
		collect(having)

		groupIdx := map[string]int{}
		for i, g := range q.GroupBy {
			groupIdx[Render(g)] = i
		}
		over := func(e Expr) Expr {
			return rewrite(e, func(n Expr) (Expr, bool) {
				if i, ok := groupIdx[Render(n)]; ok {
					return Col{fmt.Sprintf("#g%d", i)}, true
				}
				switch x := n.(type) {
				case Agg:
					return Col{fmt.Sprintf("#a%d", seen[Render(x)])}, true
				case Col:
					bindErr("column %s must appear in GROUP BY or be used in an aggregate", x.Name)
				}
				return nil, false
			})
		}
		for i, e := range out {
			out[i] = over(e)
		}
		if having != nil {
			q.Having = over(having)
		}
	}
	q.Out = out
	return q, nil
}

// bind qualifies every column reference.
func (b *binder) bind(e Expr) Expr {
	return rewrite(e, func(n Expr) (Expr, bool) {
		c, ok := n.(Col)
		if !ok {
			return nil, false
		}
		return Col{b.resolve(c.Name)}, true
	})
}

func (b *binder) resolve(name string) string {
	if i := strings.IndexByte(name, '.'); i > 0 {
		alias, col := name[:i], name[i+1:]
		for _, r := range b.rels {
			if r.Alias == alias {
				if r.Table.ColIndex(col) < 0 {
					bindErr("table %s (%s) has no column %s", r.Table.Name, alias, col)
				}
				return name
			}
		}
		bindErr("unknown table or alias %s", alias)
	}
	var found []string
	for _, r := range b.rels {
		if r.Table.ColIndex(name) >= 0 {
			found = append(found, r.Alias+"."+name)
		}
	}
	switch len(found) {
	case 0:
		bindErr("unknown column %s", name)
	case 1:
		return found[0]
	}
	bindErr("column %s is ambiguous (%s)", name, strings.Join(found, ", "))
	return ""
}

// headerFor names an output column: its alias, else a bare column's name, else the expression as
// written.
func headerFor(item SelectItem) string {
	if item.Alias != "" {
		return item.Alias
	}
	if c, ok := item.E.(Col); ok {
		if i := strings.IndexByte(c.Name, '.'); i > 0 {
			return c.Name[i+1:]
		}
		return c.Name
	}
	return Render(item.E)
}
