// Site checks for docs/: every relative link/src resolves, every cards file is strict JSON, every
// page loads in headless Chrome with no JS errors (figures included: they render on load), and the
// terminal runs the WebAssembly builds end to end (needs tools/build_wasm.sh first; REQUIRE_WASM=1
// makes their absence an error, as in CI).
//   cd tools/check-site && npm ci && node check.mjs        (CHROME_PATH overrides the browser)
import puppeteer from "puppeteer-core";
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs");
const errors = [];
const walk = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(docs);
const pages = files.filter((f) => f.endsWith(".html") && !path.basename(f).startsWith("_"));

// 1. relative references
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  for (const [, ref] of html.matchAll(/(?:href|src)="([^"#?]+)[^"]*"/g)) {
    if (/^(https?:|mailto:|data:|\/\/)/.test(ref)) continue;
    const target = path.resolve(path.dirname(page), ref);
    if (!existsSync(target)) errors.push(`${path.relative(docs, page)}: broken reference ${ref}`);
  }
}

// 2. cards: EE.addCards("NN", [ strict JSON ])
for (const f of files.filter((f) => /cards\/\d\d\.js$/.test(f))) {
  const m = readFileSync(f, "utf8").match(/EE\.addCards\(\s*"(\d\d)"\s*,\s*(\[[\s\S]*\])\s*\)\s*;?\s*$/);
  if (!m) { errors.push(`${path.relative(docs, f)}: not EE.addCards("NN", [...])`); continue; }
  try {
    const cards = JSON.parse(m[2]);
    for (const c of cards) if (!c.id || !c.q || !c.a) errors.push(`${path.relative(docs, f)}: card missing id/q/a`);
    if (new Set(cards.map((c) => c.id)).size !== cards.length) errors.push(`${path.relative(docs, f)}: duplicate card ids`);
  } catch (e) { errors.push(`${path.relative(docs, f)}: ${e.message}`); }
}

// 3. load every page, served over HTTP the way Pages serves it
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm",
  ".json": "application/json", ".sql": "text/plain", ".md": "text/markdown", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const p = path.join(docs, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(docs) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" }).end(readFileSync(p));
}).listen(0);
const base = `http://localhost:${server.address().port}/`;
const chrome = process.env.CHROME_PATH || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const browser = await puppeteer.launch({ executablePath: chrome, headless: "new", args: ["--no-sandbox", "--allow-file-access-from-files"] });
for (const page of pages) {
  const tab = await browser.newPage();
  const rel = path.relative(docs, page);
  tab.on("pageerror", (e) => errors.push(`${rel}: ${e.message}`));
  tab.on("console", (m) => { if (m.type() === "error" && !/fonts\.(googleapis|gstatic)|Failed to load resource/.test(m.text())) errors.push(`${rel}: console: ${m.text()}`); });
  tab.on("requestfailed", (r) => { if (r.url().startsWith(base)) errors.push(`${rel}: failed to load ${r.url()}`); });
  tab.on("response", (r) => { if (r.url().startsWith(base) && r.status() >= 400 && !r.url().endsWith("favicon.ico")) errors.push(`${rel}: HTTP ${r.status()} ${r.url()}`); });
  await tab.setViewport({ width: 1200, height: 900 });
  if (rel === "terminal.html" && !existsSync(path.join(docs, "wasm/engine.wasm"))) {
    if (process.env.REQUIRE_WASM) errors.push("docs/wasm missing: run tools/build_wasm.sh");
    else console.log("skipping terminal.html (no docs/wasm; run tools/build_wasm.sh)");
    await tab.close(); continue;
  }
  await tab.goto(base + rel, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 400));
  // pages with figures must have rendered them
  const unmounted = await tab.evaluate(() => [...document.querySelectorAll('article div[id^="viz"]')].filter((d) => !d.children.length).map((d) => d.id));
  for (const id of unmounted) errors.push(`${rel}: figure mount #${id} never rendered`);
  await tab.close();
  console.log(`checked ${rel}`);
}
// 4. the terminal, end to end: a lesson demo, an interactive SQL session on the VM, a file read
if (existsSync(path.join(docs, "wasm/engine.wasm"))) {
  const tab = await browser.newPage();
  tab.on("pageerror", (e) => errors.push(`terminal: ${e.message}`));
  await tab.setViewport({ width: 1200, height: 900 });
  await tab.goto(base + "terminal.html", { waitUntil: "load" });
  const log = async () => (await tab.evaluate(() => window.__termLog || "")).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const waitFor = async (re, what, ms = 60000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 200))) if (re.test(await log())) return true;
    errors.push(`terminal: timed out waiting for ${what}\n${(await log()).slice(-800)}`); return false;
  };
  const type = async (s) => { await tab.keyboard.type(s); await tab.keyboard.press("Enter"); };
  const steps = [
    [null, /ee \$ $/, "the shell prompt"],
    ["lesson02", /scan read 3 of 4[\s\S]*ee \$ $/, "lesson02 to finish"],
    ["engine -vm", /sql> $/, "the engine prompt"],
    ["SELECT city, count(*) AS n FROM customers GROUP BY city ORDER BY n DESC LIMIT 3;", /\(3 rows\)[\s\S]*sql> $/, "a query result"],
    ["\\q", /ee \$ $/, "the engine to exit"],
    ["engine -golden queries/golden.sql", /\(2 rows\)\s*ee \$ $/, "the golden file to run"],
  ];
  await tab.click("#terminal");
  for (const [input, re, what] of steps) {
    if (input) await type(input);
    if (!(await waitFor(re, what))) break;
  }
  console.log("checked terminal (lesson02, engine -vm, -golden)");
  await tab.close();
}
await browser.close();
server.close();

if (errors.length) { console.error("\n" + errors.join("\n")); process.exit(1); }
console.log(`\nOK: ${pages.length} pages, no errors`);
