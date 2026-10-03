// Command engine is the integrated execution engine's CLI and REPL.
//
//	go run ./cmd/engine                         REPL
//	go run ./cmd/engine -e "SELECT …"           one query
//	go run ./cmd/engine -vm -e "SELECT …"       …on the bytecode VM
//	go run ./cmd/engine -golden ../queries/golden.sql
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"execengine/engine"
)

func main() {
	useVM := flag.Bool("vm", false, "execute with the bytecode VM instead of Volcano iterators")
	sql := flag.String("e", "", "run one SQL statement and exit")
	golden := flag.String("golden", "", "run every query in a golden file, print canonical output")
	flag.Parse()

	eng := engine.New()

	switch {
	case *golden != "":
		queries, err := engine.ReadGolden(*golden)
		if err != nil {
			fatal(err)
		}
		out, err := eng.Golden(queries, *useVM)
		if err != nil {
			fatal(err)
		}
		fmt.Print(out)
	case *sql != "":
		r := &repl{eng: eng, vm: *useVM}
		if !r.run(*sql) {
			os.Exit(1)
		}
	default:
		(&repl{eng: eng, vm: *useVM}).loop()
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

type repl struct {
	eng         *engine.Engine
	vm          bool
	explain     bool
	showProgram bool
}

func (r *repl) executor() string {
	if r.vm {
		return "bytecode VM"
	}
	return "volcano iterators"
}

func (r *repl) loop() {
	fmt.Printf("execution engine — %s\n", r.eng.DB.Describe())
	fmt.Println(`indexes: ` + strings.Join(r.eng.DB.IndexNames(), ", "))
	fmt.Println(`commands: \vm  \explain on|off  \program  \stats <table>  \q   (queries end at newline or ;)`)
	in := bufio.NewScanner(os.Stdin)
	var buf strings.Builder
	prompt := func() {
		if buf.Len() == 0 {
			fmt.Print("sql> ")
		} else {
			fmt.Print("...> ")
		}
	}
	prompt()
	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		switch {
		case buf.Len() == 0 && strings.HasPrefix(line, `\`):
			if !r.meta(line) {
				return
			}
		case line == "" && buf.Len() == 0:
		default:
			buf.WriteString(line + " ")
			// A statement ends at a semicolon, or at the end of a line that parses on its own.
			text := strings.TrimSpace(buf.String())
			if strings.HasSuffix(text, ";") || parses(text) {
				buf.Reset()
				r.run(text)
			}
		}
		prompt()
	}
	fmt.Println()
}

func parses(sql string) bool {
	_, err := engine.Parse(sql)
	return err == nil || !strings.Contains(err.Error(), "end of input")
}

func (r *repl) meta(line string) bool {
	fields := strings.Fields(line)
	switch fields[0] {
	case `\q`, `\quit`:
		return false
	case `\vm`:
		r.vm = !r.vm
		fmt.Println("executor:", r.executor())
	case `\explain`:
		r.explain = len(fields) < 2 || fields[1] == "on"
		fmt.Println("explain:", map[bool]string{true: "on", false: "off"}[r.explain])
	case `\program`:
		r.showProgram = true
		fmt.Println("will print the bytecode for the next query")
	case `\stats`:
		if len(fields) < 2 {
			for _, name := range r.eng.DB.Order {
				fmt.Print(r.eng.DB.Tables[name].Stats.Format(r.eng.DB.Tables[name]))
			}
			break
		}
		t, ok := r.eng.DB.Tables[strings.ToLower(fields[1])]
		if !ok {
			fmt.Println("no such table", fields[1])
			break
		}
		fmt.Print(t.Stats.Format(t))
	default:
		fmt.Println(`unknown command; try \vm \explain on|off \program \stats <table> \q`)
	}
	return true
}

// run executes one statement and prints the result; false on error.
func (r *repl) run(sql string) bool {
	p, err := r.eng.Prepare(sql)
	if err != nil {
		fmt.Println("error:", err)
		return false
	}
	if p.Query.Explain || r.explain {
		fmt.Print(engine.Explain(p.Plan))
		if p.Query.Explain {
			return true
		}
	}
	if r.showProgram {
		r.showProgram = false
		prog, err := p.Program()
		if err != nil {
			fmt.Println("error:", err)
			return false
		}
		fmt.Print(prog.Listing())
	}
	start := time.Now()
	res, err := r.eng.Run(p, r.vm)
	if err != nil {
		fmt.Println("error:", err)
		return false
	}
	fmt.Print(res.Pretty())
	fmt.Printf("%s in %s\n", r.executor(), time.Since(start).Round(time.Microsecond))
	return true
}
