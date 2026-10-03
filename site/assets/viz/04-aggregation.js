// Part 4 figures: hash vs sort aggregation, external merge sort, top-N with a heap.
(function () {
  "use strict";
  const { el, svg, clear, fmt, frame, stepper, seg, TOY, lcg } = EE;

  // ---------- figure A: GROUP BY product_id, hash vs sort ----------
  // orders(id, customer_id, product_id, qty)
  const ORD = TOY.orders.rows;
  const OUT_COLS = ["product_id", "count(*)", "sum(qty)", "avg(qty)"];
  const finalize = (g) => [g.key, g.count, g.sum, (g.sum / g.count).toFixed(2)]; // avg is always a float: print 2.00, not 2
  const stateText = (g) => [["count", g.count], ["sum", g.sum], ["avg", `(${g.sum}, ${g.count})`]];

  function hashFrames() {
    const fr = [], groups = [], index = new Map(), out = [];
    const snap = (o) => fr.push({ mode: "hash", groups: groups.map((g) => ({ ...g })), out: out.slice(), order: ORD.map((_, i) => i), maxHeld: groups.length, ...o });
    snap({ cur: -1, msg: "Hash aggregation: one pass over the input. Each row finds its group's accumulator in a hash table (creating it on first sight) and updates it." });
    ORD.forEach((r, i) => {
      const key = r[2];
      let created = false;
      if (!index.has(key)) { index.set(key, groups.length); groups.push({ key, count: 0, sum: 0 }); created = true; }
      const g = groups[index.get(key)];
      g.count += 1; g.sum += r[3];
      snap({ cur: i, active: key, msg: `order ${r[0]}: product_id ${key} → ${created ? "new group (first seen), " : "existing group, "}count = ${g.count}, sum = ${g.sum}, avg state = (sum ${g.sum}, count ${g.count})` });
    });
    groups.forEach((g) => out.push(finalize(g)));
    snap({ cur: -1, done: true, msg: `Input exhausted. Only now can any group be emitted: finalize each (avg = sum / count) and output in first-seen order. ${groups.length} groups were held in memory at once.` });
    return fr;
  }

  function sortFrames() {
    const fr = [], out = [];
    const order = ORD.map((_, i) => i).sort((a, b) => ORD[a][2] - ORD[b][2]); // stable sort by product_id
    let cur = null;
    const snap = (o) => fr.push({ mode: "sort", groups: cur ? [{ ...cur }] : [], out: out.slice(), order, maxHeld: 1, ...o });
    snap({ cur: -1, msg: "Sort aggregation: first sort the input by the group key (shown sorted). Rows of one group are now adjacent." });
    order.forEach((i) => {
      const r = ORD[i], key = r[2];
      if (cur && cur.key !== key) {
        out.push(finalize(cur));
        snap({ cur: i, emitted: true, msg: `product_id changed ${cur.key} → ${key}: group ${cur.key} can never get another row, so finalize and emit it now.` });
        cur = null;
      }
      if (!cur) cur = { key, count: 0, sum: 0 };
      cur.count += 1; cur.sum += r[3];
      snap({ cur: i, active: key, msg: `order ${r[0]}: product_id ${key}, count = ${cur.count}, sum = ${cur.sum}` });
    });
    if (cur) { out.push(finalize(cur)); cur = null; snap({ cur: -1, done: true, msg: "End of input: emit the last group. One group's state in memory at a time, and output starts streaming as soon as the first group ends." }); }
    return fr;
  }

  function figA() {
    const mount = document.querySelector("#viz-agg");
    if (!mount) return;
    const v = frame(mount, "Grouping: hash or sort", "SELECT product_id, count(*), sum(qty), avg(qty) FROM orders GROUP BY product_id");
    let mode = 0;
    v.root.insertBefore(el("div", { class: "viz-controls" }, seg(["Hash aggregate", "Sort aggregate"], 0, (i) => { mode = i; ctl.setFrames(mode ? sortFrames() : hashFrames()); })), v.controls);
    let onEnd = null;
    const play = () => [...v.controls.querySelectorAll("button")].find((b) => /Play/.test(b.textContent)).click();
    const pm = el("div"); v.root.insertBefore(pm, v.stage);
    const guess = EE.predict(pm, {
      prompt: "Grouping 5,000 orders by <code>product_id</code> (50 products). At peak, how many accumulators does each strategy hold — hash / sort?",
      choices: ["5,000 / 5,000", "5,000 / 1", "50 / 50", "50 / 1"], answer: 3,
      explain: "Hash aggregation holds one accumulator per group until the input ends (50). Sort aggregation holds only the current group, because sorted input means a finished group never comes back. The price is the sort.",
      onLock() {
        v.root.querySelector(".seg").children[0].click();        // hash aggregate (rebuilds frames)
        onEnd = () => guess.reveal();
        play();
      },
    });

    const inBox = el("div"), gBox = el("div", { class: "ag-groups" }), outBox = el("div"), stats = el("div", { class: "stats-row", style: "margin-bottom:1rem" });
    v.stage.append(stats, el("div", { class: "ag-grid" },
      el("div", null, el("div", { class: "ag-label", text: "orders (input)" }), inBox),
      el("div", null, el("div", { class: "ag-label", text: "accumulators in memory" }), gBox),
      el("div", null, el("div", { class: "ag-label", text: "output" }), outBox)));

    function render(f) {
      const pos = f.cur >= 0 ? f.order.indexOf(f.cur) : f.done ? f.order.length : -1;
      clear(inBox).append(EE.table(TOY.orders.columns, f.order.map((i) => ORD[i]), {
        rowClass: (_, k) => (k === pos ? "hl" : k < pos ? "dim" : null) }));
      clear(gBox);
      if (!f.groups.length) gBox.append(el("span", { class: "viz-sub", text: f.done ? "(all emitted)" : "(empty)" }));
      f.groups.forEach((g) => gBox.append(el("div", { class: "ag-card" + (g.key === f.active ? " on" : "") },
        el("div", { class: "ag-key" }, "product_id ", el("b", { text: g.key })),
        ...stateText(g).map(([k, val]) => el("div", { class: "ag-st" }, el("span", { text: k }), el("b", { class: "mono", text: val }))))));
      clear(outBox).append(f.out.length ? EE.table(OUT_COLS, f.out) : el("span", { class: "viz-sub", text: "(nothing yet)" }));
      clear(stats).append(
        el("span", { class: "stat" }, el("b", { text: f.groups.length }), el("span", { text: "groups in memory now" })),
        el("span", { class: "stat" }, el("b", { text: f.out.length }), el("span", { text: "groups emitted" })));
      v.foot.textContent = f.msg;
      if (onEnd && f.done) { const k = onEnd; onEnd = null; k(); }
    }
    const ctl = stepper(v.controls, hashFrames(), render, { speed: 3 });
  }

  // ---------- figure B: external merge sort ----------
  function figB() {
    const mount = document.querySelector("#viz-extsort");
    if (!mount) return;
    const v = frame(mount, "External merge sort", "sort 24 rows when only M fit in memory");
    const g = lcg(7n);
    const data = Array.from({ length: 24 }, () => g.intn(100));
    let M = 6;
    const mIn = el("input", { type: "range", min: 3, max: 12, value: M, oninput: (e) => { M = +e.target.value; mLab.textContent = M; ctl.setFrames(build()); } });
    const mLab = el("b", { class: "mono", text: M });
    v.root.insertBefore(el("div", { class: "viz-controls" }, el("label", null, "memory M =", mIn, mLab, "rows")), v.controls);

    function build() {
      const fr = [], runs = [];
      const input = data.slice();
      let consumed = 0;
      const snap = (o) => fr.push({ runs: runs.map((r) => r.slice()), consumed, ...o });
      snap({ phase: 1, mem: [], msg: `Phase 1 (run generation): read M = ${M} rows at a time, sort them in memory, write each sorted chunk out as a "run".` });
      while (consumed < input.length) {
        const chunk = input.slice(consumed, consumed + M);
        consumed += chunk.length;
        snap({ phase: 1, mem: chunk, msg: `Load ${chunk.length} rows into memory (full).` });
        const sorted = chunk.slice().sort((a, b) => a - b);
        snap({ phase: 1, mem: sorted, sortedMem: true, msg: "Sort them in memory." });
        runs.push(sorted);
        snap({ phase: 1, mem: [], msg: `Write run ${runs.length} to disk.` });
      }
      // phase 2: k-way merge with a min-heap of run heads
      const ptr = runs.map(() => 0), out = [];
      let cmps = 0;
      const heads = () => runs.map((r, i) => (ptr[i] < r.length ? { v: r[ptr[i]], run: i } : null)).filter(Boolean);
      const passes = runs.length <= 1 ? 0 : Math.ceil(Math.log(runs.length) / Math.log(Math.max(2, M - 1)));
      snap({ phase: 2, ptr: ptr.slice(), out: [], heap: heads(), msg: `Phase 2 (merge): ${runs.length} sorted runs. Keep one "head" per run in a min-heap; repeatedly output the smallest head and refill from its run. ${runs.length > M - 1 ? `With only M = ${M} rows of memory you can merge at most ${M - 1} runs at once, so a real sort would need ${passes} merge passes. The animation merges all runs in one pass.` : "All runs fit in one merge pass."}` });
      for (;;) {
        const h = heads();
        if (!h.length) break;
        cmps += Math.max(0, Math.ceil(Math.log2(h.length)));
        const best = h.reduce((a, b) => (b.v < a.v ? b : a));
        out.push(best.v); ptr[best.run]++;
        snap({ phase: 2, ptr: ptr.slice(), out: out.slice(), heap: heads(), took: best, msg: `Smallest head is ${best.v} from run ${best.run + 1}: output it, advance run ${best.run + 1}.` });
      }
      snap({ phase: 2, ptr: ptr.slice(), out: out.slice(), heap: [], done: true, msg: `Sorted. Every row was read twice and written twice (once per phase), whatever the size of M. Memory never held more than ${M} rows.` });
      return fr;
    }

    const memBox = el("div"), runsBox = el("div"), outBox = el("div"), inBox = el("div");
    v.stage.append(
      el("div", { class: "ag-label", text: "input on disk" }), inBox,
      el("div", { class: "es-row" },
        el("div", null, el("div", { class: "ag-label", text: "memory" }), memBox),
        el("div", null, el("div", { class: "ag-label", text: "sorted runs on disk" }), runsBox)),
      el("div", { class: "ag-label", text: "output" }), outBox);

    const cells = (vals, cls) => el("div", { class: "es-cells" }, vals.map((x, i) => el("span", { class: "es-c " + (typeof cls === "function" ? cls(x, i) : cls || ""), text: x })));
    function render(f) {
      clear(inBox).append(cells(data, (_, i) => (i < f.consumed ? "gone" : "")));
      clear(memBox).append(f.phase === 1 ? cells(f.mem.length ? f.mem : [" "], f.sortedMem ? "mem sorted" : f.mem.length ? "mem" : "empty")
        : f.heap.length ? el("div", null, el("div", { class: "viz-sub", text: "min-heap of run heads" }), cells(f.heap.slice().sort((a, b) => a.v - b.v).map((h) => h.v), (_, i) => (i === 0 ? "mem top" : "mem"))) : el("span", { class: "viz-sub", text: "(empty)" }));
      clear(runsBox).append(...f.runs.map((r, ri) => el("div", { class: "es-run" }, el("span", { class: "es-rl", text: `run ${ri + 1}` }),
        cells(r, (_, i) => (f.phase === 2 ? (i < f.ptr[ri] ? "gone" : i === f.ptr[ri] ? "head" : "") : "")))));
      clear(outBox).append(f.out && f.out.length ? cells(f.out, (_, i) => (i === f.out.length - 1 && !f.done ? "new" : "outv")) : el("span", { class: "viz-sub", text: "(nothing yet)" }));
      v.foot.textContent = f.msg;
    }
    const ctl = stepper(v.controls, build(), render, { speed: 4 });
  }

  // ---------- figure C: top-N with a min-heap ----------
  function figC() {
    const mount = document.querySelector("#viz-topn");
    if (!mount) return;
    const v = frame(mount, "ORDER BY price DESC LIMIT N", "keep the N best in a min-heap; the root is the one to beat");
    const g = lcg(11n);
    const prices = Array.from({ length: 16 }, () => (100 + g.intn(9900)) / 100);
    let N = 4;
    v.root.insertBefore(el("div", { class: "viz-controls" }, el("label", null, "N =", seg(["3", "4", "5", "7"], 1, (i) => { N = [3, 4, 5, 7][i]; ctl.setFrames(build()); }))), v.controls);

    function build() {
      const fr = [], heap = [], dropped = [];
      let cmps = 0;
      const less = (a, b) => { cmps++; return a < b; };
      const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (less(heap[i], heap[p])) { [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } else break; } };
      const down = (i) => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } };
      const snap = (o) => fr.push({ heap: heap.slice(), dropped: dropped.slice(), cmps, ...o });
      snap({ idx: -1, msg: `Stream the prices once. Keep at most ${N} in a min-heap: its root is the smallest of the best ${N} so far, the one a newcomer has to beat.` });
      prices.forEach((p, idx) => {
        if (heap.length < N) { heap.push(p); up(heap.length - 1); snap({ idx, verdict: "push", msg: `${fmt(p)}: heap not full yet, push it.` }); }
        else if (less(heap[0], p)) { const old = heap[0]; heap[0] = p; down(0); dropped.push(old); snap({ idx, verdict: "replace", msg: `${fmt(p)} beats the root ${fmt(old)}: evict ${fmt(old)}, put ${fmt(p)} at the root, sift it down.` }); }
        else { dropped.push(p); snap({ idx, verdict: "drop", msg: `${fmt(p)} ≤ root ${fmt(heap[0])}: it can't be in the top ${N}. Drop it after one comparison.` }); }
      });
      const result = heap.slice().sort((a, b) => b - a);
      snap({ idx: prices.length, done: true, result, msg: `Done: ${cmps} comparisons with ${N} values in memory. A full sort of all ${prices.length} would hold all of them and do about ${Math.round(prices.length * Math.log2(prices.length))} comparisons, then throw away ${prices.length - N}.` });
      return fr;
    }

    let onEnd = null;
    const play = () => [...v.controls.querySelectorAll("button")].find((b) => /Play/.test(b.textContent)).click();
    const pm = el("div"); v.root.insertBefore(pm, v.stage);
    const guess = EE.predict(pm, {
      prompt: "Top 4 of 16 prices. A full sort needs about 64 comparisons. How many will the heap make?",
      number: { min: 0, max: 80, step: 1, value: 40 }, tolerance: 0.25,
      explain: "Filling the heap and sifting newcomers down costs a few comparisons each, but most prices lose to the root in one comparison and are gone. The gap widens as the input grows: N·log n vs N·log N.",
      onLock() {
        v.root.querySelector(".seg").children[1].click();        // N = 4 (rebuilds frames)
        onEnd = (f) => guess.reveal(f.cmps);
        play();
      },
    });

    const streamBox = el("div"), heapBox = el("div"), resBox = el("div"), stats = el("div", { class: "stats-row", style: "margin-top:.8rem" });
    v.stage.append(el("div", { class: "ag-label", text: "input stream" }), streamBox,
      el("div", { class: "es-row" }, el("div", null, el("div", { class: "ag-label", text: "min-heap" }), heapBox), el("div", null, el("div", { class: "ag-label", text: "result" }), resBox)), stats);

    function render(f) {
      clear(streamBox).append(el("div", { class: "es-cells" }, prices.map((p, i) => el("span", {
        class: "es-c wide " + (i === f.idx ? (f.verdict === "drop" ? "drop" : "new") : i < f.idx ? (f.dropped.includes(p) ? "gone" : "outv") : ""), text: fmt(p) }))));
      // heap as a binary tree
      const n = f.heap.length, levels = Math.max(1, Math.ceil(Math.log2(n + 1)));
      const W = 360, LH = 54;
      const s = svg("svg", { viewBox: `0 0 ${W} ${levels * LH + 10}`, width: W, height: levels * LH + 10, style: "max-width:100%;height:auto" });
      const pos = (i) => { const d = Math.floor(Math.log2(i + 1)), k = i + 1 - 2 ** d, span = W / 2 ** d; return { x: span * k + span / 2, y: 22 + d * LH }; };
      for (let i = 1; i < n; i++) { const a = pos(i), b = pos((i - 1) >> 1); s.append(svg("line", { class: "edge", x1: a.x, y1: a.y, x2: b.x, y2: b.y })); }
      f.heap.forEach((val, i) => { const p = pos(i); s.append(svg("g", { class: "node" + (i === 0 ? " active" : "") },
        svg("rect", { x: p.x - 26, y: p.y - 13, width: 52, height: 26, rx: 6 }),
        svg("text", { x: p.x, y: p.y + 4, "text-anchor": "middle", class: "mono", "font-size": 12, text: fmt(val) }))); });
      clear(heapBox).append(n ? s : el("span", { class: "viz-sub", text: "(empty)" }));
      clear(resBox).append(f.result ? EE.table(["price"], f.result.map((x) => [x])) : el("span", { class: "viz-sub", text: "(after the stream ends, sort the heap's N values)" }));
      clear(stats).append(el("span", { class: "stat" }, el("b", { text: f.cmps }), el("span", { text: "comparisons" })),
        el("span", { class: "stat" }, el("b", { text: f.heap.length }), el("span", { text: "values in memory" })));
      v.foot.textContent = f.msg;
      if (onEnd && f.done) { const k = onEnd; onEnd = null; k(f); }
    }
    const ctl = stepper(v.controls, build(), render, { speed: 5 });
  }

  figA();
  figB();
  figC();
})();
