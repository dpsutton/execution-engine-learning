// Part 2 figures: a pull pipeline stepped call by call, and materialize-vs-stream on generated data.
(function () {
  "use strict";
  const { el, clear, fmt, frame, stepper, seg, TOY, lcg } = EE;
  const rows = TOY.customers.rows;

  // ---------- figure A: Next() calls go down, rows come up ----------
  // Simulate Limit(n) <- Project(name) <- Filter(city = 'Austin') <- Scan(customers), recording a frame per event.
  function simulate(limitN) {
    const frames = [], stack = [], out = [], log = [];
    const st = { scan: 0, limit: 0 };
    const snap = (focus, msg, extra = {}) => {
      log.push({ depth: Math.max(0, stack.length - 1), msg });
      frames.push({ focus, stack: [...stack], st: { ...st }, out: out.map((r) => r.slice()), log: log.slice(), msg, ...extra });
    };
    const ops = {
      scan() {
        stack.push("scan");
        let r = null;
        if (st.scan < rows.length) { r = rows[st.scan]; st.scan++; snap("scan", `Scan reads row #${st.scan - 1} (${r[1]}), returns it`, { up: { at: "scan", row: r } }); }
        else snap("scan", "Scan: past the last row → returns done", { up: { at: "scan", done: true } });
        stack.pop(); return r;
      },
      filter() {
        stack.push("filter");
        for (;;) {
          snap("filter", "Filter calls Scan.Next()", { down: "scan" });
          const r = ops.scan();
          if (!r) { snap("filter", "Filter: child is done → returns done", { up: { at: "filter", done: true } }); stack.pop(); return null; }
          if (r[2] === "Austin") { snap("filter", `Filter: city = '${r[2]}' is TRUE → returns the row`, { up: { at: "filter", row: r } }); stack.pop(); return r; }
          snap("filter", `Filter: city = '${r[2]}' is FALSE → drops it, loops`, { reject: r });
        }
      },
      project() {
        stack.push("project");
        snap("project", "Project calls Filter.Next()", { down: "filter" });
        const r = ops.filter();
        if (!r) { snap("project", "Project: child is done → returns done", { up: { at: "project", done: true } }); stack.pop(); return null; }
        const p = [r[1]];
        snap("project", `Project evaluates name → returns (${p[0]})`, { up: { at: "project", row: p } });
        stack.pop(); return p;
      },
      limit() {
        stack.push("limit");
        if (st.limit >= limitN) { snap("limit", `Limit: already returned ${limitN} → returns done without calling its child`, { up: { at: "limit", done: true } }); stack.pop(); return null; }
        snap("limit", "Limit calls Project.Next()", { down: "project" });
        const r = ops.project();
        if (!r) { snap("limit", "Limit: child is done → returns done", { up: { at: "limit", done: true } }); stack.pop(); return null; }
        st.limit++;
        snap("limit", `Limit: count = ${st.limit} → returns the row`, { up: { at: "limit", row: r } });
        stack.pop(); return r;
      },
    };
    stack.push("driver");
    snap("driver", "Open(): each operator opens its child. Scan positions before row #0. Nothing has been read.");
    for (;;) {
      snap("driver", "Driver calls Limit.Next()", { down: "limit" });
      const r = ops.limit();
      if (!r) { snap("driver", `Driver sees done. Close() cascades down. Scan read ${st.scan} of ${rows.length} rows.`, { final: true }); break; }
      out.push(r);
      snap("driver", `Driver emits (${r[0]})`, { emitted: true });
    }
    return frames;
  }

  const OPS = [
    { id: "driver", name: "Driver", detail: "while row := root.Next() { emit(row) }" },
    { id: "limit", name: "Limit", detail: (n) => `n = ${n}` },
    { id: "project", name: "Project", detail: "name" },
    { id: "filter", name: "Filter", detail: "city = 'Austin'" },
    { id: "scan", name: "Scan", detail: "customers" },
  ];

  function figA() {
    const mount = document.querySelector("#viz-pull");
    if (!mount) return;
    const v = frame(mount, "Pulling rows through a pipeline", "SELECT name FROM customers WHERE city = 'Austin' LIMIT n");
    let limitN = 2;
    const row2 = el("div", { class: "viz-controls" }, el("label", null, "LIMIT", seg(["1", "2", "3"], 1, (i) => { limitN = i + 1; ctl.setFrames(simulate(limitN)); })));
    v.root.insertBefore(row2, v.controls);

    let onEnd = null;
    const play = () => [...v.controls.querySelectorAll("button")].find((b) => /Play/.test(b.textContent)).click();
    const pm = el("div"); v.root.insertBefore(pm, v.stage);
    const guess = EE.predict(pm, {
      prompt: "With <code>LIMIT 2</code>, how many of the 4 customer rows will Scan read?",
      number: { min: 0, max: 4, step: 1, value: 4 }, answer: 3, tolerance: 0,
      explain: "Ada (kept), Bo (dropped by Filter), Cy (kept). Limit now has its 2 rows and returns done without calling down again, so Di is never read.",
      onLock() {
        row2.querySelectorAll(".seg button")[1].click();         // LIMIT 2 (rebuilds frames)
        onEnd = (f) => guess.reveal(f.st.scan);
        play();
      },
    });

    const left = el("div", { class: "pl-ops" });
    const logBox = el("ol", { class: "pl-log" });
    const outBox = el("div");
    const scanBox = el("div");
    v.stage.append(el("div", { class: "pl-grid" },
      left,
      el("div", null,
        el("div", { class: "pl-label", text: "call log (indented by stack depth)" }), logBox,
        el("div", { class: "pl-label", text: "customers (Scan's input)" }), scanBox,
        el("div", { class: "pl-label", text: "output" }), outBox)));

    function render(f) {
      clear(left);
      OPS.forEach((op, i) => {
        const onStack = f.stack.includes(op.id);
        const active = f.focus === op.id;
        const state = op.id === "scan" ? `pos = ${f.st.scan}` : op.id === "limit" ? `returned = ${f.st.limit}` : op.id === "driver" ? "" : "no state";
        const box = el("div", { class: "pl-op" + (active ? " active" : onStack ? " waiting" : "") },
          el("div", { class: "pl-name" }, op.name, el("span", { class: "pl-detail", text: typeof op.detail === "function" ? op.detail(limitN) : op.detail })),
          el("div", { class: "pl-state" },
            state ? el("span", { class: "tag violet", text: state }) : null,
            onStack && !active ? el("span", { class: "tag accent", text: "on call stack" }) : null,
            active ? el("span", { class: "tag accent", text: "running" }) : null));
        left.append(box);
        if (i < OPS.length - 1) {
          const below = OPS[i + 1].id;
          let mid = null;
          if (f.down === below && f.focus === op.id) mid = el("span", { class: "pl-call", text: "↓ Next()" });
          if (f.up && f.up.at === below) mid = f.up.done ? el("span", { class: "pl-done", text: "↑ done" }) : el("span", { class: "pl-row", text: "↑ (" + f.up.row.map(fmt).join(", ") + ")" });
          left.append(el("div", { class: "pl-edge" }, mid));
        }
      });
      if (f.reject) left.append(el("div", { class: "pl-reject", text: `✕ dropped (${f.reject.map(fmt).join(", ")})` }));

      clear(logBox).append(...f.log.map((l, i) => el("li", { class: i === f.log.length - 1 ? "cur" : null, style: `padding-left:${l.depth * 0.9}rem`, text: l.msg })));
      logBox.scrollTop = logBox.scrollHeight;
      clear(scanBox).append(EE.table(TOY.customers.columns, rows, { rowClass: (_, i) => i < f.st.scan ? (i === f.st.scan - 1 && f.focus === "scan" ? "hl" : "dim") : null }));
      clear(outBox).append(f.out.length ? EE.table(["name"], f.out) : el("span", { class: "viz-sub", text: "(nothing yet)" }));
      v.foot.textContent = f.msg;
      if (onEnd && f.final) { const k = onEnd; onEnd = null; k(f); }
    }
    const ctl = stepper(v.controls, simulate(limitN), render, { speed: 4 });
  }

  // ---------- figure B: materialize vs stream ----------
  // The generated customers table (DESIGN.md PRNG), so the numbers are the same ones the engines see.
  function genCustomers() {
    const g = lcg(42n), cities = ["Austin", "Boston", "Chicago", "Denver", "Miami", "Oakland", "Portland", "Seattle"];
    const out = [];
    for (let id = 1; id <= 200; id++) {
      const r = g.intn(100);
      const city = r < 40 ? cities[0] : r < 60 ? cities[1] : r < 72 ? cities[2] : cities[3 + g.intn(5)];
      g.intn(60); // age draw (unused here, but keeps the stream aligned)
      out.push(city);
    }
    return out;
  }

  function figB() {
    const mount = document.querySelector("#viz-stream");
    if (!mount) return;
    const v = frame(mount, "Materialize every step, or stream?", "SELECT name FROM customers WHERE city = ? LIMIT k, over the 200 generated customers");
    const cities = genCustomers();
    const counts = {}; cities.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
    const choices = ["Austin", "Boston", "Chicago", "Seattle", "Miami", "Denver"];
    let city = "Austin", k = 5;
    const cityPick = el("select", { onchange: (e) => { city = e.target.value; draw(); } }, choices.map((c) => el("option", { value: c, text: `${c} (${counts[c]} rows)` })));
    const kIn = el("input", { type: "range", min: 1, max: 40, value: k, oninput: (e) => { k = +e.target.value; draw(); } });
    const kLabel = el("b", { class: "mono" });
    v.controls.append(el("label", null, "city =", cityPick), el("label", null, "LIMIT", kIn, kLabel));

    // Predict: LIMIT only saves work if enough rows match early.
    const PC = "Miami", PK = 5;
    const pm = el("div"); v.root.insertBefore(pm, v.stage);
    const guess = EE.predict(pm, {
      prompt: `<code>WHERE city = '${PC}' LIMIT ${PK}</code> over 200 customers: how many rows does the <em>streaming</em> plan scan?`,
      number: { min: 0, max: 200, step: 1, value: 20 },
      explain: counts[PC] < PK
        ? `Only ${counts[PC]} customers live in ${PC}, so the LIMIT is never satisfied and the scan runs to the end of the table. LIMIT bounds the output, not the work.`
        : `The scan stops at the ${PK}th ${PC} row. Rare values sit far apart, so a small LIMIT can still read a lot.`,
      onLock() {
        cityPick.value = PC; city = PC; k = PK; kIn.value = PK;
        guess.reveal(draw());
      },
    });

    const strip = el("div", { class: "ms-strip" });
    const bars = el("div", { class: "ms-bars" });
    v.stage.append(el("div", { class: "pl-label", text: "the customers table, in scan order (each square is a row)" }), strip,
      el("div", { class: "ms-legend" },
        el("span", null, el("i", { class: "sq match" }), " matches, read by the streaming plan"),
        el("span", null, el("i", { class: "sq read" }), " read by the streaming plan"),
        el("span", null, el("i", { class: "sq" }), " never touched by the streaming plan")),
      bars);

    function bar(label, val, max, cls) {
      return el("div", { class: "ms-bar" },
        el("span", { class: "ms-bl", text: label }),
        el("span", { class: "ms-track" }, el("span", { class: "ms-fill " + cls, style: `width:${Math.max(0.8, (100 * val) / max)}%` })),
        el("b", { class: "mono", text: String(val) }));
    }

    function draw() {
      kLabel.textContent = k;
      const m = counts[city];
      let seen = 0, stop = cities.length;
      for (let i = 0; i < cities.length; i++) { if (cities[i] === city && ++seen === k) { stop = i + 1; break; } }
      clear(strip).append(...cities.map((c, i) => el("i", { class: "sq" + (i < stop ? (c === city ? " match" : " read") : ""), title: `#${i + 1} ${c}` })));
      const matRows = cities.length, matHeld = cities.length + m + m + Math.min(k, m);
      const max = Math.max(matHeld, 1);
      clear(bars).append(
        el("div", { class: "ms-col" }, el("h4", { text: "Materialize each step" }),
          bar("rows scanned", matRows, max, "m"),
          bar("predicate evals", matRows, max, "m"),
          bar("rows held in memory", matHeld, max, "m")),
        el("div", { class: "ms-col" }, el("h4", { text: "Stream (pull iterators)" }),
          bar("rows scanned", stop, max, "s"),
          bar("predicate evals", stop, max, "s"),
          bar("rows held in memory", 1, max, "s")));
      const fewer = m < k;
      v.foot.textContent = fewer
        ? `Only ${m} customers live in ${city}, fewer than LIMIT ${k}: the streaming plan has to read the whole table to find out. Streaming never does more work than materializing, but it saves nothing when the LIMIT can't be satisfied early.`
        : `The streaming plan stops after row #${stop}: the ${k}th ${city} customer. Materializing reads all ${cities.length}, then builds a ${cities.length}-row scan result, a ${m}-row filter result, a ${m}-row projection, and finally keeps ${k}.`;
      return stop;
    }
    draw();
  }

  figA();
  figB();
})();
