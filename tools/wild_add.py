# /// script
# requires-python = ">=3.11"
# ///
"""Add (or replace) an "In the wild" excerpt, copying code verbatim from a pinned engine clone.

  uv run tools/wild_add.py --part 03 --id 03-postgres-hashjoin --engine PostgreSQL \
      --clone /tmp/ee-engines/postgres --path src/backend/executor/nodeHashjoin.c \
      --lines 220-260 --lines 300-312 --lang c \
      --title "ExecHashJoin is a state machine" \
      --prompt "Which field plays the role of our <code>cur</code>?" \
      --notes "<p>…</p>"

The clone must be a checkout of the pinned commit (its HEAD); repo and sha are read from it.
Code is never typed by hand, so tools/verify_wild.py should always pass.
"""
import argparse, json, re, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
for a in ("--part", "--id", "--engine", "--clone", "--path", "--lang", "--title"):
    ap.add_argument(a, required=True)
ap.add_argument("--lines", action="append", required=True, help="start-end, 1-based inclusive; repeatable")
ap.add_argument("--prompt", default="")
ap.add_argument("--notes", default="")
a = ap.parse_args()

git = lambda *args: subprocess.run(["git", "-C", a.clone, *args], capture_output=True, text=True, check=True).stdout
sha = git("rev-parse", "HEAD").strip()
url = git("remote", "get-url", "origin").strip()
repo = re.sub(r"^https://github.com/|\.git$", "", url)
lines = git("show", f"HEAD:{a.path}").split("\n")
segments = []
for rng in a.lines:
    s, e = map(int, rng.split("-"))
    if not (1 <= s <= e <= len(lines)):
        raise SystemExit(f"--lines {rng} out of range (file has {len(lines)} lines)")
    segments.append({"start": s, "end": e, "code": "\n".join(lines[s - 1 : e])})

entry = {"id": a.id, "engine": a.engine, "repo": repo, "sha": sha, "path": a.path, "lang": a.lang,
         "title": a.title, **({"prompt": a.prompt} if a.prompt else {}), "notes": a.notes, "segments": segments}
f = ROOT / f"docs/assets/wild/{a.part}.js"
entries = []
if f.exists():
    m = re.search(r'EE\.addWild\(\s*"\d\d"\s*,\s*(\[.*\])\s*\)\s*;?\s*$', f.read_text(), re.S)
    entries = json.loads(m.group(1))
entries = [x for x in entries if x["id"] != a.id] + [entry]
f.write_text(f'EE.addWild("{a.part}", ' + json.dumps(entries, indent=1, ensure_ascii=False) + ");\n")
print(f"{a.id}: {repo}@{sha[:7]} {a.path} " + ", ".join(f"L{s['start']}-{s['end']}" for s in segments)
      + f"  ({sum(s['end'] - s['start'] + 1 for s in segments)} lines) → {f.relative_to(ROOT)}")
