package engine

import (
	"fmt"
	"strconv"
	"strings"
)

// A recursive-descent parser for the SQL subset in DESIGN.md. Each grammar rule is one method;
// expression precedence climbs from OR (loosest) to primary (tightest):
//
//	or → and → not → comparison → additive → multiplicative → unary → primary

var reserved = map[string]bool{
	"select": true, "from": true, "where": true, "group": true, "by": true, "having": true,
	"order": true, "limit": true, "join": true, "inner": true, "on": true, "as": true, "and": true,
	"or": true, "not": true, "is": true, "null": true, "true": true, "false": true, "asc": true,
	"desc": true, "explain": true,
}

var aggFns = map[string]bool{"count": true, "sum": true, "min": true, "max": true, "avg": true}

type parser struct {
	toks []token
	i    int
}

// Parse turns SQL text into a SelectStmt.
func Parse(sql string) (stmt *SelectStmt, err error) {
	toks, err := lex(sql)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	defer func() {
		if r := recover(); r != nil {
			pe, ok := r.(ParseError)
			if !ok {
				panic(r)
			}
			stmt, err = nil, pe
		}
	}()
	stmt = p.statement()
	return stmt, nil
}

func (p *parser) peek() token { return p.toks[p.i] }
func (p *parser) next() token { t := p.toks[p.i]; p.i++; return t }

func (p *parser) errorf(format string, args ...any) {
	panic(ParseError{fmt.Sprintf(format, args...), p.peek().pos})
}

// isKw / acceptKw / expectKw work on keywords (identifiers with a reserved meaning).
func (p *parser) isKw(kw string) bool {
	t := p.peek()
	return t.kind == tIdent && t.text == kw
}

func (p *parser) acceptKw(kw string) bool {
	if p.isKw(kw) {
		p.i++
		return true
	}
	return false
}

func (p *parser) expectKw(kw string) {
	if !p.acceptKw(kw) {
		p.errorf("expected %s, got %s", strings.ToUpper(kw), describe(p.peek()))
	}
}

func (p *parser) isSym(s string) bool {
	t := p.peek()
	return t.kind == tSymbol && t.text == s
}

func (p *parser) acceptSym(s string) bool {
	if p.isSym(s) {
		p.i++
		return true
	}
	return false
}

func (p *parser) expectSym(s string) {
	if !p.acceptSym(s) {
		p.errorf("expected %q, got %s", s, describe(p.peek()))
	}
}

func describe(t token) string {
	switch t.kind {
	case tEOF:
		return "end of input"
	case tString:
		return "'" + t.text + "'"
	}
	return fmt.Sprintf("%q", t.text)
}

func (p *parser) ident() string {
	t := p.peek()
	if t.kind != tIdent || reserved[t.text] {
		p.errorf("expected a name, got %s", describe(t))
	}
	p.i++
	return t.text
}

func (p *parser) statement() *SelectStmt {
	explain := p.acceptKw("explain")
	s := p.selectStmt()
	s.Explain = explain
	p.acceptSym(";")
	if p.peek().kind != tEOF {
		p.errorf("unexpected %s after end of query", describe(p.peek()))
	}
	return s
}

func (p *parser) selectStmt() *SelectStmt {
	s := &SelectStmt{Limit: -1}
	p.expectKw("select")
	if p.acceptSym("*") {
		s.Star = true
	} else {
		for {
			item := SelectItem{E: p.expr()}
			if p.acceptKw("as") {
				item.Alias = p.ident()
			} else if t := p.peek(); t.kind == tIdent && !reserved[t.text] {
				item.Alias = p.ident()
			}
			s.Items = append(s.Items, item)
			if !p.acceptSym(",") {
				break
			}
		}
	}

	p.expectKw("from")
	s.From = append(s.From, p.tableRef())
	for {
		if p.acceptSym(",") {
			s.From = append(s.From, p.tableRef())
			continue
		}
		if p.isKw("join") || p.isKw("inner") {
			p.acceptKw("inner")
			p.expectKw("join")
			ref := p.tableRef()
			p.expectKw("on")
			ref.On = p.expr()
			s.From = append(s.From, ref)
			continue
		}
		break
	}

	if p.acceptKw("where") {
		s.Where = p.expr()
	}
	if p.acceptKw("group") {
		p.expectKw("by")
		s.GroupBy = p.exprList()
	}
	if p.acceptKw("having") {
		s.Having = p.expr()
	}
	if p.acceptKw("order") {
		p.expectKw("by")
		for {
			item := OrderItem{E: p.expr()}
			if p.acceptKw("desc") {
				item.Desc = true
			} else {
				p.acceptKw("asc")
			}
			s.OrderBy = append(s.OrderBy, item)
			if !p.acceptSym(",") {
				break
			}
		}
	}
	if p.acceptKw("limit") {
		t := p.next()
		n, err := strconv.ParseInt(t.text, 10, 64)
		if t.kind != tNumber || err != nil {
			p.i--
			p.errorf("LIMIT expects an integer, got %s", describe(t))
		}
		s.Limit = n
	}
	return s
}

func (p *parser) tableRef() TableRef {
	ref := TableRef{Table: p.ident()}
	if p.acceptKw("as") {
		ref.Alias = p.ident()
	} else if t := p.peek(); t.kind == tIdent && !reserved[t.text] {
		ref.Alias = p.ident()
	}
	if ref.Alias == "" {
		ref.Alias = ref.Table
	}
	return ref
}

func (p *parser) exprList() []Expr {
	out := []Expr{p.expr()}
	for p.acceptSym(",") {
		out = append(out, p.expr())
	}
	return out
}

func (p *parser) expr() Expr { return p.or() }

func (p *parser) or() Expr {
	e := p.and()
	for p.acceptKw("or") {
		e = Bin{"or", e, p.and()}
	}
	return e
}

func (p *parser) and() Expr {
	e := p.not()
	for p.acceptKw("and") {
		e = Bin{"and", e, p.not()}
	}
	return e
}

func (p *parser) not() Expr {
	if p.acceptKw("not") {
		return Not{p.not()}
	}
	return p.comparison()
}

func (p *parser) comparison() Expr {
	e := p.additive()
	for {
		if p.acceptKw("is") {
			neg := p.acceptKw("not")
			p.expectKw("null")
			e = IsNull{e, neg}
			continue
		}
		t := p.peek()
		if t.kind == tSymbol {
			switch t.text {
			case "=", "!=", "<", "<=", ">", ">=":
				p.i++
				e = Bin{t.text, e, p.additive()}
				continue
			}
		}
		return e
	}
}

func (p *parser) additive() Expr {
	e := p.multiplicative()
	for {
		switch {
		case p.acceptSym("+"):
			e = Bin{"+", e, p.multiplicative()}
		case p.acceptSym("-"):
			e = Bin{"-", e, p.multiplicative()}
		default:
			return e
		}
	}
}

func (p *parser) multiplicative() Expr {
	e := p.unary()
	for {
		switch {
		case p.acceptSym("*"):
			e = Bin{"*", e, p.unary()}
		case p.acceptSym("/"):
			e = Bin{"/", e, p.unary()}
		default:
			return e
		}
	}
}

func (p *parser) unary() Expr {
	if p.acceptSym("-") {
		e := p.unary()
		switch v := e.(type) {
		case Lit: // fold -3 into a literal
			switch n := v.V.(type) {
			case int64:
				return Lit{-n}
			case float64:
				return Lit{-n}
			}
		}
		return Bin{"-", Lit{int64(0)}, e}
	}
	return p.primary()
}

func (p *parser) primary() Expr {
	t := p.peek()
	switch t.kind {
	case tNumber:
		p.i++
		if strings.Contains(t.text, ".") {
			f, err := strconv.ParseFloat(t.text, 64)
			if err != nil {
				p.i--
				p.errorf("bad number %s", t.text)
			}
			return Lit{f}
		}
		n, err := strconv.ParseInt(t.text, 10, 64)
		if err != nil {
			p.i--
			p.errorf("bad integer %s", t.text)
		}
		return Lit{n}
	case tString:
		p.i++
		return Lit{t.text}
	case tSymbol:
		if p.acceptSym("(") {
			e := p.expr()
			p.expectSym(")")
			return e
		}
	case tIdent:
		switch t.text {
		case "null":
			p.i++
			return Lit{nil}
		case "true":
			p.i++
			return Lit{true}
		case "false":
			p.i++
			return Lit{false}
		}
		if reserved[t.text] {
			break
		}
		p.i++
		if p.acceptSym("(") { // function or aggregate call
			if aggFns[t.text] {
				if t.text == "count" && p.acceptSym("*") {
					p.expectSym(")")
					return Agg{Fn: "count", Star: true}
				}
				arg := p.expr()
				p.expectSym(")")
				return Agg{Fn: t.text, Arg: arg}
			}
			var args []Expr
			if !p.isSym(")") {
				args = p.exprList()
			}
			p.expectSym(")")
			return Func{t.text, args}
		}
		if p.acceptSym(".") {
			return Col{t.text + "." + p.ident()}
		}
		return Col{t.text}
	}
	p.errorf("expected an expression, got %s", describe(t))
	return nil
}
