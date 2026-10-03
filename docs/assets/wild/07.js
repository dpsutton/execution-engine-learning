EE.addWild("07", [
 {
  "id": "07-sqlite-resultrow",
  "engine": "SQLite",
  "repo": "sqlite/sqlite",
  "sha": "cb547ab3e931c7766e24834af5ef6c4578863e3d",
  "path": "src/vdbe.c",
  "lang": "c",
  "title": "sqlite3VdbeExec: one loop, one switch, and a row is a <code>return</code>",
  "prompt": "Where does SQLite save the program counter before handing a row back to the caller? And where does the next <code>sqlite3_step()</code> pick up?",
  "notes": "<p>The loop starts at <code>aOp[p-&gt;pc]</code>, so resuming a statement is just entering the loop again at the saved address. <code>OP_ResultRow</code> doesn't copy the row: <code>p-&gt;pResultRow</code> points at registers <code>r(P1)…</code>, then <code>p-&gt;pc</code> is set to the <em>next</em> instruction and the function returns <code>SQLITE_ROW</code>. That's our <code>ResultRow</code> case: advance the pc first, then return the registers.</p><p>One difference: SQLite's registers (<code>Mem</code>) and cursors point into C memory and B-tree pages, so a paused statement can resume in-process but can't be written out the way our JSON snapshot can.</p>",
  "segments": [
   {
    "start": 987,
    "end": 993,
    "code": "  for(pOp=&aOp[p->pc]; 1; pOp++){\n    /* Errors are detected by individual opcodes, with an immediate\n    ** jumps to abort_due_to_error. */\n    assert( rc==SQLITE_OK );\n\n    assert( pOp>=aOp && pOp<&aOp[p->nOp]);\n    nVmStep++;"
   },
   {
    "start": 1070,
    "end": 1070,
    "code": "    switch( pOp->opcode ){"
   },
   {
    "start": 1806,
    "end": 1812,
    "code": "case OP_ResultRow: {\n  assert( p->nResColumn==pOp->p2 );\n  assert( pOp->p1>0 || CORRUPT_DB );\n  assert( pOp->p1+pOp->p2<=(p->nMem+1 - p->nCursor)+1 );\n\n  p->cacheCtr = (p->cacheCtr + 2)|1;\n  p->pResultRow = &aMem[pOp->p1];"
   },
   {
    "start": 1833,
    "end": 1836,
    "code": "  p->pc = (int)(pOp - aOp) + 1;\n  rc = SQLITE_ROW;\n  goto vdbe_return;\n}"
   }
  ]
 },
 {
  "id": "07-spark-produce-consume",
  "engine": "Spark SQL",
  "repo": "apache/spark",
  "sha": "099c3ee2e2e71ef8c826ee06d35081cb6d82b29c",
  "path": "sql/core/src/main/scala/org/apache/spark/sql/execution/WholeStageCodegenExec.scala",
  "lang": "scala",
  "title": "CodegenSupport: produce and consume, by name",
  "prompt": "Which method plays the role of our <code>consume(regs)</code> callback, the one that emits the parent's code inside the child's loop?",
  "notes": "<p>Spark's whole-stage code generation is Neumann's produce/consume model. <code>produce</code> asks an operator to emit the loop that generates its rows (<code>doProduce</code>). Inside that loop the operator calls <code>consume</code>, which hands the row's variables to <code>parent.doConsume</code>, so the parent's code is emitted in place. The aggregation example in the comment is our pipeline breaker: build the hash map by calling <code>child.produce()</code>, then start a second loop over the map.</p><p>The output is Java source, compiled at runtime (with Janino) into one function per stage, not bytecode for an interpreter. Note <code>if (shouldStop()) return;</code> in that example: the generated loop can return early between rows, a small cousin of our <code>ResultRow</code> yield.</p>",
  "segments": [
   {
    "start": 94,
    "end": 101,
    "code": "  final def produce(ctx: CodegenContext, parent: CodegenSupport): String = executeQuery {\n    this.parent = parent\n    ctx.freshNamePrefix = variablePrefix\n    s\"\"\"\n       |${ctx.registerComment(s\"PRODUCE: ${this.simpleString(conf.maxToStringFields)}\")}\n       |${doProduce(ctx)}\n     \"\"\".stripMargin\n  }"
   },
   {
    "start": 103,
    "end": 119,
    "code": "  /**\n   * Generate the Java source code to process, should be overridden by subclass to support codegen.\n   *\n   * doProduce() usually generate the framework, for example, aggregation could generate this:\n   *\n   *   if (!initialized) {\n   *     # create a hash map, then build the aggregation hash map\n   *     # call child.produce()\n   *     initialized = true;\n   *   }\n   *   while (hashmap.hasNext()) {\n   *     row = hashmap.next();\n   *     # build the aggregation results\n   *     # create variables for results\n   *     # call consume(), which will call parent.doConsume()\n   *      if (shouldStop()) return;\n   *   }"
   },
   {
    "start": 128,
    "end": 128,
    "code": "  protected def doProduce(ctx: CodegenContext): String"
   },
   {
    "start": 330,
    "end": 343,
    "code": "  /**\n   * Generate the Java source code to process the rows from child SparkPlan. This should only be\n   * called from `consume`.\n   *\n   * This should be override by subclass to support codegen.\n   *\n   * Note: The operator should not assume the existence of an outer processing loop,\n   *       which it can jump from with \"continue;\"!\n   *\n   * For example, filter could generate this:\n   *   # code to evaluate the predicate expression, result is isNull1 and value2\n   *   if (!isNull1 && value2) {\n   *     # call consume(), which will call parent.doConsume()\n   *   }"
   },
   {
    "start": 352,
    "end": 354,
    "code": "  def doConsume(ctx: CodegenContext, input: Seq[ExprCode], row: ExprCode): String = {\n    throw SparkUnsupportedOperationException()\n  }"
   }
  ]
 },
 {
  "id": "07-duckdb-pipeline-budget",
  "engine": "DuckDB",
  "repo": "duckdb/duckdb",
  "sha": "fc9d6e93409a2dc412b658cade45b963371cd033",
  "path": "src/parallel/pipeline_executor.cpp",
  "lang": "cpp",
  "title": "PipelineExecutor::Execute(max_chunks): a pipeline that runs on a budget",
  "prompt": "What does <code>Execute</code> return when its budget runs out before the pipeline is done, and when the sink can't accept more data?",
  "notes": "<p>DuckDB runs each pipeline as a push loop over vectors (chunks of rows) with a budget: <code>ExecutionBudget chunk_budget(max_chunks)</code>, and the loop ends when <code>chunk_budget.Next()</code> says the budget is spent. Then it returns <code>NOT_FINISHED</code>, and a sink that can't take more returns <code>INTERRUPTED</code>. The caller, <code>PipelineTask::ExecuteTask</code> in <code>src/parallel/pipeline.cpp</code>, passes <code>PARTIAL_CHUNK_COUNT</code> (50 chunks) and maps those results to <code>TASK_NOT_FINISHED</code> / <code>TASK_BLOCKED</code>, so the scheduler can run other work and resume this task later.</p><p>That's our fuel, measured in chunks instead of instructions. The resumable state is the executor object's fields (<code>remaining_sink_chunk</code>, <code>exhausted_pipeline</code>, in-process operators). It's in-process C++ state, so pausing works and serialization doesn't.</p>",
  "segments": [
   {
    "start": 330,
    "end": 336,
    "code": "PipelineExecuteResult PipelineExecutor::Execute(idx_t max_chunks) {\n\tD_ASSERT(pipeline.sink);\n\tauto &source_chunk = pipeline.operators.empty() ? final_chunk : *intermediate_chunks[0];\n\tExecutionBudget chunk_budget(max_chunks);\n\n\tdo {\n\t\tcontext.client.InterruptCheck();"
   },
   {
    "start": 419,
    "end": 436,
    "code": "\t\t// SINK INTERRUPT\n\t\tif (result == OperatorResultType::BLOCKED) {\n\t\t\tremaining_sink_chunk = true;\n\t\t\treturn PipelineExecuteResult::INTERRUPTED;\n\t\t}\n\n\t\tif (result == OperatorResultType::FINISHED) {\n\t\t\tD_ASSERT(in_process_operators.empty());\n\t\t\texhausted_pipeline = true;\n\t\t}\n\t} while (chunk_budget.Next());\n\n\tif ((!exhausted_pipeline || !done_flushing) && !IsFinished()) {\n\t\treturn PipelineExecuteResult::NOT_FINISHED;\n\t}\n\n\treturn PushFinalize();\n}"
   }
  ]
 },
 {
  "id": "07-postgres-llvmjit",
  "engine": "PostgreSQL",
  "repo": "postgres/postgres",
  "sha": "6f3bdadaadc4692050ca20dff53d3890088b9272",
  "path": "src/backend/jit/llvm/llvmjit_expr.c",
  "lang": "c",
  "title": "llvmjit_expr.c: turning an expression's step program into machine code",
  "prompt": "Postgres compiles each expression into a flat array of steps for an interpreter. How does the JIT turn the interpreter's jumps between steps into LLVM control flow?",
  "notes": "<p>Postgres evaluates expressions with a small bytecode of its own (<code>state-&gt;steps</code>, run by <code>ExecInterpExpr</code>). With JIT enabled, this function walks the same step array and emits LLVM IR: one basic block per step, allocated up front so any step can branch to any other, just as our compiler patches jump targets. <code>EEOP_QUAL</code> shows three-valued logic compiled to a branch: NULL <em>or</em> false goes to the failure block, everything else falls through to the next step.</p><p>This is the \"compile\" answer to the interpretation tax at the end of the post, applied to expressions only. Postgres's plan nodes are still Volcano iterators. It also only pays off for long-running queries, which is why it's gated by cost thresholds (<code>jit_above_cost</code>).</p>",
  "segments": [
   {
    "start": 300,
    "end": 318,
    "code": "\t/* allocate blocks for each op upfront, so we can do jumps easily */\n\topblocks = palloc_array(LLVMBasicBlockRef, state->steps_len);\n\tfor (int opno = 0; opno < state->steps_len; opno++)\n\t\topblocks[opno] = l_bb_append_v(eval_fn, \"b.op.%d.start\", opno);\n\n\t/* jump from entry to first block */\n\tLLVMBuildBr(b, opblocks[0]);\n\n\tfor (int opno = 0; opno < state->steps_len; opno++)\n\t{\n\t\tExprEvalStep *op;\n\t\tExprEvalOp\topcode;\n\t\tLLVMValueRef v_resvaluep;\n\t\tLLVMValueRef v_resnullp;\n\n\t\tLLVMPositionBuilderAtEnd(b, opblocks[opno]);\n\n\t\top = &state->steps[opno];\n\t\topcode = ExecEvalStepOp(state, op);"
   },
   {
    "start": 323,
    "end": 324,
    "code": "\t\tswitch (opcode)\n\t\t{"
   },
   {
    "start": 970,
    "end": 971,
    "code": "\t\t\tcase EEOP_QUAL:\n\t\t\t\t{"
   },
   {
    "start": 977,
    "end": 994,
    "code": "\t\t\t\t\tb_qualfail = l_bb_before_v(opblocks[opno + 1],\n\t\t\t\t\t\t\t\t\t\t\t   \"op.%d.qualfail\", opno);\n\n\t\t\t\t\tv_resvalue = l_load(b, TypeDatum, v_resvaluep, \"\");\n\t\t\t\t\tv_resnull = l_load(b, TypeStorageBool, v_resnullp, \"\");\n\n\t\t\t\t\tv_nullorfalse =\n\t\t\t\t\t\tLLVMBuildOr(b,\n\t\t\t\t\t\t\t\t\tLLVMBuildICmp(b, LLVMIntEQ, v_resnull,\n\t\t\t\t\t\t\t\t\t\t\t\t  l_sbool_const(1), \"\"),\n\t\t\t\t\t\t\t\t\tLLVMBuildICmp(b, LLVMIntEQ, v_resvalue,\n\t\t\t\t\t\t\t\t\t\t\t\t  l_datum_const(0), \"\"),\n\t\t\t\t\t\t\t\t\t\"\");\n\n\t\t\t\t\tLLVMBuildCondBr(b,\n\t\t\t\t\t\t\t\t\tv_nullorfalse,\n\t\t\t\t\t\t\t\t\tb_qualfail,\n\t\t\t\t\t\t\t\t\topblocks[opno + 1]);"
   }
  ]
 },
 {
  "id": "07-sqlite-progress",
  "engine": "SQLite",
  "repo": "sqlite/sqlite",
  "sha": "cb547ab3e931c7766e24834af5ef6c4578863e3d",
  "path": "src/vdbe.c",
  "lang": "c",
  "title": "The progress handler: fuel, checked where loops jump back",
  "prompt": "Our VM checks <code>fuel</code> before every instruction. Which instructions make SQLite check its budget, and what happens when the callback says stop?",
  "notes": "<p><code>nVmStep</code> counts executed opcodes; <code>nProgressLimit</code> is the count at which <code>sqlite3_progress_handler()</code>'s callback next runs. The check isn't on every opcode. It happens on jumps that can repeat work: loop bottoms (<code>OP_Next</code>, <code>OP_SorterNext</code>, … per the comment) and a few others, such as <code>OP_Gosub</code>, that land on <code>jump_to_p2_and_check_for_interrupt</code>. The comment explains why: checking every opcode cost about 1.5% of <code>sqlite3_step()</code> time. Every loop iteration still passes a check, so a query can't run long without reaching one.</p><p>The difference from our fuel: a non-zero return from the callback aborts the statement with <code>SQLITE_INTERRUPT</code>. It's a deadline, not a pause. Our <code>OutOfFuel</code> leaves the state intact so <code>step()</code> can be called again.</p>",
  "segments": [
   {
    "start": 936,
    "end": 944,
    "code": "  }\n#ifndef SQLITE_OMIT_PROGRESS_CALLBACK\n  if( db->xProgress ){\n    u32 iPrior = p->aCounter[SQLITE_STMTSTATUS_VM_STEP];\n    assert( 0 < db->nProgressOps );\n    nProgressLimit = db->nProgressOps - (iPrior % db->nProgressOps);\n  }else{\n    nProgressLimit = LARGEST_UINT64;\n  }"
   },
   {
    "start": 1134,
    "end": 1166,
    "code": "jump_to_p2_and_check_for_interrupt:\n  pOp = &aOp[pOp->p2 - 1];\n\n  /* Opcodes that are used as the bottom of a loop (OP_Next, OP_Prev,\n  ** OP_VNext, or OP_SorterNext) all jump here upon\n  ** completion.  Check to see if sqlite3_interrupt() has been called\n  ** or if the progress callback needs to be invoked.\n  **\n  ** This code uses unstructured \"goto\" statements and does not look clean.\n  ** But that is not due to sloppy coding habits. The code is written this\n  ** way for performance, to avoid having to run the interrupt and progress\n  ** checks on every opcode.  This helps sqlite3_step() to run about 1.5%\n  ** faster according to \"valgrind --tool=cachegrind\" */\ncheck_for_interrupt:\n  if( AtomicLoad(&db->u1.isInterrupted) ) goto abort_due_to_interrupt;\n#ifndef SQLITE_OMIT_PROGRESS_CALLBACK\n  /* Call the progress callback if it is configured and the required number\n  ** of VDBE ops have been executed (either since this invocation of\n  ** sqlite3VdbeExec() or since last time the progress callback was called).\n  ** If the progress callback returns non-zero, exit the virtual machine with\n  ** a return code SQLITE_ABORT.\n  */\n  while( nVmStep>=nProgressLimit && db->xProgress!=0 ){\n    assert( db->nProgressOps!=0 );\n    nProgressLimit += db->nProgressOps;\n    if( db->xProgress(db->pProgressArg) ){\n      nProgressLimit = LARGEST_UINT64;\n      rc = SQLITE_INTERRUPT;\n      goto abort_due_to_error;\n    }\n  }\n#endif\n "
   }
  ]
 }
]);
