EE.addWild("01", [
 {
  "id": "01-sqlite-and-or-truth-table",
  "engine": "SQLite",
  "repo": "sqlite/sqlite",
  "sha": "cb547ab3e931c7766e24834af5ef6c4578863e3d",
  "path": "src/vdbe.c",
  "lang": "c",
  "title": "<code>OP_And</code> / <code>OP_Or</code>: three-valued logic as a lookup table",
  "prompt": "Operands are encoded 0 = FALSE, 1 = TRUE, 2 = NULL, and the table is indexed by <code>v1*3+v2</code>. Which entries of <code>and_logic</code> say that FALSE AND NULL is FALSE?",
  "notes": "<p>This is our <code>and3</code> and <code>or3</code> flattened into two nine-entry arrays. <code>sqlite3VdbeBooleanValue</code> turns each register into 0, 1, or 2, and a result of 2 is written back as a NULL register. Indexes 2 (FALSE, NULL) and 6 (NULL, FALSE) of <code>and_logic</code> are 0: the decisive value wins, exactly as in the post.</p><p>There's no short-circuit inside the opcode: both operands are already in registers when it runs. Short-circuiting happens in the code generator instead. In a WHERE clause <code>OP_And</code> isn't emitted at all: <code>sqlite3ExprIfFalse</code> in <code>expr.c</code> compiles <code>a AND b</code> into two conditional jumps to the same \"row fails\" label. When the value itself is needed, <code>exprCodeTargetAndOr</code> adds a skip jump only when one operand is a subquery or it chose to evaluate the right side first. Control flow standing in for <code>if a == false then return false</code> is part 7's idea, showing up early.</p>",
  "segments": [
   {
    "start": 2634,
    "end": 2643,
    "code": "/* Opcode: And P1 P2 P3 * *\n** Synopsis: r[P3]=(r[P1] && r[P2])\n**\n** Take the logical AND of the values in registers P1 and P2 and\n** write the result into register P3.\n**\n** If either P1 or P2 is 0 (false) then the result is 0 even if\n** the other input is NULL.  A NULL and true or two NULLs give\n** a NULL output.\n*/"
   },
   {
    "start": 2654,
    "end": 2676,
    "code": "case OP_And:              /* same as TK_AND, in1, in2, out3 */\ncase OP_Or: {             /* same as TK_OR, in1, in2, out3 */\n  int v1;    /* Left operand:  0==FALSE, 1==TRUE, 2==UNKNOWN or NULL */\n  int v2;    /* Right operand: 0==FALSE, 1==TRUE, 2==UNKNOWN or NULL */\n\n  v1 = sqlite3VdbeBooleanValue(&aMem[pOp->p1], 2);\n  v2 = sqlite3VdbeBooleanValue(&aMem[pOp->p2], 2);\n  if( pOp->opcode==OP_And ){\n    static const unsigned char and_logic[] = { 0, 0, 0, 0, 1, 2, 0, 2, 2 };\n    v1 = and_logic[v1*3+v2];\n  }else{\n    static const unsigned char or_logic[] = { 0, 1, 2, 1, 1, 1, 2, 1, 2 };\n    v1 = or_logic[v1*3+v2];\n  }\n  pOut = &aMem[pOp->p3];\n  if( v1==2 ){\n    MemSetTypeFlag(pOut, MEM_Null);\n  }else{\n    pOut->u.i = v1;\n    MemSetTypeFlag(pOut, MEM_Int);\n  }\n  break;\n}"
   }
  ]
 },
 {
  "id": "01-postgres-bool-and-steps",
  "engine": "PostgreSQL",
  "repo": "postgres/postgres",
  "sha": "6f3bdadaadc4692050ca20dff53d3890088b9272",
  "path": "src/backend/executor/execExprInterp.c",
  "lang": "c",
  "title": "<code>ExecInterpExpr</code>: an expression compiled to a flat program of steps",
  "prompt": "Find the line that is Postgres's version of our <code>if a == false then return false</code>. Where does execution go next?",
  "notes": "<p>Postgres doesn't walk the expression tree per row, and it doesn't build closures either. <code>ExecInitExpr</code> (in <code>execExpr.c</code>) compiles the tree once into an array of steps, and <code>ExecInterpExpr</code> runs them in a loop: <code>EEO_NEXT()</code> moves to the next step and <code>EEO_JUMP(stepno)</code> jumps, dispatched with computed goto where the compiler supports it. Each AND argument's step checks the value just computed. FALSE jumps to <code>jumpdone</code>, past the remaining arguments, and NULL sets <code>anynull</code> so the last step can turn the final result into NULL.</p><p>That's our <code>compile</code> with a different output format: a step array with a program counter instead of nested closures. It sits halfway between part 1 and part 7, and the step array is also what Postgres's optional LLVM JIT starts from.</p>",
  "segments": [
   {
    "start": 1035,
    "end": 1044,
    "code": "\t\t/*\n\t\t * If any of its clauses is FALSE, an AND's result is FALSE regardless\n\t\t * of the states of the rest of the clauses, so we can stop evaluating\n\t\t * and return FALSE immediately.  If none are FALSE and one or more is\n\t\t * NULL, we return NULL; otherwise we return TRUE.  This makes sense\n\t\t * when you interpret NULL as \"don't know\": perhaps one of the \"don't\n\t\t * knows\" would have been FALSE if we'd known its value.  Only when\n\t\t * all the inputs are known to be TRUE can we state confidently that\n\t\t * the AND's result is TRUE.\n\t\t */"
   },
   {
    "start": 1057,
    "end": 1071,
    "code": "\t\tEEO_CASE(EEOP_BOOL_AND_STEP)\n\t\t{\n\t\t\tif (*op->resnull)\n\t\t\t{\n\t\t\t\t*op->d.boolexpr.anynull = true;\n\t\t\t}\n\t\t\telse if (!DatumGetBool(*op->resvalue))\n\t\t\t{\n\t\t\t\t/* result is already set to FALSE, need not change it */\n\t\t\t\t/* bail out early */\n\t\t\t\tEEO_JUMP(op->d.boolexpr.jumpdone);\n\t\t\t}\n\n\t\t\tEEO_NEXT();\n\t\t}"
   },
   {
    "start": 1089,
    "end": 1093,
    "code": "\t\t\telse if (*op->d.boolexpr.anynull)\n\t\t\t{\n\t\t\t\t*op->resvalue = (Datum) 0;\n\t\t\t\t*op->resnull = true;\n\t\t\t}"
   }
  ]
 },
 {
  "id": "01-duckdb-conjunction-select",
  "engine": "DuckDB",
  "repo": "duckdb/duckdb",
  "sha": "fc9d6e93409a2dc412b658cade45b963371cd033",
  "path": "src/execution/expression_executor/execute_conjunction.cpp",
  "lang": "cpp",
  "title": "AND over a batch: selection vectors and adaptive ordering",
  "prompt": "Each child of the AND sees fewer rows than the one before it. Which assignment makes that happen, and which line is the batch-wide short-circuit?",
  "notes": "<p>DuckDB evaluates a WHERE clause over a vector of up to 2,048 rows at a time. <code>Select</code> doesn't produce TRUE, FALSE, or NULL per row. It splits row positions into a <code>true_sel</code> list and a <code>false_sel</code> list, so a row whose predicate is NULL simply isn't among the true ones, which is the WHERE rule from the post. After each conjunct, <code>current_sel = true_sel</code> narrows the next conjunct's input to the rows still passing, and <code>if (current_count == 0) break;</code> stops when nothing survives.</p><p>The <code>permutation</code> comes from an <code>AdaptiveFilter</code> (<code>adaptive_filter.cpp</code>). It times each call, occasionally swaps two adjacent conjuncts, and keeps the swap only if the measured runtime went down. It turns reordering off when a conjunct can throw. Our engine always evaluates AND left to right. DuckDB treats the order as something to tune at run time.</p>",
  "segments": [
   {
    "start": 61,
    "end": 72,
    "code": "idx_t ExpressionExecutor::Select(const BoundConjunctionExpression &expr, ExpressionState *state_p,\n                                 const SelectionVector *sel, idx_t count, SelectionVector *true_sel,\n                                 SelectionVector *false_sel) {\n\tauto &state = state_p->Cast<ConjunctionState>();\n\n\tif (expr.GetExpressionType() == ExpressionType::CONJUNCTION_AND) {\n\t\t// get runtime statistics\n\t\tauto filter_state = state.adaptive_filter->BeginFilter();\n\t\tconst auto &permutation = state.adaptive_filter->GetPermutation();\n\t\tconst SelectionVector *current_sel = sel;\n\t\tidx_t current_count = count;\n\t\tidx_t false_count = 0;"
   },
   {
    "start": 82,
    "end": 105,
    "code": "\t\tfor (idx_t i = 0; i < expr.GetChildren().size(); i++) {\n\t\t\tidx_t tcount = Select(*expr.GetChildren()[permutation[i]], state.child_states[permutation[i]].get(),\n\t\t\t                      current_sel, current_count, true_sel, temp_false.get());\n\t\t\tidx_t fcount = current_count - tcount;\n\t\t\tif (fcount > 0 && false_sel) {\n\t\t\t\t// move failing tuples into the false_sel\n\t\t\t\t// tuples passed, move them into the actual result vector\n\t\t\t\tfor (idx_t i = 0; i < fcount; i++) {\n\t\t\t\t\tfalse_sel->set_index(false_count++, temp_false->get_index(i));\n\t\t\t\t}\n\t\t\t}\n\t\t\tcurrent_count = tcount;\n\t\t\tif (current_count == 0) {\n\t\t\t\tbreak;\n\t\t\t}\n\t\t\tif (current_count < count) {\n\t\t\t\t// tuples were filtered out: move on to using the true_sel to only evaluate passing tuples in subsequent\n\t\t\t\t// iterations\n\t\t\t\tcurrent_sel = true_sel;\n\t\t\t}\n\t\t}\n\t\t// adapt runtime statistics\n\t\tstate.adaptive_filter->EndFilter(filter_state);\n\t\treturn current_count;"
   }
  ]
 },
 {
  "id": "01-datafusion-evaluate-conjunction",
  "engine": "DataFusion",
  "repo": "apache/datafusion",
  "sha": "801b017bb8824e577593ac6deefad6a425cc6ac3",
  "path": "datafusion/physical-expr/src/expressions/binary.rs",
  "lang": "rust",
  "title": "<code>evaluate_conjunction</code>: Kleene AND, one Arrow array at a time",
  "prompt": "Which line is the batch-wide version of our <code>if a == false then return false</code>? And why do rows that are NULL so far have to stay in the batch?",
  "notes": "<p>DataFusion evaluates expressions over Arrow record batches. Each conjunct produces a boolean array, and <code>and_kleene_columnar</code> combines it with the result so far using Kleene (three-valued) logic. A scalar TRUE leaves the other side unchanged and a scalar FALSE absorbs it; otherwise it calls Arrow's <code>and_kleene</code> kernel. <code>Ok(!is_all_false(&amp;result))</code> ends the walk over the remaining conjuncts once every row in the batch is FALSE.</p><p>The doc comment states the 3VL subtlety: NULL rows stay, because a later conjunct might still make them FALSE (NULL AND FALSE is FALSE). When few rows are undecided, it filters the batch down before running the next conjunct, then <code>unfilter</code>s the result back to full size at the end. Like DuckDB's selection vectors, it's a way to skip work per batch rather than per row.</p>",
  "segments": [
   {
    "start": 1209,
    "end": 1247,
    "code": "    /// Evaluates nested `AND`s together to avoid repeated filtering (#25035).\n    ///\n    /// When at most [`PRE_SELECTION_THRESHOLD`] of original rows remain,\n    /// filters before conjuncts that may be costly or fail, so they never see\n    /// rows nested evaluation would skip. `NULL` rows stay for a later `false`.\n    fn evaluate_conjunction(&self, batch: &RecordBatch) -> Result<ColumnarValue> {\n        // Keep each filter mask for the final scatter.\n        let mut selections = vec![];\n        let mut input = Cow::Borrowed(batch);\n        let mut result = ColumnarValue::Scalar(ScalarValue::Boolean(Some(true)));\n\n        // Returns whether to go on to the next conjunct.\n        let mut evaluate = |conjunct: &Arc<dyn PhysicalExpr>| -> Result<bool> {\n            if let Some(undecided) = rows_to_filter_before(\n                conjunct,\n                &result,\n                batch.schema_ref(),\n                batch.num_rows(),\n            ) {\n                let array = result.to_array(input.num_rows())?;\n                // Every kept row is true when there are no NULLs.\n                result = if array.null_count() == 0 {\n                    ColumnarValue::Scalar(ScalarValue::Boolean(Some(true)))\n                } else {\n                    ColumnarValue::Array(filter(&array, &undecided)?)\n                };\n                input = Cow::Owned(filter_record_batch(&input, &undecided)?);\n                selections.push(undecided);\n            }\n\n            let value = conjunct.evaluate(&input)?;\n            let so_far =\n                std::mem::replace(&mut result, ColumnarValue::Scalar(ScalarValue::Null));\n            result = and_kleene_columnar(so_far, value, input.num_rows())?;\n            Ok(!is_all_false(&result))\n        };\n        if for_each_conjunct(&self.left, &mut evaluate)? {\n            for_each_conjunct(&self.right, &mut evaluate)?;\n        }"
   }
  ]
 }
]);
