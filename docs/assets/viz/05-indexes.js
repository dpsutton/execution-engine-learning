// Part 5 figures: a live B+tree (insert / search / range with visited path), and the
// full-scan vs index-scan cost crossover.
(function () {
  "use strict";
  const { el, svg, clear, frame, seg } = EE;

  // ---------------------------------------------------------------- B+tree
  // order = max children per internal node; every node holds at most order-1 keys.
  // Leaves hold the keys (a real index stores (key, row id)); leaves are linked left→right.
  let nid = 0;
  const leaf = () => ({ id: nid++, leaf: true, keys: [], next: null });
  const inner = () => ({ id: nid++, leaf: false, keys: [], children: [] });

  function childIndex(node, key) {          // first child whose range can contain key
    let i = 0;
    while (i < node.keys.length && key >= node.keys[i]) i++;
    return i;
  }

  function makeTree(order) {
    const t = { order, root: leaf() };
    return t;
  }

  // Returns {visited: [node ids], log: [strings]}.
  function insert(t, key) {
    const visited = [], log = [];
    const max = t.order - 1;
    function ins(node) {
      visited.push(node.id);
      if (node.leaf) {
        let i = 0;
        while (i < node.keys.length && node.keys[i] < key) i++;
        node.keys.splice(i, 0, key);
        if (node.keys.length <= max) return null;
        const right = leaf(), mid = Math.ceil(node.keys.length / 2);
        right.keys = node.keys.splice(mid);
        right.next = node.next; node.next = right;
        log.push(`leaf overflowed (${max} keys max) → split into [${node.keys.join(", ")}] and [${right.keys.join(", ")}]; ${right.keys[0]} is copied up`);
        return { key: right.keys[0], right };
      }
      const i = childIndex(node, key);
      const split = ins(node.children[i]);
      if (!split) return null;
      node.keys.splice(i, 0, split.key);
      node.children.splice(i + 1, 0, split.right);
      if (node.keys.length <= max) return null;
      const right = inner(), mid = Math.floor(node.keys.length / 2), up = node.keys[mid];
      right.keys = node.keys.splice(mid + 1);
      node.keys.pop();
      right.children = node.children.splice(mid + 1);
      log.push(`inner node overflowed → split; ${up} moves up`);
      return { key: up, right };
    }
    const split = ins(t.root);
    if (split) {
      const r = inner();
      r.keys = [split.key];
      r.children = [t.root, split.right];
      t.root = r;
      log.push(`root split → tree grows one level (height ${height(t)})`);
    }
    return { visited, log };
  }

  function height(t) { let h = 1, n = t.root; while (!n.leaf) { n = n.children[0]; h++; } return h; }

  function contains(t, key) {
    let n = t.root;
    while (!n.leaf) n = n.children[childIndex(n, key)];
    return n.keys.includes(key);
  }

  // Frames for animation: each frame = {node, keys: Set of highlighted key values, note}
  function searchFrames(t, lo, hi) {
    const frames = [];
    let n = t.root;
    while (!n.leaf) {
      const i = childIndex(n, lo);
      frames.push({ node: n.id, note: `inner node [${n.keys.join(", ")}]: ${lo} → child ${i + 1} of ${n.children.length}` });
      n = n.children[i];
    }
    const found = [];
    // walk leaves until a key exceeds hi
    let done = false;
    while (n && !done) {
      const hits = n.keys.filter((k) => k >= lo && k <= hi);
      found.push(...hits);
      if (n.keys.length && n.keys[n.keys.length - 1] > hi) done = true;
      frames.push({ node: n.id, hits, note: hi === lo
        ? (hits.length ? `leaf [${n.keys.join(", ")}]: found ${lo}` : `leaf [${n.keys.join(", ")}]: ${lo} is not here, so it's not in the tree`)
        : `leaf [${n.keys.join(", ")}]: ${hits.length ? "emit " + hits.join(", ") : "nothing in range"}${done ? "; passed " + hi + ", stop" : "; follow the leaf link →"}` });
      if (lo === hi) break;
      n = n.next;
    }
    return { frames, found };
  }

  function figTree() {
    const mount = document.getElementById("viz-btree");
    if (!mount) return;
    const v = frame(mount, "A B+tree you can poke", "insert keys, change the order, search and range-scan");
    const INITIAL = [8, 3, 15, 22, 1, 12, 27, 5, 19, 30, 10, 17];
    let order = 4, keys = [], t, anim = null, lastVisits = 0;
    const lastHits = new Map();   // node id → Set of keys to highlight
    const visitedSet = new Set();
    let activeNode = null;

    const keyIn = el("input", { type: "number", value: 24, style: "width:4.5rem" });
    const findIn = el("input", { type: "number", value: 19, style: "width:4.5rem" });
    const loIn = el("input", { type: "number", value: 9, style: "width:4rem" });
    const hiIn = el("input", { type: "number", value: 23, style: "width:4rem" });
    const statBox = el("div", { class: "stats-row" });
    const svgBox = el("div", { style: "overflow-x:auto" });

    v.controls.append(
      el("label", null, "order", seg(["3", "4", "5"], 1, (i) => { order = 3 + i; rebuild(); })),
      el("span", { class: "bt-group" }, keyIn, el("button", { class: "primary", text: "Insert", onclick: () => doInsert(+keyIn.value) }),
        el("button", { text: "+5 random", onclick: insertRandom })),
      el("span", { class: "bt-group" }, findIn, el("button", { text: "Search", onclick: () => animate(+findIn.value, +findIn.value) })),
      el("span", { class: "bt-group" }, loIn, "–", hiIn, el("button", { text: "Range scan", onclick: () => animate(Math.min(+loIn.value, +hiIn.value), Math.max(+loIn.value, +hiIn.value)) })),
      el("button", { text: "⟲ Reset", onclick: () => { keys = INITIAL.slice(); rebuild(); } }));
    v.stage.append(statBox, svgBox);

    const orderSeg = v.controls.querySelector(".seg");
    const guess = EE.predict(null, {
      id: "05-insert-24",
      prompt: "This tree has order 4: at most 3 keys per node. Insert <code>24</code>. What happens?",
      choices: [
        "It fits in a leaf; nothing else changes",
        "Its leaf splits and the parent takes the new separator",
        "Its leaf splits, then the parent (the root) splits too: the tree gets one level taller",
      ],
      answer: 2,
      explain: "24 lands in the full leaf [22, 27, 30]. That leaf splits and copies 27 up; the root [8, 15, 22] is full too, so it splits and 22 moves up into a brand-new root. Trees grow at the top, which is why every leaf stays at the same depth.",
      onLock: () => {
        orderSeg.querySelectorAll("button")[1].click();
        keys = INITIAL.slice();
        rebuild();
        doInsert(24);
        guess.reveal();
      },
    });
    v.stage.before(guess.el);

    function rebuild(msg) {
      stopAnim();
      nid = 0;
      t = makeTree(order);
      keys.forEach((k) => insert(t, k));
      clearHl();
      lastVisits = 0;
      draw();
      v.foot.textContent = msg || `Built from ${keys.length} keys with order ${order}: up to ${order - 1} keys and ${order} children per node.`;
    }
    function clearHl() { lastHits.clear(); visitedSet.clear(); activeNode = null; }

    function doInsert(k) {
      if (!Number.isFinite(k)) return;
      stopAnim();
      if (contains(t, k)) { v.foot.textContent = `${k} is already in the tree (this demo keeps keys unique).`; return; }
      keys.push(k);
      const { visited, log } = insert(t, k);
      clearHl();
      visited.forEach((id) => visitedSet.add(id));
      lastVisits = visited.length;
      draw();
      v.foot.textContent = `Inserted ${k}: visited ${visited.length} node${visited.length > 1 ? "s" : ""} root→leaf. ` + (log.length ? log.join(" · ") : "The leaf had room; nothing else changed.");
      keyIn.value = k + 1;
    }
    function insertRandom() {
      const added = [];
      for (let tries = 0; added.length < 5 && tries < 200; tries++) {
        const k = 1 + Math.floor(Math.random() * 99);
        if (!contains(t, k)) { keys.push(k); insert(t, k); added.push(k); }
      }
      clearHl(); draw();
      v.foot.textContent = `Inserted ${added.join(", ")}. Height is ${height(t)}; it grows only when the root splits, so every leaf stays at the same depth.`;
    }

    function animate(lo, hi) {
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
      stopAnim();
      clearHl();
      const { frames, found } = searchFrames(t, lo, hi);
      let i = 0;
      const tick = () => {
        const f = frames[i];
        if (activeNode !== null) visitedSet.add(activeNode);
        activeNode = f.node;
        if (f.hits) lastHits.set(f.node, new Set(f.hits));
        lastVisits = i + 1;
        draw();
        v.foot.textContent = `${f.note}`;
        i++;
        if (i < frames.length) anim = setTimeout(tick, 650);
        else anim = setTimeout(() => {
          visitedSet.add(activeNode); activeNode = null; draw();
          v.foot.textContent = (lo === hi ? (found.length ? `Found ${lo}` : `${lo} not found`) : `Range [${lo}, ${hi}] → ${found.length} key${found.length === 1 ? "" : "s"}: ${found.join(", ") || "none"}`) +
            ` · ${frames.length} node visits for ${keys.length} keys. A full scan would read all ${countLeaves()} leaves.`;
        }, 650);
      };
      tick();
    }
    function stopAnim() { clearTimeout(anim); anim = null; }

    function countLeaves() { let n = t.root, c = 0; while (!n.leaf) n = n.children[0]; while (n) { c++; n = n.next; } return c; }
    function countNodes(n = t.root) { return n.leaf ? 1 : 1 + n.children.reduce((a, c) => a + countNodes(c), 0); }

    function draw() {
      clear(statBox).append(
        stat(height(t), "height"), stat(countNodes(), "nodes"), stat(keys.length, "keys"),
        stat(order - 1, "max keys/node"), stat(lastVisits || "–", "nodes visited (last op)"));
      // layout: levels top→bottom; leaves left→right; parents centered over children
      const SW = 28, PAD = 4, GAP = 12, LH = 74, NH = 28;
      const nodeW = (order - 1) * SW + PAD * 2;
      const pos = new Map();
      let x = 0;
      const h = height(t);
      (function place(n, d) {
        if (n.leaf) { pos.set(n.id, { x, y: d * LH, n }); x += nodeW + GAP; return; }
        n.children.forEach((c) => place(c, d + 1));
        const xs = n.children.map((c) => pos.get(c.id).x);
        pos.set(n.id, { x: (xs[0] + xs[xs.length - 1]) / 2, y: d * LH, n });
      })(t.root, 0);
      const W = Math.max(x - GAP, nodeW), H = (h - 1) * LH + NH + 18;
      const s = svg("svg", { viewBox: `-2 -2 ${W + 4} ${H + 4}`, width: W + 4, style: "display:block;margin:0 auto;max-width:none" });
      // edges
      for (const { x: px, y: py, n } of pos.values()) {
        if (n.leaf) continue;
        n.children.forEach((c, i) => {
          const cp = pos.get(c.id);
          const sx = px + PAD + i * SW;
          const on = (visitedSet.has(c.id) || activeNode === c.id) && (visitedSet.has(n.id) || activeNode === n.id);
          s.append(svg("path", { class: "edge", d: `M${sx},${py + NH} C${sx},${py + NH + 22} ${cp.x + nodeW / 2},${cp.y - 24} ${cp.x + nodeW / 2},${cp.y}`,
            style: on ? "stroke:var(--accent);stroke-width:2" : null }));
        });
      }
      // leaf links
      for (const { x: px, y: py, n } of pos.values()) {
        if (!n.leaf || !n.next) continue;
        const q = pos.get(n.next.id);
        s.append(svg("path", { d: `M${px + nodeW},${py + NH / 2} L${q.x - 3},${q.y + NH / 2}`, style: "stroke:var(--teal);stroke-width:1.4;stroke-dasharray:3 3;fill:none", "marker-end": "url(#bt-arrow)" }));
      }
      s.append(svg("defs", null, svg("marker", { id: "bt-arrow", viewBox: "0 0 6 6", refX: 5, refY: 3, markerWidth: 6, markerHeight: 6, orient: "auto" },
        svg("path", { d: "M0,0 L6,3 L0,6 z", style: "fill:var(--teal)" }))));
      // nodes
      for (const { x: px, y: py, n } of pos.values()) {
        const cls = "node" + (activeNode === n.id ? " active" : visitedSet.has(n.id) ? (n.leaf ? " done" : " teal") : "");
        const g = svg("g", { class: cls });
        g.append(svg("rect", { x: px, y: py, width: nodeW, height: NH, rx: 5 }));
        const hits = lastHits.get(n.id);
        for (let i = 0; i < order - 1; i++) {
          const k = n.keys[i];
          const cx = px + PAD + i * SW;
          if (i > 0) g.append(svg("line", { x1: cx, x2: cx, y1: py + 5, y2: py + NH - 5, style: "stroke:var(--rule)" }));
          if (k !== undefined) {
            if (hits && hits.has(k)) g.append(svg("rect", { x: cx + 2, y: py + 4, width: SW - 4, height: NH - 8, rx: 3, style: "fill:var(--accent);stroke:none" }));
            g.append(svg("text", { x: cx + SW / 2, y: py + NH / 2 + 4, "text-anchor": "middle", class: "mono", "font-size": 12,
              style: hits && hits.has(k) ? "fill:#fff;font-weight:600" : null, text: k }));
          }
        }
        s.append(g);
      }
      clear(svgBox).append(s);
    }

    keys = INITIAL.slice();
    rebuild();
  }

  function stat(value, label) { return el("span", { class: "stat" }, el("b", { text: String(value) }), el("span", { text: label })); }

  // ---------------------------------------------------------------- cost crossover
  function figCost() {
    const mount = document.getElementById("viz-crossover");
    if (!mount) return;
    const v = frame(mount, "When does the index win?", "1,000,000 rows, 100 rows per page; cost in page reads");
    const NROWS = 1e6, PER_PAGE = 100, PAGES = NROWS / PER_PAGE, LEAF_FANOUT = 200, HEIGHT = 3;
    const selIn = el("input", { type: "range", min: -6, max: 0, step: 0.01, value: -3, style: "width:14rem" });
    const rcIn = el("input", { type: "range", min: 1, max: 10, step: 0.5, value: 4 });
    const selOut = el("b", { class: "mono" }), rcOut = el("b", { class: "mono" });
    v.controls.append(el("label", null, "selectivity", selIn, selOut), el("label", null, "random page cost", rcIn, rcOut));
    const statsRow = el("div", { class: "stats-row", style: "margin-bottom:.8rem" });
    const chart = el("div", { style: "overflow-x:auto" });
    v.stage.append(statsRow, chart);
    selIn.addEventListener("input", draw);
    rcIn.addEventListener("input", draw);

    const guess = EE.predict(null, {
      id: "05-crossover",
      prompt: "A secondary index is cheaper than a full scan only while few enough rows match. Below roughly what fraction of the table?",
      choices: ["50%", "10%", "1%", "0.25%", "0.01%"],
      answer: 3,
      explain: "Each matching row costs a random page read (4× a sequential one by default), and the scan is only 10,000 sequential pages. 1,000,000 × s × 4 ≈ 10,000 gives s ≈ 0.25%. The marker below sits on the crossover.",
      onLock: () => {
        rcIn.value = 4;
        selIn.value = Math.log10(crossover((q) => idxUnclustered(q, 4)));
        draw();
        guess.reveal();
      },
    });
    v.stage.before(guess.el);

    const scanCost = () => PAGES;
    const idxUnclustered = (s, rc) => HEIGHT + (s * NROWS) / LEAF_FANOUT + s * NROWS * rc;
    const idxClustered = (s) => HEIGHT + (s * NROWS) / LEAF_FANOUT + Math.max(1, (s * NROWS) / PER_PAGE);

    function crossover(f) {   // bisection in log space for f(s) = scan
      let lo = -7, hi = 0;
      if (f(1) < PAGES) return null;
      for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(10 ** m) < PAGES) lo = m; else hi = m; }
      return 10 ** lo;
    }
    const pct = (s) => (s * 100 >= 1 ? (s * 100).toFixed(1) : s * 100 >= 0.01 ? (s * 100).toFixed(2) : (s * 100).toPrecision(2)) + "%";

    function draw() {
      const s = 10 ** +selIn.value, rc = +rcIn.value;
      selOut.textContent = `${pct(s)} (${Math.round(s * NROWS).toLocaleString()} rows)`;
      rcOut.textContent = rc.toFixed(1);
      const cu = idxUnclustered(s, rc), cc = idxClustered(s), cs = scanCost();
      const best = Math.min(cu, cc, cs);
      const xU = crossover((q) => idxUnclustered(q, rc)), xC = crossover(idxClustered);
      clear(statsRow).append(
        stat(Math.round(cs).toLocaleString(), "full scan"),
        stat(Math.round(cu).toLocaleString(), "secondary index"),
        stat(Math.round(cc).toLocaleString(), "clustered index"),
        stat(xU ? pct(xU) : "never", "secondary index wins below"));
      // chart
      const W = 760, H = 300, L = 62, R = 16, T = 14, B = 40;
      const xs = (lx) => L + ((lx + 6) / 6) * (W - L - R);
      const yMin = 0, yMax = 7.5;   // log10 cost
      const ys = (c) => T + (1 - (Math.log10(Math.max(c, 1)) - yMin) / (yMax - yMin)) * (H - T - B);
      const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", style: "display:block;height:auto;min-width:520px;max-width:none" });
      for (let e = 0; e <= 7; e++) {
        g.append(svg("line", { x1: L, x2: W - R, y1: ys(10 ** e), y2: ys(10 ** e), style: "stroke:var(--rule);stroke-width:1" }));
        g.append(svg("text", { x: L - 8, y: ys(10 ** e) + 4, "text-anchor": "end", "font-size": 11, class: "faint", text: e <= 3 ? String(10 ** e) : `1e${e}` }));
      }
      ["0.0001%", "0.001%", "0.01%", "0.1%", "1%", "10%", "100%"].forEach((t, i) =>
        g.append(svg("text", { x: xs(i - 6), y: H - B + 18, "text-anchor": i === 0 ? "start" : i === 6 ? "end" : "middle", "font-size": 11, class: "faint", text: t })));
      g.append(svg("text", { x: (L + W - R) / 2, y: H - 6, "text-anchor": "middle", "font-size": 11, class: "faint", text: "fraction of rows matching (log scale)" }));
      g.append(svg("text", { x: 14, y: T + 4, "font-size": 11, class: "faint", transform: `rotate(90 14 ${T + 4})`, text: "page reads (log)" }));
      const line = (f, color, dash) => {
        let d = "";
        for (let i = 0; i <= 240; i++) { const lx = -6 + (6 * i) / 240; d += (i ? "L" : "M") + xs(lx).toFixed(1) + "," + ys(f(10 ** lx)).toFixed(1); }
        g.append(svg("path", { d, style: `fill:none;stroke:${color};stroke-width:2.2${dash ? ";stroke-dasharray:6 4" : ""}` }));
      };
      line(() => cs, "var(--ink-soft)");
      line((q) => idxUnclustered(q, rc), "var(--accent)");
      line(idxClustered, "var(--teal)", true);
      const lab = (txt, x, y, color) => g.append(svg("text", { x, y, "font-size": 12, style: `fill:${color};font-weight:600`, text: txt }));
      lab("full scan", xs(-5.9), ys(cs) - 6, "var(--ink-soft)");
      lab("secondary index", xs(-1.6), ys(idxUnclustered(10 ** -1.6, rc)) - 8, "var(--accent)");
      lab("clustered index", xs(-2.2), ys(idxClustered(10 ** -2.2)) + 18, "var(--teal)");
      if (xU) g.append(svg("circle", { cx: xs(Math.log10(xU)), cy: ys(cs), r: 4.5, style: "fill:var(--accent)" }));
      if (xC) g.append(svg("circle", { cx: xs(Math.log10(xC)), cy: ys(cs), r: 4.5, style: "fill:var(--teal)" }));
      const cx = xs(+selIn.value);
      g.append(svg("line", { x1: cx, x2: cx, y1: T, y2: H - B, style: "stroke:var(--violet);stroke-width:1.5;stroke-dasharray:2 3" }));
      [[cs, "var(--ink-soft)"], [cu, "var(--accent)"], [cc, "var(--teal)"]].forEach(([c, col]) =>
        g.append(svg("circle", { cx, cy: ys(c), r: c === best ? 6 : 4, style: `fill:var(--bg-raised);stroke:${col};stroke-width:2.5` })));
      clear(chart).append(g);
      const winner = best === cs ? "the full scan" : best === cc ? "a clustered index" : "the secondary index";
      v.foot.textContent = `At ${pct(s)} the cheapest plan is ${winner}. ` +
        (xU ? `A secondary index stops paying off at about ${pct(xU)}: past that, one random page read per matching row costs more than reading every page in order.` : "");
    }
    draw();
  }

  document.addEventListener("DOMContentLoaded", () => { figTree(); figCost(); });
})();
