import html
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IN = ROOT / 'exports' / 'asoiaf-lorebook.live-before-concordance.world-db.json'
HTML = ROOT / 'exports' / 'westeros-concordance-2.1.3.1.html'
OUT = ROOT / 'exports' / 'asoiaf-lorebook.concordance-enriched.world-db.json'
REPORT = ROOT / 'exports' / 'asoiaf-lorebook.concordance-enrichment-report.json'
STORY_ID = 'story_asoiaf_lorebook_seed'
URL = 'https://www.westeros.org/Citadel/Concordance/Section/2.1.3.1./'
NOW = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
SOURCE_ENTRY_ID = 'entry_source_westeros_concordance_2_1_3_1'
FREE_CITIES_ID = 'entity_asoiaf_free_cities_0188'
VALYRIA_ID = 'entity_asoiaf_valyria_0042'
VALYRIAN_STEEL_ID = 'entity_asoiaf_valyrian_steel_0060'
DRAGONSTONE_ID = 'entity_asoiaf_dragonstone_0033'

html_text = HTML.read_text(encoding='utf-8')
plain = html.unescape(re.sub(r'<[^>]+>', ' ', html_text))
plain = re.sub(r'\s+', ' ', plain)
parts = [p.strip() for p in re.split(r'(?<=\))\s+', plain) if p.strip()]

wanted = []
patterns = [
    'The Free Cities speak a bastard version of Valyrian',
    'Valyria left many roads',
    'High Valyrian is still used by some',
    'Dragonstone was the westernmost outpost',
    'The Valyrians had great skill in shaping stone',
    'Valyria produced items known as glass candles',
    'Some claim to still know the spells that must be used to rework Valyrian steel',
    'The Targaryens were on Dragonstone for about two centuries after the Doom',
    'There are descendants of the Valyrians scattered across the world',
]
for pat in patterns:
    found = next((p for p in parts if pat.lower() in p.lower()), None)
    if found and found not in wanted:
        wanted.append(found)
# fallback if page text shifts
if len(wanted) < 5:
    for p in parts:
        low = p.lower()
        if ('free cities' in low or 'valyria' in low or 'valyrian' in low) and 45 < len(p) < 700 and p not in wanted:
            wanted.append(p)
        if len(wanted) >= 12:
            break

bundle = json.loads(IN.read_text(encoding='utf-8'))
wd = bundle['worldDatabase']
entries = wd.get('entries') or wd.get('storyEntries') or []
entities = wd['entities']
facts = wd.setdefault('facts', [])
source_refs = wd.setdefault('sourceRefs', [])
memories = wd.setdefault('memoryNodes', [])

position = max([int(e.get('position',0) or 0) for e in entries] + [0]) + 1
content = 'Westeros.org Citadel Concordance source digest for Free Cities / Valyrian context ({})\n'.format(URL) + '\n'.join('- '+x for x in wanted)
entry_row = {
    'id': SOURCE_ENTRY_ID,
    'storyId': STORY_ID,
    'type': 'source_westeros_concordance_page',
    'content': content,
    'position': position,
    'parentId': None,
    'branchId': None,
    'metadata': {
        'sourceType': 'westeros_org_citadel_concordance',
        'url': URL,
        'retrievedAt': NOW,
        'note': 'User supplied as a deeper lore source. Exact page is Concordance section 2.1.3.1 / Red Keep but full HTML includes concordance text around Ancient Valyria and Free Cities.'
    },
    'serverVersion': 1,
    'createdAt': NOW,
    'updatedAt': NOW,
}
existing = next((e for e in entries if e.get('id') == SOURCE_ENTRY_ID), None)
if existing: existing.update(entry_row)
else: entries.append(entry_row)

def get_ent(eid):
    return next((e for e in entities if e.get('id') == eid), None)

def add_source(ent):
    ent.setdefault('sourceEntryIds', [])
    if SOURCE_ENTRY_ID not in ent['sourceEntryIds']:
        ent['sourceEntryIds'].append(SOURCE_ENTRY_ID)
    meta = ent.setdefault('metadata', {})
    tags = meta.get('tags') if isinstance(meta.get('tags'), list) else []
    for t in ['westeros-org', 'citadel-concordance']:
        if t not in tags: tags.append(t)
    meta['tags'] = tags
    refs = meta.get('externalSources') if isinstance(meta.get('externalSources'), list) else []
    if not any(isinstance(r, dict) and r.get('url') == URL for r in refs):
        refs.append({'source':'Westeros.org Citadel Concordance', 'url': URL, 'retrievedAt': NOW})
    meta['externalSources'] = refs
    meta['concordanceEnrichedAt'] = NOW

# Update Free Cities with relevant concordance bullets.
free = get_ent(FREE_CITIES_ID)
if free:
    add_source(free)
    state = free.setdefault('state', {})
    old = state.get('concordanceBullets') if isinstance(state.get('concordanceBullets'), list) else []
    for b in wanted:
        if ('free cities' in b.lower() or 'valyrian' in b.lower() or 'valyria' in b.lower()) and b not in old:
            old.append(b)
    state['concordanceBullets'] = old[:16]
    if 'The Free Cities speak a bastard version of Valyrian' in content and 'bastard Valyrian dialects' not in state.get('languages', []):
        langs = state.get('languages') if isinstance(state.get('languages'), list) else []
        langs.append('bastard Valyrian dialects')
        state['languages'] = langs
    free['description'] = (free.get('description','').rstrip() + ' Concordance note: Westeros.org records that the Free Cities speak a bastard version of Valyrian because most began as Valyrian colonies; descendants of Valyrians remain scattered in the Free Cities, though intermarried with other peoples.').strip()

# Add source links to Valyria-ish records, without overwriting AWOIAF content.
for eid in [VALYRIA_ID, VALYRIAN_STEEL_ID, DRAGONSTONE_ID]:
    ent = get_ent(eid)
    if ent:
        add_source(ent)
        state = ent.setdefault('state', {})
        cb = state.get('concordanceBullets') if isinstance(state.get('concordanceBullets'), list) else []
        for b in wanted:
            low = b.lower()
            if eid == VALYRIAN_STEEL_ID and 'valyrian steel' not in low: continue
            if eid == DRAGONSTONE_ID and 'dragonstone' not in low: continue
            if eid == VALYRIA_ID and not ('valyria' in low or 'valyrian' in low): continue
            if b not in cb: cb.append(b)
        state['concordanceBullets'] = cb[:12]

# Facts, source refs.
base_fact_count = len(facts)
for i, b in enumerate(wanted[:12], start=1):
    fid = f'fact_westeros_concordance_valyria_free_cities_{i:02d}'
    if not any(f.get('id') == fid for f in facts):
        facts.append({
            'id': fid,
            'storyId': STORY_ID,
            'type': 'westeros_concordance_lore',
            'subjectEntityId': FREE_CITIES_ID if 'free cities' in b.lower() else VALYRIA_ID,
            'targetEntityId': None,
            'title': f'Westeros.org Concordance fact {i}',
            'statement': b,
            'confidence': 0.9,
            'status': 'active',
            'visibility': 'player_known',
            'firstSeenEntryId': SOURCE_ENTRY_ID,
            'sourceEntryIds': [SOURCE_ENTRY_ID],
            'sourceEventIds': [],
            'sourcePatchIds': [],
            'metadata': {'source': 'Westeros.org Citadel Concordance', 'url': URL, 'retrievedAt': NOW},
            'serverVersion': 1,
            'createdAt': NOW,
            'updatedAt': NOW,
        })

for target_table, target_id, field in [('entities', FREE_CITIES_ID, 'description/state.concordanceBullets'), ('entities', VALYRIA_ID, 'state.concordanceBullets'), ('story_entries', SOURCE_ENTRY_ID, 'content')]:
    sid = f"sourceref_westeros_concordance_{target_id}_{field.replace('/','_').replace('.','_')}"
    if not any(r.get('id') == sid for r in source_refs):
        source_refs.append({
            'id': sid,
            'storyId': STORY_ID,
            'sourceType': 'web_page',
            'sourceId': URL,
            'targetTable': target_table,
            'targetRecordId': target_id,
            'targetRecordField': field,
            'sourceField': 'Concordance text',
            'confidence': 0.9,
            'rationale': 'User supplied Westeros.org Citadel Concordance as a deeper lore source.',
            'notes': f'Retrieved {NOW}',
            'serverVersion': 1,
            'createdAt': NOW,
            'updatedAt': NOW,
        })

mem_id = 'memory_westeros_concordance_valyria_free_cities'
if not any(m.get('id') == mem_id for m in memories):
    memories.append({
        'id': mem_id,
        'storyId': STORY_ID,
        'type': 'source_digest',
        'title': 'Westeros.org Concordance: Valyria / Free Cities context',
        'content': 'User supplied Westeros.org Citadel Concordance as a deeper source. This pass added concise Concordance-backed facts about Valyrian origins, Free Cities language/origin, roads, Dragonstone, glass candles, and Valyrian steel context.',
        'summary': f'Added {len(facts)-base_fact_count} Concordance-backed facts.',
        'keywords': ['Westeros.org', 'Citadel', 'Concordance', 'Valyria', 'Free Cities'],
        'entityIds': [FREE_CITIES_ID, VALYRIA_ID, VALYRIAN_STEEL_ID, DRAGONSTONE_ID],
        'factionIds': [],
        'threadIds': [],
        'locationId': None,
        'visibility': 'player_known',
        'importance': 0.82,
        'sourceEntryIds': [SOURCE_ENTRY_ID],
        'sourceEventIds': [],
        'sourcePatchIds': [],
        'embedding': None,
        'metadata': {'source': 'Westeros.org Citadel Concordance', 'url': URL, 'retrievedAt': NOW},
        'serverVersion': 1,
        'createdAt': NOW,
        'updatedAt': NOW,
    })

# Keep compatibility roots aligned if present.
if 'storyEntries' in bundle: bundle['storyEntries'] = entries
if 'backendCanon' in bundle and isinstance(bundle['backendCanon'], dict):
    bc = bundle['backendCanon']
    bc['entries'] = entries; bc['entities'] = entities; bc['facts'] = facts; bc['sourceRefs'] = source_refs; bc['memoryNodes'] = memories
bundle['exportedAt'] = NOW
# Validation.
errors=[]
entry_ids={e['id'] for e in entries}
entity_ids={e['id'] for e in entities}
for ent in entities:
    for se in ent.get('sourceEntryIds', []):
        if se not in entry_ids: errors.append(f"entity {ent['id']} missing source {se}")
for fact in facts:
    if fact.get('subjectEntityId') and fact['subjectEntityId'] not in entity_ids: errors.append(f"fact {fact['id']} bad subject")
    for se in fact.get('sourceEntryIds', []):
        if se not in entry_ids: errors.append(f"fact {fact['id']} missing source {se}")
for name, rows in [('entries',entries),('facts',facts),('sourceRefs',source_refs),('memoryNodes',memories)]:
    ids=[r.get('id') for r in rows if isinstance(r,dict)]
    dup=[x for x,c in Counter(ids).items() if x and c>1]
    if dup: errors.append(f'duplicate ids in {name}: {dup[:5]}')
report={'valid': not errors, 'errors': errors[:100], 'updatedAt': NOW, 'sourceUrl': URL, 'selectedFacts': wanted, 'factsAdded': len(facts)-base_fact_count, 'outputs': {'bundle': str(OUT), 'report': str(REPORT)}}
OUT.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding='utf-8')
REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
json.loads(OUT.read_text(encoding='utf-8'))
json.loads(REPORT.read_text(encoding='utf-8'))
print(json.dumps({'valid': report['valid'], 'errors': len(errors), 'factsAdded': report['factsAdded'], 'output': str(OUT)}, indent=2))
