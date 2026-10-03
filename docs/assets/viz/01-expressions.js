// Part 1 figures: expression-tree evaluator and three-valued logic explorer.
(function () {
  "use strict";
  const { el, svg, clear, fmt, frame, stepper, seg, TOY } = EE;
  const cust = TOY.customers;

  // ---------- a tiny evaluator over AST arrays, with SQL three-valued logic ----------
  // AST: ["col", name] ["lit", v] [op, a, b] ["not", e] ["is-null", e] ["fn", name, ...args]
  const ARITH = { "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b };
  const CMP = { "=": (c) => c === 0, "!=": (c) => c !== 0, "<": (c) => c < 0, "<=": (c) => c <= 0, ">": (c) => c > 0, ">=": (c) => c >= 0 };
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const and3 = (a, b) => (a === false || b === false ? false : a === null || b === null ? null : true);
  const or3 = (a, b) => (a === true || b === true ? true : a === null || b === null ? null : false);

  // Evaluate, recording each node's value in post-order. `trace` gets {node, v, note}.
  // AND/OR short-circuit exactly when 3VL allows it (left FALSE for AND, left TRUE for OR).
  function evaluate(node, row, trace, skipped) {
    const [op] = node;
    const rec = (v, note) => { trace.push({ node, v, note }); return v; };
    if (op === "col") return rec(row[cust.columns.indexOf(node[1])], `read column ${node[1]}`);
    if (op === "lit") return rec(node[1], "literal");
    if (op === "and" || op === "or") {
      const l = evaluate(node[1], row, trace, skipped);
      const decisive = op === "and" ? false : true;
      if (l === decisive) {
        markSkipped(node[2], skipped, trace.length);
        return rec(l, `left is ${show(l)}, so ${op.toUpperCase()} is ${show(l)} no matter what: right side skipped`);
      }
      const r = evaluate(node[2], row, trace, skipped);
      const v = op === "and" ? and3(l, r) : or3(l, r);
      return rec(v, `${show(l)} ${op.toUpperCase()} ${show(r)} = ${show(v)}`);
    }
    if (op === "not") {
      const x = evaluate(node[1], row, trace, skipped);
      const v = x === null ? null : !x;
      return rec(v, `NOT ${show(x)} = ${show(v)}${x === null ? " (unknown stays unknown)" : ""}`);
    }
    if (op === "is-null") {
      const x = evaluate(node[1], row, trace, skipped);
      return rec(x === null, `IS NULL never returns NULL: ${show(x === null)}`);
    }
    if (op === "fn") { // coalesce only
      const args = node.slice(2).map((a) => evaluate(a, row, trace, skipped));
      const v = args.find((a) => a !== null);
      return rec(v === undefined ? null : v, "coalesce: first non-NULL argument");
    }
    const a = evaluate(node[1], row, trace, skipped);
    const b = evaluate(node[2], row, trace, skipped);
    if (a === null || b === null) return rec(null, `${show(a)} ${op} ${show(b)}: a NULL input makes the result NULL`);
    if (ARITH[op]) { const v = ARITH[op](a, b); return rec(v, `${show(a)} ${op} ${show(b)} = ${show(v)}`); }
    const v = CMP[op](cmp(a, b));
    return rec(v, `${show(a)} ${op} ${show(b)} is ${show(v)}`);
  }
  // skipped: Map node -> trace index at which its short-circuiting parent was decided
  function markSkipped(node, map, at) { map.set(node, at); children(node).forEach((c) => markSkipped(c, map, at)); }
  function show(v) { return v === true ? "TRUE" : v === false ? "FALSE" : v === null ? "NULL" : typeof v === "string" ? `'${v}'` : fmt(v); }
  function label(node) {
    const [op, x] = node;
    if (op === "col") return x;
    if (op === "lit") return typeof x === "string" ? `'${x}'` : x === null ? "NULL" : String(x);
    if (op === "fn") return x + "()";
    if (op === "is-null") return "IS NULL";
    return op.toUpperCase();
  }
  const children = (n) => (n[0] === "col" || n[0] === "lit" ? [] : n[0] === "fn" ? n.slice(2) : n.slice(1));
  const valClass = (v) => (v === true ? "v-true" : v === false ? "v-false" : v === null ? "v-null" : "v-val");

  // ---------- figure A: step through post-order evaluation ----------
  const EXPRS = [
    { sql: "age + 10 > 40 AND city = 'Austin'",
      ast: ["and", [">", ["+", ["col", "age"], ["lit", 10]], ["lit", 40]], ["=", ["col", "city"], ["lit", "Austin"]]] },
    { sql: "age > 40 OR city = 'Austin'",
      ast: ["or", [">", ["col", "age"], ["lit", 40]], ["=", ["col", "city"], ["lit", "Austin"]]] },
    { sql: "NOT (age < 30)", ast: ["not", ["<", ["col", "age"], ["lit", 30]]] },
  ];

  function layout(root) {
    // Leaves get consecutive x slots; parents sit over the middle of their children.
    const pos = new Map(); let leaf = 0, maxDepth = 0;
    (function walk(n, d) {
      maxDepth = Math.max(maxDepth, d);
      const kids = children(n);
      if (!kids.length) { pos.set(n, { x: leaf++, d }); return; }
      kids.forEach((k) => walk(k, d + 1));
      const xs = kids.map((k) => pos.get(k).x);
      pos.set(n, { x: (Math.min(...xs) + Math.max(...xs)) / 2, d });
    })(root, 0);
    return { pos, leaves: leaf, depth: maxDepth };
  }

  function figA() {
    const mount = document.querySelector("#viz-eval");
    if (!mount) return;
    const v = frame(mount, "Evaluating an expression tree", "post-order: children first, then the parent");
    let exprIdx = 0, rowIdx = 0;
    const pick = el("select", { onchange: (e) => { exprIdx = +e.target.value; rebuild(); } },
      EXPRS.map((e, i) => el("option", { value: i, text: e.sql })));
    const row2 = el("div", { class: "viz-controls" },
      el("label", null, "expression", pick),
      el("label", null, "row", seg(cust.rows.map((r) => r[1]), 0, (i) => { rowIdx = i; rebuild(); })));
    v.root.insertBefore(row2, v.controls);

    // Predict: Bo's age is NULL; most people expect the whole AND to be NULL.
    let onEnd = null;
    const play = () => [...v.controls.querySelectorAll("button")].find((b) => /Play/.test(b.textContent)).click();
    const pm = el("div"); v.root.insertBefore(pm, v.stage);
    const guess = EE.predict(pm, {
      prompt: "For Bo (age NULL, city Boston), what does <code>age + 10 &gt; 40 AND city = 'Austin'</code> evaluate to?",
      choices: ["TRUE", "FALSE", "NULL"], answer: 1,
      explain: "The left side is NULL, but <code>city = 'Austin'</code> is FALSE for Bo, and FALSE AND anything is FALSE: the unknown can't change the answer.",
      onLock() {
        pick.value = 0; exprIdx = 0;
        row2.querySelectorAll(".seg button")[1].click();        // select Bo (rebuilds frames)
        onEnd = () => guess.reveal();
        play();
      },
    });

    const rowView = el("div", { style: "margin-bottom:.8rem" });
    const drawing = el("div");
    v.stage.append(rowView, drawing);

    function framesFor() {
      const row = cust.rows[rowIdx], trace = [], skipped = new Map();
      const result = evaluate(EXPRS[exprIdx].ast, row, trace, skipped);
      const frames = [{ upto: -1, note: "Nothing evaluated yet. The walk starts at the root and recurses into children before computing anything." }];
      trace.forEach((t, i) => frames.push({ upto: i, note: t.note }));
      frames.push({ upto: trace.length - 1, final: true,
        note: result === true ? `Result TRUE: ${row[1]} passes the WHERE clause.`
          : `Result ${show(result)}: ${row[1]} is filtered out${result === null ? ". A WHERE clause keeps a row only on TRUE, and NULL is not TRUE." : "."}` });
      return { frames, trace, skipped, row };
    }

    let state;
    function render(f) {
      const { trace, skipped, row } = state;
      const root = EXPRS[exprIdx].ast;
      const { pos, leaves, depth } = layout(root);
      const W = 118, H = 90, pad = 20;
      const width = Math.max(leaves * W, 300) + pad * 2, height = (depth + 1) * H + 30;
      const X = (n) => pad + pos.get(n).x * W + W / 2, Y = (n) => 24 + pos.get(n).d * H;
      const valueOf = new Map(); trace.slice(0, f.upto + 1).forEach((t) => valueOf.set(t.node, t.v));
      const current = f.upto >= 0 ? trace[f.upto].node : null;
      const s = svg("svg", { viewBox: `0 0 ${width} ${height}`, width, height, style: "display:block;margin:0 auto;max-width:100%;height:auto" });
      (function edges(n) { children(n).forEach((k) => { s.append(svg("line", { class: "edge", x1: X(n), y1: Y(n) + 42, x2: X(k), y2: Y(k) - 15 })); edges(k); }); })(root);
      (function nodes(n) {
        const done = valueOf.has(n);
        const skip = skipped.has(n) && f.upto >= skipped.get(n);
        const cls = "node" + (n === current && !f.final ? " active" : done ? " done" : "") + (skip ? " skipped" : "");
        const g = svg("g", { class: cls });
        const w = Math.max(54, label(n).length * 8 + 20);
        g.append(svg("rect", { x: X(n) - w / 2, y: Y(n) - 15, width: w, height: 30, rx: 7 }),
          svg("text", { x: X(n), y: Y(n) + 5, "text-anchor": "middle", class: "mono", "font-size": 13, text: label(n) }));
        if (done) g.append(svg("text", { x: X(n), y: Y(n) + 33, "text-anchor": "middle", class: "mono val " + valClass(valueOf.get(n)), "font-size": 12, "font-weight": 600, text: show(valueOf.get(n)) }));
        s.append(g);
        children(n).forEach(nodes);
      })(root);
      clear(drawing).append(s);
      clear(rowView).append(EE.table(cust.columns, [row]));
      v.foot.textContent = f.note;
      if (onEnd && f.final) { const k = onEnd; onEnd = null; k(); }
    }

    let ctl = null;
    function rebuild() {
      state = framesFor();
      if (!ctl) ctl = stepper(v.controls, state.frames, render, { speed: 2 });
      else ctl.setFrames(state.frames);
    }
    rebuild();
  }

  // ---------- figure B: truth tables + which rows survive a WHERE ----------
  const PREDS = [
    { sql: "age > 30", ast: [">", ["col", "age"], ["lit", 30]],
      why: "Bo's age is NULL, so age > 30 is NULL: unknown, not false. WHERE keeps only TRUE." },
    { sql: "NOT (age > 30)", ast: ["not", [">", ["col", "age"], ["lit", 30]]],
      why: "Negating doesn't rescue Bo: NOT NULL is still NULL. Bo is in neither the result nor its complement." },
    { sql: "age > 30 OR age <= 30", ast: ["or", [">", ["col", "age"], ["lit", 30]], ["<=", ["col", "age"], ["lit", 30]]],
      why: "A tautology in two-valued logic. In SQL it's NULL OR NULL = NULL for Bo, so this misses a row." },
    { sql: "age = NULL", ast: ["=", ["col", "age"], ["lit", null]],
      why: "Comparing anything to NULL gives NULL, even for Bo, so this returns zero rows. Use IS NULL." },
    { sql: "age IS NULL", ast: ["is-null", ["col", "age"]],
      why: "IS NULL is the one predicate that looks at NULL directly. It only ever returns TRUE or FALSE." },
    { sql: "coalesce(age, 0) > 30", ast: [">", ["fn", "coalesce", ["col", "age"], ["lit", 0]], ["lit", 30]],
      why: "coalesce decides what an unknown age means (0 here), turning the NULL into a value before comparing." },
  ];

  function figB() {
    const mount = document.querySelector("#viz-3vl");
    if (!mount) return;
    const v = frame(mount, "Three-valued logic", "click a cell; pick a predicate");
    const vals = [true, null, false];
    const explain = {
      "and": (a, b, r) => r === false ? "One FALSE is enough: whatever the unknown is, the AND is FALSE." : r === null ? "Could go either way depending on what the unknown is, so the answer is unknown." : "Both TRUE.",
      "or": (a, b, r) => r === true ? "One TRUE is enough: whatever the unknown is, the OR is TRUE." : r === null ? "Could go either way depending on what the unknown is, so the answer is unknown." : "Both FALSE.",
    };
    const tables = el("div", { style: "display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:1.2rem" });
    function grid(op) {
      const fn = op === "and" ? and3 : or3;
      return el("table", { class: "mini tvl" },
        el("thead", null, el("tr", null, el("th", { text: op.toUpperCase() }), vals.map((b) => el("th", { text: show(b) })))),
        el("tbody", null, vals.map((a) => el("tr", null, el("th", { text: show(a) }), vals.map((b) => {
          const r = fn(a, b);
          return el("td", { class: "tvl-cell " + valClass(r), text: show(r), tabindex: 0,
            onclick: (e) => { tables.querySelectorAll(".tvl-cell").forEach((c) => c.classList.remove("sel")); e.target.classList.add("sel");
              v.foot.textContent = `${show(a)} ${op.toUpperCase()} ${show(b)} = ${show(r)}. ${explain[op](a, b, r)}`; } });
        })))));
    }
    const notT = el("table", { class: "mini tvl" },
      el("thead", null, el("tr", null, el("th", { text: "x" }), el("th", { text: "NOT x" }))),
      el("tbody", null, vals.map((a) => el("tr", null, el("th", { text: show(a) }), el("td", { class: "tvl-cell " + valClass(a === null ? null : !a), text: show(a === null ? null : !a) })))));
    tables.append(grid("and"), grid("or"), notT);

    const pick = el("select", { onchange: (e) => draw(+e.target.value) }, PREDS.map((p, i) => el("option", { value: i, text: "WHERE " + p.sql })));
    v.controls.append(el("label", null, "predicate", pick));
    const out = el("div");
    v.stage.append(tables, out);

    // Predict: the "tautology" that isn't one.
    const pm = el("div"); v.root.insertBefore(pm, v.stage);
    const guess = EE.predict(pm, {
      prompt: "Which customers does <code>WHERE age &gt; 30 OR age &lt;= 30</code> keep?",
      choices: ["All four", "Ada, Cy, Di (everyone but Bo)", "Only Bo", "None"], answer: 1,
      explain: "For Bo both sides are NULL, and NULL OR NULL is NULL. WHERE keeps only TRUE, so the \"always true\" predicate drops him.",
      onLock() { pick.value = 2; draw(2); guess.reveal(); },
    });

    function draw(i) {
      const p = PREDS[i];
      const rows = cust.rows.map((r) => { const val = evaluate(p.ast, r, [], new Map()); return { r, val }; });
      const t = el("table", { class: "mini" },
        el("thead", null, el("tr", null, cust.columns.map((c) => el("th", { text: c })), el("th", { text: p.sql }), el("th", { text: "kept?" }))),
        el("tbody", null, rows.map(({ r, val }) => el("tr", { class: val === true ? "pass" : "fail" },
          r.map(EE.cell), el("td", { class: "mono " + valClass(val), text: show(val) }), el("td", { text: val === true ? "yes" : "no" })))));
      clear(out).append(t);
      v.foot.textContent = `${rows.filter((x) => x.val === true).length} of 4 rows kept. ${p.why}`;
    }
    draw(0);
  }

  figA();
  figB();
})();
