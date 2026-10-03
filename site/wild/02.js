EE.addWild("02", [
 {
  "id": "02-cockroachdb-filterer-next",
  "engine": "CockroachDB",
  "repo": "cockroachdb/cockroach",
  "sha": "d30c905fff79ef825adc96bcc647f1872a90f2ff",
  "path": "pkg/sql/rowexec/filterer.go",
  "lang": "go",
  "title": "<code>filtererProcessor.Next</code>: a pull-based filter, in Go",
  "prompt": "Compare this with our <code>Filter.Next</code>. Where does it pull again after a rejected row, and what is the second return value that ours doesn't have?",
  "notes": "<p>The same loop as the post's Filter: pull from <code>f.input.Next()</code>, evaluate the predicate, return the row if it passes, otherwise go around again. CockroachDB's <code>RowSource.Next</code> (<code>execinfra/base.go</code>) returns a row <em>or</em> a <code>ProducerMetadata</code>, an out-of-band channel for errors, stats, and tracing that travels up the same pull path as the data.</p><p>Ending is a state machine rather than a boolean: an exhausted input or an error calls <code>MoveToDraining</code>, and from then on <code>Next</code> only hands back metadata from <code>DrainHelper</code>. Projection and LIMIT ride along on every processor: its output goes through <code>ProcessRowHelper</code>, and <code>ProcOutputHelper.ProcessRow</code> (<code>execinfra/processorsbase.go</code>) renders columns and counts rows against <code>maxRowIdx</code> = offset + limit. Reaching it moves the processor to draining, which is our Limit fused into whatever operator sits below it.</p>",
  "segments": [
   {
    "start": 83,
    "end": 111,
    "code": "func (f *filtererProcessor) Next() (rowenc.EncDatumRow, *execinfrapb.ProducerMetadata) {\n\tfor f.State == execinfra.StateRunning {\n\t\trow, meta := f.input.Next()\n\n\t\tif meta != nil {\n\t\t\tif meta.Err != nil {\n\t\t\t\tf.MoveToDraining(nil /* err */)\n\t\t\t}\n\t\t\treturn nil, meta\n\t\t}\n\t\tif row == nil {\n\t\t\tf.MoveToDraining(nil /* err */)\n\t\t\tbreak\n\t\t}\n\n\t\t// Perform the actual filtering.\n\t\tpasses, err := f.filter.EvalFilter(f.Ctx(), row)\n\t\tif err != nil {\n\t\t\tf.MoveToDraining(err)\n\t\t\tbreak\n\t\t}\n\t\tif passes {\n\t\t\tif outRow := f.ProcessRowHelper(row); outRow != nil {\n\t\t\t\treturn outRow, nil\n\t\t\t}\n\t\t}\n\t}\n\treturn nil, f.DrainHelper()\n}"
   }
  ]
 },
 {
  "id": "02-mysql-limit-offset",
  "engine": "MySQL",
  "repo": "mysql/mysql-server",
  "sha": "3b99be40f8a31d9396cad10accfd3ba51647d613",
  "path": "sql/iterators/composite_iterators.cc",
  "lang": "cpp",
  "title": "<code>LimitOffsetIterator::DoRead</code>: LIMIT, OFFSET, and the case that won't stop early",
  "prompt": "Find the branch where LIMIT is reached but the iterator keeps reading its child anyway. What would make a LIMIT do that?",
  "notes": "<p>MySQL 8's executor is iterators all the way down. <code>RowIterator</code> has <code>Init()</code> (which also rewinds) and <code>Read()</code>, which returns 0 for a row, -1 at the end, and 1 on error. The row isn't returned at all: it's written into the table's record buffer, which the parent then reads. Here <code>m_limit</code> already includes the offset, as the header documents, and the OFFSET rows are skipped lazily on the first <code>Read()</code>, not in <code>Init()</code>.</p><p>The interesting part is <code>m_count_all_rows</code>. With <code>SQL_CALC_FOUND_ROWS</code> the query must also report how many rows there would have been, so after reaching the limit it keeps calling <code>m_source-&gt;Read()</code> to the end. The header says it outright: \"you will not get any performance benefits of early end.\" The early exit from part 2 is something the iterator model lets you have, and a feature can still take it away.</p>",
  "segments": [
   {
    "start": 164,
    "end": 207,
    "code": "int LimitOffsetIterator::DoRead() {\n  if (m_seen_rows >= m_limit) {\n    // We either have hit our LIMIT, or we need to skip OFFSET rows.\n    // Check which one.\n    if (m_needs_offset) {\n      // We skip OFFSET rows here and not in Init(), since performance schema\n      // batch mode may not be set up by the executor before the first Read().\n      // This makes sure that\n      //\n      //   a) we get the performance benefits of batch mode even when reading\n      //      OFFSET rows, and\n      //   b) we don't inadvertedly enable batch mode (e.g. through the\n      //      NestedLoopIterator) during Init(), since the executor may not\n      //      be ready to _disable_ it if it gets an error before first Read().\n      for (ha_rows row_idx = 0; row_idx < m_offset; ++row_idx) {\n        int err = m_source->Read();\n        if (err != 0) {\n          // Note that we'll go back into this loop if Init() is called again,\n          // and return the same error/EOF status.\n          return err;\n        }\n        if (m_skipped_rows != nullptr) {\n          ++*m_skipped_rows;\n        }\n        m_source->UnlockRow();\n      }\n      m_seen_rows = m_offset;\n      m_needs_offset = false;\n\n      // Fall through to LIMIT testing.\n    }\n\n    if (m_seen_rows >= m_limit) {\n      // We really hit LIMIT (or hit LIMIT immediately after OFFSET finished),\n      // so EOF.\n      if (m_count_all_rows) {\n        // Count rows until the end or error (ignore the error if any).\n        while (m_source->Read() == 0) {\n          ++*m_skipped_rows;\n        }\n      }\n      return -1;\n    }\n  }"
   }
  ]
 },
 {
  "id": "02-datafusion-limit-stream",
  "engine": "DataFusion",
  "repo": "apache/datafusion",
  "sha": "801b017bb8824e577593ac6deefad6a425cc6ac3",
  "path": "datafusion/physical-plan/src/limit.rs",
  "lang": "rust",
  "title": "<code>LimitStream</code>: pull, but asynchronous and a batch at a time",
  "prompt": "How does this LIMIT stop its input early? Find the line, then think about what happens to the operators below when it runs.",
  "notes": "<p>DataFusion's operators are Rust async <code>Stream</code>s. The parent calls <code>poll_next</code>, and the result is <code>Ready(Some(batch))</code>, <code>Ready(None)</code> at the end, or <code>Pending</code> when the input isn't ready yet (for example, waiting on I/O). That's our <code>Next()</code> with a third answer, \"not yet, call me back\", and the stream's fields hold all the state needed to resume, as our iterators' fields do.</p><p>Because rows arrive in batches, LIMIT slices instead of counting: <code>batch.slice(0, batch_rows)</code> keeps just enough rows from the batch that crosses the limit. <code>self.input = None</code> then drops the whole input stream, and with it every operator below. That's how early termination reaches the scan, without a separate <code>Close()</code>.</p>",
  "segments": [
   {
    "start": 692,
    "end": 712,
    "code": "    fn stream_limit(&mut self, batch: RecordBatch) -> Option<RecordBatch> {\n        // records time on drop\n        let _timer = self.baseline_metrics.elapsed_compute().timer();\n        if self.fetch == 0 {\n            self.input = None; // Clear input so it can be dropped early\n            None\n        } else if batch.num_rows() < self.fetch {\n            //\n            self.fetch -= batch.num_rows();\n            Some(batch)\n        } else if batch.num_rows() >= self.fetch {\n            let batch_rows = self.fetch;\n            self.fetch = 0;\n            self.input = None; // Clear input so it can be dropped early\n\n            // It is guaranteed that batch_rows is <= batch.num_rows\n            Some(batch.slice(0, batch_rows))\n        } else {\n            unreachable!()\n        }\n    }"
   },
   {
    "start": 718,
    "end": 738,
    "code": "    fn poll_next(\n        mut self: Pin<&mut Self>,\n        cx: &mut Context<'_>,\n    ) -> Poll<Option<Self::Item>> {\n        let fetch_started = self.skip == 0;\n        let poll = match &mut self.input {\n            Some(input) => {\n                let poll = if fetch_started {\n                    input.poll_next_unpin(cx)\n                } else {\n                    self.poll_and_skip(cx)\n                };\n\n                poll.map(|x| match x {\n                    Some(Ok(batch)) => Ok(self.stream_limit(batch)).transpose(),\n                    other => other,\n                })\n            }\n            // Input has been cleared\n            None => Poll::Ready(None),\n        };"
   }
  ]
 },
 {
  "id": "02-duckdb-limit-sink",
  "engine": "DuckDB",
  "repo": "duckdb/duckdb",
  "sha": "fc9d6e93409a2dc412b658cade45b963371cd033",
  "path": "src/execution/operator/helper/physical_limit.cpp",
  "lang": "cpp",
  "title": "<code>PhysicalLimit::Sink</code>: LIMIT in a push engine",
  "prompt": "In a pull engine, LIMIT stops by not asking its child for more. Here nobody asks: chunks are pushed into it. How does it tell the scan to stop?",
  "notes": "<p>DuckDB turns the iterator model inside out (the \"push\" direction from part 2's last section). A pipeline's source produces chunks and the executor pushes each chunk through the operators into a <em>sink</em>. LIMIT is a sink. It keeps what it needs from each chunk, slicing the one that crosses the limit, and returns <code>SinkResultType::FINISHED</code> once it has enough. In <code>pipeline_executor.cpp</code> that result calls <code>FinishProcessing()</code>, and the pipeline stops fetching from its source.</p><p>The operators in the middle report through <code>OperatorResultType</code> (<code>NEED_MORE_INPUT</code>, <code>HAVE_MORE_OUTPUT</code>, <code>FINISHED</code>, <code>BLOCKED</code>): a pull engine's control flow, written as return codes. Part 7 builds the same push shape, compiled to bytecode.</p>",
  "segments": [
   {
    "start": 116,
    "end": 137,
    "code": "SinkResultType PhysicalLimit::Sink(ExecutionContext &context, DataChunk &chunk, OperatorSinkInput &input) const {\n\tD_ASSERT(chunk.size() > 0);\n\tauto &state = input.local_state.Cast<LimitLocalState>();\n\tauto &limit = state.limit;\n\tauto &offset = state.offset;\n\n\tidx_t max_element;\n\tif (!ComputeOffset(context, chunk, limit, offset, state.current_offset, max_element, limit_val, offset_val)) {\n\t\treturn SinkResultType::FINISHED;\n\t}\n\tauto max_cardinality = max_element - state.current_offset;\n\tif (max_cardinality < chunk.size()) {\n\t\t// truncate the chunk to the first max_cardinality rows\n\t\tchunk.Slice(0, max_cardinality);\n\t}\n\tstate.data.Append(chunk, state.partition_info.batch_index.GetIndex());\n\tstate.current_offset += chunk.size();\n\tif (state.current_offset == max_element) {\n\t\treturn SinkResultType::FINISHED;\n\t}\n\treturn SinkResultType::NEED_MORE_INPUT;\n}"
   }
  ]
 }
]);
