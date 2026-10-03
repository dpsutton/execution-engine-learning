# /// script
# requires-python = ">=3.11"
# ///
"""Verify docs/assets/wild/*.js: every excerpt must be verbatim at its pinned permalink.

For each entry, fetch https://raw.githubusercontent.com/<repo>/<sha>/<path> and compare each
segment's `code` to lines start..end exactly (tabs, spacing, everything). Also checks structure:
required fields, unique ids, 40-hex sha, ≥3 engines per part, no engine more than twice per part.
Fetched files are cached in ~/.cache/ee-wild. Run: uv run tools/verify_wild.py
"""
import json, re, sys, hashlib, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path.home() / ".cache" / "ee-wild"
CACHE.mkdir(parents=True, exist_ok=True)
REQUIRED = {"id", "engine", "repo", "sha", "path", "lang", "title", "notes", "segments"}


def fetch(repo, sha, path):
    key = CACHE / hashlib.sha1(f"{repo}/{sha}/{path}".encode()).hexdigest()
    if key.exists():
        return key.read_text()
    url = f"https://raw.githubusercontent.com/{repo}/{sha}/{path}"
    with urllib.request.urlopen(url, timeout=60) as r:
        text = r.read().decode("utf-8")
    key.write_text(text)
    return text


errors, ids, total = [], set(), 0
files = sorted((ROOT / "docs/assets/wild").glob("[0-9][0-9].js"))
for f in files:
    part = f.stem
    m = re.search(r'EE\.addWild\(\s*"(\d\d)"\s*,\s*(\[.*\])\s*\)\s*;?\s*$', f.read_text(), re.S)
    if not m:
        errors.append(f"{f.name}: not EE.addWild(\"NN\", [...])"); continue
    try:
        entries = json.loads(m.group(2))
    except json.JSONDecodeError as e:
        errors.append(f"{f.name}: invalid JSON: {e}"); continue
    engines = {}
    for e in entries:
        total += 1
        where = f"{f.name}:{e.get('id', '?')}"
        if missing := REQUIRED - e.keys():
            errors.append(f"{where}: missing {sorted(missing)}"); continue
        if e["id"] in ids: errors.append(f"{where}: duplicate id")
        ids.add(e["id"])
        if not re.fullmatch(r"[0-9a-f]{40}", e["sha"]): errors.append(f"{where}: sha must be a full commit hash")
        engines[e["engine"]] = engines.get(e["engine"], 0) + 1
        try:
            lines = fetch(e["repo"], e["sha"], e["path"]).split("\n")
        except Exception as ex:
            errors.append(f"{where}: cannot fetch {e['repo']}@{e['sha'][:7]}:{e['path']}: {ex}"); continue
        for s in e["segments"]:
            want = "\n".join(lines[s["start"] - 1 : s["end"]])
            if s["code"] != want:
                got, exp = s["code"].split("\n"), want.split("\n")
                first = next((i for i, (a, b) in enumerate(zip(got, exp)) if a != b), min(len(got), len(exp)))
                errors.append(f"{where}: L{s['start']}-{s['end']} differs from source at line {s['start'] + first}:\n"
                              f"    snippet: {got[first] if first < len(got) else '<end>'!r}\n"
                              f"    source:  {exp[first] if first < len(exp) else '<end>'!r}")
    if len(engines) < 3: errors.append(f"{f.name}: only {len(engines)} engines (want ≥3)")
    for eng, n in engines.items():
        if n > 2: errors.append(f"{f.name}: {eng} appears {n} times (max 2 per part)")

if errors:
    print("\n".join(errors)); sys.exit(1)
print(f"OK: {total} excerpts in {len(files)} parts, all verbatim at their permalinks")
