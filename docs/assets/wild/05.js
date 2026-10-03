EE.addWild("05", [
 {
  "id": "05-bbolt-seek",
  "engine": "bbolt",
  "repo": "etcd-io/bbolt",
  "sha": "4dc08f7187c709d355a8bcf334fcbcf7d7cfedf6",
  "path": "cursor.go",
  "lang": "go",
  "title": "A cursor descends with a stack, and <code>next()</code> climbs back up it",
  "prompt": "bbolt's pages have no pointer to the next leaf. Find how <code>next()</code> gets from the last entry of one leaf to the first entry of the next.",
  "notes": "<p><code>search</code> is our <code>findLeaf</code>: binary search on each branch page, recurse into the chosen child, and push an <code>elemRef</code> (page + index) per level onto <code>c.stack</code>. There are no sibling links (bbolt's on-disk page header is just id, flags, count, overflow), so <code>next()</code> walks the stack from the bottom up to the deepest level that still has an entry to its right, bumps that index, and descends again to the first leaf entry below it.</p><p>Our range scan follows <code>leaf.next</code> instead. bbolt pays a partial re-descent at each leaf boundary, and in exchange a split or a copy-on-write page never has to update a neighbour's pointer.</p>",
  "segments": [
   {
    "start": 283,
    "end": 302,
    "code": "func (c *Cursor) search(key []byte, pgId common.Pgid) {\n\tp, n := c.bucket.pageNode(pgId)\n\tif p != nil && !p.IsBranchPage() && !p.IsLeafPage() {\n\t\tpanic(fmt.Sprintf(\"invalid page type: %d: %x\", p.Id(), p.Flags()))\n\t}\n\te := elemRef{page: p, node: n}\n\tc.stack = append(c.stack, e)\n\n\t// If we're on a leaf page/node then find the specific node.\n\tif e.isLeaf() {\n\t\tc.nsearch(key)\n\t\treturn\n\t}\n\n\tif n != nil {\n\t\tc.searchNode(key, n)\n\t\treturn\n\t}\n\tc.searchPage(key, p)\n}"
   },
   {
    "start": 215,
    "end": 237,
    "code": "func (c *Cursor) next() (key []byte, value []byte, flags uint32) {\n\tfor {\n\t\t// Attempt to move over one element until we're successful.\n\t\t// Move up the stack as we hit the end of each page in our stack.\n\t\tvar i int\n\t\tfor i = len(c.stack) - 1; i >= 0; i-- {\n\t\t\telem := &c.stack[i]\n\t\t\tif elem.index < elem.count()-1 {\n\t\t\t\telem.index++\n\t\t\t\tbreak\n\t\t\t}\n\t\t}\n\n\t\t// If we've hit the root page then stop and return. This will leave the\n\t\t// cursor on the last element of the last page.\n\t\tif i == -1 {\n\t\t\treturn nil, nil, 0\n\t\t}\n\n\t\t// Otherwise start from where we left off in the stack and find the\n\t\t// first element of the first leaf page.\n\t\tc.stack = c.stack[:i+1]\n\t\tc.goToFirstElementOnTheStack()"
   }
  ]
 },
 {
  "id": "05-bbolt-split",
  "engine": "bbolt",
  "repo": "etcd-io/bbolt",
  "sha": "4dc08f7187c709d355a8bcf334fcbcf7d7cfedf6",
  "path": "node.go",
  "lang": "go",
  "title": "Splitting by bytes, at commit time",
  "prompt": "Our tree splits when a leaf holds more than <code>order − 1</code> keys. What makes a bbolt node split, and which key goes up to the parent?",
  "notes": "<p>bbolt doesn't split during <code>Put</code>. Nodes are split when a transaction commits and dirty nodes are written out (<code>spill</code>, the second segment), and the test is <em>size</em>: split only if the node doesn't fit in a page and has more than <code>2 × MinKeysPerPage</code> entries, cutting at <code>pageSize × FillPercent</code> (default 0.5). Pages hold variable-length keys and values, so a key count would be meaningless.</p><p>The separator pushed into the parent is <code>node.inodes[0].Key()</code>, the first key of each resulting node: the same \"copy the right half's first key up\" rule as our leaf split.</p>",
  "segments": [
   {
    "start": 229,
    "end": 260,
    "code": "func (n *node) splitTwo(pageSize uintptr) (*node, *node) {\n\t// Ignore the split if the page doesn't have at least enough nodes for\n\t// two pages or if the nodes can fit in a single page.\n\tif len(n.inodes) <= (common.MinKeysPerPage*2) || n.sizeLessThan(pageSize) {\n\t\treturn n, nil\n\t}\n\n\t// Determine the threshold before starting a new node.\n\tvar fillPercent = n.bucket.FillPercent\n\tif fillPercent < minFillPercent {\n\t\tfillPercent = minFillPercent\n\t} else if fillPercent > maxFillPercent {\n\t\tfillPercent = maxFillPercent\n\t}\n\tthreshold := int(float64(pageSize) * fillPercent)\n\n\t// Determine split position and sizes of the two pages.\n\tsplitIndex, _ := n.splitIndex(threshold)\n\n\t// Split node into two separate nodes.\n\t// If there's no parent then we'll need to create one.\n\tif n.parent == nil {\n\t\tn.parent = &node{bucket: n.bucket, children: []*node{n}}\n\t}\n\n\t// Create a new node and add it to the parent.\n\tnext := &node{bucket: n.bucket, isLeaf: n.isLeaf, parent: n.parent}\n\tn.parent.children = append(n.parent.children, next)\n\n\t// Split inodes across two nodes.\n\tnext.inodes = n.inodes[splitIndex:]\n\tn.inodes = n.inodes[:splitIndex]"
   },
   {
    "start": 334,
    "end": 345,
    "code": "\t\t// Insert into parent inodes.\n\t\tif node.parent != nil {\n\t\t\tvar key = node.key\n\t\t\tif key == nil {\n\t\t\t\tkey = node.inodes[0].Key()\n\t\t\t}\n\n\t\t\tnode.parent.put(key, node.inodes[0].Key(), nil, node.pgid, 0)\n\t\t\tnode.key = node.inodes[0].Key()\n\t\t\tcommon.Assert(len(node.key) > 0, \"spill: zero-length node key\")\n\t\t}\n"
   }
  ]
 },
 {
  "id": "05-sqlite-moveto",
  "engine": "SQLite",
  "repo": "sqlite/sqlite",
  "sha": "cb547ab3e931c7766e24834af5ef6c4578863e3d",
  "path": "src/btree.c",
  "lang": "c",
  "title": "<code>sqlite3BtreeTableMoveto</code>: one binary search per page",
  "prompt": "On an interior page the search finds an exact match for the rowid. Does it return? And where does the child pointer for keys larger than every cell come from?",
  "notes": "<p>The inner <code>for(;;)</code> is a binary search over the page's cells; the outer one is the descent, one page per iteration, via <code>moveToChild</code>. An exact match on an interior page does <em>not</em> return: it sets <code>lwr = idx</code> and keeps descending, because in a rowid table the row data lives on the leaves. That's the B+tree rule: inner nodes only route.</p><p>Each interior cell carries the pointer to the child on its left; the extra rightmost pointer (<code>Ptr(N)</code>) lives in the page header at offset 8, hence <code>aData[hdrOffset+8]</code> when <code>lwr</code> runs past the last cell. Our inner nodes keep a separate <code>children</code> array instead.</p>",
  "segments": [
   {
    "start": 5917,
    "end": 5951,
    "code": "    lwr = 0;\n    upr = pPage->nCell-1;\n    assert( biasRight==0 || biasRight==1 );\n    idx = upr>>(1-biasRight); /* idx = biasRight ? upr : (lwr+upr)/2; */\n    for(;;){\n      i64 nCellKey;\n      pCell = findCellPastPtr(pPage, idx);\n      if( pPage->intKeyLeaf ){\n        while( 0x80 <= *(pCell++) ){\n          if( pCell>=pPage->aDataEnd ){\n            return SQLITE_CORRUPT_PAGE(pPage);\n          }\n        }\n      }\n      nCellKey = sqlite3VarintValue(pCell);\n      if( nCellKey<intKey ){\n        lwr = idx+1;\n        if( lwr>upr ){ c = -1; break; }\n      }else if( nCellKey>intKey ){\n        upr = idx-1;\n        if( lwr>upr ){ c = +1; break; }\n      }else{\n        assert( nCellKey==intKey );\n        pCur->ix = (u16)idx;\n        if( !pPage->leaf ){\n          lwr = idx;\n          goto moveto_table_next_layer;\n        }else{\n          pCur->curFlags |= BTCF_ValidNKey;\n          pCur->info.nKey = nCellKey;\n          pCur->info.nSize = 0;\n          *pRes = 0;\n          return SQLITE_OK;\n        }\n      }"
   },
   {
    "start": 5964,
    "end": 5973,
    "code": "moveto_table_next_layer:\n    if( lwr>=pPage->nCell ){\n      chldPg = get4byte(&pPage->aData[pPage->hdrOffset+8]);\n    }else{\n      chldPg = get4byte(findCell(pPage, lwr));\n    }\n    pCur->ix = (u16)lwr;\n    rc = moveToChild(pCur, chldPg);\n    if( rc ) break;\n  }"
   }
  ]
 },
 {
  "id": "05-postgres-bt-search",
  "engine": "PostgreSQL",
  "repo": "postgres/postgres",
  "sha": "6f3bdadaadc4692050ca20dff53d3890088b9272",
  "path": "src/backend/access/nbtree/nbtsearch.c",
  "lang": "c",
  "title": "<code>_bt_search</code>: descend, but first check whether the page split under you",
  "prompt": "Before searching each page, the loop calls <code>_bt_moveright</code>. What race is it handling, and why doesn't our tree need it?",
  "notes": "<p>Same shape as our descent: binary-search the page (<code>_bt_binsrch</code>), follow the chosen pivot's downlink, stop at a leaf. The extra step is concurrency. PostgreSQL's btree is Lehman &amp; Yao's: every page, not just leaves, has a right-link. If another backend split the page after we read its downlink in the parent, the key may now live in the new right sibling, and <code>_bt_moveright</code> follows right-links until it finds the right page.</p><p>That's why the descent can hold a lock on only one page at a time (<code>_bt_relandgetbuf</code> releases the parent before locking the child). Our single-threaded tree never sees a page change mid-search.</p>",
  "segments": [
   {
    "start": 119,
    "end": 159,
    "code": "\t/* Loop iterates once per level descended in the tree */\n\tfor (;;)\n\t{\n\t\tPage\t\tpage;\n\t\tBTPageOpaque opaque;\n\t\tOffsetNumber offnum;\n\t\tItemId\t\titemid;\n\t\tIndexTuple\titup;\n\t\tBlockNumber child;\n\t\tBTStack\t\tnew_stack;\n\n\t\t/*\n\t\t * Race -- the page we just grabbed may have split since we read its\n\t\t * downlink in its parent page (or the metapage).  If it has, we may\n\t\t * need to move right to its new sibling.  Do that.\n\t\t *\n\t\t * In write-mode, allow _bt_moveright to finish any incomplete splits\n\t\t * along the way.  Strictly speaking, we'd only need to finish an\n\t\t * incomplete split on the leaf page we're about to insert to, not on\n\t\t * any of the upper levels (internal pages with incomplete splits are\n\t\t * also taken care of in _bt_getstackbuf).  But this is a good\n\t\t * opportunity to finish splits of internal pages too.\n\t\t */\n\t\t*bufP = _bt_moveright(rel, heaprel, key, *bufP, (access == BT_WRITE),\n\t\t\t\t\t\t\t  stack_in, page_access);\n\n\t\t/* if this is a leaf page, we're done */\n\t\tpage = BufferGetPage(*bufP);\n\t\topaque = BTPageGetOpaque(page);\n\t\tif (P_ISLEAF(opaque))\n\t\t\tbreak;\n\n\t\t/*\n\t\t * Find the appropriate pivot tuple on this page.  Its downlink points\n\t\t * to the child page that we're about to descend to.\n\t\t */\n\t\toffnum = _bt_binsrch(rel, key, *bufP);\n\t\titemid = PageGetItemId(page, offnum);\n\t\titup = (IndexTuple) PageGetItem(page, itemid);\n\t\tAssert(BTreeTupleIsPivot(itup) || !key->heapkeyspace);\n\t\tchild = BTreeTupleGetDownLink(itup);"
   },
   {
    "start": 184,
    "end": 185,
    "code": "\t\t/* drop the read lock on the page, then acquire one on its child */\n\t\t*bufP = _bt_relandgetbuf(rel, *bufP, child, page_access);"
   }
  ]
 },
 {
  "id": "05-cockroach-lookup-join",
  "engine": "CockroachDB",
  "repo": "cockroachdb/cockroach",
  "sha": "d30c905fff79ef825adc96bcc647f1872a90f2ff",
  "path": "pkg/sql/rowexec/joinreader.go",
  "lang": "go",
  "title": "Lookup join: the index nested-loop join, in batches",
  "prompt": "Our <code>IndexNLJoin</code> does one index search per outer row. How many outer rows does this operator read before it looks anything up?",
  "notes": "<p>This is the index nested-loop join from this post, as a CockroachDB processor. <code>Next()</code> is an explicit state machine (<code>jrReadingInput</code> → <code>jrFetchingLookupRows</code> → <code>jrEmittingRows</code>), the same \"loop as state on the heap\" pattern as our iterators.</p><p>The difference is batching. Per the comment, it reads a <em>batch</em> of input rows, maps them to index keys, and issues the lookups together. The index lives in a distributed key-value store, so one round trip per outer row would dominate the cost; batching amortizes it. Our in-memory B+tree makes a single search cheap, so we never needed to.</p>",
  "segments": [
   {
    "start": 801,
    "end": 838,
    "code": "func (jr *joinReader) Next() (rowenc.EncDatumRow, *execinfrapb.ProducerMetadata) {\n\t// The lookup join is implemented as follows:\n\t// - Read the input rows in batches.\n\t// - For each batch, map the rows onto index keys and perform an index\n\t//   lookup for those keys. Note that multiple rows may map to the same key.\n\t// - Retrieve the index lookup results in batches, since the index scan may\n\t//   return more rows than the input batch size.\n\t// - Join the index rows with the corresponding input rows and buffer the\n\t//   results in jr.toEmit.\n\tfor jr.State == execinfra.StateRunning {\n\t\tvar row rowenc.EncDatumRow\n\t\tvar meta *execinfrapb.ProducerMetadata\n\t\tswitch jr.runningState {\n\t\tcase jrReadingInput:\n\t\t\tjr.runningState, row, meta = jr.readInput()\n\t\tcase jrFetchingLookupRows:\n\t\t\tjr.runningState, meta = jr.fetchLookupRow()\n\t\tcase jrEmittingRows:\n\t\t\tjr.runningState, row, meta = jr.emitRow()\n\t\tcase jrReadyToDrain:\n\t\t\tjr.MoveToDraining(nil)\n\t\t\tmeta = jr.DrainHelper()\n\t\t\tjr.runningState = jrStateUnknown\n\t\tdefault:\n\t\t\tlog.Dev.Fatalf(jr.Ctx(), \"unsupported state: %d\", jr.runningState)\n\t\t}\n\t\tif row == nil && meta == nil {\n\t\t\tcontinue\n\t\t}\n\t\tif meta != nil {\n\t\t\treturn nil, meta\n\t\t}\n\t\tif outRow := jr.ProcessRowHelper(row); outRow != nil {\n\t\t\treturn outRow, nil\n\t\t}\n\t}\n\treturn nil, jr.DrainHelper()\n}"
   }
  ]
 }
]);
