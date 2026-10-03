# /// script
# dependencies = ["genanki"]
# ///
"""Export docs/assets/cards/*.js to an Anki deck: execution-engine.apkg (one subdeck per part)."""
import json, re, hashlib
from pathlib import Path
import genanki

ROOT = Path(__file__).resolve().parent.parent
TITLES = ["Expressions", "Iterators", "Joins", "Aggregation & sorting", "Indexes", "Statistics & planning", "Bytecode"]
model = genanki.Model(1607392319, "Execution Engine card",
    fields=[{"name": "Q"}, {"name": "A"}, {"name": "Part"}],
    templates=[{"name": "Card", "qfmt": "<div class=part>{{Part}}</div>{{Q}}", "afmt": "{{FrontSide}}<hr id=answer>{{A}}"}],
    css=".card{font-family:-apple-system,sans-serif;font-size:18px;text-align:left;max-width:40em;margin:auto}"
        ".part{font-size:12px;color:#999;text-transform:uppercase;letter-spacing:.1em}code{font-family:Menlo,monospace}")
decks = []
for f in sorted((ROOT / "docs/assets/cards").glob("[0-9][0-9].js")):
    part = f.stem
    m = re.search(r"EE\.addCards\(\s*\"\d\d\"\s*,\s*(\[.*\])\s*\)\s*;?\s*$", f.read_text(), re.S)
    cards = json.loads(m.group(1))
    name = f"Execution Engine::{int(part):02d} {TITLES[int(part) - 1]}"
    deck = genanki.Deck(int(hashlib.md5(name.encode()).hexdigest()[:8], 16), name)
    for c in cards:
        guid = genanki.guid_for(c["id"])
        deck.add_note(genanki.Note(model=model, fields=[c["q"], c["a"], f"Part {int(part)} · {TITLES[int(part) - 1]}"], guid=guid))
    decks.append(deck)
    print(f"{name}: {len(cards)} cards")
genanki.Package(decks).write_to_file(ROOT / "execution-engine.apkg")
print("wrote execution-engine.apkg")
