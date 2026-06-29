import copy
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'exports' / 'asoiaf-lorebook.concordance-enriched.world-db.json'
# Use the clean pre-copy Song Bird export so failed same-id copy attempts do not contribute dangling aliases.
SONG_CURRENT = ROOT / 'exports' / 'song-bird.before-asoiaf-copy.world-db.json'
OUT = ROOT / 'exports' / 'song-bird.asoiaf-lore-attributed-cloned.world-db.json'
REPORT = ROOT / 'exports' / 'song-bird.asoiaf-lore-copy-cloned-report.json'
OLD_STORY_ID = 'story_asoiaf_lorebook_seed'
TARGET_STORY_ID = 'story_b9d0fb4f-011e-43f0-a2b1-2b0c05b97f56'
NOW = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
PREFIX = 'songbird_'
ATTRIBUTION_ENTRY_ID = 'entry_source_song_bird_asoiaf_lore_attribution'
ATTRIBUTION_MEMORY_ID = 'memory_song_bird_asoiaf_lore_attribution'
ATTRIBUTION_FACT_ID = 'fact_song_bird_asoiaf_lore_attribution'
ATTRIBUTION_SOURCE_REF_ID = 'sourceref_song_bird_asoiaf_lore_attribution'
TABLES = ['entries','entities','entityAliases','relationships','factions','factionMemberships','factionResources','factionGoals','factionProjects','agreements','threads','npcBeliefs','events','npcEventLinks','statePatches','facts','sourceRefs','patchProposals','continuityWarnings','memoryNodes','chapters','arcs','sagas']

source_bundle = json.loads(SOURCE.read_text(encoding='utf-8'))
song_bundle = json.loads(SONG_CURRENT.read_text(encoding='utf-8'))
source_wd = source_bundle['worldDatabase']
song_wd = song_bundle['worldDatabase']

# Map every source row id to a new globally distinct Song Bird id. Mtherios ids are globally unique,
# so simply retargeting storyId is not enough while the seed database still exists.
id_map = {OLD_STORY_ID: TARGET_STORY_ID}
for table in TABLES:
    for row in source_wd.get(table, []):
        if isinstance(row, dict) and row.get('id'):
            old = row['id']
            id_map[old] = old if old.startswith(PREFIX) else PREFIX + old

def transform(value):
    if isinstance(value, dict):
        return {k: transform(v) for k, v in value.items()}
    if isinstance(value, list):
        return [transform(v) for v in value]
    if isinstance(value, str) and value in id_map:
        return id_map[value]
    return value

# Start with cloned source rows.
wd = {k: transform(copy.deepcopy(v)) for k, v in source_wd.items()}

# Preserve the actual Song Bird story shell/settings, with attribution.
story = copy.deepcopy(song_wd['story'])
metadata = story.setdefault('metadata', {})
metadata.update({
    'asoiafLoreCopiedFromStoryId': OLD_STORY_ID,
    'asoiafLoreCopiedAt': NOW,
    'asoiafLoreSourceBundle': str(SOURCE),
    'asoiafLoreIdPrefix': PREFIX,
    'asoiafLoreAttribution': {
        'localLorebookSource': 'E:/DEV/Projects/mtherios-factions-work/lore/main_A Song of Ice and Fire_Game of Thrones Lorebook_world_info (1).json',
        'externalSources': [
            'https://awoiaf.westeros.org/index.php/Yi_Ti',
            'https://awoiaf.westeros.org/index.php/Volantis',
            'https://awoiaf.westeros.org/index.php/Free_Cities',
            'https://www.westeros.org/Citadel/Concordance/Section/2.1.3.1./'
        ],
        'note': 'Imported as evidence-linked lore substrate for the Song Bird campaign. Structured rows are campaign canon proposals until reviewed in play.'
    }
})
settings = story.setdefault('settings', {})
settings.update({
    'loreDatabase': 'ASOIAF/Game of Thrones lorebook seed copied into Song Bird',
    'canonPolicy': 'Use imported ASOIAF rows as evidence-backed campaign substrate; preserve player agency and spoiler boundaries.',
    'sourceAttributionRequired': True,
})
story['description'] = 'Song Bird campaign world. Includes an attributed ASOIAF/Game of Thrones lore database copied from the project seed, with source entries for the local lorebook, AWOIAF, and Westeros.org Citadel Concordance.'
story['headerPrompt'] = "Use the imported ASOIAF lore database as Song Bird's political and mythic substrate. Treat source entries and source refs as evidence; keep imported lore reviewable and avoid revealing spoiler-sensitive knowledge unless the current scene justifies it."
story['updatedAt'] = NOW
wd['story'] = story

# Merge existing Song Bird rows (Aurion etc.) and do not clone them.
def merge_by_id(base_rows, extra_rows):
    ids = {r.get('id') for r in base_rows if isinstance(r, dict)}
    rows = list(base_rows)
    added = 0
    for row in extra_rows:
        if not isinstance(row, dict) or not row.get('id') or row['id'] in ids:
            continue
        rows.append(copy.deepcopy(row))
        ids.add(row['id'])
        added += 1
    return rows, added

merged_counts = {}
for table in TABLES:
    rows, added = merge_by_id(wd.get(table, []), song_wd.get(table, []))
    wd[table] = rows
    if added:
        merged_counts[table] = added

entries = wd.setdefault('entries', [])
facts = wd.setdefault('facts', [])
source_refs = wd.setdefault('sourceRefs', [])
memories = wd.setdefault('memoryNodes', [])
position = max([int(e.get('position', 0) or 0) for e in entries] + [0]) + 1
# Remove any stale attribution rows from previous attempts then recreate cleanly.
entries[:] = [e for e in entries if e.get('id') != ATTRIBUTION_ENTRY_ID]
facts[:] = [f for f in facts if f.get('id') != ATTRIBUTION_FACT_ID]
source_refs[:] = [r for r in source_refs if r.get('id') != ATTRIBUTION_SOURCE_REF_ID]
memories[:] = [m for m in memories if m.get('id') != ATTRIBUTION_MEMORY_ID]
entries.append({
    'id': ATTRIBUTION_ENTRY_ID,
    'storyId': TARGET_STORY_ID,
    'type': 'source_attribution',
    'content': 'Song Bird ASOIAF lore attribution. This campaign database contains a cloned copy of the ASOIAF/Game of Thrones lore substrate generated from the local SillyTavern world-info lorebook, enriched with AWOIAF pages for Yi Ti, Volantis, and the Free Cities, plus Westeros.org Citadel Concordance context. Cloned lore rows use the songbird_ id prefix so the original seed database can coexist.',
    'position': position,
    'parentId': None,
    'branchId': None,
    'metadata': {'sourceType': 'attribution', 'copiedFromStoryId': OLD_STORY_ID, 'targetStoryId': TARGET_STORY_ID, 'idPrefix': PREFIX, 'createdBy': 'Hermes/Raven', 'createdAt': NOW},
    'serverVersion': 1,
    'createdAt': NOW,
    'updatedAt': NOW,
})
facts.append({
    'id': ATTRIBUTION_FACT_ID,
    'storyId': TARGET_STORY_ID,
    'type': 'source_attribution',
    'subjectEntityId': None,
    'targetEntityId': None,
    'title': 'Song Bird lore database attribution',
    'statement': 'Song Bird includes an attributed cloned copy of the ASOIAF/Game of Thrones lorebook seed, enriched from AWOIAF and Westeros.org Citadel Concordance; imported structured lore remains reviewable campaign substrate.',
    'confidence': 1,
    'status': 'active',
    'visibility': 'player_known',
    'firstSeenEntryId': ATTRIBUTION_ENTRY_ID,
    'sourceEntryIds': [ATTRIBUTION_ENTRY_ID],
    'sourceEventIds': [],
    'sourcePatchIds': [],
    'metadata': {'source': 'copy-asoiaf-lore-to-song-bird-cloned.py', 'copiedAt': NOW},
    'serverVersion': 1,
    'createdAt': NOW,
    'updatedAt': NOW,
})
source_refs.append({
    'id': ATTRIBUTION_SOURCE_REF_ID,
    'storyId': TARGET_STORY_ID,
    'sourceType': 'derived_database_copy',
    'sourceId': OLD_STORY_ID,
    'targetTable': 'stories',
    'targetRecordId': TARGET_STORY_ID,
    'targetRecordField': 'metadata.asoiafLoreAttribution',
    'sourceField': 'worldDatabase',
    'confidence': 1,
    'rationale': 'User requested attribution/copy of the ASOIAF lore database into Song Bird.',
    'notes': f'Cloned at {NOW} from {SOURCE}; cloned ids use prefix {PREFIX}',
    'serverVersion': 1,
    'createdAt': NOW,
    'updatedAt': NOW,
})
memories.append({
    'id': ATTRIBUTION_MEMORY_ID,
    'storyId': TARGET_STORY_ID,
    'type': 'source_attribution',
    'title': 'Song Bird ASOIAF lore attribution',
    'content': 'Song Bird contains a cloned ASOIAF/Game of Thrones seed lore copy with preserved source entries, source refs, AWOIAF enrichment, Westeros.org Concordance context, and dead/deceased tags for inferred dead characters.',
    'summary': 'Attribution/copy marker for ASOIAF lore imported into Song Bird.',
    'keywords': ['Song Bird', 'ASOIAF', 'Game of Thrones', 'AWOIAF', 'Westeros.org', 'attribution'],
    'entityIds': [],
    'factionIds': [],
    'threadIds': [],
    'locationId': None,
    'visibility': 'player_known',
    'importance': 0.95,
    'sourceEntryIds': [ATTRIBUTION_ENTRY_ID],
    'sourceEventIds': [],
    'sourcePatchIds': [],
    'embedding': None,
    'metadata': {'copiedFromStoryId': OLD_STORY_ID, 'copiedAt': NOW, 'idPrefix': PREFIX},
    'serverVersion': 1,
    'createdAt': NOW,
    'updatedAt': NOW,
})

out = copy.deepcopy(source_bundle)
out['schemaVersion'] = source_bundle.get('schemaVersion', 3)
out['version'] = source_bundle.get('version', 2)
out['exportedAt'] = NOW
out['source'] = 'Song Bird cloned copy of ASOIAF lorebook seed with attribution'
out['worldDatabase'] = wd
out['story'] = story
if 'storyEntries' in out: out['storyEntries'] = wd.get('entries', [])
if isinstance(out.get('backendCanon'), dict):
    for k in TABLES: out['backendCanon'][k] = wd.get(k, [])

# Validation.
errors=[]
entry_ids={r['id'] for r in wd.get('entries', []) if isinstance(r, dict) and r.get('id')}
entity_ids={r['id'] for r in wd.get('entities', []) if isinstance(r, dict) and r.get('id')}
for table in TABLES:
    rows=wd.get(table, [])
    ids=[r.get('id') for r in rows if isinstance(r, dict) and r.get('id')]
    dup=[x for x,c in Counter(ids).items() if c>1]
    if dup: errors.append(f'duplicate ids in {table}: {dup[:10]}')
    for r in rows:
        if isinstance(r, dict):
            for key in ['storyId', 'story_id']:
                if r.get(key) not in (None, TARGET_STORY_ID): errors.append(f'{table}/{r.get("id")} wrong {key}={r.get(key)}')
for ent in wd.get('entities', []):
    for se in ent.get('sourceEntryIds', []):
        if se not in entry_ids: errors.append(f'entity {ent.get("id")} missing source {se}')
for al in wd.get('entityAliases', []):
    if al.get('entityId') and al['entityId'] not in entity_ids: errors.append(f'alias {al.get("id")} missing entity {al.get("entityId")}')
for fact in wd.get('facts', []):
    if fact.get('subjectEntityId') and fact['subjectEntityId'] not in entity_ids: errors.append(f'fact {fact.get("id")} missing subject {fact.get("subjectEntityId")}')
    for se in fact.get('sourceEntryIds', []):
        if se not in entry_ids: errors.append(f'fact {fact.get("id")} missing source {se}')
counts={k:len(wd.get(k,[])) for k in TABLES}
report={'valid': not errors, 'errors': errors[:200], 'targetStoryId': TARGET_STORY_ID, 'sourceStoryId': OLD_STORY_ID, 'idPrefix': PREFIX, 'copiedAt': NOW, 'mergedExistingSongBirdRows': merged_counts, 'counts': counts, 'outputs': {'bundle': str(OUT), 'report': str(REPORT)}}
OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
json.loads(OUT.read_text(encoding='utf-8'))
json.loads(REPORT.read_text(encoding='utf-8'))
print(json.dumps({'valid': report['valid'], 'errors': len(errors), 'counts': counts, 'mergedExistingSongBirdRows': merged_counts, 'output': str(OUT)}, indent=2))
