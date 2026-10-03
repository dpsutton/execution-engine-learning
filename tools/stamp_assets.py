# /// script
# requires-python = ">=3.11"
# ///
"""Deploy-time cache busting: append ?v=<stamp> to every local .js/.css reference in docs/*.html.

GitHub Pages serves with max-age=600, so after a deploy a browser can combine new HTML with a
stale cached common.js. Stamping makes each deploy's references unique. Runs in the Pages
workflow only (the repo itself stays build-free).  uv run tools/stamp_assets.py <stamp>
"""
import re, sys
from pathlib import Path

stamp = sys.argv[1]
docs = Path(__file__).resolve().parent.parent / "docs"
pat = re.compile(r'''((?:src|href)=")((?!https?:|//|data:)[^"?#]+\.(?:js|css))(")''')
for f in docs.rglob("*.html"):
    s = f.read_text()
    new, n = pat.subn(lambda m: f"{m.group(1)}{m.group(2)}?v={stamp}{m.group(3)}", s)
    if n:
        f.write_text(new)
        print(f"{f.relative_to(docs)}: {n}")
