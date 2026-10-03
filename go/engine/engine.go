package engine

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"
)

// Engine ties the stages together over one database.
type Engine struct{ DB *DB }

// New builds the generated dataset (seed 42) with its indexes and statistics.
func New() *Engine { return &Engine{DB: Generate(42)} }

// Prepared is a query that has been parsed, bound, and planned.
type Prepared struct {
	SQL     string
	Stmt    *SelectStmt
	Query   *Query
	Plan    Node
	Headers []string
}

// Prepare runs SQL through parser, binder, and planner.
func (e *Engine) Prepare(sql string) (*Prepared, error) {
	stmt, err := Parse(sql)
	if err != nil {
		return nil, err
	}
	q, err := Bind(stmt, e.DB)
	if err != nil {
		return nil, err
	}
	plan, err := PlanQuery(q, e.DB)
	if err != nil {
		return nil, err
	}
	return &Prepared{SQL: sql, Stmt: stmt, Query: q, Plan: plan, Headers: q.Headers}, nil
}

// Program compiles the plan to bytecode.
func (p *Prepared) Program() (*Program, error) { return Compile(p.Plan, p.Query.Visible()) }

// Result is a finished query's output.
type Result struct {
	Headers []string
	Rows    [][]Value
}

// Run executes a prepared query with the Volcano executor or the bytecode VM.
func (e *Engine) Run(p *Prepared, useVM bool) (*Result, error) {
	var rows [][]Value
	var err error
	if useVM {
		var prog *Program
		if prog, err = p.Program(); err != nil {
			return nil, err
		}
		rows, err = RunVM(prog, e.DB)
	} else {
		rows, err = RunVolcano(p.Plan, e.DB)
		for i, r := range rows { // drop hidden ORDER BY columns
			rows[i] = r[:p.Query.Visible()]
		}
	}
	if err != nil {
		return nil, err
	}
	return &Result{Headers: p.Headers, Rows: rows}, nil
}

// Query is Prepare + Run.
func (e *Engine) Query(sql string, useVM bool) (*Result, error) {
	p, err := e.Prepare(sql)
	if err != nil {
		return nil, err
	}
	return e.Run(p, useVM)
}

// Canonical renders a result in the golden format from DESIGN.md.
func (r *Result) Canonical() string {
	var b strings.Builder
	b.WriteString(strings.Join(r.Headers, " | "))
	b.WriteByte('\n')
	for _, row := range r.Rows {
		parts := make([]string, len(row))
		for i, v := range row {
			parts[i] = FormatValue(v)
		}
		b.WriteString(strings.Join(parts, " | "))
		b.WriteByte('\n')
	}
	fmt.Fprintf(&b, "(%d rows)\n", len(r.Rows))
	return b.String()
}

// Pretty renders a result as an aligned table for the terminal.
func (r *Result) Pretty() string {
	cells := make([][]string, len(r.Rows))
	width := make([]int, len(r.Headers))
	for i, h := range r.Headers {
		width[i] = utf8.RuneCountInString(h)
	}
	numeric := make([]bool, len(r.Headers))
	for i, row := range r.Rows {
		cells[i] = make([]string, len(row))
		for j, v := range row {
			cells[i][j] = FormatValue(v)
			width[j] = max(width[j], utf8.RuneCountInString(cells[i][j]))
			switch v.(type) {
			case int64, float64:
				numeric[j] = true
			}
		}
	}
	pad := func(s string, w int, right bool) string {
		gap := strings.Repeat(" ", w-utf8.RuneCountInString(s))
		if right {
			return gap + s
		}
		return s + gap
	}
	var b strings.Builder
	line := func(parts []string) {
		b.WriteString(" " + strings.Join(parts, " │ ") + "\n")
	}
	hs := make([]string, len(r.Headers))
	rule := make([]string, len(r.Headers))
	for i, h := range r.Headers {
		hs[i] = pad(h, width[i], numeric[i])
		rule[i] = strings.Repeat("─", width[i])
	}
	line(hs)
	b.WriteString("─" + strings.Join(rule, "─┼─") + "─\n")
	for _, row := range cells {
		parts := make([]string, len(row))
		for j, c := range row {
			parts[j] = pad(c, width[j], numeric[j])
		}
		line(parts)
	}
	fmt.Fprintf(&b, "(%d rows)\n", len(r.Rows))
	return b.String()
}

// ReadGolden returns the queries in a golden file: one per line, skipping blanks and -- comments.
func ReadGolden(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "--") {
			continue
		}
		out = append(out, line)
	}
	return out, sc.Err()
}

// Golden runs every golden query and renders "SQL line, canonical output" blocks separated by a
// blank line — the text Go and Clojure must agree on byte for byte.
func (e *Engine) Golden(queries []string, useVM bool) (string, error) {
	var blocks []string
	for _, q := range queries {
		res, err := e.Query(q, useVM)
		if err != nil {
			return "", fmt.Errorf("%s: %w", q, err)
		}
		blocks = append(blocks, q+"\n"+res.Canonical())
	}
	return strings.Join(blocks, "\n"), nil
}
