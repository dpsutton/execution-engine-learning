EE.addWild("06", [
 {
  "id": "06-spark-join-reorder-dp",
  "engine": "Spark SQL",
  "repo": "apache/spark",
  "sha": "099c3ee2e2e71ef8c826ee06d35081cb6d82b29c",
  "path": "sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/optimizer/CostBasedJoinReorder.scala",
  "lang": "scala",
  "title": "<code>JoinReorderDP</code>: Selinger's DP, level by level",
  "prompt": "Our DP is left-deep: the right input of every join is one base table. Find the line that shows Spark's can be bushy, and the one that skips cross products.",
  "notes": "<p>This is our <code>join-order-dp</code> almost line for line. <code>existingLevels(k)</code> holds the best plan per set of <code>k + 1</code> items (our <code>best[S]</code>), a new plan replaces the stored one only if <code>betterThan</code>, and <code>buildJoin</code> returns <code>None</code> when no join condition spans both sides, which is the cross-product pruning from part 6.</p><p>The difference is the pairing: level <code>k</code> is joined with level <code>lev − k</code>, so both inputs can be multi-table joins (a bushy tree), with the bigger side put on the left. Spark's cost here is only output cardinality and size in bytes, weighted (see <code>betterThan</code> in the same file): no CPU or I/O model at all, which fits Leis et al.'s point that row counts matter most.</p>",
  "segments": [
   {
    "start": 213,
    "end": 243,
    "code": "    // Build plans for the next level from plans at level k (one side of the join) and level\n    // lev - k (the other side of the join).\n    // For the lower level k, we only need to search from 0 to lev - k, because when building\n    // a join from A and B, both A J B and B J A are handled.\n    while (k <= lev - k) {\n      val oneSideCandidates = existingLevels(k).values.toSeq\n      for (i <- oneSideCandidates.indices) {\n        val oneSidePlan = oneSideCandidates(i)\n        val otherSideCandidates = if (k == lev - k) {\n          // Both sides of a join are at the same level, no need to repeat for previous ones.\n          oneSideCandidates.drop(i)\n        } else {\n          existingLevels(lev - k).values.toSeq\n        }\n\n        otherSideCandidates.foreach { otherSidePlan =>\n          buildJoin(oneSidePlan, otherSidePlan, conf, conditions, topOutput, filters) match {\n            case Some(newJoinPlan) =>\n              // Check if it's the first plan for the item set, or it's a better plan than\n              // the existing one due to lower cost.\n              val existingPlan = nextLevel.get(newJoinPlan.itemIds)\n              if (existingPlan.isEmpty || newJoinPlan.betterThan(existingPlan.get, conf)) {\n                nextLevel.update(newJoinPlan.itemIds, newJoinPlan)\n              }\n            case None =>\n          }\n        }\n      }\n      k += 1\n    }\n    nextLevel"
   },
   {
    "start": 289,
    "end": 299,
    "code": "    val onePlan = oneJoinPlan.plan\n    val otherPlan = otherJoinPlan.plan\n    val joinConds = conditions\n      .filterNot(l => canEvaluate(l, onePlan))\n      .filterNot(r => canEvaluate(r, otherPlan))\n      .filter(e => e.references.subsetOf(onePlan.outputSet ++ otherPlan.outputSet))\n    if (joinConds.isEmpty) {\n      // Cartesian product is very expensive, so we exclude them from candidate plans.\n      // This also significantly reduces the search space.\n      return None\n    }"
   }
  ]
 },
 {
  "id": "06-cockroach-dpsube",
  "engine": "CockroachDB",
  "repo": "cockroachdb/cockroach",
  "sha": "d30c905fff79ef825adc96bcc647f1872a90f2ff",
  "path": "pkg/sql/opt/xform/join_order_builder.go",
  "lang": "go",
  "title": "DPSube: subsets as bitmasks, enumerated in numeric order",
  "prompt": "There's no \"for size in 2..n\" loop here. Why is it still safe to visit <code>subset</code> in plain increasing integer order?",
  "notes": "<p>A set of relations is a bitmask (<code>vertexSet</code>), and every proper subset of a mask is a smaller integer, so counting <code>subset</code> upward from 1 visits each set after all of its parts. That replaces our size-ordered loop. For each set it enumerates every split into two disjoint halves <code>s1</code>, <code>s2</code>, so like Spark's this search is bushy.</p><p>Unlike ours, it doesn't price anything here. <code>addJoins</code> checks which predicate edges can legally connect the halves (needed once outer joins constrain reordering) and adds the join to the memo; the optimizer's coster picks the cheapest alternative later. The doc comment's TODO names the next step: DPHyp, which enumerates only connected pairs instead of testing every split.</p>",
  "segments": [
   {
    "start": 561,
    "end": 592,
    "code": "// dpSube carries out the DPSube algorithm (citations: [8] figure 4). All\n// disjoint pairs of subsets of base relations are enumerated and checked for\n// validity. If valid, the pair of subsets is used along with the edges\n// connecting them to create a new join operator, which is added to the memo.\n// TODO(drewk): implement DPHyp (or a similar algorithm).\nfunc (jb *JoinOrderBuilder) dpSube() {\n\tsubsets := jb.allVertexes()\n\tfor subset := vertexSet(1); subset <= subsets; subset++ {\n\t\tif subset.isSingleton() {\n\t\t\t// This subset has only one set bit, which means it only represents one\n\t\t\t// relation. We need at least two relations in order to create a new join.\n\t\t\tcontinue\n\t\t}\n\t\tjb.setApplicableEdges(subset)\n\n\t\t// Enumerate all possible pairwise-disjoint binary partitions of the subset,\n\t\t// s1 AND s2. These represent sets of relations that may be joined together.\n\t\t//\n\t\t// Only iterate s1 up to subset/2 to avoid enumerating duplicate partitions.\n\t\t// This works because s1 and s2 are always disjoint, and subset will always\n\t\t// be equal to s1 + s2. Therefore, any pair of subsets where s1 > s2 will\n\t\t// already have been handled when s2 < s1. Also note that for subset = 1111\n\t\t// (in binary), subset / 2 = 0111 (integer division).\n\t\tfor s1 := vertexSet(1); s1 <= subset/2; s1++ {\n\t\t\tif !s1.isSubsetOf(subset) {\n\t\t\t\tcontinue\n\t\t\t}\n\t\t\ts2 := subset.difference(s1)\n\t\t\tjb.addJoins(s1, s2)\n\t\t}\n\t}\n}"
   }
  ]
 },
 {
  "id": "06-sqlite-path-solver",
  "engine": "SQLite",
  "repo": "sqlite/sqlite",
  "sha": "cb547ab3e931c7766e24834af5ef6c4578863e3d",
  "path": "src/where.c",
  "lang": "c",
  "title": "<code>wherePathSolver</code>: not DP, a beam of the N best paths",
  "prompt": "How many partial join orders does SQLite keep per step for a 2-table join? And what does adding <code>pWLoop-&gt;rRun + pFrom-&gt;nRow</code> compute, given that costs are <code>LogEst</code>s?",
  "notes": "<p>SQLite builds join orders one loop at a time, like a left-deep DP, but keeps only the <code>mxChoice</code> cheapest partial paths per generation (1, 5, or 12–18 by the tuning comment) and drops any candidate worse than all of them. It's a beam search, not an exhaustive search over subsets, and it can miss the optimum in exchange for a bounded planning cost.</p><p><code>LogEst</code> is 10·log₂ of a count (sqliteInt.h: 2 → 10, 1024 → 100), so adding two of them multiplies the counts: <code>rRun + nRow</code> is \"cost per run of this loop × rows from the outer path\". The <code>isOrdered</code> bookkeeping is Selinger's interesting orders from the aside: a path whose rows already satisfy the ORDER BY avoids a sort cost.</p>",
  "segments": [
   {
    "start": 5871,
    "end": 5883,
    "code": "  /* TUNING: mxChoice is the maximum number of possible paths to preserve\n  ** at each step.  Based on the number of loops in the FROM clause:\n  **\n  **     nLoop      mxChoice\n  **     -----      --------\n  **       1            1            // the most common case\n  **       2            5\n  **       3+        12 or 18        // see computeMxChoice()\n  */\n  if( nLoop<=1 ){\n    mxChoice = 1;\n  }else if( nLoop==2 ){\n    mxChoice = 5;"
   },
   {
    "start": 5945,
    "end": 5960,
    "code": "  /* Compute successively longer WherePaths using the previous generation\n  ** of WherePaths as the basis for the next.  Keep track of the mxChoice\n  ** best paths at each generation */\n  for(iLoop=0; iLoop<nLoop; iLoop++){\n    nTo = 0;\n    for(ii=0, pFrom=aFrom; ii<nFrom; ii++, pFrom++){\n      for(pWLoop=pWInfo->pLoops; pWLoop; pWLoop=pWLoop->pNextLoop){\n        LogEst nOut;                      /* Rows visited by (pFrom+pWLoop) */\n        LogEst rCost;                     /* Cost of path (pFrom+pWLoop) */\n        LogEst rUnsort;                   /* Unsorted cost of (pFrom+pWLoop) */\n        i8 isOrdered;                     /* isOrdered for (pFrom+pWLoop) */\n        Bitmask maskNew;                  /* Mask of src visited by (..) */\n        Bitmask revMask;                  /* Mask of rev-order loops for (..) */\n\n        if( (pWLoop->prereq & ~pFrom->maskLoop)!=0 ) continue;\n        if( (pWLoop->maskSelf & pFrom->maskLoop)!=0 ) continue;"
   },
   {
    "start": 5972,
    "end": 5977,
    "code": "        rUnsort = pWLoop->rRun + pFrom->nRow;\n        if( pWLoop->rSetup ){\n          rUnsort = sqlite3LogEstAdd(pWLoop->rSetup, rUnsort);\n        }\n        rUnsort = sqlite3LogEstAdd(rUnsort, pFrom->rUnsort);\n        nOut = pFrom->nRow + pWLoop->nOut;"
   },
   {
    "start": 6036,
    "end": 6043,
    "code": "        if( jj>=nTo ){\n          /* None of the existing best-so-far paths match the candidate. */\n          if( nTo>=mxChoice\n           && (rCost>mxCost || (rCost==mxCost && rUnsort>=mxUnsort))\n          ){\n            /* The current candidate is no better than any of the mxChoice\n            ** paths currently in the best-so-far buffer.  So discard\n            ** this candidate as not viable. */"
   }
  ]
 },
 {
  "id": "06-duckdb-cardinality",
  "engine": "DuckDB",
  "repo": "duckdb/duckdb",
  "sha": "fc9d6e93409a2dc412b658cade45b963371cd033",
  "path": "src/optimizer/join_order/cardinality_estimator.cpp",
  "lang": "cpp",
  "title": "Join cardinality: product of inputs over a \"total domain\"",
  "prompt": "Our formula is <code>|L|·|R| / max(ndv(L.a), ndv(R.b))</code>. Find the <code>max</code>, and find what DuckDB does for <code>&lt;</code> where we'd use 1/3.",
  "notes": "<p>The last segment is our formula generalized: the numerator multiplies base-table cardinalities, the denominator multiplies one \"total domain\" per join predicate. The first segment builds that domain as the <em>max</em> distinct count over the columns in an equality class, preferring HyperLogLog or exact counts over min/max-derived ones: the same <code>max(ndv)</code> containment assumption as ours.</p><p>Two differences. Equality predicates are grouped into transitive equivalence classes (<code>a = b</code>, <code>b = c</code> share one domain) rather than each counting separately, which avoids dividing twice for the same key. For non-equality comparisons the denominator grows by <code>d^(2/3)</code>, a heuristic tied to the domain size instead of a constant.</p>",
  "segments": [
   {
    "start": 79,
    "end": 86,
    "code": "void DomainEstimate::Update(const DistinctCount &distinct_count) {\n\tif (IsReliableDistinctCount(distinct_count.source)) {\n\t\tUpdateMaxDistinctCount(reliable_distinct_count, distinct_count.distinct_count);\n\t} else if (distinct_count.source == DistinctCountSource::MIN_MAX) {\n\t\tUpdateMaxDistinctCount(min_max_distinct_count, distinct_count.distinct_count);\n\t} else {\n\t\tfallback_distinct_count = MinValue(distinct_count.distinct_count, fallback_distinct_count);\n\t}"
   },
   {
    "start": 445,
    "end": 462,
    "code": "// Apply the denominator multiplier for a given comparison type and effective distinct count.\nstatic double ApplyComparisonRatio(double base_denom, ExpressionType comparison_type, double effective_d) {\n\tswitch (comparison_type) {\n\tcase ExpressionType::COMPARE_EQUAL:\n\tcase ExpressionType::COMPARE_NOT_DISTINCT_FROM:\n\t\treturn base_denom * effective_d;\n\tcase ExpressionType::COMPARE_LESSTHANOREQUALTO:\n\tcase ExpressionType::COMPARE_LESSTHAN:\n\tcase ExpressionType::COMPARE_GREATERTHANOREQUALTO:\n\tcase ExpressionType::COMPARE_GREATERTHAN:\n\tcase ExpressionType::COMPARE_NOTEQUAL:\n\tcase ExpressionType::COMPARE_DISTINCT_FROM:\n\t\t// Assume this blows up, but use the tdom to bound it a bit.\n\t\treturn base_denom * pow(effective_d, 2.0 / 3.0);\n\tdefault:\n\t\treturn base_denom;\n\t}\n}"
   },
   {
    "start": 892,
    "end": 910,
    "code": "// The estimator starts with base relation cardinalities and divides by a denominator assembled from predicate domain\n// groups. INNER equality predicates use transitive equality classes, composite same-pair equalities can apply an FK/PK\n// cap, disconnected predicate subgraphs are merged by cross product, and LEFT/SEMI/ANTI joins adjust the numerator side\n// according to their output semantics. Non-equality predicates still use a heuristic total-domain penalty.\ntemplate <>\ndouble CardinalityEstimator::EstimateCardinalityWithSet(JoinRelationSet &new_set) {\n\tdouble result;\n\tauto it = state->relation_set_2_cardinality.find(new_set);\n\tif (it != state->relation_set_2_cardinality.end()) {\n\t\tresult = it->second.cardinality_before_filters;\n\t} else {\n\t\t// can happen if a table has cardinality 0, or a tdom is set to 0\n\t\tauto denom = GetDenominator(new_set);\n\t\t// we pass numerator relations, because for semi and anti joins, we don't want to\n\t\t// include cardinalities of relations on the RHS of a semi/anti join.\n\t\tauto numerator = GetNumerator(denom.numerator_relations);\n\t\tresult = numerator / denom.denominator;\n\t\tstate->relation_set_2_cardinality[new_set] = CardinalityHelper(result);\n\t}"
   }
  ]
 }
]);
