package engine

import (
	"fmt"
	"strings"
)

// The bytecode compiler. It turns a physical plan into a flat program for the register VM in
// vm.go, in the same shape SQLite's code generator produces.
//
// It's a produce/consume compiler (Neumann 2011): produce(node, consume) emits the code that makes
// node's rows, and calls consume(regs) at the point in that code where one row sits in registers
// regs. The consumer emits its own code right there, inside the producer's loop. So a filter over
// a scan becomes
//
//	loop: Column → regs ; <predicate> ; IfNot skip ; <parent's code> ; skip: Next loop
//
// and a nested-loop join is just one scan loop emitted inside another. Pipeline breakers (hash
// build, sort, aggregate) finish one loop that fills a data structure, then start a new loop that
// reads it.

// Inst is one instruction. P1–P3 are small ints (registers, cursors, jump targets); P4 carries
// anything bigger (a table name, a constant, a sort spec).
type Inst struct {
	Op      string
	P1      int
	P2      int
	P3      int
	P4      any
	Comment string
}

// Program is compiled bytecode plus how many of each runtime resource it needs.
type Program struct {
	Insts                         []Inst
	NRegs, NCursors, NHash, NSort int
	NAgg                          int
	Visible                       int // ResultRow emits this many leading columns
}

// RangeSpec is IndexRange's P4: which index, which registers hold the bounds (-1 = unbounded).
type RangeSpec struct {
	Index          string // "table.col"
	LoReg, HiReg   int
	LoIncl, HiIncl bool
}

type compiler struct {
	prog     *Program
	consts   []Inst // constant loads, hoisted to run once before the main body
	constReg map[string]int
	halts    []int // jumps to patch to the Halt address
}

// Compile turns a plan into a program.
func Compile(plan Node, visible int) (prog *Program, err error) {
	defer recoverEval(&err)
	c := &compiler{prog: &Program{Visible: visible}, constReg: map[string]int{}}

	// Like SQLite: Init jumps to the constant-loading block at the end, which jumps back to 1.
	initAddr := c.emit("Init", 0, 0, 0, nil, "")
	c.produce(plan, func(regs []int) {
		first := c.contiguous(regs[:visible])
		c.emit("ResultRow", first, visible, 0, nil, "output one row")
	})
	haltAddr := c.emit("Halt", 0, 0, 0, nil, "")
	for _, h := range c.halts {
		c.prog.Insts[h].P2 = haltAddr
	}

	if len(c.consts) == 0 {
		c.prog.Insts[initAddr].P2 = 1
	} else {
		c.prog.Insts[initAddr].P2 = len(c.prog.Insts)
		c.prog.Insts[initAddr].Comment = "load constants"
		c.prog.Insts = append(c.prog.Insts, c.consts...)
		c.emit("Goto", 0, 1, 0, nil, "back to the start")
	}
	return c.prog, nil
}

func (c *compiler) emit(op string, p1, p2, p3 int, p4 any, comment string) int {
	c.prog.Insts = append(c.prog.Insts, Inst{op, p1, p2, p3, p4, comment})
	return len(c.prog.Insts) - 1
}

func (c *compiler) here() int { return len(c.prog.Insts) }

func (c *compiler) reg() int {
	c.prog.NRegs++
	return c.prog.NRegs - 1
}

func (c *compiler) regs(n int) int {
	first := c.prog.NRegs
	c.prog.NRegs += n
	return first
}

// contiguous returns the first of len(regs) consecutive registers holding regs' values, copying
// only if they aren't already laid out that way.
func (c *compiler) contiguous(regs []int) int {
	ok := true
	for i := 1; i < len(regs); i++ {
		if regs[i] != regs[0]+i {
			ok = false
		}
	}
	if ok && len(regs) > 0 {
		return regs[0]
	}
	first := c.regs(len(regs))
	for i, r := range regs {
		c.emit("Copy", r, first+i, 0, nil, "")
	}
	return first
}

// constant returns a register holding v, loaded once in the hoisted constant block.
func (c *compiler) constant(v Value) int {
	key := fmt.Sprintf("%T:%v", v, v)
	if r, ok := c.constReg[key]; ok {
		return r
	}
	r := c.reg()
	c.constReg[key] = r
	c.consts = append(c.consts, Inst{"Const", 0, r, 0, v, ""})
	return r
}

var opcodes = map[string]string{
	"+": "Add", "-": "Sub", "*": "Mul", "/": "Div",
	"=": "Eq", "!=": "Ne", "<": "Lt", "<=": "Le", ">": "Gt", ">=": "Ge",
	"and": "And", "or": "Or",
}

// expr emits code computing e and returns the register holding the result. env maps the current
// row's column names to registers.
func (c *compiler) expr(e Expr, env map[string]int) int {
	switch x := e.(type) {
	case Col:
		r, ok := env[x.Name]
		if !ok {
			fail("unknown column %s", x.Name)
		}
		return r
	case Lit:
		return c.constant(x.V)
	case Bin:
		a, b := c.expr(x.L, env), c.expr(x.R, env)
		d := c.reg()
		c.emit(opcodes[x.Op], a, b, d, nil, "")
		return d
	case Not:
		a := c.expr(x.E, env)
		d := c.reg()
		c.emit("Not", a, 0, d, nil, "")
		return d
	case IsNull:
		a := c.expr(x.E, env)
		d := c.reg()
		op := "IsNull"
		if x.Negate {
			op = "NotNull"
		}
		c.emit(op, a, 0, d, nil, "")
		return d
	case Func:
		args := make([]int, len(x.Args))
		for i, a := range x.Args {
			args[i] = c.expr(a, env)
		}
		first := c.contiguous(args)
		d := c.reg()
		c.emit("Func", first, len(args), d, x.Name, "")
		return d
	}
	fail("cannot compile %s", Render(e))
	return 0
}

func envFor(schema []string, regs []int) map[string]int {
	env := make(map[string]int, len(schema))
	for i, name := range schema {
		env[name] = regs[i]
	}
	return env
}

// filter emits "if pred isn't true, jump past body" around body.
func (c *compiler) filter(pred Expr, env map[string]int, body func()) {
	if pred == nil {
		body()
		return
	}
	r := c.expr(pred, env)
	skip := c.emit("IfNot", r, 0, 0, nil, "")
	body()
	c.prog.Insts[skip].P2 = c.here()
}

func (c *compiler) cursor() int {
	c.prog.NCursors++
	return c.prog.NCursors - 1
}

// readColumns loads every column of the cursor's current row into fresh registers. (SQLite only
// loads the columns the query uses; loading all of them keeps this compiler simpler.)
func (c *compiler) readColumns(op string, cur int, schema []string) []int {
	regs := make([]int, len(schema))
	for i, name := range schema {
		regs[i] = c.reg()
		c.emit(op, cur, i, regs[i], nil, name)
	}
	return regs
}

// produce emits code for node, calling consume wherever a row is ready.
func (c *compiler) produce(n Node, consume func(regs []int)) {
	switch x := n.(type) {
	case *Scan:
		cur := c.cursor()
		c.emit("OpenScan", cur, 0, 0, x.Table.Name, tableLabel(x.Alias, x.Table))
		rewind := c.emit("Rewind", cur, 0, 0, nil, "")
		loop := c.here()
		consume(c.readColumns("Column", cur, x.Schema()))
		c.emit("Next", cur, loop, 0, nil, "")
		c.prog.Insts[rewind].P2 = c.here()

	case *IndexScan:
		cur := c.cursor()
		index := x.Table.Name + "." + x.Col
		var seek int
		if x.Eq {
			seek = c.emit("SeekIndex", cur, c.constant(x.Lo), 0, index, x.rangeText())
		} else {
			spec := RangeSpec{Index: index, LoReg: -1, HiReg: -1, LoIncl: x.LoIncl, HiIncl: x.HiIncl}
			if x.Lo != nil {
				spec.LoReg = c.constant(x.Lo)
			}
			if x.Hi != nil {
				spec.HiReg = c.constant(x.Hi)
			}
			seek = c.emit("IndexRange", cur, 0, 0, spec, x.rangeText())
		}
		loop := c.here()
		consume(c.readColumns("Column", cur, x.Schema()))
		c.emit("IndexNext", cur, loop, 0, nil, "")
		c.prog.Insts[seek].P3 = c.here() // both seeks jump here when nothing matches

	case *Filter:
		schema := x.Child.Schema()
		c.produce(x.Child, func(regs []int) {
			c.filter(x.Pred, envFor(schema, regs), func() { consume(regs) })
		})

	case *Project:
		schema := x.Child.Schema()
		c.produce(x.Child, func(regs []int) {
			env := envFor(schema, regs)
			out := make([]int, len(x.Exprs))
			for i, e := range x.Exprs {
				out[i] = c.expr(e, env)
			}
			consume(out)
		})

	case *NLJoin:
		ls, rs := x.Left.Schema(), x.Right.Schema()
		c.produce(x.Left, func(lregs []int) {
			c.produce(x.Right, func(rregs []int) { // the inner loop, emitted inside the outer one
				all := append(append([]int(nil), lregs...), rregs...)
				c.filter(x.Pred, envFor(concat(ls, rs), all), func() { consume(all) })
			})
		})

	case *HashJoin:
		h := c.prog.NHash
		c.prog.NHash++
		ls, rs := x.Left.Schema(), x.Right.Schema()
		c.emit("HashOpen", h, 0, 0, nil, "build side: "+Render(x.RightKey))
		c.produce(x.Right, func(rregs []int) {
			key := c.expr(x.RightKey, envFor(rs, rregs))
			first := c.contiguous(rregs)
			c.emit("HashInsert", h, key, first, len(rregs), "")
		})
		c.produce(x.Left, func(lregs []int) {
			key := c.expr(x.LeftKey, envFor(ls, lregs))
			seek := c.emit("HashSeek", h, key, 0, nil, "probe: "+Render(x.LeftKey))
			loop := c.here()
			rregs := c.readColumns("HashColumn", h, rs)
			all := append(append([]int(nil), lregs...), rregs...)
			c.filter(x.Residual, envFor(concat(ls, rs), all), func() { consume(all) })
			c.emit("HashNext", h, loop, 0, nil, "")
			c.prog.Insts[seek].P3 = c.here()
		})

	case *IndexNLJoin:
		ls := x.Left.Schema()
		inner := tableSchema(x.Alias, x.Table)
		cur := c.cursor()
		c.produce(x.Left, func(lregs []int) {
			key := c.expr(x.OuterKey, envFor(ls, lregs))
			seek := c.emit("SeekIndex", cur, key, 0, x.Table.Name+"."+x.Col, tableLabel(x.Alias, x.Table))
			loop := c.here()
			rregs := c.readColumns("Column", cur, inner)
			all := append(append([]int(nil), lregs...), rregs...)
			c.filter(x.Residual, envFor(concat(ls, inner), all), func() { consume(all) })
			c.emit("IndexNext", cur, loop, 0, nil, "")
			c.prog.Insts[seek].P3 = c.here()
		})

	case *HashAggregate:
		a := c.prog.NAgg
		c.prog.NAgg++
		spec := aggSpecFor(len(x.Keys), x.Aggs)
		schema := x.Child.Schema()
		c.emit("AggOpen", a, 0, 0, spec, "")
		c.produce(x.Child, func(regs []int) {
			env := envFor(schema, regs)
			keys := make([]int, len(x.Keys))
			for i, k := range x.Keys {
				keys[i] = c.expr(k, env)
			}
			args := make([]int, len(x.Aggs))
			for i, ag := range x.Aggs {
				if ag.Star {
					args[i] = c.constant(int64(1))
				} else {
					args[i] = c.expr(ag.Arg, env)
				}
			}
			firstKey := 0
			if len(keys) > 0 {
				firstKey = c.contiguous(keys)
			}
			firstArg := 0
			if len(args) > 0 {
				firstArg = c.contiguous(args)
			}
			c.emit("AggStep", a, firstKey, len(keys), firstArg, "")
		})
		rewind := c.emit("AggRewind", a, 0, 0, nil, "end of input; iterate groups")
		loop := c.here()
		consume(c.readColumns("AggColumn", a, x.Schema()))
		c.emit("AggNext", a, loop, 0, nil, "")
		c.prog.Insts[rewind].P2 = c.here()

	case *Sort:
		s := c.prog.NSort
		c.prog.NSort++
		schema := x.Child.Schema()
		c.emit("SorterOpen", s, 0, 0, x.Keys, "")
		c.produce(x.Child, func(regs []int) {
			first := c.contiguous(regs)
			c.emit("SorterInsert", s, first, len(regs), nil, "")
		})
		sorted := c.emit("SorterSort", s, 0, 0, nil, "")
		loop := c.here()
		consume(c.readColumns("SorterColumn", s, schema))
		c.emit("SorterNext", s, loop, 0, nil, "")
		c.prog.Insts[sorted].P2 = c.here()

	case *Limit:
		if x.N <= 0 {
			c.halts = append(c.halts, c.emit("Goto", 0, 0, 0, nil, "LIMIT 0"))
			return
		}
		counter := c.reg()
		c.emit("Const", 0, counter, 0, x.N, fmt.Sprintf("LIMIT %d", x.N))
		c.produce(x.Child, func(regs []int) {
			consume(regs)
			c.halts = append(c.halts, c.emit("DecrJumpZero", counter, 0, 0, nil, "stop after the last row"))
		})

	default:
		fail("cannot compile %T", n)
	}
}

// Listing prints a program in the style of SQLite's EXPLAIN.
func (p *Program) Listing() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%-4s  %-13s %4s %4s %4s  %-22s %s\n", "addr", "opcode", "p1", "p2", "p3", "p4", "comment")
	fmt.Fprintf(&b, "%-4s  %-13s %4s %4s %4s  %-22s %s\n", "----", "-------------", "----", "----", "----", strings.Repeat("-", 22), "-------")
	for i, in := range p.Insts {
		fmt.Fprintf(&b, "%-4d  %-13s %4d %4d %4d  %-22s %s\n", i, in.Op, in.P1, in.P2, in.P3, p4Text(in.P4), in.Comment)
	}
	return b.String()
}

func p4Text(p4 any) string {
	switch x := p4.(type) {
	case nil:
		return ""
	case string:
		return x
	case []SortKey:
		parts := make([]string, len(x))
		for i, k := range x {
			parts[i] = fmt.Sprintf("%d", k.Idx)
			if k.Desc {
				parts[i] += " DESC"
			}
		}
		return "k(" + strings.Join(parts, ",") + ")"
	case AggSpec:
		parts := make([]string, len(x.Fns))
		for i, f := range x.Fns {
			if f.Star {
				parts[i] = f.Fn + "(*)"
			} else {
				parts[i] = f.Fn
			}
		}
		return fmt.Sprintf("keys=%d %s", x.NKeys, strings.Join(parts, ","))
	case RangeSpec:
		return fmt.Sprintf("%s lo=r%d hi=r%d", x.Index, x.LoReg, x.HiReg)
	case int:
		return fmt.Sprintf("r%d", x)
	}
	return Render(Lit{p4})
}
