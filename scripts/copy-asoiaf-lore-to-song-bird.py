import copy
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'exports' / 'asoiaf-lorebook.concordance-enriched.world-db.json'
SONG_BIRD_BEFORE = ROOT / 'exports' / 'song-bird.before-asoiaf-copy.world-db.json'
OUT = ROOT / 'exports' / 'song-bird.asoiaf-lore-attributed.world-db.json'
REPORT = ROOT / 'exports' / 'song-bird.asoiaf-lore-copy-report.json'
OLD_STORY_ID = 'story_asoiaf_lorebook_seed'
TARGET_STORY_ID = 'story_b9d0fb4f-011e-43f0-a2b1-2b0c05b97f56'
NOW = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
ATTRIBUTION_ENTRY_ID = 'entry_source_song_bird_asoiaf_lore_attribution'
ATTRIBUTION_MEMORY_ID = 'memory_song_bird_asoiaf_lore_attribution'
ATTRIBUTION_FACT_ID = 'fact_song_bird_asoiaf_lore_attribution'
ATTRIBUTION_SOURCE_REF_ID = 'sourceref_song_bird_asoiaf_lore_attribution'

source_bundle = json.loads(SOURCE.read_text(encoding='utf-8'))
song_bundle = json.loads(SONG_BIRD_BEFORE.read_text(encoding='utf-8'))
source_wd = source_bundle['worldDatabase']
song_wd = song_bundle['worldDatabase']

# Deep copy the enriched ASOIAF canon rows, then retarget every exact story id value.
def retarget(value):
    if isinstance(value, dict):
        return {k: retarget(v) for k, v in value.items()}
    if isinstance(value, list):
        return [retarget(v) for v in value]
    if value == OLD_STORY_ID:
        return TARGET_STORY_ID
    return value

wd = retarget(copy.deepcopy(source_wd))

# Preserve Song Bird's actual story shell/settings, while adding attribution and ASOIAF header guidance.
story = copy.deepcopy(song_wd['story'])
metadata = story.setdefault('metadata', {})
metadata.update({
    'asoiafLoreCopiedFromStoryId': OLD_STORY_ID,
    'asoiafLoreCopiedAt': NOW,
    'asoiafLoreSourceBundle': str(SOURCE),
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
story['description'] = (story.get('description') or 'Song Bird campaign world.').rstrip() + ' Includes an attributed ASOIAF/Game of Thrones lore database copied from the project seed, with source entries for the local lorebook, AWOIAF, and Westeros.org Citadel Concordance.'
base_header = story.get('headerPrompt') or ''
addition = 'Use the imported ASOIAF lore database as Song Bird\'s political and mythic substrate. Treat source entries and source refs as evidence; keep imported lore reviewable and avoid revealing spoiler-sensitive knowledge unless the current scene justifies it.'
story['headerPrompt'] = (base_header + '\n\n' + addition).strip() if base_header else addition
story['updatedAt'] = NOW
wd['story'] = story

# Merge Song Bird's pre-existing player/campaign rows into the copied lore DB.
def merge_by_id(base_rows, extra_rows):
    by_id = {r.get('id'): r for r in base_rows if isinstance(r, dict) and r.get('id')}
    rows = list(base_rows)
    added = 0
    for row in extra_rows:
        rid = row.get('id') if isinstance(row, dict) else None
        if not rid or rid in by_id:
            continue
        rows.append(copy.deepcopy(row))
        by_id[rid] = row
        added += 1
    return rows, added

merged_counts = {}
for key in ['entries', 'entities', 'entityAliases', 'relationships', 'factions', 'factionMemberships', 'factionResources', 'factionGoals', 'factionProjects', 'agreements', 'threads', 'npcBeliefs', 'events', 'npcEventLinks', 'statePatches', 'facts', 'sourceRefs', 'patchProposals', 'continuityWarnings', 'memoryNodes', 'chapters', 'arcs', 'sagas']:
    base = wd.get(key, [])
    extra = song_wd.get(key, [])
    merged, added = merge_by_id(base, extra)
    wd[key] = merged
    if added:
        merged_counts[key] = added

entries = wd.setdefault('entries', [])
facts = wd.setdefault('facts', [])
source_refs = wd.setdefault('sourceRefs', [])
memories = wd.setdefault('memoryNodes', [])

position = max([int(e.get('position', 0) or 0) for e in entries] + [0]) + 1
if not any(e.get('id') == ATTRIBUTION_ENTRY_ID for e in entries):
    entries.append({
        'id': ATTRIBUTION_ENTRY_ID,
        'storyId': TARGET_STORY_ID,
        'type': 'source_attribution',
        'content': (
            'Song Bird ASOIAF lore attribution. This campaign database contains a copied ASOIAF/Game of Thrones lore substrate generated from the local SillyTavern world-info lorebook, then enriched with A Wiki of Ice and Fire pages for Yi Ti, Volantis, and the Free Cities, plus Westeros.org Citadel Concordance context for Free Cities / Valyrian lore. Structured rows are reviewable campaign canon proposals; source entries and source references preserve evidence.'
        ),
        'position': position,
        'parentId': None,
        'branchId': None,
        'metadata': {
            'sourceType': 'attribution',
            'copiedFromStoryId': OLD_STORY_ID,
            'targetStoryId': TARGET_STORY_ID,
            'createdBy': 'Hermes/Raven',
            'createdAt': NOW,
            'sources': [
                'Local SillyTavern ASOIAF/Game of Thrones lorebook JSON',
                'https://awoiaf.westeros.org/index.php/Yi_Ti',
                'https://awoiaf.westeros.org/index.php/Volantis',
                'https://awoiaf.westeros.org/index.php/Free_Cities',
                'https://www.westeros.org/Citadel/Concordance/Section/2.1.3.1./'
            ]
        },
        'serverVersion': 1,
        'createdAt': NOW,
        'updatedAt': NOW,
    })

if not any(f.get('id') == ATTRIBUTION_FACT_ID for f in facts):
    facts.append({
        'id': ATTRIBUTION_FACT_ID,
        'storyId': TARGET_STORY_ID,
        'type': 'source_attribution',
        'subjectEntityId': None,
        'targetEntityId': None,
        'title': 'Song Bird lore database attribution',
        'statement': 'Song Bird includes an attributed copy of the ASOIAF/Game of Thrones lorebook seed, enriched from AWOIAF and Westeros.org Citadel Concordance; imported structured lore remains reviewable campaign substrate.',
        'confidence': 1,
        'status': 'active',
        'visibility': 'player_known',
        'firstSeenEntryId': ATTRIBUTION_ENTRY_ID,
        'sourceEntryIds': [ATTRIBUTION_ENTRY_ID],
        'sourceEventIds': [],
        'sourcePatchIds': [],
        'metadata': {'source': 'copy-asoiaf-lore-to-song-bird.py', 'copiedAt': NOW},
        'serverVersion': 1,
        'createdAt': NOW,
        'updatedAt': NOW,
    })

if not any(r.get('id') == ATTRIBUTION_SOURCE_REF_ID for r in source_refs):
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
        'notes': f'Copied at {NOW} from {SOURCE}',
        'serverVersion': 1,
        'createdAt': NOW,
        'updatedAt': NOW,
    })

if not any(m.get('id') == ATTRIBUTION_MEMORY_ID for m in memories):
    memories.append({
        'id': ATTRIBUTION_MEMORY_ID,
        'storyId': TARGET_STORY_ID,
        'type': 'source_attribution',
        'title': 'Song Bird ASOIAF lore attribution',
        'content': 'Song Bird contains copied ASOIAF/Game of Thrones seed lore with preserved source entries, source refs, AWOIAF enrichment, Westeros.org Concordance context, and dead/deceased tags for inferred dead characters.',
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
        'metadata': {'copiedFromStoryId': OLD_STORY_ID, 'copiedAt': NOW},
        'serverVersion': 1,
        'createdAt': NOW,
        'updatedAt': NOW,
    })

# Build export bundle from source but with Song Bird-targeted worldDatabase.
out = copy.deepcopy(source_bundle)
out['worldDatabase'] = wd
out['story'] = story
out['schemaVersion'] = source_bundle.get('schemaVersion', 3)
out['exportedAt'] = NOW
out['source'] = 'Song Bird copy of ASOIAF lorebook seed with attribution'
# Align compatibility roots if present.
compat_map = {
    'storyEntries': 'entries',
    'backendCanon': None,
}
if 'storyEntries' in out:
    out['storyEntries'] = wd.get('entries', [])
if isinstance(out.get('backendCanon'), dict):
    for k in ['entries','entities','entityAliases','relationships','factions','factionMemberships','factionResources','factionGoals','factionProjects','agreements','threads','npcBeliefs','events','npcEventLinks','statePatches','facts','sourceRefs','patchProposals','continuityWarnings','memoryNodes','chapters','arcs','sagas']:
        out['backendCanon'][k] = wd.get(k, [])

# Validation.
errors = []
entry_ids = {r['id'] for r in wd.get('entries', []) if isinstance(r, dict) and r.get('id')}
entity_ids = {r['id'] for r in wd.get('entities', []) if isinstance(r, dict) and r.get('id')}
for table, rows in wd.items():
    if isinstance(rows, list):
        ids = [r.get('id') for r in rows if isinstance(r, dict) and r.get('id')]
        dup = [x for x, c in Counter(ids).items() if c > 1]
        if dup:
            errors.append(f'duplicate ids in {table}: {dup[:10]}')
        for r in rows:
            if isinstance(r, dict):
                for key in ['storyId', 'story_id']:
                    if r.get(key) not in (None, TARGET_STORY_ID):
                        errors.append(f'{table}/{r.get("id")} has wrong {key}: {r.get(key)}')
for ent in wd.get('entities', []):
    for se in ent.get('sourceEntryIds', []):
        if se not in entry_ids:
            errors.append(f'entity {ent.get("id")} missing source entry {se}')
for alias in wd.get('entityAliases', []):
    if alias.get('entityId') and alias['entityId'] not in entity_ids:
        errors.append(f'alias {alias.get("id")} missing entity {alias.get("entityId")}')
for fact in wd.get('facts', []):
    if fact.get('subjectEntityId') and fact['subjectEntityId'] not in entity_ids:
        errors.append(f'fact {fact.get("id")} bad subject {fact.get("subjectEntityId")}')
    for se in fact.get('sourceEntryIds', []):
        if se not in entry_ids:
            errors.append(f'fact {fact.get("id")} missing source entry {se}')

counts = {k: len(v) for k, v in wd.items() if isinstance(v, list)}
report = {
    'valid': not errors,
    'errors': errors[:200],
    'targetStoryId': TARGET_STORY_ID,
    'targetTitle': story['title'],
    'sourceStoryId': OLD_STORY_ID,
    'copiedAt': NOW,
    'mergedExistingSongBirdRows': merged_counts,
    'counts': counts,
    'outputs': {'bundle': str(OUT), 'report': str(REPORT)},
}
OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
json.loads(OUT.read_text(encoding='utf-8'))
json.loads(REPORT.read_text(encoding='utf-8'))
print(json.dumps({'valid': report['valid'], 'errors': len(errors), 'target': TARGET_STORY_ID, 'counts': counts, 'mergedExistingSongBirdRows': merged_counts, 'output': str(OUT)}, indent=2))
