// Part 3 figures: nested loop / hash / sort-merge join over customers ⋈ orders, and how they scale.
(function () {
  "use strict";
  const { el, clear, fmt, frame, stepper, seg, TOY } = EE;

  // customers(id, name, city) and orders(id, customer_id, qty): the columns that matter here
  const L = TOY.customers.rows.map((r) => ({ id: r[0], name: r[1], city: r[2] }));
  const R = TOY.orders.rows.map((r) => ({ id: r[0], cid: r[1], qty: r[3] }));
  const OUT_COLS = ["c.id", "c.name", "o.id", "o.customer_id"];
  const outRow = (l, r) => [l.id, l.name, r ? r.id : null, r ? r.cid : null];
  const NB = 4; // buckets in the figure's hash table
  const bucketOf = (k) => k % NB;

  // Each algorithm returns frames: {li, ri, rows: right-side display order, ht?, msg, out, cmp, phase, match?}
  function nestedLoop(left) {
    const fr = [], out = []; let cmp = 0;
    const push = (o) => fr.push({ algo: "nl", out: out.slice(), cmp, ...o });
    push({ li: -1, ri: -1, msg: "Nested loop: for every customer (outer), scan every order (inner) and test the condition." });
    L.forEach((l, i) => {
      let matched = false;
      R.forEach((r, j) => {
        cmp++;
        const ok = l.id === r.cid;
        if (ok) { out.push(outRow(l, r)); matched = true; }
        push({ li: i, ri: j, match: ok, msg: `${l.name}.id = ${l.id} vs order ${r.id}.customer_id = ${r.cid}: ${ok ? "match → emit" : "no match"}` });
      });
      if (left && !matched) { out.push(outRow(l, null)); push({ li: i, ri: -1, msg: `${l.name} matched nothing. Left join: emit ${l.name} padded with NULLs.` }); }
    });
    push({ li: -1, ri: -1, done: true, msg: `Done: ${cmp} comparisons, every customer × every order. The inner side was rescanned ${L.length} times.` });
    return fr;
  }

  function hashJoin(left) {
    const fr = [], out = []; let cmp = 0, hashes = 0;
    const ht = Array.from({ length: NB }, () => []);
    const snapHT = () => ht.map((b) => b.slice());
    const push = (o) => fr.push({ algo: "hash", out: out.slice(), cmp, hashes, ht: snapHT(), ...o });
    push({ li: -1, ri: -1, phase: "build", msg: `Build phase: read every order and file it under hash(customer_id) = customer_id mod ${NB}.` });
    R.forEach((r, j) => {
      hashes++;
      ht[bucketOf(r.cid)].push(j);
      push({ li: -1, ri: j, phase: "build", bucket: bucketOf(r.cid), entry: j, msg: `order ${r.id}: customer_id ${r.cid} → bucket ${bucketOf(r.cid)}` });
    });
    push({ li: -1, ri: -1, phase: "probe", msg: "Probe phase: for each customer, hash its id and look only in that bucket." });
    L.forEach((l, i) => {
      hashes++;
      const b = bucketOf(l.id);
      let matched = false;
      push({ li: i, ri: -1, phase: "probe", bucket: b, msg: `${l.name}: hash(${l.id}) → bucket ${b}, ${ht[b].length ? ht[b].length + " entr" + (ht[b].length > 1 ? "ies" : "y") + " to check" : "empty: no possible match"}` });
      ht[b].forEach((j) => {
        cmp++;
        const r = R[j], ok = r.cid === l.id;
        if (ok) { out.push(outRow(l, r)); matched = true; }
        push({ li: i, ri: j, phase: "probe", bucket: b, entry: j, match: ok,
          msg: ok ? `order ${r.id} has customer_id ${r.cid} = ${l.id}: match → emit` : `order ${r.id} has customer_id ${r.cid} ≠ ${l.id}: same bucket, different key (a collision). Keys must still be compared.` });
      });
      if (left && !matched) { out.push(outRow(l, null)); push({ li: i, ri: -1, phase: "probe", bucket: b, msg: `${l.name} matched nothing. Left join: emit padded with NULLs.` }); }
    });
    push({ li: -1, ri: -1, phase: "probe", done: true, msg: `Done: ${hashes} hash computations, ${cmp} key comparisons. Each side was read exactly once.` });
    return fr;
  }

  function mergeJoin(left) {
    const fr = [], out = []; let cmp = 0;
    const ls = L.map((l, i) => i).sort((a, b) => L[a].id - L[b].id);
    const rs = R.map((r, j) => j).sort((a, b) => R[a].cid - R[b].cid);
    const push = (o) => fr.push({ algo: "merge", out: out.slice(), cmp, rorder: rs, lorder: ls, ...o });
    push({ li: -1, ri: -1, msg: "Sort-merge: sort both inputs by the join key (shown sorted). Then walk them together with two cursors, like merging two sorted lists." });
    let i = 0, j = 0;
    const matchedL = new Set();
    while (i < ls.length && j < rs.length) {
      const l = L[ls[i]], r = R[rs[j]];
      cmp++;
      if (l.id < r.cid) {
        push({ li: ls[i], ri: rs[j], msg: `${l.id} < ${r.cid}: no order can match ${l.name} any more (orders only get larger), so advance the customer cursor.` });
        if (left && !matchedL.has(ls[i])) { out.push(outRow(l, null)); push({ li: ls[i], ri: rs[j], msg: `Left join: ${l.name} had no match, emit padded with NULLs.` }); }
        i++;
      } else if (l.id > r.cid) {
        push({ li: ls[i], ri: rs[j], msg: `${l.id} > ${r.cid}: order ${r.id} can't match any later customer either, so advance the order cursor.` });
        j++;
      } else {
        // equal keys: emit the whole run of matching orders, then rewind to its start for the next customer (mark/restore)
        const mark = j;
        while (j < rs.length && R[rs[j]].cid === l.id) {
          if (j > mark) cmp++;
          out.push(outRow(l, R[rs[j]])); matchedL.add(ls[i]);
          push({ li: ls[i], ri: rs[j], match: true, msg: `${l.id} = ${R[rs[j]].cid}: match → emit. Keep walking the run of equal keys.` });
          j++;
        }
        i++;
        if (i < ls.length && L[ls[i]].id === l.id) { j = mark; push({ li: ls[i], ri: rs[j], msg: "Next customer has the same key: rewind the order cursor to the start of the run (mark/restore)." }); }
      }
    }
    while (left && i < ls.length) {
      const l = L[ls[i]];
      if (!matchedL.has(ls[i])) { out.push(outRow(l, null)); push({ li: ls[i], ri: -1, msg: `Orders exhausted. Left join: ${l.name} gets NULLs.` }); }
      i++;
    }
    push({ li: -1, ri: -1, done: true, msg: `Done: ${cmp} comparisons after sorting. Neither input was rescanned. Note order 14 (customer 9) was never emitted: no customer has id 9.` });
    return fr;
  }

  function figA() {
    const mount = document.querySelector("#viz-joins");
    if (!mount) return;
    const v = frame(mount, "Three ways to join", "customers c JOIN orders o ON o.customer_id = c.id");
    let algo = 1, leftJoin = false;
    const builders = [nestedLoop, hashJoin, mergeJoin];
    const rebuild = () => ctl.setFrames(builders[algo](leftJoin));
    v.root.insertBefore(el("div", { class: "viz-controls" },
      seg(["Nested loop", "Hash", "Sort-merge"], algo, (i) => { algo = i; rebuild(); }),
      seg(["Inner", "Left outer"], 0, (i) => { leftJoin = i === 1; rebuild(); })), v.controls);

    let onEnd = null;
    const play = () => [...v.controls.querySelectorAll("button")].find((b) => /Play/.test(b.textContent)).click();
    const pm = el("div"); v.root.insertBefore(pm, v.stage);
    const guess = EE.predict(pm, {
      prompt: "The nested loop makes 20 key comparisons here (4 customers × 5 orders). How many will the <em>hash</em> join make?",
      number: { min: 0, max: 20, step: 1, value: 10 }, tolerance: 0,
      explain: "Only rows in the probed bucket get compared: Ada checks bucket 1 (3 entries, one a collision with customer 9), Cy and Di one each, and Bo's bucket is empty. Hashing does the rest of the narrowing.",
      onLock() {
        const segs = v.root.querySelectorAll(".seg");
        segs[1].children[0].click();                             // inner
        segs[0].children[1].click();                             // hash (rebuilds frames)
        onEnd = (f) => guess.reveal(f.cmp);
        play();
      },
    });

    const leftBox = el("div"), rightBox = el("div"), midBox = el("div"), outBox = el("div"), stats = el("div", { class: "stats-row", style: "margin-bottom:1rem" });
    v.stage.append(stats, el("div", { class: "jn-grid" },
      el("div", null, el("div", { class: "jn-label", text: "customers (left / probe)" }), leftBox),
      el("div", null, midBox),
      el("div", null, el("div", { class: "jn-label", text: "orders (right / build)" }), rightBox)),
      el("div", { class: "jn-label", text: "output" }), outBox);

    function render(f) {
      const lorder = f.lorder || L.map((_, i) => i), rorder = f.rorder || R.map((_, j) => j);
      const lcls = (i) => (i === f.li ? (f.match === true ? "pass" : "hl") : f.algo === "merge" && f.li >= 0 && lorder.indexOf(i) < lorder.indexOf(f.li) ? "dim" : null);
      const rcls = (j) => (j === f.ri ? (f.match === true ? "pass" : f.match === false ? "fail" : "hl2") : null);
      clear(leftBox).append(tbl(["id", "name", "city"], lorder.map((i) => [L[i].id, L[i].name, L[i].city]), lorder.map(lcls), f.algo === "merge" ? "sorted by id" : null));
      clear(rightBox).append(tbl(["id", "customer_id", "qty"], rorder.map((j) => [R[j].id, R[j].cid, R[j].qty]), rorder.map(rcls), f.algo === "merge" ? "sorted by customer_id" : null));
      clear(midBox);
      if (f.algo === "hash") {
        midBox.append(el("div", { class: "jn-label", text: `hash table (key mod ${NB})` }),
          el("div", { class: "jn-ht" }, f.ht.map((b, bi) => el("div", { class: "jn-bucket" + (bi === f.bucket ? " on" : "") },
            el("span", { class: "jn-bi", text: bi }),
            b.map((j) => el("span", { class: "jn-entry" + (j === f.entry ? (f.match === false ? " miss" : " hit") : ""), text: `${R[j].cid}→o${R[j].id}` }))))),
          el("div", { class: "viz-sub", style: "margin-top:.4rem", text: f.phase === "build" ? "building…" : "probing" }));
      } else if (f.algo === "nl") {
        midBox.append(el("div", { class: "jn-arrow", text: "for each ×\nfor each" }));
      } else {
        midBox.append(el("div", { class: "jn-arrow", text: "⇉ two cursors\nadvance the\nsmaller key" }));
      }
      clear(outBox).append(f.out.length ? EE.table(OUT_COLS, f.out) : el("span", { class: "viz-sub", text: "(nothing yet)" }));
      clear(stats).append(...[
        el("span", { class: "stat" }, el("b", { text: f.cmp }), el("span", { text: "key comparisons" })),
        f.algo === "hash" ? el("span", { class: "stat" }, el("b", { text: f.hashes }), el("span", { text: "hash computations" })) : null,
        el("span", { class: "stat" }, el("b", { text: f.out.length }), el("span", { text: "rows out" }))].filter(Boolean));
      v.foot.textContent = f.msg;
      if (onEnd && f.done) { const k = onEnd; onEnd = null; k(f); }
    }
    function tbl(cols, rows, classes, note) {
      return el("div", null, note ? el("div", { class: "viz-sub", text: note }) : null,
        EE.table(cols, rows, { rowClass: (_, i) => classes[i] }));
    }
    const ctl = stepper(v.controls, builders[algo](leftJoin), render, { speed: 3 });
  }

  // ---------- figure B: how the three scale ----------
  function figB() {
    const mount = document.querySelector("#viz-scale");
    if (!mount) return;
    const v = frame(mount, "How the work grows", "rough operation counts; log scale");
    let lExp = 3, rExp = 5, sorted = false;
    const fmtN = (n) => n >= 1e12 ? (n / 1e12).toFixed(1) + "T" : n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n));
    const time = (ops) => { const s = ops / 1e8; return s < 1e-3 ? "< 1 ms" : s < 1 ? (s * 1000).toFixed(0) + " ms" : s < 120 ? s.toFixed(1) + " s" : s < 7200 ? (s / 60).toFixed(0) + " min" : s < 172800 ? (s / 3600).toFixed(1) + " h" : (s / 86400).toFixed(0) + " days"; };
    const lIn = el("input", { type: "range", min: 1, max: 8, step: 0.5, value: lExp, oninput: (e) => { lExp = +e.target.value; draw(); } });
    const rIn = el("input", { type: "range", min: 1, max: 8, step: 0.5, value: rExp, oninput: (e) => { rExp = +e.target.value; draw(); } });
    const lLab = el("b", { class: "mono" }), rLab = el("b", { class: "mono" });
    const sortedBox = el("input", { type: "checkbox", onchange: (e) => { sorted = e.target.checked; draw(); } });
    v.controls.append(el("label", null, "|left|", lIn, lLab), el("label", null, "|right|", rIn, rLab), el("label", null, sortedBox, "inputs already sorted (e.g. from an index)"));
    const chart = el("div");
    v.stage.append(chart);

    // Predict: people badly underestimate products.
    const pm = el("div"); v.root.insertBefore(pm, v.stage);
    const guess = EE.predict(pm, {
      prompt: "200 customers ⋈ 5,000 orders by nested loop: how many key comparisons?",
      number: { min: 2, max: 9, step: 0.1, value: 4, log: true }, answer: 1000000,
      explain: "Every customer meets every order: 200 × 5,000 = 1,000,000. A hash join building on the 200 customers does about 2·200 + 5,000 = 5,400 operations.",
      onLock() {
        lExp = Math.log10(200); rExp = Math.log10(5000); lIn.value = lExp; rIn.value = rExp;
        sorted = false; sortedBox.checked = false;
        draw(); guess.reveal();
      },
    });
    function draw() {
      const l = Math.round(10 ** lExp), r = Math.round(10 ** rExp);
      lLab.textContent = fmtN(l); rLab.textContent = fmtN(r);
      const lg = (n) => (n > 1 ? Math.log2(n) : 1);
      const rows = [
        ["Nested loop", l * r, "every pair: |L|·|R|", "nl"],
        ["Hash join", 2 * Math.min(l, r) + Math.max(l, r), "build the smaller side, probe with the larger: ~2·build + probe", "hash"],
        ["Sort-merge", (sorted ? 0 : l * lg(l) + r * lg(r)) + l + r, sorted ? "already sorted: one merge pass, |L| + |R|" : "sort both (n log n), then one merge pass", "merge"],
      ];
      const maxLog = Math.log10(Math.max(...rows.map((x) => x[1]), 10));
      clear(chart).append(...rows.map(([name, ops, why, cls]) => el("div", { class: "sc-row" },
        el("div", { class: "sc-name" }, el("b", { text: name }), el("span", { class: "viz-sub", text: why })),
        el("div", { class: "sc-track" }, el("span", { class: "sc-fill " + cls, style: `width:${Math.max(1, (100 * Math.log10(Math.max(ops, 1))) / maxLog)}%` })),
        el("div", { class: "sc-num mono" }, el("b", { text: fmtN(ops) }), el("span", { class: "viz-sub", text: time(ops) })))));
      v.foot.textContent = `At ~100M simple operations per second. Nested loop is ${fmtN((l * r) / rows[1][1])}× the hash join's work here, and the gap grows with the product of the sizes.`;
    }
    draw();
  }

  figA();
  figB();
})();
