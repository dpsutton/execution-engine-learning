# Execution Engine

A learning project: build a SQL query execution engine from scratch, in seven parts, in both Go and
Clojure. Pitched at the level of sqlglot's Python executor: no robustness, no persistence, nothing
production about it. The goal is to understand how an AST turns into something that produces rows,
and to work up to a planner driven by statistics and a resumable bytecode VM like SQLite's.

## Read

Open `docs/index.html` in a browser (it works straight from `file://`; no build step). On GitHub,
Pages can serve it as-is: Settings → Pages → deploy from branch, folder `/docs`. Seven posts, each with
pseudocode and interactive figures:

1. **Expressions**: rows, values, tree-walking evaluation, three-valued logic, closure compilation
2. **Iterators**: the Volcano model (Scan, Filter, Project, Limit)
3. **Joins**: nested loop, hash, sort-merge; outer joins
4. **Aggregation & sorting**: hash vs. sort aggregation, external merge sort, top-N
5. **Indexes**: B+trees, index scans, index nested-loop joins
6. **Statistics & planning**: histograms, selectivity, cardinality, cost, DP join ordering
7. **Bytecode**: produce/consume compilation to a register VM; fuel, snapshot, resume

## Run

```bash
# Go (stdlib only)
cd go
go run ./cmd/lesson03            # any lesson's demo
go run ./cmd/engine              # REPL; -e "SQL" for one-shot, -vm to use the bytecode VM
go test ./...

# Clojure
cd clojure
clojure -M -m lesson03.joins     # any lesson's demo
clojure -M -m engine.main        # REPL; -e "SQL", --vm
clojure -X:test
```

In the REPL: `\vm` toggles the executor, `\explain on`, `\program` prints the bytecode for the next
query, `\stats orders`, `\q`.

Each engine runs `queries/golden.sql` through both of its executors (iterators and bytecode VM)
and checks they agree. Go and Clojure aren't required to match each other (they currently do,
but nothing depends on it).

## Layout

```
DESIGN.md          the shared contract: values, semantics, dataset, operators, VM instruction set
queries/           golden queries
docs/              the blog posts (static HTML, vanilla JS figures)
go/                lessonNN/ standalone lessons, engine/ integrated, cmd/
clojure/           src/lessonNN/ standalone lessons, src/engine/ integrated
```

## Further reading

- **SQLite, "The SQLite Bytecode Engine"** (sqlite.org/opcode.html), and running `EXPLAIN` on your
  own queries in the `sqlite3` shell. The model for part 7.
- **Goetz Graefe, "Volcano — An Extensible and Parallel Query Evaluation System"** (1994). The
  pull-iterator model from part 2.
- **Boncz, Zukowski, Nes, "MonetDB/X100: Hyper-Pipelining Query Execution"** (CIDR 2005).
  Vectorized execution: run each operator over batches to amortize the interpretation overhead.
- **Thomas Neumann, "Efficiently Compiling Efficient Query Plans for Modern Hardware"** (VLDB 2011).
  Push-based, data-centric pipelines compiled to machine code; the produce/consume compiler in part 7.
- **Kersten, Leis, Kemper, Neumann, Pavlo, Boncz, "Everything You Always Wanted to Know About
  Compiled and Vectorized Queries But Were Afraid to Ask"** (VLDB 2018). The head-to-head comparison
  of the two models.
- **Toby Mao, "Writing a Python SQL engine from scratch"** (sqlglot `posts/python_sql_engine.md`).
  The inspiration for this project's level.

Also relevant to parts 5–6:

- **Selinger et al., "Access Path Selection in a Relational Database Management System"** (SIGMOD
  1979). The original cost-based optimizer and DP join ordering.
- **Leis et al., "How Good Are Query Optimizers, Really?"** (VLDB 2015). Shows how wrong cardinality
  estimates get, and that they matter more than the cost model.
