package lesson01

import "testing"

func TestThreeValuedLogic(t *testing.T) {
	cases := []struct {
		op   string
		a, b Value
		want Value
	}{
		{"and", false, nil, false},
		{"and", true, nil, nil},
		{"and", true, true, true},
		{"or", true, nil, true},
		{"or", false, nil, nil},
		{"or", false, false, false},
	}
	for _, c := range cases {
		var got Value
		if c.op == "and" {
			got = And3(c.a, c.b)
		} else {
			got = Or3(c.a, c.b)
		}
		if got != c.want {
			t.Errorf("%v %s %v = %v, want %v", c.a, c.op, c.b, got, c.want)
		}
	}
	if Not3(nil) != nil {
		t.Error("NOT NULL should be NULL")
	}
}

func TestEvalAndCompileAgree(t *testing.T) {
	exprs := []Expr{
		Bin{"and", Bin{">", Col{"age"}, Lit{int64(30)}}, Bin{"=", Col{"city"}, Lit{"Austin"}}},
		Bin{"or", Bin{">", Col{"age"}, Lit{int64(30)}}, Bin{"=", Col{"name"}, Lit{"Bo"}}},
		Bin{"/", Col{"age"}, Lit{int64(2)}},
		Func{"coalesce", []Expr{Col{"age"}, Lit{int64(-1)}}},
		IsNull{Col{"age"}, false},
		Func{"upper", []Expr{Col{"city"}}},
	}
	for _, e := range exprs {
		f := Compile(e, CustomersSchema)
		for _, r := range Customers {
			if a, b := Eval(e, CustomersSchema, r), f(r); a != b {
				t.Errorf("%s on %v: eval=%v compiled=%v", e, r, a, b)
			}
		}
	}
}

func TestArithmetic(t *testing.T) {
	if v := ApplyBinary("+", int64(2), int64(3)); v != int64(5) {
		t.Errorf("int+int = %v", v)
	}
	if v := ApplyBinary("/", int64(3), int64(2)); v != 1.5 {
		t.Errorf("3/2 = %v, want float 1.5", v)
	}
	if v := ApplyBinary("/", int64(3), int64(0)); v != nil {
		t.Errorf("3/0 = %v, want NULL", v)
	}
	if v := ApplyBinary("<", int64(2), 2.5); v != true {
		t.Errorf("2 < 2.5 = %v", v)
	}
	if v := ApplyBinary("=", nil, nil); v != nil {
		t.Errorf("NULL = NULL = %v, want NULL", v)
	}
}

func TestPasses(t *testing.T) {
	if Passes(nil) || Passes(false) || !Passes(true) {
		t.Error("only exactly-true passes a filter")
	}
}
