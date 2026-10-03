package engine

import (
	"strings"
	"testing"
)

func TestParseRoundTrip(t *testing.T) {
	cases := map[string]string{
		"a + b * c":                   "a + b * c",
		"(a + b) * c":                 "(a + b) * c",
		"a - (b - c)":                 "a - (b - c)",
		"a = 1 or b = 2 and c = 3":    "a = 1 OR b = 2 AND c = 3",
		"(a = 1 or b = 2) and c = 3":  "(a = 1 OR b = 2) AND c = 3",
		"not a is null":               "NOT a IS NULL",
		"x is not null":               "x IS NOT NULL",
		"-3 + -y":                     "-3 + (0 - y)",
		"upper(c.City) <> 'it''s'":    "upper(c.city) != 'it''s'",
		"count(*) + SUM(o.qty) / 2.5": "count(*) + sum(o.qty) / 2.5",
		"coalesce(a, NULL, TRUE)":     "coalesce(a, NULL, true)",
	}
	for in, want := range cases {
		s, err := Parse("SELECT " + in + " FROM t")
		if err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if got := Render(s.Items[0].E); got != want {
			t.Errorf("%s: rendered %q, want %q", in, got, want)
		}
	}
}

func TestParseClauses(t *testing.T) {
	s, err := Parse(`EXPLAIN SELECT c.name AS who, count(*) n
		FROM customers c JOIN orders AS o ON o.customer_id = c.id, products
		WHERE c.age > 30 GROUP BY c.name HAVING count(*) > 2
		ORDER BY n DESC, who LIMIT 10;`)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Explain || len(s.Items) != 2 || s.Items[0].Alias != "who" || s.Items[1].Alias != "n" {
		t.Errorf("select list: %+v", s.Items)
	}
	if len(s.From) != 3 || s.From[1].Alias != "o" || s.From[1].On == nil || s.From[2].Alias != "products" {
		t.Errorf("from: %+v", s.From)
	}
	if len(s.GroupBy) != 1 || s.Having == nil || len(s.OrderBy) != 2 || !s.OrderBy[0].Desc || s.Limit != 10 {
		t.Errorf("tail clauses wrong: %+v", s)
	}
}

func TestParseErrors(t *testing.T) {
	cases := map[string]string{
		"SELECT":                      "expected an expression",
		"SELECT a FROM":               "expected a name",
		"SELECT a FROM t WHERE":       "expected an expression",
		"SELECT a FROM t LIMIT x":     "LIMIT expects an integer",
		"SELECT 'oops FROM t":         "unterminated string",
		"SELECT a FROM t JOIN u":      "expected ON",
		"SELECT a FROM t extra junk":  "after end of query",
		"SELECT a FROM t WHERE a = #": "unexpected character",
	}
	for sql, want := range cases {
		_, err := Parse(sql)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v, want error containing %q", sql, err, want)
		}
	}
}
