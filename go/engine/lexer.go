package engine

import (
	"fmt"
	"strings"
	"unicode"
)

type tokKind int

const (
	tEOF tokKind = iota
	tIdent
	tNumber
	tString
	tSymbol
)

type token struct {
	kind tokKind
	text string // identifiers are lowercased; strings are unquoted
	pos  int
}

// ParseError is a syntax or binding error with a position (byte offset into the SQL) when known.
type ParseError struct {
	Msg string
	Pos int
}

func (e ParseError) Error() string {
	if e.Pos >= 0 {
		return fmt.Sprintf("%s (at offset %d)", e.Msg, e.Pos)
	}
	return e.Msg
}

// lex splits SQL into tokens. Identifiers are case-insensitive, so we lowercase them here.
func lex(sql string) ([]token, error) {
	var toks []token
	rs := []rune(sql)
	i := 0
	for i < len(rs) {
		c := rs[i]
		switch {
		case unicode.IsSpace(c):
			i++
		case c == '-' && i+1 < len(rs) && rs[i+1] == '-': // comment to end of line
			for i < len(rs) && rs[i] != '\n' {
				i++
			}
		case unicode.IsLetter(c) || c == '_':
			start := i
			for i < len(rs) && (unicode.IsLetter(rs[i]) || unicode.IsDigit(rs[i]) || rs[i] == '_') {
				i++
			}
			toks = append(toks, token{tIdent, strings.ToLower(string(rs[start:i])), start})
		case unicode.IsDigit(c):
			start := i
			for i < len(rs) && (unicode.IsDigit(rs[i]) || rs[i] == '.') {
				i++
			}
			toks = append(toks, token{tNumber, string(rs[start:i]), start})
		case c == '\'':
			start := i
			i++
			var b strings.Builder
			for {
				if i >= len(rs) {
					return nil, ParseError{"unterminated string", start}
				}
				if rs[i] == '\'' {
					if i+1 < len(rs) && rs[i+1] == '\'' { // '' is an escaped quote
						b.WriteRune('\'')
						i += 2
						continue
					}
					i++
					break
				}
				b.WriteRune(rs[i])
				i++
			}
			toks = append(toks, token{tString, b.String(), start})
		default:
			start := i
			two := ""
			if i+1 < len(rs) {
				two = string(rs[i : i+2])
			}
			switch two {
			case "<=", ">=", "!=", "<>":
				if two == "<>" {
					two = "!="
				}
				toks = append(toks, token{tSymbol, two, start})
				i += 2
				continue
			}
			if strings.ContainsRune("(),.*+-/=<>;", c) {
				toks = append(toks, token{tSymbol, string(c), start})
				i++
				continue
			}
			return nil, ParseError{fmt.Sprintf("unexpected character %q", c), start}
		}
	}
	toks = append(toks, token{tEOF, "", len(rs)})
	return toks, nil
}
