EE.addWild("03", [
 {
  "id": "03-postgres-hashjoin-states",
  "engine": "PostgreSQL",
  "repo": "postgres/postgres",
  "sha": "6f3bdadaadc4692050ca20dff53d3890088b9272",
  "path": "src/backend/executor/nodeHashjoin.c",
  "lang": "c",
  "title": "<code>ExecHashJoinImpl</code>: the whole join is a <code>switch</code> on <code>hj_JoinState</code>",
  "prompt": "Our <code>HashJoin</code> keeps <code>cur</code> (the probe row) and its position in <code>matches</code> as fields, so the next <code>Next()</code> picks up mid-bucket. Which fields of <code>node</code> play those roles, and which one is the left-outer \"did anything match?\" bit?",
  "notes": "<p>Every call loops over a <code>switch</code> on <code>node-&gt;hj_JoinState</code>. When a joined row is returned from <code>HJ_SCAN_BUCKET</code>, the state is left at <code>HJ_SCAN_BUCKET</code>, so the next call resumes scanning the same bucket. <code>hj_CurTuple</code> is the position in the bucket (our index into <code>matches</code>), the outer slot set into <code>econtext</code> is our <code>cur</code>, and <code>hj_MatchedOuter</code> is the outer-join bit that <code>HJ_FILL_OUTER_TUPLE</code> checks before emitting a NULL-padded row. Postgres calls the probe side \"outer\" and the build side \"inner\".</p><p>The big difference from ours is batches. In the lines skipped after <code>hj_CurTuple = NULL</code>, a probe row whose hash maps to a later batch is written to <code>hashtable-&gt;outerBatchFile[batchno]</code> and skipped for now. That is how Postgres runs a hash join whose build side does not fit in memory: both sides are partitioned by hash into batches, joined one batch at a time.</p>",
  "segments": [
   {
    "start": 269,
    "end": 269,
    "code": "\t\tswitch (node->hj_JoinState)"
   },
   {
    "start": 435,
    "end": 446,
    "code": "\t\t\tcase HJ_NEED_NEW_OUTER:\n\n\t\t\t\t/*\n\t\t\t\t * We don't have an outer tuple, try to get the next one\n\t\t\t\t */\n\t\t\t\tif (parallel)\n\t\t\t\t\touterTupleSlot =\n\t\t\t\t\t\tExecParallelHashJoinOuterGetTuple(outerNode, node,\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t  &hashvalue);\n\t\t\t\telse\n\t\t\t\t\touterTupleSlot =\n\t\t\t\t\t\tExecHashJoinOuterGetTuple(outerNode, node, &hashvalue);"
   },
   {
    "start": 489,
    "end": 490,
    "code": "\t\t\t\tecontext->ecxt_outertuple = outerTupleSlot;\n\t\t\t\tnode->hj_MatchedOuter = false;"
   },
   {
    "start": 496,
    "end": 501,
    "code": "\t\t\t\tnode->hj_CurHashValue = hashvalue;\n\t\t\t\tExecHashGetBucketAndBatch(hashtable, hashvalue,\n\t\t\t\t\t\t\t\t\t\t  &node->hj_CurBucketNo, &batchno);\n\t\t\t\tnode->hj_CurSkewBucketNo = ExecHashGetSkewBucket(hashtable,\n\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t hashvalue);\n\t\t\t\tnode->hj_CurTuple = NULL;"
   },
   {
    "start": 531,
    "end": 536,
    "code": "\t\t\t\t/* OK, let's scan the bucket for matches */\n\t\t\t\tnode->hj_JoinState = HJ_SCAN_BUCKET;\n\n\t\t\t\tpg_fallthrough;\n\n\t\t\tcase HJ_SCAN_BUCKET:"
   },
   {
    "start": 550,
    "end": 557,
    "code": "\t\t\t\telse\n\t\t\t\t{\n\t\t\t\t\tif (!ExecScanHashBucket(node, econtext))\n\t\t\t\t\t{\n\t\t\t\t\t\t/* out of matches; check for possible outer-join fill */\n\t\t\t\t\t\tnode->hj_JoinState = HJ_FILL_OUTER_TUPLE;\n\t\t\t\t\t\tcontinue;\n\t\t\t\t\t}"
   },
   {
    "start": 632,
    "end": 635,
    "code": "\t\t\t\tnode->hj_JoinState = HJ_NEED_NEW_OUTER;\n\n\t\t\t\tif (!node->hj_MatchedOuter &&\n\t\t\t\t\tHJ_FILL_OUTER(node))"
   }
  ]
 },
 {
  "id": "03-cockroach-hashjoiner",
  "engine": "CockroachDB",
  "repo": "cockroachdb/cockroach",
  "sha": "d30c905fff79ef825adc96bcc647f1872a90f2ff",
  "path": "pkg/sql/colexec/colexecjoin/hashjoiner.go",
  "lang": "go",
  "title": "<code>hashJoiner.Next</code>: the same state machine, in Go, a batch at a time",
  "prompt": "Compare with the Postgres states. Which state exists here only for right and full outer joins, and what does <code>Next()</code> return instead of a single row?",
  "notes": "<p>Build, probe, optionally emit leftovers from the build side, done: the same shape as Postgres, as a Go <code>for</code>/<code>switch</code>. <code>Next()</code> returns a <code>coldata.Batch</code>, which the <code>coldata</code> package documents as a set of column vectors plus a selection vector. This is CockroachDB&rsquo;s vectorized engine, so part 2&rsquo;s per-call overhead is paid once per batch instead of once per row.</p><p><code>hjEmittingRight</code> is the full outer join step from part 3: after the probe side is exhausted, walk the build table (<code>emittingRightState.rowIdx</code>) and emit the rows that never matched, which requires <code>trackBuildMatches</code>. <code>CancelChecker.CheckEveryCall()</code> at the top of the loop checks the query&rsquo;s context for cancellation on every call (and does CPU admission control), the same \"check between units of work\" idea as part 7&rsquo;s fuel.</p>",
  "segments": [
   {
    "start": 38,
    "end": 43,
    "code": "\t// hjEmittingRight represents the state the hashJoiner is in when it is\n\t// emitting only either unmatched or matched rows from its build table\n\t// after having consumed the probe table. Unmatched rows are emitted for\n\t// right/full outer and right anti joins whereas matched rows are emitted\n\t// for right semi joins.\n\thjEmittingRight"
   },
   {
    "start": 291,
    "end": 328,
    "code": "func (hj *hashJoiner) Next() (coldata.Batch, *execinfrapb.ProducerMetadata) {\n\tfor {\n\t\thj.ht.CancelChecker.CheckEveryCall()\n\t\tswitch hj.state {\n\t\tcase hjBuilding:\n\t\t\tmeta := hj.build()\n\t\t\tif meta != nil {\n\t\t\t\treturn nil, meta\n\t\t\t}\n\t\t\tif hj.ht.Vals.Length() == 0 {\n\t\t\t\t// The build side is empty, so we might be able to\n\t\t\t\t// short-circuit probing phase altogether.\n\t\t\t\tif hj.spec.JoinType.IsEmptyOutputWhenRightIsEmpty() {\n\t\t\t\t\thj.state = hjDone\n\t\t\t\t}\n\t\t\t}\n\t\t\tcontinue\n\t\tcase hjProbing:\n\t\t\toutput, meta := hj.exec()\n\t\t\tif meta != nil {\n\t\t\t\treturn nil, meta\n\t\t\t}\n\t\t\tif output.Length() == 0 {\n\t\t\t\tif hj.spec.trackBuildMatches {\n\t\t\t\t\thj.state = hjEmittingRight\n\t\t\t\t} else {\n\t\t\t\t\thj.state = hjDone\n\t\t\t\t}\n\t\t\t\tcontinue\n\t\t\t}\n\t\t\treturn output, nil\n\t\tcase hjEmittingRight:\n\t\t\tif hj.emittingRightState.rowIdx == hj.ht.Vals.Length() {\n\t\t\t\thj.state = hjDone\n\t\t\t\tcontinue\n\t\t\t}\n\t\t\thj.emitRight(hj.spec.JoinType == descpb.RightSemiJoin /* matched */)\n\t\t\treturn hj.output, nil"
   }
  ]
 },
 {
  "id": "03-mysql-hashjoin-spill",
  "engine": "MySQL",
  "repo": "mysql/mysql-server",
  "sha": "3b99be40f8a31d9396cad10accfd3ba51647d613",
  "path": "sql/iterators/hash_join_iterator.cc",
  "lang": "cpp",
  "title": "<code>HashJoinIterator::BuildHashTable</code>: when the build side does not fit",
  "prompt": "Our hash join assumes the build side fits in memory. Find the moment MySQL learns it does not, and what it does with the rest of the build input.",
  "notes": "<p>The loop reads build rows and stores them in <code>m_row_buffer</code>, the in-memory hash table. When <code>StoreRow</code> returns <code>BUFFER_FULL</code>, MySQL keeps the rows already in memory and writes the <em>remaining</em> build rows to chunk files on disk. A row&rsquo;s chunk is chosen from its join-key hash (<code>join_key_hash &amp; (chunks-&gt;size() - 1)</code>, a few hundred lines up), so matching build and probe rows land in the same chunk pair.</p><p>The comment explains a deliberate choice: probe rows are first checked against the rows already in memory, and only then written to probe chunk files, so the work of filling the buffer is not wasted. <code>ReadNextHashJoinChunk</code> later joins the chunk files pair by pair. If spilling is not allowed (<code>m_allow_spill_to_disk</code> false), it probes with what fits and refills the table, which the comment at the top of the function describes as re-filling \"multiple times\". Same partition-to-fit idea as part 4&rsquo;s external sort.</p>",
  "segments": [
   {
    "start": 532,
    "end": 533,
    "code": "  for (;;) {  // Termination condition within loop.\n    int res = m_build_input->Read();"
   },
   {
    "start": 562,
    "end": 571,
    "code": "    const hash_join_buffer::StoreRowResult store_row_result =\n        m_row_buffer.StoreRow(thd(), reject_duplicate_keys);\n    switch (store_row_result) {\n      case hash_join_buffer::StoreRowResult::ROW_STORED:\n        break;\n      case hash_join_buffer::StoreRowResult::BUFFER_FULL: {\n        // The row buffer is full, so start spilling to disk (if allowed). Note\n        // that the row buffer checks for OOM _after_ the row was inserted, so\n        // we should always manage to insert at least one row.\n        assert(!m_row_buffer.empty());"
   },
   {
    "start": 573,
    "end": 575,
    "code": "        // If we are not allowed to spill to disk, just go on to reading from\n        // the probe iterator.\n        if (!m_allow_spill_to_disk) {"
   },
   {
    "start": 587,
    "end": 591,
    "code": "        if (InitializeChunkFiles(\n                m_estimated_build_rows, m_row_buffer.size(),\n                m_probe_input_tables, m_build_input_tables,\n                /*include_match_flag_for_probe=*/m_join_type == JoinType::OUTER,\n                &m_chunk_files_on_disk)) {"
   },
   {
    "start": 596,
    "end": 608,
    "code": "        // Write out the remaining rows from the build input out to chunk files.\n        // The probe input will be written out to chunk files later; we will do\n        // it _after_ we have checked the probe input for matches against the\n        // rows that are already written to the hash table. An alternative\n        // approach would be to write out the remaining rows from the build\n        // _and_ the rows that already are in the hash table. In that case, we\n        // could also write out the entire probe input to disk here as well. But\n        // we don't want to waste the rows that we already have stored in\n        // memory.\n        //\n        // We never write out rows with NULL in condition for the build/right\n        // input, as these rows will never match in a join condition.\n        if (WriteBuildTableToChunkFiles()) {"
   },
   {
    "start": 623,
    "end": 624,
    "code": "        SetReadingProbeRowState();\n        return false;"
   }
  ]
 },
 {
  "id": "03-sqlite-autoindex",
  "engine": "SQLite",
  "repo": "sqlite/sqlite",
  "sha": "cb547ab3e931c7766e24834af5ef6c4578863e3d",
  "path": "src/where.c",
  "lang": "c",
  "title": "Every join is a nested loop; with no index, SQLite builds one on the spot",
  "prompt": "SQLite&rsquo;s planner emits nested loops only. What does it build when the inner table has no usable index on the join column, and what does the planner charge for building it?",
  "notes": "<p>The first comment is SQLite&rsquo;s whole join strategy: one nested loop per table in the FROM clause, ordered to make the best use of indexes. When the inner table has no index on the join column, the planner can create an <em>automatic index</em>, a transient B-tree filled once from that table (<code>constructAutomaticIndex</code> emits <code>OP_OpenAutoindex</code> and an <code>OP_IdxInsert</code> loop). After that, each outer row does a seek instead of a scan: part 5&rsquo;s index nested-loop join.</p><p>That transient index does the job of a hash join&rsquo;s build side, sorted instead of hashed. The second excerpt prices it at about X·N·log₂N with X = 7 for tables, and much cheaper for views and subqueries, which can never have a real index. The <code>TUNING</code> constants are hand-picked, which is how most real cost models look up close.</p>",
  "segments": [
   {
    "start": 6759,
    "end": 6774,
    "code": "** The basic idea is to do a nested loop, one loop for each table in\n** the FROM clause of a select.  (INSERT and UPDATE statements are the\n** same as a SELECT with only a single table in the FROM clause.)  For\n** example, if the SQL is this:\n**\n**       SELECT * FROM t1, t2, t3 WHERE ...;\n**\n** Then the code generated is conceptually like the following:\n**\n**      foreach row1 in t1 do       \\    Code generated\n**        foreach row2 in t2 do      |-- by sqlite3WhereBegin()\n**          foreach row3 in t3 do   /\n**            ...\n**          end                     \\    Code generated\n**        end                        |-- by sqlite3WhereEnd()\n**      end                         /"
   },
   {
    "start": 4091,
    "end": 4105,
    "code": "        /* TUNING: One-time cost for computing the automatic index is\n        ** estimated to be X*N*log2(N) where N is the number of rows in\n        ** the table being indexed and where X is 7 (LogEst=28) for normal\n        ** tables or 0.5 (LogEst=-10) for views and subqueries.  The value\n        ** of X is smaller for views and subqueries so that the query planner\n        ** will be more aggressive about generating automatic indexes for\n        ** those objects, since there is no opportunity to add schema\n        ** indexes on subqueries and views. */\n        pNew->rSetup = rLogSize + rSize;\n        if( !IsView(pTab) && (pTab->tabFlags & TF_Ephemeral)==0 ){\n          pNew->rSetup += 28;\n        }else{\n          pNew->rSetup -= 25;  /* Greatly reduced setup cost for auto indexes\n                               ** on ephemeral materializations of views */\n        }"
   }
  ]
 }
]);
