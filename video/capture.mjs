// Render anim.html frame by frame with headless Chrome.
//   node capture.mjs stills 1.5 9 14 ...      → build/stills/t-<t>.png
//   node capture.mjs video [fps] [from] [to]  → raw frames piped to ffmpeg → build/silent.mp4
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [mode = "stills", ...args] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--allow-file-access-from-files", "--force-color-profile=srgb", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
await page.evaluateOnNewDocument(() => { window.__capture = true; });
await page.goto("file://" + path.join(here, "anim.html"), { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);
const stage = await page.$("#stage");

if (mode === "stills") {
  mkdirSync(path.join(here, "build/stills"), { recursive: true });
  for (const t of args.map(Number)) {
    await page.evaluate((t) => renderAt(t, 0), t);
    await stage.screenshot({ path: path.join(here, `build/stills/t-${t.toFixed(2)}.png`) });
  }
  console.log("stills:", args.join(" "));
} else {
  const fps = Number(args[0] || 30);
  const total = await page.evaluate(() => window.TOTAL);
  const from = Number(args[1] || 0), to = Number(args[2] || total);
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(here, "build/silent.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
  const n = Math.round((to - from) * fps);
  const t0 = Date.now();
  for (let f = 0; f < n; f++) {
    const t = from + f / fps;
    await page.evaluate((t, f) => renderAt(t, f), t, f);
    const buf = await page.screenshot({ type: "jpeg", quality: 95, clip: { x: 0, y: 0, width: 1920, height: 1080 }, optimizeForSpeed: true });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (f % (fps * 5) === 0) console.log(`frame ${f}/${n}  t=${t.toFixed(1)}s  ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log("wrote build/silent.mp4");
}
await browser.close();
