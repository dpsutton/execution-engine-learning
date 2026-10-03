// Part 6 figures: a histogram explorer (estimated vs actual rows on the real generated data), and a
// step-through Selinger DP join ordering with estimated and actual cardinalities.
(function () {
  "use strict";
  const { el, svg, clear, frame, seg, fmt } = EE;

  // ---------------------------------------------------------------- the generated dataset (DESIGN.md)
  const CITIES = ["Austin", "Boston", "Chicago", "Denver", "Miami", "Oakland", "Portland", "Seattle"];
  const CATEGORIES = ["books", "games", "garden", "music", "tools"];
  function generate() {
    const r = EE.lcg(42n);
    const customers = [], products = [], orders = [];
    for (let id = 1; id <= 200; id++) {
      const x = r.intn(100);
      const city = x < 40 ? CITIES[0] : x < 60 ? CITIES[1] : x < 72 ? CITIES[2] : CITIES[3 + r.intn(5)];
      let age = 18 + r.intn(60);
      if (id % 17 === 0) age = null;
      customers.push({ id, name: "cust" + id, city, age });
    }
    for (let id = 1; id <= 50; id++) {
      const category = CATEGORIES[r.intn(5)];
      const price = (100 + r.intn(9900)) / 100;
      products.push({ id, name: "prod" + id, category, price });
    }
    for (let id = 1; id <= 5000; id++) {
      const x = r.intn(100);
      const customer_id = x < 50 ? 1 + r.intn(20) : 1 + r.intn(200);
      const product_id = 1 + r.intn(50);
      const qty = 1 + r.intn(5);
      const day = 1 + r.intn(365);
      orders.push({ id, customer_id, product_id, qty, day });
    }
    return { customers, products, orders };
  }
  let DB = null;
  const db = () => (DB = DB || generate());

  // ---------------------------------------------------------------- ANALYZE
  const NBUCKETS = 8;
  function analyze(values) {
    const nonNull = values.filter((v) => v !== null);
    const sorted = nonNull.slice().sort((a, b) => a - b);
    const ndv = new Set(sorted).size;
    return { rows: values.length, nulls: values.length - nonNull.length, ndv, min: sorted[0], max: sorted[sorted.length - 1], sorted };
  }
  // Each bucket: {lo, hi, count, ndv} over an integer domain.
  function equiDepth(st) {
    const s = st.sorted, n = s.length, buckets = [];
    let start = 0;
    for (let b = 0; b < NBUCKETS && start < n; b++) {
      let end = Math.min(n, Math.round(((b + 1) * n) / NBUCKETS)) - 1;
      if (end < start) continue;
      while (end + 1 < n && s[end + 1] === s[end]) end++;   // never split one value across buckets
      const lo = buckets.length ? buckets[buckets.length - 1].hi + 1 : st.min;
      buckets.push({ lo, hi: s[end], count: end - start + 1, ndv: new Set(s.slice(start, end + 1)).size });
      start = end + 1;
    }
    return buckets;
  }
  function equiWidth(st) {
    const w = (st.max - st.min + 1) / NBUCKETS, buckets = [];
    for (let b = 0; b < NBUCKETS; b++) {
      const lo = Math.ceil(st.min + b * w), hi = b === NBUCKETS - 1 ? st.max : Math.ceil(st.min + (b + 1) * w) - 1;
      const inB = st.sorted.filter((v) => v >= lo && v <= hi);
      buckets.push({ lo, hi, count: inB.length, ndv: new Set(inB).size });
    }
    return buckets;
  }
  function estLE(st, buckets, x) {
    if (!buckets) return x < st.min ? 0 : x >= st.max ? st.rows - st.nulls : ((x - st.min + 1) / (st.max - st.min + 1)) * (st.rows - st.nulls);
    let est = 0;
    for (const b of buckets) {
      if (x >= b.hi) est += b.count;
      else if (x >= b.lo) est += (b.count * (x - b.lo + 1)) / (b.hi - b.lo + 1);
    }
    return est;
  }
  function estEQ(st, buckets, x) {
    if (x < st.min || x > st.max) return 0;
    if (!buckets) return (st.rows - st.nulls) / st.ndv;
    const b = buckets.find((b) => x >= b.lo && x <= b.hi);
    return b && b.ndv ? b.count / b.ndv : 0;
  }

  const stat = (value, label, cls) => el("span", { class: "stat" + (cls ? " " + cls : "") }, el("b", { text: String(value) }), el("span", { text: label }));
  const errFactor = (est, act) => { if (act === 0 && est < 0.5) return "exact"; const a = Math.max(act, 0.5), e = Math.max(est, 0.5); const f = Math.max(a / e, e / a); return f < 1.05 ? "≈ exact" : (e > a ? "over " : "under ") + f.toFixed(1) + "×"; };

  // ---------------------------------------------------------------- figure A: histograms
  function figHistogram() {
    const mount = document.getElementById("viz-histogram");
    if (!mount) return;
    const v = frame(mount, "What the histogram believes", "real generated data · 8 buckets");
    const COLS = [
      { label: "orders.customer_id", get: () => db().orders.map((o) => o.customer_id), x0: 7 },
      { label: "orders.day", get: () => db().orders.map((o) => o.day), x0: 100 },
      { label: "customers.age", get: () => db().customers.map((c) => c.age), x0: 30 },
    ];
    let col = 0, op = 0, kind = 1;
    const slider = el("input", { type: "range", min: 0, max: 1, value: 0, style: "width:12rem" });
    const predOut = el("b", { class: "mono" });
    v.controls.append(
      seg(COLS.map((c) => c.label), 0, (i) => { col = i; setup(); }),
      seg(["col <= x", "col = x"], 0, (i) => { op = i; draw(); }),
      seg(["no histogram", "equi-depth", "equi-width"], 1, (i) => { kind = [0, 1, 2][i]; draw(); }),
      el("label", null, slider, predOut));
    const statsRow = el("div", { class: "stats-row", style: "margin-bottom:.8rem" });
    const chart = el("div", { style: "overflow-x:auto" });
    const meta = el("div", { class: "table-wrap", style: "margin:.8rem 0 0" });
    v.stage.append(statsRow, chart, meta);
    slider.addEventListener("input", draw);

    const guess = EE.predict(null, {
      id: "06-customer-7",
      prompt: "Knowing only <code>rows</code> and <code>ndv</code>, the estimator says customer 7 has 5000 / 200 = <b>25</b> orders. How many does customer 7 actually have?",
      number: { min: 0, max: 300, value: 25 },
      unit: "orders",
      answer: 126,
      explain: "Half of all orders go to customers 1–20, and a single ndv can't see skew: every value gets the same share. Switch the figure to equi-depth: its narrow buckets over 1–19 estimate 143.",
      onLock: () => {
        const segs = v.controls.querySelectorAll(".seg");
        segs[0].querySelectorAll("button")[0].click();   // orders.customer_id (resets x to 7)
        segs[1].querySelectorAll("button")[1].click();   // col = x
        segs[2].querySelectorAll("button")[0].click();   // no histogram
        slider.value = 7;
        draw();
        guess.reveal();
      },
    });
    v.stage.before(guess.el);

    let st, freq, hist;
    function setup() {
      const vals = COLS[col].get();
      st = analyze(vals);
      freq = new Map();
      st.sorted.forEach((x) => freq.set(x, (freq.get(x) || 0) + 1));
      hist = { 1: equiDepth(st), 2: equiWidth(st) };
      slider.min = st.min; slider.max = st.max; slider.value = COLS[col].x0;
      draw();
    }

    function draw() {
      const x = +slider.value, buckets = kind ? hist[kind] : null;
      const name = COLS[col].label.split(".")[1];
      predOut.textContent = `${name} ${op ? "=" : "<="} ${x}`;
      const actual = op ? freq.get(x) || 0 : st.sorted.filter((y) => y <= x).length;
      const est = op ? estEQ(st, buckets, x) : estLE(st, buckets, x);
      clear(statsRow).append(stat(actual, "actual rows"), stat(est.toFixed(1), "estimated"), stat(errFactor(est, actual), "error"),
        stat(st.rows, "rows"), stat(st.nulls, "nulls"), stat(st.ndv, "ndv"), stat(`${st.min}–${st.max}`, "min–max"));
      // chart: per-value frequency bars + bucket density blocks
      const W = 760, H = 230, L = 40, R = 10, T = 12, B = 30;
      const span = st.max - st.min + 1;
      const xs = (val) => L + ((val - st.min) / span) * (W - L - R);
      const bw = Math.max((W - L - R) / span, 0.6);
      let ymax = Math.max(...freq.values());
      const dens = (b) => b.count / (b.hi - b.lo + 1);
      if (buckets) ymax = Math.max(ymax, ...buckets.map(dens));
      if (!buckets) ymax = Math.max(ymax, (st.rows - st.nulls) / span);
      const ys = (c) => T + (1 - c / ymax) * (H - T - B);
      const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", style: "display:block;height:auto;min-width:560px;max-width:none" });
      // predicate region
      const inPred = (val) => (op ? val === x : val <= x);
      g.append(svg("rect", { x: op ? xs(x) - 1 : L, y: T, width: op ? bw + 2 : Math.max(0, xs(x) + bw - L), height: H - T - B, style: "fill:var(--accent-soft)" }));
      // bucket blocks (what the estimator assumes: uniform inside each bucket)
      const blocks = buckets || [{ lo: st.min, hi: st.max, count: st.rows - st.nulls }];
      blocks.forEach((b, i) => {
        g.append(svg("rect", { x: xs(b.lo), y: ys(dens(b)), width: Math.max(1, xs(b.hi + 1) - xs(b.lo)), height: H - B - ys(dens(b)),
          style: `fill:var(--teal-soft);stroke:var(--teal);stroke-width:1.2;opacity:${i % 2 ? 0.85 : 1}` }));
      });
      // actual frequencies
      for (const [val, c] of freq) {
        g.append(svg("rect", { x: xs(val), y: ys(c), width: Math.max(bw - (bw > 3 ? 1 : 0), 0.6), height: H - B - ys(c),
          style: `fill:${inPred(val) ? "var(--accent)" : "var(--ink-faint)"};opacity:.85` }));
      }
      g.append(svg("line", { x1: L, x2: W - R, y1: H - B, y2: H - B, style: "stroke:var(--ink-faint)" }));
      [st.min, Math.round(st.min + span / 2), st.max].forEach((t) => g.append(svg("text", { x: xs(t) + bw / 2, y: H - B + 16, "text-anchor": "middle", "font-size": 11, class: "faint", text: t })));
      g.append(svg("text", { x: L - 6, y: ys(ymax) + 4, "text-anchor": "end", "font-size": 11, class: "faint", text: Math.round(ymax) }));
      g.append(svg("text", { x: L - 6, y: H - B, "text-anchor": "end", "font-size": 11, class: "faint", text: 0 }));
      clear(chart).append(g);
      // bucket table
      clear(meta);
      if (buckets) meta.append(EE.table(["bucket", "lo", "hi", "count", "ndv", "rows/value"],
        buckets.map((b, i) => [i + 1, b.lo, b.hi, b.count, b.ndv, (b.count / b.ndv).toFixed(1)]),
        { rowClass: (r) => (op ? (x >= r[1] && x <= r[2] ? "hl" : null) : r[1] <= x ? "hl" : null) }));
      else meta.append(el("p", { class: "viz-sub", style: "margin:0", text: `No histogram: assume values spread evenly between min and max. Equality = (rows − nulls) / ndv = ${((st.rows - st.nulls) / st.ndv).toFixed(1)} rows for any value.` }));
      v.foot.textContent = op
        ? (buckets ? `Equality: find x's bucket, assume its ${hist[kind].length} buckets' values are equally common: count / ndv of that bucket.` : "Equality with only ndv: every value gets the same share.")
          + " Grey/orange bars are the real per-value counts; teal blocks are the estimator's assumption."
        : "Range: add whole buckets below x, plus a linear slice of the bucket x falls in. Grey/orange bars are the real per-value counts; teal blocks are the estimator's assumption.";
    }
    setup();
  }

  // ---------------------------------------------------------------- figure B: DP join ordering
  function figDP() {
    const mount = document.getElementById("viz-dp");
    if (!mount) return;
    const v = frame(mount, "Choosing a join order, one subset at a time", "Selinger DP, left-deep · customers c, orders o, products p");

    const SCENARIOS = [
      { label: "no filters", sql: "", filters: {} },
      { label: "c.city = 'Seattle'", sql: "WHERE c.city = 'Seattle'", filters: { c: { col: "city", op: "=", val: "Seattle" } } },
      { label: "p.category = 'games'", sql: "WHERE p.category = 'games'", filters: { p: { col: "category", op: "=", val: "games" } } },
      { label: "c.age < 25 AND p.category = 'games'", sql: "WHERE c.age < 25 AND p.category = 'games'",
        filters: { c: { col: "age", op: "<", val: 25 }, p: { col: "category", op: "=", val: "games" } } },
    ];
    const REL = {
      c: { table: "customers", get: () => db().customers },
      o: { table: "orders", get: () => db().orders },
      p: { table: "products", get: () => db().products },
    };
    // join predicates: [relA, colA, relB, colB]
    const EDGES = [["o", "customer_id", "c", "id"], ["o", "product_id", "p", "id"]];
    const INDEXED = { "c.id": true, "p.id": true, "o.customer_id": true, "o.product_id": true, "o.id": true };

    const statsCache = {};
    function colStats(rel, col) {
      const key = rel + "." + col;
      if (!statsCache[key]) {
        const vals = REL[rel].get().map((r) => r[col]);
        const isNum = vals.some((x) => typeof x === "number");
        const st = isNum ? analyze(vals) : { rows: vals.length, nulls: vals.filter((x) => x === null).length, ndv: new Set(vals.filter((x) => x !== null)).size };
        if (isNum) st.hist = equiDepth(st);
        statsCache[key] = st;
      }
      return statsCache[key];
    }
    function filterSel(rel, f) {
      const st = colStats(rel, f.col), nn = (st.rows - st.nulls) / st.rows;
      if (f.op === "=") return nn / st.ndv;
      if (f.op === "<") return estLE(st, st.hist, f.val - 1) / st.rows;
    }
    function filterPass(row, f) {
      const x = row[f.col];
      if (x === null) return false;
      return f.op === "=" ? x === f.val : x < f.val;
    }

    let scen = 0, sp;
    v.controls.append(seg(SCENARIOS.map((s) => s.label), 0, (i) => { scen = i; build(); }));
    const sqlBox = el("pre", { style: "margin:0 0 .9rem;font-size:.78rem;padding:.6rem .8rem;border-left:3px solid var(--accent)" });
    const tableBox = el("div", { class: "table-wrap", style: "margin:0" });
    const candBox = el("div", { style: "margin-top:.9rem" });
    const explainBox = el("pre", { style: "margin:.9rem 0 0;font-size:.76rem", hidden: true });
    const stepControls = el("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap;margin:.2rem 0 .9rem" });
    v.stage.append(sqlBox, stepControls, tableBox, candBox, explainBox);

    const scenSeg = v.controls.querySelector(".seg");
    const guess = EE.predict(null, {
      id: "06-dp-seattle",
      prompt: "Add <code>c.city = 'Seattle'</code> (estimated 25 of 200 customers). Which plan does the DP pick?",
      choices: [
        "Hash join customers ⋈ orders, then hash join products",
        "Filter to Seattle customers, then seek each one's orders through the <code>orders.customer_id</code> index",
        "Join orders ⋈ products first and apply the Seattle filter last",
        "customers × products first, because both tables are small",
      ],
      answer: 1,
      explain: "With only ~25 outer rows, 25 index seeks are far cheaper than hashing 5,000 orders. Products is then hash-joined on top. Step through the figure to see the hash-join candidate lose on cost.",
      onLock: () => {
        scenSeg.querySelectorAll("button")[1].click();
        sp.go(1e9);
        guess.reveal();
      },
    });
    v.stage.before(guess.el);

    function build() {
      const S = SCENARIOS[scen];
      sqlBox.textContent = `SELECT …\nFROM customers c, orders o, products p\nWHERE o.customer_id = c.id AND o.product_id = p.id${S.sql ? "\n  AND " + S.sql.slice(6) : ""}`;
      const frames = computeFrames(S);
      clear(stepControls);
      sp = EE.stepper(stepControls, frames, render, { speed: 1 });
    }

    // ---- actual cardinalities, by brute force on the real data
    function actualRows(S, set) {
      const rows = {};
      for (const r of ["c", "o", "p"]) rows[r] = REL[r].get().filter((row) => !S.filters[r] || filterPass(row, S.filters[r]));
      const has = (r) => set.includes(r);
      if (set.length === 1) return rows[set[0]].length;
      const cIds = new Set(rows.c.map((r) => r.id)), pIds = new Set(rows.p.map((r) => r.id));
      if (set.length === 2 && has("c") && has("p")) return rows.c.length * rows.p.length;
      return rows.o.filter((o) => (!has("c") || cIds.has(o.customer_id)) && (!has("p") || pIds.has(o.product_id))).length;
    }

    function computeFrames(S) {
      const frames = [];
      const best = {};
      const name = (set) => "{" + set.join(", ") + "}";
      const key = (set) => set.slice().sort().join("");
      // level 1: access paths
      for (const r of ["c", "o", "p"]) {
        const base = REL[r].get().length;
        const f = S.filters[r];
        const est = f ? base * filterSel(r, f) : base;
        const cost = base + (f ? base : 0);
        best[r] = { set: [r], est, cost, plan: f ? `Filter(${f.col} ${f.op} ${typeof f.val === "string" ? "'" + f.val + "'" : f.val}, Scan ${r})` : `Scan ${r}`, tree: { label: f ? `Filter ${r}.${f.col} ${f.op} ${typeof f.val === "string" ? "'" + f.val + "'" : f.val}` : `Scan ${REL[r].table} ${r}`, kids: f ? [{ label: `Scan ${REL[r].table} ${r}`, kids: [], est: base, act: base }] : [] } };
        best[r].act = actualRows(S, [r]);
        best[r].tree.est = est; best[r].tree.act = best[r].act;
        frames.push({ done: snapshot(best), current: r, cands: [{ text: best[r].plan, cost, est, chosen: true }],
          note: `Level 1: the only way to get ${REL[r].table} is a scan${f ? " plus a filter (estimated selectivity " + (est / base * 100).toFixed(1) + "%)" : ""}.` });
      }
      // levels 2, 3
      const subsets2 = [["c", "o"], ["o", "p"], ["c", "p"]];
      let cpSeen = false;
      for (const set of [...subsets2, ["c", "o", "p"]]) {
        if (key(set) === "cp") cpSeen = true;
        const cands = [];
        for (const r of set) {
          const rest = set.filter((x) => x !== r);
          const left = best[key(rest)];
          const edges = EDGES.filter((e) => (rest.includes(e[0]) && e[2] === r) || (rest.includes(e[2]) && e[0] === r));
          if (!left) { cands.push({ text: `${name(rest)} ⋈ ${r}  (needs the ${name(rest)} cross product)`, cross: true }); continue; }
          if (!edges.length) { cands.push({ text: `${left.plan ? name(rest) : ""} × ${r}`, cross: true }); continue; }
          const e = edges[0];
          const [innerCol, outerRel, outerCol] = e[0] === r ? [e[1], e[2], e[3]] : [e[3], e[0], e[1]];
          const ndvA = colStats(r, innerCol).ndv, ndvB = colStats(outerRel, outerCol).ndv;
          const right = best[r];
          const est = (left.est * right.est) / Math.max(ndvA, ndvB);
          const cond = `${outerRel}.${outerCol} = ${r}.${innerCol}`;
          const baseInner = REL[r].get().length;
          const options = [
            { alg: "HashJoin", cost: left.cost + right.cost + 2 * right.est + left.est },
            { alg: "NLJoin", cost: left.cost + right.cost + left.est * right.est },
          ];
          if (INDEXED[r + "." + innerCol]) {
            const preFilter = (left.est * baseInner) / Math.max(ndvA, ndvB);
            options.push({ alg: "IndexNLJoin", cost: left.cost + left.est * (Math.log2(baseInner) + preFilter / Math.max(left.est, 1)) + (S.filters[r] ? preFilter : 0) });
          }
          for (const o of options) cands.push({ text: `${name(rest)} ${o.alg} ${r}  on ${cond}`, alg: o.alg, cost: o.cost, est, left, right, r, cond, rest });
        }
        const real = cands.filter((c) => !c.cross);
        let chosen = null;
        if (real.length) {
          chosen = real.reduce((a, b) => (b.cost < a.cost ? b : a));
          chosen.chosen = true;
          const k = key(set);
          best[k] = { set, est: chosen.est, cost: chosen.cost, plan: `(${chosen.left.plan}) ${chosen.alg} ${chosen.r}`, act: actualRows(S, set),
            tree: { label: `${chosen.alg} ${chosen.cond}`, kids: [chosen.left.tree, chosen.alg === "IndexNLJoin" ? { label: `IndexSeek ${REL[chosen.r].table} ${chosen.r} on ${chosen.cond.split(" = ").find((x) => x.startsWith(chosen.r + "."))}${S.filters[chosen.r] ? " + filter" : ""}`, kids: [], est: null, act: null } : chosen.right.tree] } };
          best[k].tree.est = chosen.est; best[k].tree.act = best[k].act;
        }
        frames.push({ done: snapshot(best), current: key(set), cands, cpSeen,
          note: !real.length ? `${name(set)}: no join predicate connects c and p, so the only plan is a cross product. Selinger's rule: don't consider it.`
            : `${name(set)}: ${real.length} candidates (which relation joins last × which algorithm). Keep only the cheapest; larger subsets build on it.` });
      }
      const final = best["cop"];
      frames.push({ done: snapshot(best), current: null, cands: [], explain: final, cpSeen: true,
        note: `Done. The plan for {c, o, p} is the answer. Estimated ${Math.round(final.est)} rows, actual ${final.act}.` });
      return frames;
    }
    function snapshot(best) { return Object.values(best).map((b) => ({ ...b })); }

    const nice = (x) => (x == null ? "" : x >= 100 ? Math.round(x).toLocaleString() : x >= 10 ? x.toFixed(0) : x.toFixed(1));

    function render(f) {
      const order = ["c", "o", "p", "co", "op", "cp", "cop"];
      const rows = order.map((k) => {
        const b = f.done.find((x) => key2(x.set) === k);
        const label = "{" + k.split("").join(", ") + "}";
        if (k === "cp") return f.cpSeen ? [label, "—", "—", "cross product, skipped", "—"] : [label, "", "", "", ""];
        return b ? [label, nice(b.est), b.act, b.plan, nice(b.cost)] : [label, "", "", "", ""];
      });
      clear(tableBox).append(EE.table(["subset", "est rows", "actual rows", "best plan", "cost"], rows,
        { rowClass: (r, i) => (order[i] === f.current ? "hl" : r[1] === "" ? "dim" : null) }));
      clear(candBox);
      if (f.cands.length) {
        candBox.append(el("div", { class: "viz-sub", style: "margin-bottom:.35rem", text: "Candidates for this subset" }),
          EE.table(["plan", "est rows", "cost"], f.cands.map((c) => [c.text, c.cross ? "—" : nice(c.est), c.cross ? "not considered" : nice(c.cost)]),
            { rowClass: (_, i) => (f.cands[i].chosen ? "pass" : f.cands[i].cross ? "dim" : null) }));
      }
      explainBox.hidden = !f.explain;
      if (f.explain) explainBox.textContent = "EXPLAIN (estimated vs actual rows)\n" + explain(f.explain.tree, 0);
      v.foot.textContent = f.note;
    }
    const key2 = (set) => set.slice().sort().join("");
    function explain(t, d) {
      const pad = "  ".repeat(d);
      const counts = t.est == null ? "" : `  (est=${nice(t.est)} actual=${t.act})`;
      return pad + t.label + counts + "\n" + t.kids.map((k) => explain(k, d + 1)).join("");
    }

    build();
  }

  document.addEventListener("DOMContentLoaded", () => { figHistogram(); figDP(); });
  window.EE6 = { generate, analyze, equiDepth, equiWidth, estLE, estEQ };
})();
