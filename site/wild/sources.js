window.SOURCE_BLURBS = {
  "PostgreSQL": "C, row-oriented heap storage. Plans run as a tree of pull-style executor nodes (Volcano); expressions compile to a flat step program for an interpreter, optionally JIT-compiled with LLVM. A cost-based planner searches join orders exhaustively for small queries and with a genetic algorithm (GEQO) past a threshold.",
  "SQLite": "C, embedded, one database file. SQL compiles to bytecode for the VDBE register machine; every table and index is a B-tree. The model for part 7.",
  "DuckDB": "C++, embedded and analytical, columnar. Plans are split into pipelines that push vectors (chunks of rows) from a source through operators into a sink, scheduled as parallel tasks.",
  "CockroachDB": "Go, distributed SQL on a replicated, transactional key-value store. Has a row-at-a-time engine and a vectorized columnar one, and a cost-based optimizer built around a memo of equivalent plans.",
  "MySQL": "C++, with pluggable storage engines; InnoDB stores each table as a B+tree clustered on the primary key. The executor is a tree of row iterators and supports hash joins.",
  "ClickHouse": "C++, column-oriented OLAP. Processes data in blocks of columns with heavily specialized code paths (e.g. per-key-type hash tables for GROUP BY); MergeTree tables are sorted by key with a sparse index.",
  "DataFusion": "Rust, built on Apache Arrow's columnar format. Physical plan nodes produce async streams of record batches (pull-based, vectorized); used as an embeddable engine.",
  "Spark SQL": "Scala on the JVM, distributed. The Catalyst optimizer rewrites plans; whole-stage code generation fuses each pipeline of operators into one generated Java function.",
  "bbolt": "Go, an embedded key-value store (a fork of BoltDB): one file holding a copy-on-write B+tree, with a single writer and many concurrent readers. No SQL, just the index structure from part 5."
};
