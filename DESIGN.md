# Design spec

The shared contract for the blog posts, the Go code, and the Clojure code. Anything here is binding on
all three; anything not here is the implementer's call. Learning-grade: clarity over speed, no
concurrency, no persistence, everything in memory.

## Layout

```
execution-engine/
  README.md                 overview + reading list
  DESIGN.md                 this file
  queries/golden.sql        golden queries (one per line, `--` comments)
  site/                     static site, open site/index.html directly (file:// must work)
    index.html
    posts/01-expressions.html … 07-bytecode.html
    assets/style.css  assets/common.js  assets/viz/NN-*.js
  go/                       module `execengine`, go 1.25, stdlib only
    lessonNN/               standalone package per lesson (no imports between lessons)
    cmd/lessonNN/main.go    runnable demo per lesson
    engine/                 integrated engine (may be split into sub-packages)
    cmd/engine/main.go      CLI/REPL
  clojure/                  deps.edn; :test alias (cognitect test-runner); clojure 1.12; no other deps
    src/lessonNN/<name>.clj standalone ns per lesson with -main demo
    src/engine/*.clj        integrated engine; engine.main is the CLI/REPL
    test/…
```

Lessons are **standalone**: each one copies the small bits it needs from earlier lessons (value
helpers, a Scan operator, …) rather than importing them, so a reader can open one directory and see
everything. The integrated engine is the one place code is shared.

## The seven lessons

| # | Slug | Topic | Code contents |
|---|------|-------|---------------|
| 1 | expressions | Rows, values, expression trees, NULL 3-valued logic | Expr AST; `Eval` (tree walk); `Compile` (closure compilation) |
| 2 | iterators | Operators as pull iterators (Volcano) | `Operator` interface; Scan, Filter, Project, Limit; tracing |
| 3 | joins | Nested loop, hash, sort-merge; inner + left outer | NLJoin, HashJoin, MergeJoin; comparison counters |
| 4 | aggregation | Hash vs sort aggregation; sorting; external merge sort; top-N | HashAggregate, SortAggregate, Sort, ExternalSort, TopN |
| 5 | indexes | B+tree; index scans; index nested-loop join | BPlusTree (configurable order), IndexScan, IndexNLJoin; node-visit counters |
| 6 | planner | Statistics, selectivity, cardinality, cost, join ordering | Analyze → ColumnStats + equi-depth histogram; estimator; DP join ordering; EXPLAIN with est vs actual |
| 7 | bytecode | Compile plans to register bytecode; resumable VM | produce/consume compiler; VM with `Step` + fuel; Snapshot/Restore |

Then the **integrated engine**: SQL text → parser → binder → logical plan → planner (stats) → physical
plan → executed by either the Volcano operators or the bytecode VM.

## Values

| Kind | Go | Clojure |
|------|----|---------|
| NULL | `nil` | `nil` |
| integer | `int64` | `long` |
| float | `float64` | `double` |
| string | `string` | `String` |
| boolean | `bool` | `Boolean` |

Go: `type Value = any`. A row is a positional slice/vector of values; a schema is an ordered list of
qualified column names `"table.col"` (aliases replace the table part: `"c.name"`).

Semantics:

- Arithmetic `+ - *`: int∘int → int; any float → float. `/` **always** returns float. Any NULL → NULL.
  Division by zero → NULL.
- Comparison `= != < <= > >=`: NULL if either side NULL. ints and floats compare numerically; strings
  lexicographically (byte order); bools false<true. Comparing different kinds otherwise is an error.
- `AND`/`OR`/`NOT`: SQL three-valued logic (false AND NULL = false, true OR NULL = true, …).
- A predicate passes a row only if it evaluates to exactly `true` (NULL filters the row out).
- Functions: `lower(s)`, `upper(s)`, `length(s)`, `coalesce(a, b, …)`, `abs(x)`. NULL in → NULL out
  (except coalesce).
- `IS NULL` / `IS NOT NULL`.
- Equality for grouping, hashing, DISTINCT-ish purposes: NULL groups with NULL (SQL GROUP BY rule), but
  NULL never matches NULL in a join key.
- Sort order: ascending by the comparison above, **NULLs last** in both ASC and DESC. Stable sort.

### Expression AST

Go: structs implementing `Expr` (`Col{Name}`, `Lit{V}`, `Bin{Op, L, R}`, `Not{E}`, `IsNull{E, Negate}`,
`Func{Name, Args}`, and in the engine `Agg{Fn, Arg, Star}`).
Clojure: vectors, hiccup-style:

```clojure
[:col "orders.qty"]  [:lit 3]  [:+ a b]  [:and a b]  [:not e]  [:is-null e]  [:is-not-null e]
[:fn "lower" e]      [:agg "sum" e]  [:agg "count" :*]
```

Binary op keywords/strings: `+ - * / = != < <= > >= and or`.

## Operators (lessons 2–6, engine)

Pull iterator, identical shape in both languages:

```
Open()                 -- allocate state, open children
Next() -> (row, ok)    -- ok=false when exhausted
Close()
Schema() -> []string
```

Clojure: a protocol `Operator` with `open! next! close! schema`; `next!` returns a row vector or `nil`
at end. Mutable state via `volatile!`/atoms is fine — this mirrors the Go code on purpose.

Deterministic output orders (needed for cross-language agreement):

- HashJoin: build = right child, probe = left child. Output in probe order; for each probe row,
  matches in build insertion order. Left outer: unmatched probe rows padded with NULLs.
- NLJoin: outer = left, inner = right (rewound per outer row).
- HashAggregate: output groups in **first-seen order** (Go: map to index + ordered slice, never range
  over a map for output).
- Aggregates: `count(*)`, `count(x)` (non-null), `sum`, `min`, `max`, `avg` (float). sum/min/max of
  zero non-null inputs → NULL; count → 0. sum of ints is int.
- With no GROUP BY, aggregation over empty input still yields one row.

## Datasets

### Toy dataset (posts, lesson demos, visuals)

```
customers(id, name, city, age)
  (1, "Ada", "Austin", 36)
  (2, "Bo",  "Boston", NULL)
  (3, "Cy",  "Austin", 52)
  (4, "Di",  "Denver", 29)

orders(id, customer_id, product_id, qty)
  (10, 1, 100, 2)
  (11, 1, 101, 1)
  (12, 3, 100, 5)
  (13, 4, 102, 1)
  (14, 9, 101, 3)      -- customer 9 doesn't exist (orphan; shows up in outer joins)
                       -- customer 2 (Bo) has no orders
products(id, name, category, price)
  (100, "Pen",   "tools", 1.50)
  (101, "Atlas", "books", 24.00)
  (102, "Chess", "games", 18.25)
```

### Generated dataset (lesson 5/6 demos, integrated engine, golden tests)

PRNG — 64-bit LCG (shared spec for convenience; cross-language parity is not a goal):

```
state := seed                      (uint64; seed = 42)
next():  state = state * 6364136223846793005 + 1442695040888963407   (mod 2^64)
         return state >>> 33       (unsigned shift; result in [0, 2^31))
intn(n): return next() mod n
```

Clojure: `unchecked-multiply`, `unchecked-add`, `unsigned-bit-shift-right`.

One stream, generated in this order; within a row, draw randoms in exactly the listed order.

```
cities     = ["Austin","Boston","Chicago","Denver","Miami","Oakland","Portland","Seattle"]
categories = ["books","games","garden","music","tools"]

customers: for id in 1..200
  name = "cust" + id
  r = intn(100)
  city = r < 40 ? cities[0] : r < 60 ? cities[1] : r < 72 ? cities[2] : cities[3 + intn(5)]
  age  = 18 + intn(60);  if id % 17 == 0 then age = NULL   (draw happens regardless)

products: for id in 1..50
  name     = "prod" + id
  category = categories[intn(5)]
  price    = float(100 + intn(9900)) / 100.0

orders: for id in 1..5000
  r = intn(100)
  customer_id = r < 50 ? 1 + intn(20) : 1 + intn(200)
  product_id  = 1 + intn(50)
  qty         = 1 + intn(5)
  day         = 1 + intn(365)
```

Indexes in the integrated engine (B+tree, order 32): `customers.id`, `products.id`, `orders.id`,
`orders.customer_id`, `orders.product_id`.

## Statistics & cost (lesson 6, engine)

Per column: `rows`, `nulls`, `ndv`, `min`, `max`, equi-depth histogram with 8 buckets (bucket = upper
bound + count). Selectivity rules:

- `col = const`: 1/ndv (non-null fraction aware: × (rows−nulls)/rows)
- `col < / <= / > / >= const`: histogram fraction (linear interpolation inside a bucket for numbers)
- `col IS NULL`: nulls/rows
- `a AND b` → s(a)·s(b); `a OR b` → s(a)+s(b)−s(a)s(b); `NOT a` → 1−s(a); unknown → 1/3
- equi-join `L.a = R.b`: |L|·|R| / max(ndv(a), ndv(b))

Cost units (rough, documented in the post): scan = rows; filter = input rows; hash join =
2·build + probe; NL join = outer · inner; index NL join = outer · (log₂(inner) + matches/outer);
sort = n·log₂(n); hash agg = input rows. Join ordering: Selinger-style DP over subsets, left-deep, up
to ~6 relations, choosing the cheapest algorithm per join (hash / NL / index NL when the inner side is
a base table with an index on its join column).

## Bytecode VM (lesson 7, engine)

Register machine modeled on SQLite's VDBE. Program = list of instructions `{op, p1, p2, p3, p4,
comment}` (unused params 0/nil). State = `pc`, `regs []Value`, `cursors`, `hashTables`, `sorters`,
`aggTables`, `fuel`, `halted`. Everything that is state must be plain data so it can be snapshotted.

Instruction set (minimum; add if needed, document in the post):

```
Init         -        jump target to start            (p2 = addr)
Goto         -        p2 = addr
Halt
OpenScan     p1=cursor  p4=table name
Rewind       p1=cursor  p2=addr if empty
Next         p1=cursor  p2=addr to jump to if more rows
Column       p1=cursor  p2=column idx  p3=dest reg
Integer/Const p2=dest reg  p4=value
Copy         p1=src reg  p2=dest reg
Add Sub Mul Div   p1=a reg  p2=b reg  p3=dest
Eq Ne Lt Le Gt Ge p1=a  p2=b  p3=dest        (3VL result in dest)
And Or Not IsNull NotNull   p1,p2 → p3
Func         p4=name  p1=first arg reg  p2=nargs  p3=dest
IfNot        p1=reg  p2=addr     jump unless reg is exactly true
If           p1=reg  p2=addr
DecrJumpZero p1=reg  p2=addr     reg -= 1; jump if now 0          (LIMIT)
ResultRow    p1=first reg  p2=n  -- yields a row to the caller; pc advances first
SeekIndex    p1=cursor  p4=table.col  p2=key reg  p3=addr if no match   (positions on first match)
IndexNext    p1=cursor  p2=addr if another match
HashOpen     p1=hash table id
HashInsert   p1=ht  p2=key reg  p3=first row reg  p4=n regs
HashSeek     p1=ht  p2=key reg  p3=addr if no match
HashNext     p1=ht  p2=addr if another match
HashColumn   p1=ht  p2=col idx  p3=dest
SorterOpen   p1=sorter id  p4=sort key spec
SorterInsert p1=sorter  p2=first reg  p3=n
SorterSort   p1=sorter  p2=addr if empty
SorterNext   p1=sorter  p2=addr if more
SorterColumn p1=sorter  p2=col idx  p3=dest
AggOpen      p1=agg table id  p4=agg spec
AggStep      p1=agg table  p2=first key reg  p3=n keys  p4=first value reg
AggRewind    p1=agg table  p2=addr if empty
AggNext      p1=agg table  p2=addr if more
AggColumn    p1=agg table  p2=col idx (keys then finalized aggs)  p3=dest
```

API:

```
vm := NewVM(program, db)
vm.Step(fuel) -> (row, status)    status ∈ Row | Done | OutOfFuel
vm.Snapshot() -> bytes/data       (Go: JSON; Clojure: EDN string)
RestoreVM(program, db, snapshot) -> vm   (continues exactly where it left off)
```

Each executed instruction costs 1 fuel. Compiler is produce/consume (Neumann 2011, same shape SQLite
emits): `compile(node, consume)` where `consume(regs)` emits the code for "one row is available in
these registers". Pipeline breakers (hash build, sort, aggregate) end one loop and start another.
Listing format mirrors SQLite `EXPLAIN`: `addr  opcode  p1 p2 p3 p4  comment`.

## Integrated engine SQL subset

```
SELECT expr [AS alias], … | *
FROM table [alias] [, table [alias]]… [JOIN table [alias] ON expr]…
[WHERE expr] [GROUP BY expr, …] [HAVING expr] [ORDER BY expr [ASC|DESC], …] [LIMIT n]
EXPLAIN <select>          -- physical plan with estimated rows and cost
```

Inner joins only (comma joins + `JOIN … ON`), so the planner may reorder freely. Identifiers
case-insensitive, string literals single-quoted. Unqualified column names resolve if unambiguous.

CLI: `go run ./cmd/engine [-vm] [-e "SQL"]` / `clojure -M -m engine.main [--vm] [-e "SQL"]`;
without `-e`, a REPL. Meta-commands: `\vm` (toggle executor), `\explain on|off`, `\program` (print
bytecode for next query), `\stats table`, `\q`.

Canonical result output (golden comparison): header `col | col | …`, then one line per row, values
joined by ` | `; NULL → `NULL`; floats `%.2f`; ints decimal; bools `true`/`false`; final line
`(N rows)`.

Output column names: the alias if given; else a bare column name (`c.name` → `name`); else the
expression's SQL text (`count(*)`, `count(age)`). ORDER BY resolves SELECT aliases first; GROUP BY
resolves input columns first. NULL keys are never inserted into hash tables or indexes. The engines
add `IndexRange` (p1=cursor, p3=addr if empty, p4={index, lo, hi}) for range IndexScans.

Golden: `queries/golden.sql`, one query per line. Each implementation has a test running every
golden query through both executors (Volcano and VM) and asserting identical output. **Go ↔ Clojure parity is not a goal** — don't add complexity for it.

## Learning aids

**Exercise markers** (reference lessons only, never the engine). Wrap the body region a reader should
write themselves; `uv run tools/make_exercises.py` copies lessons + tests to `go/exercises/lessonNN`
and `clojure/ex/exercises/lessonNN` (ns `exercises.lessonNN.*`, run with `clojure -M:ex -d ex`) with
each region replaced by a throwing TODO, writes `EXERCISES.md`, and checks that exercise tests fail
and reference tests pass.

```go
func (j *HashJoin) Next() (Row, bool) {
	// EXERCISE(hash-join-probe): For the current probe row, look its key up in the table built in
	// Open and emit one joined row per match; pad with NULLs for left outer when nothing matched.
	...reference code...
	// END EXERCISE
}
```
```clojure
;; EXERCISE(hash-join-probe): …hint…
…complete, balanced forms…
;; END EXERCISE
```

Rules: a region is the *whole* body of one function or method (or a contiguous run of complete
forms), so the stub compiles (Go: no variable declared before the region may become unused; the
generator removes now-unused imports). 2–4 exercises per lesson, aimed at the mechanism the post
teaches, each covered by a test that fails with the TODO. Hints say what to do, not how.
Exercise ids: kebab-case, unique per lesson, same id in Go and Clojure for the same function.

**Predict-then-reveal**: `EE.predict(mount, {prompt, number|choices, answer, explain, onLock})` in
`common.js`. 1–2 per post, on misconceptions; the figure runs after the guess is locked.

**Cards**: `site/assets/cards/NN.js` = `EE.addCards("NN", [ …strict JSON… ])`, each
`{"id": "NN-slug", "q": html, "a": html, "warmup": true?}`. 8–12 per post; test mechanisms and
reasons, not trivia; answers 1–3 sentences. Mark 3 `"warmup": true` (they open the next post).
Posts include `<div data-warmup></div>` right after the dek, and a `.build-it` callout naming the
lesson's exercises and test commands.
