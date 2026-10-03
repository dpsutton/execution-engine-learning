// Part 7 figures: a produce/consume compiler + register VM (DESIGN.md instruction set), a VM stepper
// with fuel / snapshot / restore, and a plan-tree ↔ instruction provenance view.
(function () {
  "use strict";
  const { el, svg, clear, fmt, frame, seg, TOY } = EE;

  // ---------------------------------------------------------------- plans
  // Expressions are hiccup-style arrays, as in DESIGN.md: ["col","c.id"], ["lit",1], [">", a, b].
  let nextId = 0;
  const N = (o) => Object.assign({ id: "n" + nextId++ }, o);

  const QUERIES = [
    {
      label: "Join + LIMIT",
      sql: "SELECT c.name, o.qty\nFROM customers c JOIN orders o ON o.customer_id = c.id\nWHERE o.qty > 1\nLIMIT 2",
      plan: () => N({ type: "Limit", n: 2, child:
        N({ type: "Project", exprs: [["col", "c.name"], ["col", "o.qty"]], names: ["c.name", "o.qty"], child:
          N({ type: "Filter", pred: [">", ["col", "o.qty"], ["lit", 1]], child:
            N({ type: "HashJoin", leftKey: ["col", "c.id"], rightKey: ["col", "o.customer_id"],
              left: N({ type: "Scan", table: "customers", alias: "c" }),
              right: N({ type: "Scan", table: "orders", alias: "o" }) }) }) }) }),
    },
    {
      label: "GROUP BY",
      sql: "SELECT c.city, count(*), max(c.age)\nFROM customers c\nGROUP BY c.city",
      plan: () => N({ type: "Aggregate", groupBy: [["col", "c.city"]],
        aggs: [{ fn: "count", arg: null }, { fn: "max", arg: ["col", "c.age"] }],
        names: ["c.city", "count(*)", "max(c.age)"],
        child: N({ type: "Scan", table: "customers", alias: "c" }) }),
    },
    {
      label: "Join + GROUP BY",
      sql: "SELECT c.name, sum(o.qty)\nFROM customers c JOIN orders o ON o.customer_id = c.id\nGROUP BY c.name",
      plan: () => N({ type: "Aggregate", groupBy: [["col", "c.name"]],
        aggs: [{ fn: "sum", arg: ["col", "o.qty"] }], names: ["c.name", "sum(o.qty)"],
        child: N({ type: "HashJoin", leftKey: ["col", "c.id"], rightKey: ["col", "o.customer_id"],
          left: N({ type: "Scan", table: "customers", alias: "c" }),
          right: N({ type: "Scan", table: "orders", alias: "o" }) }) }),
    },
  ];

  const SYM = { "+": "Add", "-": "Sub", "*": "Mul", "/": "Div", "=": "Eq", "!=": "Ne", "<": "Lt", "<=": "Le", ">": "Gt", ">=": "Ge", and: "And", or: "Or" };

  function exprStr(e) {
    if (e[0] === "col") return e[1];
    if (e[0] === "lit") return typeof e[1] === "string" ? `'${e[1]}'` : fmt(e[1]);
    return `${exprStr(e[1])} ${e[0]} ${exprStr(e[2])}`;
  }

  function schemaOf(node) {
    switch (node.type) {
      case "Scan": return TOY[node.table].columns.map((c) => `${node.alias}.${c}`);
      case "Filter": case "Limit": return schemaOf(node.child);
      case "Project": case "Aggregate": return node.names;
      case "HashJoin": return [...schemaOf(node.left), ...schemaOf(node.right)];
    }
  }

  function nodeLabel(node) {
    switch (node.type) {
      case "Scan": return `Scan ${node.table} ${node.alias}`;
      case "Filter": return `Filter ${exprStr(node.pred)}`;
      case "Limit": return `Limit ${node.n}`;
      case "Project": return `Project ${node.names.join(", ")}`;
      case "HashJoin": return `HashJoin ${exprStr(node.leftKey)} = ${exprStr(node.rightKey)}`;
      case "Aggregate": return `Aggregate by ${node.groupBy.map(exprStr).join(", ")}`;
      case "Output": return "Output (ResultRow)";
    }
  }

  // ---------------------------------------------------------------- compiler (produce/consume)
  // gen(node, consume): emit code that produces node's rows; for each row call consume(regs), which
  // emits the code that runs "with one row sitting in these registers".
  function compile(plan) {
    const prog = [];
    const consts = [];
    let nreg = 0, ncur = 0, nht = 0, nagg = 0;
    const OUT = { id: "out", type: "Output" };
    const reg = (n = 1) => { const r = nreg + 1; nreg += n; return r; };
    const label = () => ({ addr: null });
    const place = (l) => { l.addr = prog.length; };
    const emit = (node, op, p1 = 0, p2 = 0, p3 = 0, p4 = null, comment = "") => {
      prog.push({ op, p1, p2, p3, p4, comment, node: node ? node.id : null });
    };
    const constReg = (v) => { const r = reg(); consts.push({ r, v }); return r; };
    const envOf = (node, regs) => Object.fromEntries(schemaOf(node).map((c, i) => [c, regs[i]]));

    function expr(e, env, node) {
      if (e[0] === "col") return env[e[1]];
      if (e[0] === "lit") return constReg(e[1]);
      const a = expr(e[1], env, node), b = expr(e[2], env, node), d = reg();
      emit(node, SYM[e[0]], a, b, d, null, `r[${d}] = r[${a}] ${e[0]} r[${b}]`);
      return d;
    }
    function contiguous(regs, node) {
      if (regs.every((r, i) => r === regs[0] + i)) return regs[0];
      const base = reg(regs.length);
      regs.forEach((r, i) => emit(node, "Copy", r, base + i, 0, null, `r[${base + i}] = r[${r}]`));
      return base;
    }

    const halt = label();

    function gen(node, consume) {
      switch (node.type) {
        case "Scan": {
          const c = ncur++, cols = schemaOf(node), base = reg(cols.length), done = label();
          emit(node, "OpenScan", c, 0, 0, node.table, `cursor ${c} on ${node.table}`);
          emit(node, "Rewind", c, done, 0, null, "empty → skip loop");
          const top = prog.length;
          cols.forEach((col, i) => emit(node, "Column", c, i, base + i, null, `r[${base + i}] = ${col}`));
          consume(cols.map((_, i) => base + i));
          emit(node, "Next", c, top, 0, null, `more rows → ${top}`);
          place(done);
          return;
        }
        case "Filter":
          return gen(node.child, (regs) => {
            const r = expr(node.pred, envOf(node.child, regs), node), skip = label();
            emit(node, "IfNot", r, skip, 0, null, `skip row unless ${exprStr(node.pred)}`);
            consume(regs);
            place(skip);
          });
        case "Project":
          return gen(node.child, (regs) => {
            const env = envOf(node.child, regs);
            consume(node.exprs.map((e) => expr(e, env, node)));
          });
        case "Limit": {
          const cnt = constReg(node.n);
          return gen(node.child, (regs) => {
            consume(regs);
            emit(node, "DecrJumpZero", cnt, halt, 0, null, `limit reached → halt`);
          });
        }
        case "HashJoin": {
          const h = nht++, rs = schemaOf(node.right);
          emit(node, "HashOpen", h, 0, 0, null, `ephemeral hash table ${h}`);
          gen(node.right, (regs) => {   // build side: a whole loop of its own (pipeline breaker)
            const k = expr(node.rightKey, envOf(node.right, regs), node);
            const b = contiguous(regs, node);
            emit(node, "HashInsert", h, k, b, rs.length, `build: key r[${k}], row r[${b}..${b + rs.length - 1}]`);
          });
          gen(node.left, (regs) => {    // probe side: runs inside the left input's loop
            const k = expr(node.leftKey, envOf(node.left, regs), node), none = label();
            emit(node, "HashSeek", h, k, none, null, `probe r[${k}]; no match → skip`);
            const base = reg(rs.length), top = prog.length;
            rs.forEach((col, i) => emit(node, "HashColumn", h, i, base + i, null, `r[${base + i}] = ${col}`));
            consume([...regs, ...rs.map((_, i) => base + i)]);
            emit(node, "HashNext", h, top, 0, null, `another match → ${top}`);
            place(none);
          });
          return;
        }
        case "Aggregate": {
          const a = nagg++, nk = node.groupBy.length, outN = nk + node.aggs.length;
          emit(node, "AggOpen", a, 0, 0, { keys: nk, aggs: node.aggs.map((x) => x.fn) }, `agg table ${a}`);
          gen(node.child, (regs) => {
            const env = envOf(node.child, regs);
            const kb = contiguous(node.groupBy.map((e) => expr(e, env, node)), node);
            const vb = contiguous(node.aggs.map((x) => (x.arg ? expr(x.arg, env, node) : constReg(1))), node);
            emit(node, "AggStep", a, kb, nk, vb, `accumulate into group r[${kb}]`);
          });
          const done = label(), base = reg(outN);
          emit(node, "AggRewind", a, done, 0, null, "no groups → skip");
          const top = prog.length;
          node.names.forEach((n, i) => emit(node, "AggColumn", a, i, base + i, null, `r[${base + i}] = ${n}`));
          consume(node.names.map((_, i) => base + i));
          emit(node, "AggNext", a, top, 0, null, `more groups → ${top}`);
          place(done);
          return;
        }
      }
    }

    const constBlock = label();
    emit(null, "Init", 0, constBlock, 0, null, "jump to constants");
    const start = prog.length;
    gen(plan, (regs) => {
      const b = contiguous(regs, OUT);
      emit(OUT, "ResultRow", b, regs.length, 0, null, `yield r[${b}..${b + regs.length - 1}]`);
    });
    place(halt);
    emit(null, "Halt");
    place(constBlock);
    consts.forEach(({ r, v }) => emit(null, Number.isInteger(v) ? "Integer" : "Const", 0, r, 0, v, `r[${r}] = ${fmt(v)}`));
    emit(null, "Goto", 0, start, 0, null, `start at ${start}`);
    for (const ins of prog) for (const p of ["p1", "p2", "p3"]) if (ins[p] && typeof ins[p] === "object") ins[p] = ins[p].addr;
    return { prog, nreg };
  }

  // ---------------------------------------------------------------- VM
  // All state is plain JSON data: snapshot = JSON.stringify(state); restore = JSON.parse.
  function newState() {
    return { pc: 0, regs: {}, cursors: {}, hashTables: {}, aggTables: {}, halted: false, executed: 0 };
  }

  const isNum = (v) => typeof v === "number";
  function arith(op, a, b) {
    if (a === null || b === null || a === undefined || b === undefined) return null;
    switch (op) {
      case "Add": return a + b;
      case "Sub": return a - b;
      case "Mul": return a * b;
      case "Div": return b === 0 ? null : a / b;
    }
  }
  function cmp(op, a, b) {
    if (a === null || b === null || a === undefined || b === undefined) return null;
    const c = a < b ? -1 : a > b ? 1 : 0;
    return { Eq: c === 0, Ne: c !== 0, Lt: c < 0, Le: c <= 0, Gt: c > 0, Ge: c >= 0 }[op];
  }
  function and3(a, b) { if (a === false || b === false) return false; if (a === null || b === null) return null; return true; }
  function or3(a, b) { if (a === true || b === true) return true; if (a === null || b === null) return null; return false; }

  function aggInit(fn) { return fn === "count" ? 0 : fn === "avg" ? [0, 0] : null; }
  function aggStep(fn, acc, v) {
    if (fn === "count") return v === null ? acc : acc + 1;
    if (v === null) return acc;
    switch (fn) {
      case "sum": return acc === null ? v : acc + v;
      case "min": return acc === null || v < acc ? v : acc;
      case "max": return acc === null || v > acc ? v : acc;
      case "avg": return [acc[0] + v, acc[1] + 1];
    }
  }
  const aggFinal = (fn, acc) => (fn === "avg" ? (acc[1] ? acc[0] / acc[1] : null) : acc);

  // Run until a row is produced, the program halts, or `fuel` instructions have executed.
  // Registers live in an object keyed by number so unwritten registers stay absent through a JSON round trip.
  const slice = (R, from, n) => Array.from({ length: n }, (_, i) => (R[from + i] === undefined ? null : R[from + i]));

  function step(prog, db, s, fuel) {
    const R = s.regs;
    while (true) {
      if (s.halted) return { status: "Done" };
      if (fuel <= 0) return { status: "OutOfFuel" };
      fuel--; s.executed++;
      const { op, p1, p2, p3, p4 } = prog[s.pc];
      let next = s.pc + 1;
      switch (op) {
        case "Init": case "Goto": next = p2; break;
        case "Halt": s.halted = true; return { status: "Done" };
        case "Integer": case "Const": R[p2] = p4; break;
        case "Copy": R[p2] = R[p1]; break;
        case "OpenScan": s.cursors[p1] = { table: p4, pos: 0 }; break;
        case "Rewind": { const c = s.cursors[p1]; c.pos = 0; if (db[c.table].rows.length === 0) next = p2; break; }
        case "Next": { const c = s.cursors[p1]; c.pos++; if (c.pos < db[c.table].rows.length) next = p2; break; }
        case "Column": { const c = s.cursors[p1]; R[p3] = db[c.table].rows[c.pos][p2]; break; }
        case "Add": case "Sub": case "Mul": case "Div": R[p3] = arith(op, R[p1], R[p2]); break;
        case "Eq": case "Ne": case "Lt": case "Le": case "Gt": case "Ge": R[p3] = cmp(op, R[p1], R[p2]); break;
        case "And": R[p3] = and3(R[p1], R[p2]); break;
        case "Or": R[p3] = or3(R[p1], R[p2]); break;
        case "IfNot": if (R[p1] !== true) next = p2; break;
        case "If": if (R[p1] === true) next = p2; break;
        case "DecrJumpZero": R[p1]--; if (R[p1] === 0) next = p2; break;
        case "ResultRow": s.pc = next; return { status: "Row", row: slice(R, p1, p2) };
        case "HashOpen": s.hashTables[p1] = { buckets: {}, seek: null }; break;
        case "HashInsert": {
          if (R[p2] === null) break;                      // NULL never matches in a join
          const k = JSON.stringify(R[p2]), t = s.hashTables[p1];
          (t.buckets[k] = t.buckets[k] || []).push(slice(R, p3, p4));
          break;
        }
        case "HashSeek": {
          const t = s.hashTables[p1], k = R[p2] === null ? null : JSON.stringify(R[p2]);
          if (k === null || !t.buckets[k]) { t.seek = null; next = p3; } else t.seek = { key: k, i: 0 };
          break;
        }
        case "HashNext": { const t = s.hashTables[p1]; t.seek.i++; if (t.seek.i < t.buckets[t.seek.key].length) next = p2; break; }
        case "HashColumn": { const t = s.hashTables[p1]; R[p3] = t.buckets[t.seek.key][t.seek.i][p2]; break; }
        case "AggOpen": s.aggTables[p1] = { spec: p4, groups: [], index: {}, it: -1 }; break;
        case "AggStep": {
          const t = s.aggTables[p1], keys = slice(R, p2, p3), k = JSON.stringify(keys);
          let gi = t.index[k];
          if (gi === undefined) { gi = t.index[k] = t.groups.length; t.groups.push({ keys, accs: t.spec.aggs.map(aggInit) }); }
          const g = t.groups[gi];
          t.spec.aggs.forEach((fn, j) => { g.accs[j] = aggStep(fn, g.accs[j], R[p4 + j]); });
          break;
        }
        case "AggRewind": { const t = s.aggTables[p1]; t.it = 0; if (t.groups.length === 0) next = p2; break; }
        case "AggNext": { const t = s.aggTables[p1]; t.it++; if (t.it < t.groups.length) next = p2; break; }
        case "AggColumn": {
          const t = s.aggTables[p1], g = t.groups[t.it], nk = t.spec.keys;
          R[p3] = p2 < nk ? g.keys[p2] : aggFinal(t.spec.aggs[p2 - nk], g.accs[p2 - nk]);
          break;
        }
        default: throw new Error("unknown op " + op);
      }
      s.pc = next;
    }
  }

  const vText = (v) => (v === undefined ? "·" : fmt(v));

  function listingTable(prog, opts = {}) {
    const rows = prog.map((ins, addr) => el("tr", { "data-addr": addr, "data-node": ins.node || "" },
      el("td", { class: "cmt", text: addr }),
      el("td", { class: "op", text: ins.op }),
      el("td", { text: ins.p1 }), el("td", { text: ins.p2 }), el("td", { text: ins.p3 }),
      el("td", { text: ins.p4 === null ? "" : typeof ins.p4 === "object" ? JSON.stringify(ins.p4) : fmt(ins.p4) }),
      el("td", { class: "cmt", text: ins.comment })));
    const t = el("table", { class: "listing" },
      el("thead", null, el("tr", null, ["addr", "opcode", "p1", "p2", "p3", "p4", "comment"].map((h) => el("th", { class: "cmt", style: "text-align:left", text: h })))),
      el("tbody", null, rows));
    return { table: t, rows };
  }

  // ---------------------------------------------------------------- figure A: VM stepper
  function figStepper() {
    const mount = document.getElementById("viz-vm");
    if (!mount) return;
    const v = frame(mount, "A resumable VM", "step it, starve it of fuel, snapshot it, restore it");
    // `output` is the caller's buffer, not VM state: a snapshot remembers only how many rows had been yielded.
    let q, compiled, s, output, prevRegs, snapshot = null, snapOutLen = 0, instance = 1, playing = null, lastStatus = "";

    const sqlBox = el("pre", { class: "vm-sql" });
    const listWrap = el("div", { class: "vm-listing" });
    const regsBox = el("div", { class: "vm-regs" });
    const cursorsBox = el("div", { class: "vm-panel" });
    const ephBox = el("div", { class: "vm-panel" });
    const outBox = el("div", { class: "vm-panel" });
    const snapBox = el("pre", { class: "vm-snap", hidden: true });
    let listing;

    const fuelIn = el("input", { type: "number", min: 1, max: 999, value: 12, style: "width:4.5rem" });
    const btnStep = el("button", { text: "Step 1", onclick: () => run(1, false) });
    const btnRow = el("button", { text: "Run to next row", onclick: () => run(1e6, false) });
    const btnFuel = el("button", { text: "step(fuel)", onclick: () => run(+fuelIn.value || 1, false) });
    const btnPlay = el("button", { class: "primary", text: "▶ Play" });
    const btnReset = el("button", { text: "⟲ Reset", onclick: () => load(q) });
    const btnSnap = el("button", { text: "Snapshot", onclick: doSnapshot });
    const btnRestore = el("button", { text: "Restore into fresh VM", disabled: true, onclick: doRestore });
    btnPlay.addEventListener("click", () => (playing ? stopPlay() : startPlay()));

    v.controls.append(
      seg(QUERIES.map((x) => x.label), 0, (i) => load(i)),
      btnStep, btnRow, el("label", null, "fuel", fuelIn), btnFuel, btnPlay, btnReset, btnSnap, btnRestore);

    v.stage.append(el("div", { class: "vm-grid" },
      el("div", null, sqlBox, listWrap),
      el("div", { class: "vm-state" },
        el("h4", { text: "Registers" }), regsBox,
        el("h4", { text: "Cursors" }), cursorsBox,
        el("h4", { text: "Ephemeral tables" }), ephBox,
        el("h4", { text: "Output (rows yielded so far)" }), outBox,
        snapBox)));

    function load(i) {
      stopPlay();
      q = i;
      nextId = 0;
      compiled = compile(QUERIES[i].plan());
      s = newState();
      output = [];
      prevRegs = {};
      snapshot = null; instance = 1; btnRestore.disabled = true; snapBox.hidden = true;
      lastStatus = "fresh VM — pc 0, nothing executed";
      sqlBox.textContent = QUERIES[i].sql;
      listing = listingTable(compiled.prog);
      clear(listWrap).append(listing.table);
      render();
    }

    function run(fuel, fromPlay) {
      if (s.halted) { lastStatus = "Done — program halted"; render(); return "Done"; }
      prevRegs = { ...s.regs };
      const r = step(compiled.prog, TOY, s, fuel);
      if (r.status === "Row") { output.push(r.row); lastStatus = `step() returned Row [${r.row.map(fmt).join(", ")}] — pc parked at ${s.pc}`; }
      else if (r.status === "OutOfFuel") lastStatus = fromPlay ? "running…" : `step() returned OutOfFuel after ${fuel} instructions — pc ${s.pc}, call again to continue`;
      else lastStatus = "step() returned Done — Halt reached";
      render();
      return r.status;
    }

    function startPlay() {
      btnPlay.textContent = "❚❚ Pause";
      const tick = () => {
        const st = run(1, true);
        if (st === "Done") return stopPlay();
        playing = setTimeout(tick, st === "Row" ? 700 : 160);
      };
      playing = setTimeout(tick, 0);
    }
    function stopPlay() { clearTimeout(playing); playing = null; btnPlay.textContent = "▶ Play"; }

    function doSnapshot() {
      snapshot = JSON.stringify(s);
      snapOutLen = output.length;
      btnRestore.disabled = false;
      const pretty = "{\n" + Object.entries(s).map(([k, val]) => `  "${k}": ${JSON.stringify(val)}`).join(",\n") + "\n}";
      snapBox.hidden = false;
      snapBox.textContent = `// snapshot of VM #${instance} — ${snapshot.length} bytes of JSON\n` + pretty;
      lastStatus = `snapshot taken at pc ${s.pc} (${s.executed} instructions executed). Keep stepping, then restore to jump back.`;
      render();
    }
    function doRestore() {
      stopPlay();
      s = JSON.parse(snapshot);
      output = output.slice(0, snapOutLen);
      instance++;
      prevRegs = { ...s.regs };
      lastStatus = `VM #${instance} built from the snapshot: same pc (${s.pc}), registers, cursors, tables. It continues exactly where #1 was.`;
      render();
    }

    function render() {
      listing.rows.forEach((tr, a) => tr.classList.toggle("pc", a === s.pc && !s.halted));
      const cur = listing.rows[s.pc];
      if (cur && !s.halted) {
        const top = cur.offsetTop - listWrap.clientHeight / 2;
        listWrap.scrollTop = Math.max(0, top);
      }
      // registers
      clear(regsBox);
      for (let r = 1; r <= compiled.nreg; r++) {
        const val = s.regs[r];
        const changed = val !== prevRegs[r];
        regsBox.append(el("span", { class: "vm-reg" + (changed ? " changed" : "") + (val === undefined ? " empty" : "") },
          el("i", { text: `r${r}` }), vText(val)));
      }
      // cursors
      clear(cursorsBox);
      const curs = Object.entries(s.cursors);
      if (!curs.length) cursorsBox.append(el("span", { class: "viz-sub", text: "none open yet" }));
      for (const [id, c] of curs) {
        const t = TOY[c.table];
        cursorsBox.append(el("div", { class: "vm-cursor" },
          el("div", { class: "viz-sub", text: `cursor ${id} → ${c.table}, pos ${c.pos}` }),
          EE.table(t.columns, t.rows, { rowClass: (_, i) => (i === c.pos ? "hl" : i < c.pos ? "dim" : null) })));
      }
      // ephemeral tables
      clear(ephBox);
      const hts = Object.entries(s.hashTables), ags = Object.entries(s.aggTables);
      if (!hts.length && !ags.length) ephBox.append(el("span", { class: "viz-sub", text: "none yet" }));
      for (const [id, t] of hts) {
        const rows = [];
        for (const [k, list] of Object.entries(t.buckets)) list.forEach((row, i) => rows.push({ k: JSON.parse(k), row, cur: t.seek && t.seek.key === k && t.seek.i === i }));
        ephBox.append(el("div", { class: "viz-sub", text: `hash table ${id} (key → build row)` }),
          rows.length ? el("table", { class: "mini" }, el("tbody", null, rows.map((x) =>
            el("tr", { class: x.cur ? "hl2" : null }, el("td", { text: fmt(x.k) + " →" }), x.row.map(EE.cell)))))
            : el("div", { class: "viz-sub", text: "empty" }));
      }
      for (const [id, t] of ags) {
        ephBox.append(el("div", { class: "viz-sub", text: `agg table ${id} — groups in first-seen order; accumulators (${t.spec.aggs.join(", ")})` }),
          t.groups.length ? el("table", { class: "mini" }, el("tbody", null, t.groups.map((g, i) =>
            el("tr", { class: i === t.it ? "hl3" : null },
              g.keys.map(EE.cell), g.accs.map((a) => EE.cell(Array.isArray(a) ? `${a[0]}/${a[1]}` : a))))))
            : el("div", { class: "viz-sub", text: "empty" }));
      }
      // output
      clear(outBox);
      outBox.append(output.length ? EE.table(schemaOf(QUERIES[q].plan()), output) : el("span", { class: "viz-sub", text: "nothing yet" }));
      v.foot.textContent = `VM #${instance} · pc ${s.halted ? "—" : s.pc} · ${s.executed} instructions executed · ${lastStatus}`;
      btnStep.disabled = btnRow.disabled = btnFuel.disabled = s.halted;
    }

    const querySeg = v.controls.querySelector(".seg");
    const toFirstRow = () => { querySeg.querySelectorAll("button")[0].click(); run(1e6, false); };
    const guess = EE.predict(null, {
      id: "07-restore",
      prompt: "Run until the VM yields its first row <code>[Ada, 2]</code>, snapshot it, and restore the snapshot into a brand-new VM. What does the new VM produce when you keep stepping?",
      choices: [
        "<code>[Ada, 2]</code> again, then <code>[Cy, 5]</code>: it restarts the query",
        "Only <code>[Cy, 5]</code>, then Done",
        "Nothing: a fresh VM has an empty hash table, so every probe misses",
        "An error: the cursors still point into the old VM",
      ],
      answer: 1,
      explain: "The pc, registers, cursor positions and the built hash table are all in the snapshot, so VM #2 resumes at the instruction after <code>ResultRow</code>, emits <code>[Cy, 5]</code>, and hits the LIMIT. Nothing is recomputed and nothing is repeated.",
      onLock: () => {
        toFirstRow();
        doSnapshot();
        doRestore();
        run(1e6, false);
        run(1e6, false);
        guess.reveal();
      },
    });
    v.stage.before(guess.el);

    load(0);
    return { snapshotSizeAtFirstRow: () => { toFirstRow(); doSnapshot(); return snapshot.length; } };
  }

  // ---------------------------------------------------------------- figure B: provenance
  const NODE_COLORS = ["var(--accent)", "var(--teal)", "var(--violet)", "var(--good)", "var(--bad)", "var(--ink-soft)", "var(--null)"];

  function figProvenance() {
    const mount = document.getElementById("viz-produce");
    if (!mount) return;
    const v = frame(mount, "Which node emitted which instructions", "click a plan node, or hover an instruction");
    let selected = null;
    const treeBox = el("div", { class: "pc-tree" });
    const listBox = el("div", { class: "vm-listing tall" });
    v.controls.append(seg(QUERIES.map((x) => x.label), 0, (i) => load(i)));
    v.stage.append(el("div", { class: "pc-grid" }, treeBox, listBox));

    let listing, nodes, colorOf;

    function load(i) {
      nextId = 0;
      const plan = QUERIES[i].plan();
      const { prog } = compile(plan);
      // nodes in tree order, with Output on top
      nodes = [];
      const walk = (n, depth) => { nodes.push({ n, depth }); ["child", "left", "right"].forEach((k) => n[k] && walk(n[k], depth + 1)); };
      nodes.push({ n: { id: "out", type: "Output" }, depth: 0 });
      walk(plan, 1);
      colorOf = Object.fromEntries(nodes.map((x, j) => [x.n.id, NODE_COLORS[j % NODE_COLORS.length]]));
      selected = null;
      drawTree();
      listing = listingTable(prog);
      listing.rows.forEach((tr) => {
        const id = tr.getAttribute("data-node");
        tr.firstChild.style.boxShadow = id ? `inset 4px 0 0 ${colorOf[id]}` : "";
        tr.addEventListener("mouseenter", () => highlight(id || null, true));
        tr.addEventListener("mouseleave", () => highlight(selected, false));
      });
      clear(listBox).append(listing.table);
      highlight(null, false);
    }

    function drawTree() {
      clear(treeBox);
      const kids = (n) => ["child", "left", "right"].map((k) => n[k]).filter(Boolean);
      // simple tidy layout: leaves get consecutive x slots, parents center over children
      let slot = 0;
      const pos = {};
      const place = (n, depth) => {
        const ks = n.type === "Output" ? [nodes[1].n] : kids(n);
        if (!ks.length) pos[n.id] = { x: slot++, y: depth };
        else { ks.forEach((k) => place(k, depth + 1)); pos[n.id] = { x: ks.reduce((a, k) => a + pos[k.id].x, 0) / ks.length, y: depth }; }
      };
      place(nodes[0].n, 0);
      const W = 230, H = 62, BW = 210, BH = 40;
      const maxX = Math.max(...Object.values(pos).map((p) => p.x)), maxY = Math.max(...Object.values(pos).map((p) => p.y));
      const s = svg("svg", { viewBox: `0 0 ${(maxX + 1) * W} ${(maxY + 1) * H}`, width: (maxX + 1) * W, style: "max-width:100%;height:auto" });
      const center = (id) => ({ x: pos[id].x * W + W / 2, y: pos[id].y * H + H / 2 });
      for (const { n } of nodes) {
        const ks = n.type === "Output" ? [nodes[1].n] : kids(n);
        for (const k of ks) {
          const a = center(n.id), b = center(k.id);
          s.append(svg("path", { class: "edge", d: `M${a.x},${a.y + BH / 2} C${a.x},${a.y + H / 2} ${b.x},${b.y - H / 2} ${b.x},${b.y - BH / 2}` }));
        }
      }
      for (const { n } of nodes) {
        const c = center(n.id);
        const g = svg("g", { class: "node pc-node", "data-node": n.id, style: "cursor:pointer" },
          svg("rect", { x: c.x - BW / 2, y: c.y - BH / 2, width: BW, height: BH, rx: 7 }),
          svg("rect", { x: c.x - BW / 2, y: c.y - BH / 2, width: 6, height: BH, rx: 2, style: `fill:${colorOf[n.id]};stroke:none` }),
          svg("text", { x: c.x - BW / 2 + 14, y: c.y + 4, "font-size": 11.5, text: truncate(nodeLabel(n), 30) }));
        g.addEventListener("click", () => { selected = selected === n.id ? null : n.id; highlight(selected, false); });
        s.append(g);
      }
      treeBox.append(s, el("p", { class: "viz-sub", style: "margin:.6rem 0 0", text: "Pipeline breakers (HashJoin build, Aggregate) emit a loop of their own; everything else emits code inside its child's loop." }));
    }

    function highlight(id, transient) {
      treeBox.querySelectorAll(".pc-node").forEach((g) => g.classList.toggle("active", g.getAttribute("data-node") === id));
      let count = 0;
      listing.rows.forEach((tr) => {
        const mine = tr.getAttribute("data-node") === id;
        if (mine) count++;
        tr.classList.toggle("pc", !!id && mine);
        tr.style.opacity = id && !mine ? 0.38 : 1;
      });
      const n = nodes.find((x) => x.n.id === id);
      v.foot.textContent = id ? `${nodeLabel(n.n)} emitted ${count} instruction${count === 1 ? "" : "s"}${transient ? "" : " (click again to clear)"}` :
        "Unattributed rows (no stripe) are the program prologue/epilogue: Init, Halt, and the constant block.";
    }

    load(0);
  }

  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  document.addEventListener("DOMContentLoaded", () => {
    const vm = figStepper();
    figProvenance();
    const mount = document.getElementById("predict-snap");
    if (!mount || !vm) return;
    const guess = EE.predict(mount, {
      id: "07-snapshot-size",
      prompt: "Run the query below until it yields its first row. All 5 orders are in the hash table by then. How big is the VM's <em>entire</em> state written as JSON?",
      number: { min: 1, max: 5, step: 0.05, value: 3, log: true },
      unit: "bytes",
      tolerance: 0.5,
      explain: "About 400 bytes: 17 registers, two cursors that are each just (table, position), and a hash table holding 5 order rows. It grows with the build side and the number of registers, not with the number of rows already emitted. The VM below now shows the snapshot.",
      onLock: () => guess.reveal(vm.snapshotSizeAtFirstRow()),
    });
    // common.js shows a log slider's raw initial value; nudge it so the readout starts at 10^value.
    const r = guess.el.querySelector('input[type="range"]');
    if (r) r.dispatchEvent(new Event("input"));
  });

  // exposed for the console, if you want to poke at it
  window.EE7 = { compile, step, newState, QUERIES };
})();
