// Site checks for docs/: every relative link/src resolves, every cards file is strict JSON, and every
// page loads in headless Chrome with no JS errors (figures included: they render on load).
//   cd tools/check-site && npm ci && node check.mjs        (CHROME_PATH overrides the browser)
import puppeteer from "puppeteer-core";
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

// 3. load every page
const chrome = process.env.CHROME_PATH || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
const browser = await puppeteer.launch({ executablePath: chrome, headless: "new", args: ["--no-sandbox", "--allow-file-access-from-files"] });
for (const page of pages) {
  const tab = await browser.newPage();
  const rel = path.relative(docs, page);
  tab.on("pageerror", (e) => errors.push(`${rel}: ${e.message}`));
  tab.on("console", (m) => { if (m.type() === "error" && !/fonts\.(googleapis|gstatic)/.test(m.text())) errors.push(`${rel}: console: ${m.text()}`); });
  tab.on("requestfailed", (r) => { if (r.url().startsWith("file:")) errors.push(`${rel}: failed to load ${r.url()}`); });
  await tab.setViewport({ width: 1200, height: 900 });
  await tab.goto("file://" + page, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 400));
  // pages with figures must have rendered them
  const unmounted = await tab.evaluate(() => [...document.querySelectorAll('article div[id^="viz"]')].filter((d) => !d.children.length).map((d) => d.id));
  for (const id of unmounted) errors.push(`${rel}: figure mount #${id} never rendered`);
  await tab.close();
  console.log(`checked ${rel}`);
}
await browser.close();

if (errors.length) { console.error("\n" + errors.join("\n")); process.exit(1); }
console.log(`\nOK: ${pages.length} pages, no errors`);
