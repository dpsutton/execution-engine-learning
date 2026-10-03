EE.addWild("04", [
 {
  "id": "04-datafusion-avg-accumulator",
  "engine": "DataFusion",
  "repo": "apache/datafusion",
  "sha": "801b017bb8824e577593ac6deefad6a425cc6ac3",
  "path": "datafusion/functions-aggregate/src/average.rs",
  "lang": "rust",
  "title": "<code>AvgAccumulator</code>: avg&rsquo;s state is (sum, count), and states merge",
  "prompt": "Map this onto part 4&rsquo;s <code>init</code> / <code>step</code> / <code>final</code>. Which method is <code>step</code>, which is <code>final</code>, and what are <code>state()</code> and <code>merge_batch()</code> for?",
  "notes": "<p><code>update_batch</code> is <code>step</code>, but over a whole Arrow array at once: add the non-null count and the array&rsquo;s sum. <code>evaluate</code> is <code>final</code>, and like ours it returns NULL when no non-null value was seen. The state really is the pair: <code>sum: Option&lt;f64&gt;</code> and <code>count: u64</code>.</p><p><code>state()</code> exports that pair and <code>merge_batch</code> adds other accumulators&rsquo; pairs into this one: counts summed, sums summed. That&rsquo;s the \"two threads each aggregate half, then add their pairs\" from part 4, made into an interface every aggregate implements. <code>retract_batch</code> goes the other way (subtract values leaving a sliding window frame), which our engine has no need for.</p>",
  "segments": [
   {
    "start": 620,
    "end": 636,
    "code": "/// An accumulator to compute the average\n#[derive(Debug, Default)]\npub struct AvgAccumulator {\n    sum: Option<f64>,\n    count: u64,\n}\n\nimpl Accumulator for AvgAccumulator {\n    fn update_batch(&mut self, values: &[ArrayRef]) -> Result<()> {\n        let values = values[0].as_primitive::<Float64Type>();\n        self.count += (values.len() - values.null_count()) as u64;\n        if let Some(x) = sum(values) {\n            let v = self.sum.get_or_insert(0.);\n            *v += x;\n        }\n        Ok(())\n    }"
   },
   {
    "start": 638,
    "end": 638,
    "code": "    fn evaluate(&mut self) -> Result<ScalarValue> {"
   },
   {
    "start": 643,
    "end": 649,
    "code": "        let avg = if self.count == 0 {\n            None\n        } else {\n            self.sum.map(|f| f / self.count as f64)\n        };\n        Ok(ScalarValue::Float64(avg))\n    }"
   },
   {
    "start": 655,
    "end": 672,
    "code": "    fn state(&mut self) -> Result<Vec<ScalarValue>> {\n        Ok(vec![\n            ScalarValue::from(self.count),\n            ScalarValue::Float64(self.sum),\n        ])\n    }\n\n    fn merge_batch(&mut self, states: &[ArrayRef]) -> Result<()> {\n        // counts are summed\n        self.count += sum(states[0].as_primitive::<UInt64Type>()).unwrap_or_default();\n\n        // sums are summed\n        if let Some(x) = sum(states[1].as_primitive::<Float64Type>()) {\n            let v = self.sum.get_or_insert(0.);\n            *v += x;\n        }\n        Ok(())\n    }"
   }
  ]
 },
 {
  "id": "04-duckdb-topn-heap",
  "engine": "DuckDB",
  "repo": "duckdb/duckdb",
  "sha": "fc9d6e93409a2dc412b658cade45b963371cd033",
  "path": "src/execution/operator/order/physical_top_n.cpp",
  "lang": "cpp",
  "title": "<code>TopNHeap</code>: ORDER BY … LIMIT as a bounded max-heap",
  "prompt": "Find our TopN&rsquo;s two cases: the heap is not full yet, and the heap is full and a new row arrives. Where is the \"one comparison and it&rsquo;s gone\" check?",
  "notes": "<p><code>EntryShouldBeAdded</code> is the cheap reject: if the heap is full and the new sort key is not smaller than <code>heap.front()</code> (the largest key kept, since <code>std::push_heap</code> builds a max-heap), the row is skipped after one comparison. Otherwise <code>AddEntryToHeap</code> pops the current worst and pushes the new entry. The heap holds <code>limit + offset</code> entries (<code>heap_size</code> in the constructor).</p><p>Two differences from ours. The sort keys are encoded into byte strings (<code>string_t</code>) that compare correctly with a plain <code>&lt;</code>, so a multi-column ORDER BY with NULL ordering becomes one byte comparison. And rows arrive a vector at a time; a few lines down, <code>CheckBoundaryValues</code> uses a boundary value shared between threads to filter a whole vector before any of it reaches the heap.</p>",
  "segments": [
   {
    "start": 141,
    "end": 167,
    "code": "\tinline bool EntryShouldBeAdded(const string_t &sort_key) {\n\t\tif (heap_size == 0) {\n\t\t\t// the heap has no capacity (LIMIT 0) - no entry can ever be added\n\t\t\treturn false;\n\t\t}\n\t\tif (heap.size() < heap_size) {\n\t\t\t// heap is not full yet - the entry can be added\n\t\t\treturn true;\n\t\t}\n\t\tif (sort_key < heap.front().sort_key) {\n\t\t\t// sort key is smaller than current max value\n\t\t\treturn true;\n\t\t}\n\t\t// heap is full and there is no room for the entry\n\t\treturn false;\n\t}\n\n\tinline void AddEntryToHeap(const TopNEntry &entry) {\n\t\tD_ASSERT(heap_size > 0);\n\t\tif (heap.size() >= heap_size) {\n\t\t\tD_ASSERT(!heap.empty());\n\t\t\tstd::pop_heap(heap.begin(), heap.end());\n\t\t\theap.pop_back();\n\t\t}\n\t\theap.push_back(entry);\n\t\tstd::push_heap(heap.begin(), heap.end());\n\t}"
   },
   {
    "start": 254,
    "end": 265,
    "code": "\tfor (idx_t r = 0; r < input.size(); r++) {\n\t\tauto &sort_key = sort_key_values[r];\n\t\tif (!EntryShouldBeAdded(sort_key)) {\n\t\t\tcontinue;\n\t\t}\n\t\t// replace the previous top entry with the new entry\n\t\tTopNEntry entry;\n\t\tentry.sort_key = sort_key_heap.AddBlob(sort_key);\n\t\tentry.index = base_index + match_count;\n\t\tAddEntryToHeap(entry);\n\t\tmatching_sel.set_index(match_count++, r);\n\t}"
   }
  ]
 },
 {
  "id": "04-clickhouse-choose-method",
  "engine": "ClickHouse",
  "repo": "ClickHouse/ClickHouse",
  "sha": "bd202925d0d4a9e560455035284251b5f7be1cd7",
  "path": "src/Interpreters/AggregatedDataVariants.cpp",
  "lang": "cpp",
  "title": "<code>chooseMethod</code>: a different hash table for every shape of GROUP BY key",
  "prompt": "Our <code>HashAggregate</code> uses one map for every key. What does ClickHouse look at to pick its hash table, and what is the fallback when nothing special applies?",
  "notes": "<p>Before aggregating, ClickHouse inspects the GROUP BY key types and picks a specialized hash table. A single 1-byte key gets <code>key8</code> (in <code>AggregatedDataVariants.h</code> that variant is a <code>FixedHashMap</code>, effectively an array indexed by the key); 8-byte numbers get <code>key64</code>; several fixed-width keys that fit in 16 or 32 bytes are packed into one wide integer (<code>keys128</code>, <code>keys256</code>). Only when nothing fits does it fall back to <code>serialized</code>, which, per its doc comment in <code>AggregationMethod.h</code>, concatenates the serialized key values into one byte string and groups by that.</p><p>Same algorithm as our hash aggregate. The difference is that a lookup&rsquo;s cost depends heavily on the key&rsquo;s representation, and an engine grouping billions of rows earns real speed by treating keys as integers whenever it can. The other variants in this file (two-level, low-cardinality, nullable) apply the same idea again.</p>",
  "segments": [
   {
    "start": 302,
    "end": 304,
    "code": "AggregatedDataVariants::Type AggregatedDataVariants::chooseMethod(\n    const Block & header, const Names & keys, Sizes & out_key_sizes)\n{"
   },
   {
    "start": 433,
    "end": 436,
    "code": "    /// No key has been found to be nullable.\n\n    /// Single numeric key.\n    if (keys_size == 1 && types_removed_nullable[0]->isValueRepresentedByNumber())"
   },
   {
    "start": 457,
    "end": 468,
    "code": "        if (size_of_field == 1)\n            return Type::key8;\n        if (size_of_field == 2)\n            return Type::key16;\n        if (size_of_field == 4)\n            return Type::key32;\n        if (size_of_field == 8)\n            return Type::key64;\n        if (size_of_field == 16)\n            return Type::keys128;\n        if (size_of_field == 32)\n            return Type::keys256;"
   },
   {
    "start": 479,
    "end": 480,
    "code": "    /// If all keys fits in N bits, will use hash table with all keys packed (placed contiguously) to single N-bit key.\n    if (keys_size == num_fixed_contiguous_keys)"
   },
   {
    "start": 490,
    "end": 499,
    "code": "        if (keys_bytes <= 2)\n            return Type::keys16;\n        if (keys_bytes <= 4)\n            return Type::keys32;\n        if (keys_bytes <= 8)\n            return Type::keys64;\n        if (keys_bytes <= 16)\n            return Type::keys128;\n        if (keys_bytes <= 32)\n            return Type::keys256;"
   },
   {
    "start": 512,
    "end": 516,
    "code": "    if (keys_size > 1 && all_keys_are_numbers_or_strings)\n        return Type::prealloc_serialized;\n\n    return Type::serialized;\n}"
   }
  ]
 },
 {
  "id": "04-sqlite-external-sort",
  "engine": "SQLite",
  "repo": "sqlite/sqlite",
  "sha": "cb547ab3e931c7766e24834af5ef6c4578863e3d",
  "path": "src/vdbesort.c",
  "lang": "c",
  "title": "The VdbeSorter: external merge sort, with runs called PMAs",
  "prompt": "Find part 4&rsquo;s two phases in this comment. What is SQLite&rsquo;s name for a run, how much memory does it use before spilling, and how many runs does it merge at once?",
  "notes": "<p>Run generation: records are buffered in memory and, once they exceed a threshold (page size × cache size), sorted and written to a temp file as a \"level-0 PMA\". That is part 4&rsquo;s sorted run. Merge: <code>Rewind()</code> is the pipeline break, the point where every row has been written. In single-threaded mode with few enough PMAs, they are then merged incrementally as the VDBE reads keys, so the merge streams instead of producing one big sorted file first.</p><p>With more than <code>SORTER_MAX_MERGE_COUNT</code> PMAs (defined as 16 further down the file), it builds a hierarchy of merges, none wider than 16, for locality: the multi-pass case our figure counts. The skipped part of the comment covers the multi-threaded variant, where worker threads sort and write PMAs and a background thread merges ahead of the reader.</p>",
  "segments": [
   {
    "start": 69,
    "end": 89,
    "code": "** Algorithm:\n**\n** Records passed to the sorter via calls to Write() are initially held\n** unsorted in main memory. Assuming the amount of memory used never exceeds\n** a threshold, when Rewind() is called the set of records is sorted using\n** an in-memory merge sort. In this case, no temporary files are required\n** and subsequent calls to Rowkey(), Next() and Compare() read records\n** directly from main memory.\n**\n** If the amount of space used to store records in main memory exceeds the\n** threshold, then the set of records currently in memory are sorted and\n** written to a temporary file in \"Packed Memory Array\" (PMA) format.\n** A PMA created at this point is known as a \"level-0 PMA\". Higher levels\n** of PMAs may be created by merging existing PMAs together - for example\n** merging two or more level-0 PMAs together creates a level-1 PMA.\n**\n** The threshold for the amount of main memory to use before flushing\n** records to a PMA is roughly the same as the limit configured for the\n** page-cache of the main database. Specifically, the threshold is set to\n** the value returned by \"PRAGMA main.page_size\" multiplied by\n** that returned by \"PRAGMA main.cache_size\", in bytes."
   },
   {
    "start": 105,
    "end": 113,
    "code": "** When Rewind() is called, any data remaining in memory is flushed to a\n** final PMA. So at this point the data is stored in some number of sorted\n** PMAs within temporary files on disk.\n**\n** If there are fewer than SORTER_MAX_MERGE_COUNT PMAs in total and the\n** sorter is running in single-threaded mode, then these PMAs are merged\n** incrementally as keys are retrieved from the sorter by the VDBE.  The\n** MergeEngine object, described in further detail below, performs this\n** merge."
   },
   {
    "start": 124,
    "end": 129,
    "code": "** If there are more than SORTER_MAX_MERGE_COUNT PMAs in total when\n** Rewind() is called, then a hierarchy of incremental-merges is used.\n** First, T bytes of data from the first SORTER_MAX_MERGE_COUNT PMAs on\n** disk are merged together. Then T bytes of data from the second set, and\n** so on, such that no operation ever merges more than SORTER_MAX_MERGE_COUNT\n** PMAs at a time. This done is to improve locality."
   }
  ]
 }
]);
