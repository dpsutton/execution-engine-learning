package engine

import (
	"encoding/json"
	"fmt"
	"strings"
)

// The VM runs a Program one instruction at a time. Its entire state is VMState: a program counter,
// registers, cursors, and the hash tables / sorters / aggregate tables the program has built. None
// of it lives on the Go call stack, which is the whole trick:
//
//   - ResultRow returns a row to the caller mid-loop; the next Step picks up at pc.
//   - Step(fuel) stops after fuel instructions, so a caller can bound work and cancel cleanly.
//   - Snapshot serializes VMState to JSON; RestoreVM continues from it, even in another process.

// Status says why Step returned.
type Status int

const (
	StatusRow Status = iota
	StatusDone
	StatusOutOfFuel
)

func (s Status) String() string { return [...]string{"row", "done", "out of fuel"}[s] }

// Cursor walks a table: every row (a scan) or the row ids an index lookup returned.
type Cursor struct {
	Table  string `json:"table"`
	Pos    int    `json:"pos"`
	Index  bool   `json:"index,omitempty"`
	RowIDs []int  `json:"row_ids,omitempty"`
}

// VMState is everything that changes while a program runs.
type VMState struct {
	PC       int          `json:"pc"`
	Regs     Vals         `json:"regs"`
	Cursors  []Cursor     `json:"cursors"`
	Hash     []*HashTable `json:"hash"`
	Sorters  []*Sorter    `json:"sorters"`
	Aggs     []*AggTable  `json:"aggs"`
	Halted   bool         `json:"halted"`
	Executed int          `json:"executed"` // instructions run so far, across restores
}

type VM struct {
	Prog  *Program
	DB    *DB
	State VMState
}

func NewVM(p *Program, db *DB) *VM {
	return &VM{Prog: p, DB: db, State: VMState{
		Regs:    make(Vals, p.NRegs),
		Cursors: make([]Cursor, p.NCursors),
		Hash:    make([]*HashTable, p.NHash),
		Sorters: make([]*Sorter, p.NSort),
		Aggs:    make([]*AggTable, p.NAgg),
	}}
}

// Snapshot serializes the VM's state. The program and database are not included: they don't
// change while the query runs, so a restorer brings its own.
func (vm *VM) Snapshot() ([]byte, error) { return json.Marshal(vm.State) }

// RestoreVM rebuilds a VM from a snapshot taken by Snapshot.
func RestoreVM(p *Program, db *DB, snapshot []byte) (*VM, error) {
	vm := &VM{Prog: p, DB: db}
	if err := json.Unmarshal(snapshot, &vm.State); err != nil {
		return nil, err
	}
	return vm, nil
}

func (vm *VM) row(c *Cursor) []Value {
	t := vm.DB.Table(c.Table)
	if c.Index {
		return t.Rows[c.RowIDs[c.Pos]]
	}
	return t.Rows[c.Pos]
}

func (vm *VM) index(spec string) (*Table, *BTree) {
	i := strings.IndexByte(spec, '.')
	t := vm.DB.Table(spec[:i])
	idx, ok := t.Indexes[spec[i+1:]]
	if !ok {
		fail("no index on %s", spec)
	}
	return t, idx
}

// Step runs at most fuel instructions. It returns a row when the program reaches ResultRow,
// StatusDone at Halt, or StatusOutOfFuel when the budget runs out first.
func (vm *VM) Step(fuel int) (row []Value, status Status, err error) {
	defer recoverEval(&err)
	s := &vm.State
	r := s.Regs
	for ; fuel > 0; fuel-- {
		if s.Halted {
			return nil, StatusDone, nil
		}
		in := vm.Prog.Insts[s.PC]
		s.PC++
		s.Executed++
		switch in.Op {
		case "Init", "Goto":
			s.PC = in.P2
		case "Halt":
			s.Halted = true
			return nil, StatusDone, nil

		// ---- table cursors
		case "OpenScan":
			s.Cursors[in.P1] = Cursor{Table: in.P4.(string)}
		case "Rewind":
			c := &s.Cursors[in.P1]
			c.Pos = 0
			if len(vm.DB.Table(c.Table).Rows) == 0 {
				s.PC = in.P2
			}
		case "Next":
			c := &s.Cursors[in.P1]
			c.Pos++
			if c.Pos < len(vm.DB.Table(c.Table).Rows) {
				s.PC = in.P2
			}
		case "Column":
			r[in.P3] = vm.row(&s.Cursors[in.P1])[in.P2]

		// ---- index cursors
		case "SeekIndex":
			t, idx := vm.index(in.P4.(string))
			var ids []int
			if key := r[in.P2]; key != nil {
				ids = idx.Search(key)
			}
			s.Cursors[in.P1] = Cursor{Table: t.Name, Index: true, RowIDs: ids}
			if len(ids) == 0 {
				s.PC = in.P3
			}
		case "IndexRange":
			spec := in.P4.(RangeSpec)
			t, idx := vm.index(spec.Index)
			var lo, hi Value
			if spec.LoReg >= 0 {
				lo = r[spec.LoReg]
			}
			if spec.HiReg >= 0 {
				hi = r[spec.HiReg]
			}
			ids := idx.Range(lo, hi, spec.LoIncl, spec.HiIncl)
			s.Cursors[in.P1] = Cursor{Table: t.Name, Index: true, RowIDs: ids}
			if len(ids) == 0 {
				s.PC = in.P3
			}
		case "IndexNext":
			c := &s.Cursors[in.P1]
			c.Pos++
			if c.Pos < len(c.RowIDs) {
				s.PC = in.P2
			}

		// ---- registers and expressions
		case "Const":
			r[in.P2] = in.P4
		case "Copy":
			r[in.P2] = r[in.P1]
		case "Add", "Sub", "Mul", "Div":
			r[in.P3] = Arith(arithOps[in.Op], r[in.P1], r[in.P2])
		case "Eq", "Ne", "Lt", "Le", "Gt", "Ge":
			r[in.P3] = CmpOp(cmpOps[in.Op], r[in.P1], r[in.P2])
		case "And":
			r[in.P3] = And3(r[in.P1], r[in.P2])
		case "Or":
			r[in.P3] = Or3(r[in.P1], r[in.P2])
		case "Not":
			r[in.P3] = Not3(r[in.P1])
		case "IsNull":
			r[in.P3] = r[in.P1] == nil
		case "NotNull":
			r[in.P3] = r[in.P1] != nil
		case "Func":
			r[in.P3] = CallFunc(in.P4.(string), r[in.P1:in.P1+in.P2])
		case "IfNot":
			if !Truthy(r[in.P1]) {
				s.PC = in.P2
			}
		case "If":
			if Truthy(r[in.P1]) {
				s.PC = in.P2
			}
		case "DecrJumpZero":
			r[in.P1] = r[in.P1].(int64) - 1
			if r[in.P1].(int64) == 0 {
				s.PC = in.P2
			}
		case "ResultRow":
			// pc already points past this instruction, so the next Step resumes right here.
			return append([]Value(nil), r[in.P1:in.P1+in.P2]...), StatusRow, nil

		// ---- hash tables (hash join)
		case "HashOpen":
			s.Hash[in.P1] = NewHashTable()
		case "HashInsert":
			s.Hash[in.P1].Insert(r[in.P2], r[in.P3:in.P3+in.P4.(int)])
		case "HashSeek":
			if !s.Hash[in.P1].Seek(r[in.P2]) {
				s.PC = in.P3
			}
		case "HashNext":
			if s.Hash[in.P1].Advance() {
				s.PC = in.P2
			}
		case "HashColumn":
			r[in.P3] = s.Hash[in.P1].Current()[in.P2]

		// ---- sorters
		case "SorterOpen":
			s.Sorters[in.P1] = &Sorter{Keys: in.P4.([]SortKey)}
		case "SorterInsert":
			s.Sorters[in.P1].Insert(r[in.P2 : in.P2+in.P3])
		case "SorterSort":
			so := s.Sorters[in.P1]
			so.Sort()
			if len(so.Rows) == 0 {
				s.PC = in.P2
			}
		case "SorterNext":
			so := s.Sorters[in.P1]
			so.Pos++
			if so.Pos < len(so.Rows) {
				s.PC = in.P2
			}
		case "SorterColumn":
			so := s.Sorters[in.P1]
			r[in.P3] = so.Rows[so.Pos][in.P2]

		// ---- aggregate tables
		case "AggOpen":
			s.Aggs[in.P1] = NewAggTable(in.P4.(AggSpec))
		case "AggStep":
			t := s.Aggs[in.P1]
			firstArg := in.P4.(int)
			t.Step(r[in.P2:in.P2+in.P3], r[firstArg:firstArg+len(t.Spec.Fns)])
		case "AggRewind":
			t := s.Aggs[in.P1]
			t.Finish()
			if len(t.Keys) == 0 {
				s.PC = in.P2
			}
		case "AggNext":
			t := s.Aggs[in.P1]
			t.Pos++
			if t.Pos < len(t.Keys) {
				s.PC = in.P2
			}
		case "AggColumn":
			t := s.Aggs[in.P1]
			r[in.P3] = t.Row(t.Pos)[in.P2]

		default:
			return nil, 0, fmt.Errorf("unknown opcode %s at %d", in.Op, s.PC-1)
		}
	}
	return nil, StatusOutOfFuel, nil
}

var arithOps = map[string]string{"Add": "+", "Sub": "-", "Mul": "*", "Div": "/"}
var cmpOps = map[string]string{"Eq": "=", "Ne": "!=", "Lt": "<", "Le": "<=", "Gt": ">", "Ge": ">="}

// RunVM executes a program to completion and returns its rows.
func RunVM(p *Program, db *DB) ([][]Value, error) {
	vm := NewVM(p, db)
	var rows [][]Value
	for {
		row, st, err := vm.Step(10_000)
		if err != nil {
			return nil, err
		}
		switch st {
		case StatusRow:
			rows = append(rows, row)
		case StatusDone:
			return rows, nil
		}
	}
}
