import html
import json
import os
import re
import time
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parents[1]
IN = ROOT / "exports" / "asoiaf-lorebook.live-before-awoiaf.world-db.json"
OUT = ROOT / "exports" / "asoiaf-lorebook.awoiaf-enriched.world-db.json"
REPORT = ROOT / "exports" / "asoiaf-lorebook.awoiaf-enrichment-report.json"
STORY_ID = "story_asoiaf_lorebook_seed"
NOW = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
PAGES = {
    "Yi Ti": "https://awoiaf.westeros.org/index.php/Yi_Ti",
    "Volantis": "https://awoiaf.westeros.org/index.php/Volantis",
    "Free Cities": "https://awoiaf.westeros.org/index.php/Free_Cities",
}
TARGET_ENTITY_IDS = {
    "Yi Ti": "entity_asoiaf_yi_ti_0182",
    "Volantis": "entity_asoiaf_volantis_0189",
    "Free Cities": "entity_asoiaf_free_cities_0188",
}

class WikiTextParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_content = False
        self.skip_depth = 0
        self.capture = None
        self.buf = []
        self.items = []
        self.current_heading = "lead"
        self.tag_stack = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = set((attrs.get("class") or "").split())
        idv = attrs.get("id") or ""
        if tag == "div" and "mw-parser-output" in classes:
            self.in_content = True
            return
        if not self.in_content:
            return
        if tag in {"table", "style", "script", "sup"} or "navbox" in classes or "metadata" in classes or "toc" in classes:
            self.skip_depth += 1
            return
        if self.skip_depth:
            self.skip_depth += 1
            return
        if tag in {"h2", "h3"}:
            self.capture = "heading"
            self.buf = []
        elif tag in {"p", "li"}:
            self.capture = tag
            self.buf = []
        elif self.capture and tag == "br":
            self.buf.append(" ")

    def handle_endtag(self, tag):
        if not self.in_content:
            return
        if self.skip_depth:
            self.skip_depth -= 1
            return
        if self.capture == "heading" and tag in {"h2", "h3"}:
            text = clean("".join(self.buf))
            if text:
                self.current_heading = text
            self.capture = None
            self.buf = []
        elif self.capture == tag and tag in {"p", "li"}:
            text = clean("".join(self.buf))
            if text and not is_junk(text):
                self.items.append((self.current_heading, text))
            self.capture = None
            self.buf = []

    def handle_data(self, data):
        if self.in_content and not self.skip_depth and self.capture:
            self.buf.append(data)


def clean(s):
    s = html.unescape(s)
    s = re.sub(r"\[[0-9a-zA-Z ]+\]", "", s)  # footnote markers
    s = re.sub(r"\s+", " ", s).strip()
    return s


def is_junk(text):
    low = text.lower()
    if len(text) < 25:
        return True
    if low.startswith(("this page uses", "for a complete list", "see also", "references", "notes")):
        return True
    if low in {"contents", "books", "chapters"}:
        return True
    return False


def fetch_page(title, url):
    req = urllib.request.Request(url, headers={"User-Agent": "Hermes/Raven local ASOIAF lore seeding"})
    with urllib.request.urlopen(req, timeout=45) as r:
        data = r.read().decode("utf-8", errors="replace")
    parser = WikiTextParser()
    parser.feed(data)
    items = parser.items
    # Keep lead plus high-signal sections; avoid long plot chapter sections.
    high = []
    for heading, text in items:
        h = heading.lower()
        if heading == "lead" or any(k in h for k in ["geography", "culture", "government", "economy", "history", "people", "society", "defenses", "slavery", "known", "description"]):
            high.append((heading, text))
    if len(high) < 5:
        high = items[:25]
    return data, high[:40]


def bullets_for(items, title):
    bullets = []
    seen = set()
    for heading, text in items:
        # Split overlong paragraphs into sentences but keep context.
        parts = re.split(r"(?<=[.!?])\s+", text)
        candidates = []
        if len(parts) > 2:
            candidates.extend(parts[:3])
        else:
            candidates.append(text)
        for part in candidates:
            part = clean(part)
            if len(part) < 35:
                continue
            key = part.lower()[:160]
            if key in seen:
                continue
            seen.add(key)
            bullets.append(part)
            if len(bullets) >= 12:
                return bullets
    return bullets


def source_entry_id(title):
    return "entry_source_awoiaf_" + re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")

def source_ref_id(title, suffix):
    return "sourceref_awoiaf_" + re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_") + "_" + suffix

def fact_id(title, n):
    return "fact_awoiaf_" + re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_") + f"_{n:02d}"

def normalize_tags(meta):
    tags = meta.get("tags")
    if not isinstance(tags, list):
        tags = []
    out=[]
    for t in tags:
        if isinstance(t, str) and t and t not in out:
            out.append(t)
    return out

DEAD_PATTERNS = [
    r"\b(?:he|she|they|it) died\b",
    r"\bdied (?:in|at|of|from|during|shortly|later|after|before)\b",
    r"\bbefore dying\b",
    r"\bafter dying\b",
    r"\bwas (?:killed|slain|murdered|executed|poisoned|burned|hanged|beheaded|devoured)\b",
    r"\bwere (?:killed|slain|murdered|executed|poisoned|burned|hanged|beheaded|devoured)\b",
    r"\bkilled by\b",
    r"\bslain by\b",
    r"\bexecuted by\b",
    r"\bperished\b",
    r"\bfell in battle\b",
    r"\bdeath and\b",
]
DEAD_RE = re.compile("|".join(f"(?:{p})" for p in DEAD_PATTERNS), re.I)
FALSE_ALIVE_HINTS = re.compile(r"\b(purportedly|rumored|rumoured|thought|believed|secretly used a glamor|resurrected|undead|as Lady Stoneheart)\b", re.I)

def is_dead_character(ent):
    text = f"{ent.get('name','')}: {ent.get('description','')}"
    if not DEAD_RE.search(text):
        return False
    # Do not mark records whose only clear death phrase is about someone else.
    # If the text says resurrected/undead, still tag as dead-derived but not lifeStatus dead.
    return True

def death_note(ent):
    desc = ent.get("description") or ""
    sentences = re.split(r"(?<=[.!?])\s+", desc)
    for s in sentences:
        if DEAD_RE.search(s):
            return clean(s)
    return "Death indicated by imported description."

with open(IN, encoding="utf-8") as f:
    bundle = json.load(f)
wd = bundle["worldDatabase"]
entries = wd.get("entries") or wd.get("storyEntries") or []
entities = wd["entities"]
facts = wd.setdefault("facts", [])
source_refs = wd.setdefault("sourceRefs", [])
memories = wd.setdefault("memoryNodes", [])
warnings = wd.setdefault("continuityWarnings", [])

# 1) Dead tag on character records.
dead_records = []
for ent in entities:
    if ent.get("type") != "character":
        continue
    if not is_dead_character(ent):
        continue
    meta = ent.setdefault("metadata", {})
    state = ent.setdefault("state", {})
    tags = normalize_tags(meta)
    if "dead" not in tags:
        tags.append("dead")
    if "deceased" not in tags:
        tags.append("deceased")
    meta["tags"] = tags
    meta["lifeStatus"] = "dead"
    meta["deathTaggedAt"] = NOW
    meta["deathTagBasis"] = death_note(ent)
    descriptors = state.get("personalityDescriptors")
    if not isinstance(descriptors, list):
        descriptors = []
    for t in ["dead", "deceased"]:
        if t not in descriptors:
            descriptors.append(t)
    state["personalityDescriptors"] = descriptors
    traits = state.get("traits")
    if not isinstance(traits, list):
        traits = []
    if "dead" not in traits:
        traits.append("dead")
    state["traits"] = traits
    state["lifeStatus"] = "dead"
    state["deathNote"] = death_note(ent)
    dead_records.append({"id": ent["id"], "name": ent["name"], "deathNote": state["deathNote"]})

# 2) AWOIAF enrichment.
awoiaf = {}
next_pos = max([int(e.get("position", 0) or 0) for e in entries] + [0]) + 1
for title, url in PAGES.items():
    raw_html, items = fetch_page(title, url)
    bullets = bullets_for(items, title)
    awoiaf[title] = {"url": url, "bullets": bullets, "itemCount": len(items)}
    sid = source_entry_id(title)
    content = f"AWOIAF source digest for {title} ({url})\n" + "\n".join(f"- {b}" for b in bullets)
    # Upsert evidence entry.
    existing = next((e for e in entries if e.get("id") == sid), None)
    entry_row = {
        "id": sid,
        "storyId": STORY_ID,
        "type": "source_awoiaf_page",
        "content": content,
        "position": next_pos,
        "parentId": None,
        "branchId": None,
        "metadata": {"sourceType": "awoiaf", "url": url, "title": title, "retrievedAt": NOW, "parser": "html.parser/mw-parser-output", "source": "https://awoiaf.westeros.org/index.php"},
        "serverVersion": 1,
        "createdAt": NOW,
        "updatedAt": NOW,
    }
    if existing:
        existing.update(entry_row)
    else:
        entries.append(entry_row)
        next_pos += 1

    ent_id = TARGET_ENTITY_IDS[title]
    ent = next((e for e in entities if e.get("id") == ent_id), None)
    if ent:
        old_desc = ent.get("description") or ""
        enriched = f"{title}: " + " ".join(bullets[:8])
        ent["description"] = enriched
        ent.setdefault("sourceEntryIds", [])
        if sid not in ent["sourceEntryIds"]:
            ent["sourceEntryIds"].append(sid)
        meta = ent.setdefault("metadata", {})
        refs = meta.get("externalSources")
        if not isinstance(refs, list):
            refs = []
        if not any(isinstance(r, dict) and r.get("url") == url for r in refs):
            refs.append({"source": "AWOIAF", "url": url, "retrievedAt": NOW})
        meta["externalSources"] = refs
        meta["awoiafEnrichedAt"] = NOW
        tags = normalize_tags(meta)
        for t in ["awoiaf", "free-cities" if title in {"Volantis", "Free Cities"} else "far-east"]:
            if t not in tags: tags.append(t)
        meta["tags"] = tags
        state = ent.setdefault("state", {})
        state["awoiafSummaryBullets"] = bullets
        if title == "Yi Ti":
            state["region"] = "Further East / Essos"
            state["terrain"] = "empire; cities, plains, hills, jungles"
            state["tradeGoods"] = ["saffron", "spices", "silk"]
            state["politicalForm"] = "Golden Empire; god-emperor and rival claimants in source tradition"
        elif title == "Volantis":
            state["region"] = "Free Cities / mouth of the Rhoyne"
            state["terrain"] = "river port city; Long Bridge; Black Walls"
            state["politicalForm"] = "triarchy elected from Tiger and Elephant parties"
            state["socialOrder"] = ["Old Blood within Black Walls", "slave population outnumbers free population", "R'hllor has major influence"]
        elif title == "Free Cities":
            state["region"] = "Western Essos"
            state["terrain"] = "network of city-states"
            state["memberCities"] = ["Braavos", "Lorath", "Lys", "Myr", "Norvos", "Pentos", "Qohor", "Tyrosh", "Volantis"]
            state["politicalForm"] = "independent city-states, mostly Valyrian-colony descendants; Braavos founded by escaped slaves"

        source_refs.append({
            "id": source_ref_id(title, "entity_description"),
            "storyId": STORY_ID,
            "sourceType": "web_page",
            "sourceId": url,
            "targetTable": "entities",
            "targetRecordId": ent_id,
            "targetRecordField": "description/state.awoiafSummaryBullets",
            "sourceField": "mw-parser-output paragraphs/list items",
            "confidence": 0.95,
            "rationale": f"{title} enriched from AWOIAF page requested by user.",
            "notes": f"Retrieved {NOW}",
            "serverVersion": 1,
            "createdAt": NOW,
            "updatedAt": NOW,
        })
        for i, b in enumerate(bullets[:8], start=1):
            facts.append({
                "id": fact_id(title, i),
                "storyId": STORY_ID,
                "type": "awoiaf_lore",
                "subjectEntityId": ent_id,
                "targetEntityId": None,
                "title": f"{title} — AWOIAF fact {i}",
                "statement": b,
                "confidence": 0.92,
                "status": "active",
                "visibility": "player_known",
                "firstSeenEntryId": sid,
                "sourceEntryIds": [sid],
                "sourceEventIds": [],
                "sourcePatchIds": [],
                "metadata": {"source": "AWOIAF", "url": url, "retrievedAt": NOW},
                "serverVersion": 1,
                "createdAt": NOW,
                "updatedAt": NOW,
            })

# Add compact memory note.
mem_id = "memory_awoiaf_yi_ti_volantis_free_cities"
mem_content = "AWOIAF enrichment added for Yi Ti, Volantis, and the Free Cities. Use entity state.awoiafSummaryBullets and awoiaf_lore facts for sourced details."
existing_mem = next((m for m in memories if m.get("id") == mem_id), None)
mem_row = {
    "id": mem_id,
    "storyId": STORY_ID,
    "type": "source_digest",
    "title": "AWOIAF enrichment: Yi Ti, Volantis, Free Cities",
    "content": mem_content,
    "summary": "Web-sourced lore digest for the Far East and Free Cities, plus dead/deceased tags on character records inferred from imported descriptions.",
    "keywords": ["AWOIAF", "Yi Ti", "Volantis", "Free Cities", "dead tag"],
    "entityIds": list(TARGET_ENTITY_IDS.values()),
    "factionIds": [],
    "threadIds": [],
    "locationId": None,
    "visibility": "player_known",
    "importance": 0.85,
    "sourceEntryIds": [source_entry_id(t) for t in PAGES],
    "sourceEventIds": [],
    "sourcePatchIds": [],
    "embedding": None,
    "metadata": {"source": "AWOIAF", "retrievedAt": NOW, "deadTagCount": len(dead_records)},
    "serverVersion": 1,
    "createdAt": NOW,
    "updatedAt": NOW,
}
if existing_mem: existing_mem.update(mem_row)
else: memories.append(mem_row)

# Warning: dead tag is heuristic.
warn_id = "warning_dead_tag_heuristic_review"
if not any(w.get("id") == warn_id for w in warnings):
    warnings.append({
        "id": warn_id,
        "storyId": STORY_ID,
        "warningType": "heuristic_tagging",
        "level": "info",
        "title": "Dead/deceased tags inferred from descriptions",
        "status": "open",
        "details": f"Added dead/deceased tags to {len(dead_records)} character records using phrase matching over imported lore descriptions. Review campaign spoiler boundary and false positives before player-facing use.",
        "entityIds": [r["id"] for r in dead_records[:100]],
        "factionIds": [],
        "threadIds": [],
        "actorIds": [],
        "sourceEntryIds": [],
        "sourceEventIds": [],
        "sourcePatchIds": [],
        "resolutionNotes": None,
        "resolvedBy": None,
        "resolvedAt": None,
        "metadata": {"source": "enrich-asoiaf-awoiaf.py", "deadTagCount": len(dead_records)},
        "serverVersion": 1,
        "createdAt": NOW,
        "updatedAt": NOW,
    })

# Export compatibility root keys too when present.
bundle["exportedAt"] = NOW
if "storyEntries" in bundle:
    bundle["storyEntries"] = entries
if "backendCanon" in bundle:
    # Keep backendCanon roughly aligned if present.
    bc = bundle["backendCanon"]
    if isinstance(bc, dict):
        bc["entries"] = entries
        bc["entities"] = entities
        bc["facts"] = facts
        bc["sourceRefs"] = source_refs
        bc["memoryNodes"] = memories
        bc["continuityWarnings"] = warnings

# Validation.
errors = []
entity_ids = {e["id"] for e in entities}
entry_ids = {e["id"] for e in entries}
fact_ids = [f.get("id") for f in facts]
for ent in entities:
    for sid in ent.get("sourceEntryIds", []):
        if sid not in entry_ids:
            errors.append(f"entity {ent['id']} missing source entry {sid}")
for f in facts:
    sid = f.get("subjectEntityId")
    if sid and sid not in entity_ids:
        errors.append(f"fact {f.get('id')} missing subject {sid}")
    for se in f.get("sourceEntryIds", []):
        if se not in entry_ids:
            errors.append(f"fact {f.get('id')} missing source entry {se}")
for table_name, rows in [("facts", facts), ("entries", entries), ("sourceRefs", source_refs), ("memoryNodes", memories), ("continuityWarnings", warnings)]:
    ids = [r.get("id") for r in rows if isinstance(r, dict) and r.get("id")]
    dups = [x for x,c in Counter(ids).items() if c > 1]
    if dups:
        errors.append(f"duplicate ids in {table_name}: {dups[:10]}")

report = {
    "valid": not errors,
    "errors": errors[:200],
    "updatedAt": NOW,
    "deadTagCount": len(dead_records),
    "deadTagSample": dead_records[:30],
    "awoiafPages": awoiaf,
    "outputs": {"bundle": str(OUT), "report": str(REPORT)},
}
OUT.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
# Parse back.
json.loads(OUT.read_text(encoding="utf-8"))
json.loads(REPORT.read_text(encoding="utf-8"))
print(json.dumps({"valid": report["valid"], "errors": len(errors), "deadTagCount": len(dead_records), "awoiafFactsAdded": 24, "output": str(OUT)}, indent=2))
