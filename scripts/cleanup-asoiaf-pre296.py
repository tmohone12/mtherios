import copy
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IN = ROOT / 'exports' / 'asoiaf-lorebook.before-pre296-cleanup.world-db.json'
OUT = ROOT / 'exports' / 'asoiaf-lorebook.pre296-clean.world-db.json'
REPORT = ROOT / 'exports' / 'asoiaf-lorebook.pre296-cleanup-report.json'
STORY_ID = 'story_asoiaf_lorebook_seed'
NOW = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
CUTOFF = 'start of 296 AC'

# Explicit future/main-series spoilers that must not be available to the narrator before the campaign reaches them.
# Deliberately focuses on events/outcomes, not every living character name.
FORBIDDEN_PATTERNS = [
    r'\b29[7-9]\s*AC\b', r'\b30[0-9]\s*AC\b',
    r'\bWar of the Five Kings\b', r'\bRed Wedding\b', r'\bPurple Wedding\b',
    r'\bBattle of (?:the )?Blackwater\b', r'\bBlackwater Rush\b',
    r'\bTourney of the Hand\b', r'\bKing in the North\b', r'\bQueen in the North\b',
    r'\bLady Stoneheart\b', r'\bYoung Griff\b', r'\bAegon VI\b',
    r'\bA Game of Thrones\b', r'\bA Clash of Kings\b', r'\bA Storm of Swords\b',
    r'\bA Feast for Crows\b', r'\bA Dance with Dragons\b', r'\bThe Winds of Winter\b',
    r'\bJoffrey(?: Baratheon)? (?:dies|died|poisoned|is poisoned|was poisoned|death)\b',
    r'\bEddard Stark(?: is| was)? (?:executed|beheaded|dies|died)\b',
    r'\bNed Stark(?: is| was)? (?:executed|beheaded|dies|died)\b',
    r'\bRobb Stark(?: is| was)? (?:killed|murdered|dies|died)\b',
    r'\bDaenerys.{0,240}\b(?:hatches|hatched|dragons|Unsullied|Meereen|Slaver)',
    r'\b(?:hatches|hatched|dragons|Unsullied|Meereen|Slaver).{0,240}\bDaenerys\b',
    r'\bthree new dragons were hatched\b',
    r'\bdragons were hatched by Daenerys\b',
    r'\bStannis.{0,160}\b(?:King|Blackwater|Wall|burn)',
    r'\bRenly.{0,160}\b(?:King|murder|shadow|dies|died|killed)',
    r'\bBalon Greyjoy.{0,160}\b(?:dies|died|death|killed|murdered|falls)',
    r'\bCersei.{0,160}\b(?:queen regent|walk of atonement|High Sparrow)',
]
FORBIDDEN_RE = re.compile('|'.join(f'(?:{p})' for p in FORBIDDEN_PATTERNS), re.I | re.S)

# Rows from generated turns/projections should not remain in a clean seed.
GENERATED_PREFIXES = (
    'event_turn_', 'event_narration_', 'event_command_', 'event_resolved_',
    'fact_turn_', 'fact_turn_summary_', 'proposal_turn_', 'proposal_turn_summary_',
    'patch_turn_', 'mem_turn_', 'mem_chapter_', 'mem_event_', 'chapter_narration_',
)

# Some post-cutoff event/source ids are known from the imported lorebook.
EXPLICIT_REMOVE_NAME_RE = re.compile(
    r'\b(War of the Five Kings|Red Wedding|Purple Wedding|Tourney of the Hand|Battle of the Blackwater|Battle of Blackwater)\b',
    re.I,
)

# For the lead-in arc only: hard-coded ordered safe history, no post-296 spoilers.
LEAD_IN_CHAPTERS = [
    ('chapter_pre296_01_deep_history', 1, 'Deep History: Dawn Age, First Men, and the Long Night',
     'Mythic prehistory frames Westeros as an old wound: Children of the Forest and giants, the coming of the First Men, the Pact, the Age of Heroes, the Long Night, and the founding memory of the Night\'s Watch. These are cultural foundations, not active spoilers.'),
    ('chapter_pre296_02_andals_rhoynar_valyria', 2, 'Migrations and Empires: Andals, Rhoynar, Old Ghis, and Valyria',
     'The Andal migrations transform southern Westeros; the Rhoynar shape Dorne; Old Ghis falls before young Valyria; the Valyrian Freehold rises through dragons, sorcery, roads, glyphs, and blood-bound imperial power.'),
    ('chapter_pre296_03_doom_and_free_cities', 3, 'After the Doom: Dragonstone, the Century of Blood, and the Free Cities',
     'The Doom destroys Valyria in 102 BC, leaving Dragonstone and House Targaryen as surviving dragonlord remnants. The Free Cities emerge from Valyrian colonies and refugees, with Braavos as the anti-slavery exception and Volantis as the proud First Daughter.'),
    ('chapter_pre296_04_aegons_conquest', 4, "Aegon's Conquest and the Forging of the Seven Kingdoms",
     'Aegon, Visenya, and Rhaenys conquer six kingdoms with Balerion, Vhagar, and Meraxes. The Iron Throne is forged; Dorne resists; the Targaryen dynasty becomes the realm\'s central political fact.'),
    ('chapter_pre296_05_early_targaryen_rule', 5, 'Early Targaryen Rule: Faith, Succession, and Consolidation',
     'Maegor, Jaehaerys, and later Targaryen rulers define royal authority, compromise with the Faith, build roads and institutions, and establish the long tension between dragonlord custom and Westerosi law.'),
    ('chapter_pre296_06_dance_and_aftermath', 6, 'The Dance of the Dragons and the Long Decline of Dragons',
     'The Dance of the Dragons tears the Targaryen house apart in 129–131 AC and begins the long decline of living dragons. Treat this as historical context, not a living timeline memory.'),
    ('chapter_pre296_07_dorne_blackfyres_and_rebellions', 7, 'Dorne, Blackfyres, and Rebellions of the Crown',
     'Dorne enters the realm through marriage rather than conquest. Blackfyre rebellions, Peake unrest, and court rivalries leave scars in noble memory, sellsword politics, and the Golden Company.'),
    ('chapter_pre296_08_summerhall_and_ninepenny_kings', 8, 'Summerhall, the Ninepenny Kings, and the Last Heroic Generation',
     'The Tragedy at Summerhall and the War of the Ninepenny Kings shape the generation that will later rule, rebel, or advise. This chapter stops at historical consequences known before 296 AC.'),
    ('chapter_pre296_09_aerys_rhaegar_and_roberts_rebellion', 9, "Aerys II, Rhaegar, Harrenhal, and Robert's Rebellion",
     'The last Targaryen reign collapses through paranoia, noble grievance, the Harrenhal mystery, and rebellion. Robert Baratheon takes the throne; surviving Targaryen children are exiled across the narrow sea. No later main-series outcomes are included.'),
    ('chapter_pre296_10_greyjoy_rebellion_and_roberts_peace', 10, "Greyjoy's Rebellion and Robert's Uneasy Peace",
     'Balon Greyjoy\'s rebellion is crushed in 289 AC. By the early 290s the realm appears stable, but debts, grudges, old loyalties, religious power, Free City politics, and dynastic secrets remain under the floorboards.'),
    ('chapter_pre296_11_essos_volantis_and_far_east', 11, 'Essos at the Cutoff: Volantis, Braavos, the Free Cities, and Yi Ti',
     'The narrow sea matters before the novels begin: Braavos holds banking power, Volantis guards Old Blood and slave wealth, the Free Cities speak Valyrian-descended tongues, and Yi Ti remains an ancient eastern civilization with its own gods, records, and imperial claims.'),
    ('chapter_pre296_12_opening_position_296_ac', 12, 'Opening Position: The World at the Edge of 296 AC',
     'The game state begins before main-series events. Robert sits the Iron Throne; the great houses hold their seats; old Targaryen, Blackfyre, Dornish, northern, ironborn, and Free City pressures exist as setup, not revealed future. The narrator must play forward from here.')
]

LEAD_ARC = {
    'id': 'arc_pre296_road_to_296_ac',
    'storyId': STORY_ID,
    'number': 1,
    'title': 'Road to 296 AC: Ordered Historical Lead-In',
    'summary': 'A single spoiler-safe historical arc that orders Westeros and Essos background from mythic prehistory through the opening position at the start of 296 AC. This replaces generated chapter/memory timelines and excludes post-cutoff main-series outcomes.',
    'chapterIds': [c[0] for c in LEAD_IN_CHAPTERS],
    'status': 'active',
    'metadata': {'source': 'pre296_cleanup', 'spoilerCutoff': CUTOFF, 'createdAt': NOW},
    'serverVersion': 1,
    'createdAt': NOW,
    'updatedAt': NOW,
}

def row_text(row):
    return json.dumps(row, ensure_ascii=False, sort_keys=True)

def has_forbidden(row):
    return bool(FORBIDDEN_RE.search(row_text(row)) or EXPLICIT_REMOVE_NAME_RE.search(str(row.get('name') or row.get('title') or '')))

def has_future_date(row):
    text = row_text(row)
    for m in re.finditer(r'\b(\d{3})\s*AC\b', text):
        if int(m.group(1)) >= 297:
            return True
    return False

def is_generated(row):
    rid = str(row.get('id') or '')
    return rid.startswith(GENERATED_PREFIXES) or str(row.get('type') or '').startswith('turn_') or 'turn_summary' in rid

def should_remove_row(row, table):
    rid = str(row.get('id') or '')
    if table in {'statePatches'}:
        return True, 'state patches removed from clean seed'
    if table == 'patchProposals' and (is_generated(row) or has_forbidden(row) or has_future_date(row)):
        return True, 'generated/spoiler patch proposal'
    if table == 'memoryNodes':
        if rid.startswith(('mem_event_', 'mem_chapter_', 'mem_turn_', 'memory_awoiaf_', 'memory_westeros_concordance_')):
            return True, 'timeline/enrichment memory removed; evidence remains in source entries/facts'
        if has_forbidden(row) or has_future_date(row) or is_generated(row):
            return True, 'spoiler/generated memory removed'
    if table in {'chapters', 'arcs'}:
        return True, 'replace generated timeline chapters/arcs with ordered pre-296 arc'
    if table == 'events':
        if str(row.get('type') or '') != 'imported_lore_event':
            return True, 'non-seed/generated event removed'
        if has_forbidden(row) or has_future_date(row):
            return True, 'post-296/spoiler event removed'
    if table in {'entries', 'entities', 'facts', 'threads', 'continuityWarnings'}:
        if has_forbidden(row) or has_future_date(row) or is_generated(row):
            return True, f'post-296/spoiler/generated {table} row removed'
    return False, ''

bundle = json.loads(IN.read_text(encoding='utf-8'))
wd = bundle['worldDatabase']
removed = defaultdict(list)
kept = {}

# First pass: filter content-heavy tables.
for table, rows in wd.items():
    if not isinstance(rows, list):
        kept[table] = rows
        continue
    new_rows = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        drop, reason = should_remove_row(row, table)
        if drop:
            removed[table].append({'id': row.get('id'), 'label': row.get('name') or row.get('title') or row.get('type'), 'reason': reason})
        else:
            new_rows.append(copy.deepcopy(row))
    kept[table] = new_rows

# Add new ordered pre-296 chapters and arc.
chapters = []
for cid, number, title, summary in LEAD_IN_CHAPTERS:
    chapters.append({
        'id': cid,
        'storyId': STORY_ID,
        'number': number,
        'title': title,
        'sceneOutcome': summary,
        'summary': summary,
        'startEntryId': None,
        'endEntryId': None,
        'metadata': {'source': 'pre296_cleanup', 'spoilerCutoff': CUTOFF, 'chapterRole': 'ordered_lore_lead_in'},
        'serverVersion': 1,
        'createdAt': NOW,
        'updatedAt': NOW,
    })
kept['chapters'] = chapters
kept['arcs'] = [LEAD_ARC]

# Safe seed memory only, not event timeline memory.
kept['memoryNodes'] = [m for m in kept.get('memoryNodes', []) if not (str(m.get('id','')).startswith('mem_'))]
kept['memoryNodes'].append({
    'id': 'memory_pre296_spoiler_boundary_policy',
    'storyId': STORY_ID,
    'type': 'seed_policy',
    'title': 'Pre-296 AC spoiler boundary',
    'content': 'Narration and retrieval for this seed must stop at the opening position of 296 AC. Do not use named post-cutoff civil wars, royal deaths, wedding disasters, major battles, dragon-return outcomes, or later book/show events unless the campaign reaches them organically.',
    'summary': 'Hard spoiler boundary: start of 296 AC. Generated memory timelines were removed; use the Road to 296 AC arc as ordered background only.',
    'keywords': ['pre-296', 'spoiler boundary', 'Road to 296 AC', 'seed policy'],
    'entityIds': [],
    'factionIds': [],
    'threadIds': ['thread_asoiaf_seed_review_and_refinement'],
    'locationId': None,
    'visibility': 'player_known',
    'importance': 1,
    'sourceEntryIds': [],
    'sourceEventIds': [],
    'sourcePatchIds': [],
    'embedding': None,
    'metadata': {'source': 'pre296_cleanup', 'createdAt': NOW},
    'serverVersion': 1,
    'createdAt': NOW,
    'updatedAt': NOW,
})

# Add policy source entry, fact, warning, and review proposal.
entries = kept.setdefault('entries', [])
entries.append({
    'id': 'entry_user_directive_pre296_spoiler_cleanup',
    'storyId': STORY_ID,
    'type': 'user_directive',
    'content': 'User directive: put ASOIAF/GOT lore in chronological order, create one big arc leading to 296 AC, and remove spoiler events/future chapters/arcs/memory timeline pollution from the seed database.',
    'position': max([int(e.get('position', 0) or 0) for e in entries] + [0]) + 1,
    'parentId': None,
    'branchId': None,
    'metadata': {'source': 'user_directive', 'receivedAt': NOW, 'spoilerCutoff': CUTOFF},
    'serverVersion': 1,
    'createdAt': NOW,
    'updatedAt': NOW,
})

facts = kept.setdefault('facts', [])
facts.append({
    'id': 'fact_pre296_spoiler_cutoff_policy',
    'storyId': STORY_ID,
    'type': 'canon_policy',
    'subjectEntityId': None,
    'targetEntityId': None,
    'title': 'Pre-296 AC spoiler cutoff policy',
    'statement': 'This seed is constrained to the opening position at the start of 296 AC. Post-cutoff main-series events and outcomes are not canonically available to the narrator until generated through play.',
    'confidence': 1,
    'status': 'active',
    'visibility': 'player_known',
    'firstSeenEntryId': 'entry_user_directive_pre296_spoiler_cleanup',
    'sourceEntryIds': ['entry_user_directive_pre296_spoiler_cleanup'],
    'sourceEventIds': [],
    'sourcePatchIds': [],
    'metadata': {'source': 'pre296_cleanup', 'createdAt': NOW},
    'serverVersion': 1,
    'createdAt': NOW,
    'updatedAt': NOW,
})

warnings = kept.setdefault('continuityWarnings', [])
# Remove obsolete "no boundary" warning if present.
warnings[:] = [w for w in warnings if 'no_spoiler_boundary' not in str(w.get('id','')).lower() and 'No campaign spoiler boundary' not in str(w.get('title',''))]
warnings.append({
    'id': 'warning_pre296_spoiler_boundary_enforced',
    'storyId': STORY_ID,
    'warningType': 'spoiler_boundary',
    'level': 'high',
    'title': 'Pre-296 AC spoiler boundary enforced',
    'status': 'open',
    'details': 'Future/post-cutoff events, generated memory timelines, and spoiler chapters/arcs were removed from the seed. Any later material must be introduced through play or reviewed patch proposals.',
    'entityIds': [],
    'factionIds': [],
    'threadIds': ['thread_asoiaf_seed_review_and_refinement'],
    'actorIds': [],
    'sourceEntryIds': ['entry_user_directive_pre296_spoiler_cleanup'],
    'sourceEventIds': [],
    'sourcePatchIds': [],
    'resolutionNotes': None,
    'resolvedBy': None,
    'resolvedAt': None,
    'metadata': {'source': 'pre296_cleanup', 'createdAt': NOW},
    'serverVersion': 1,
    'createdAt': NOW,
    'updatedAt': NOW,
})

proposals = kept.setdefault('patchProposals', [])
proposals.append({
    'id': 'proposal_review_post296_material_later',
    'storyId': STORY_ID,
    'status': 'pending',
    'title': 'Review post-296 material only when campaign reaches it',
    'summary': 'Post-cutoff lore removed by cleanup should not be reintroduced blindly. Re-add only as play reaches the relevant dates or as hidden GM-only proposals after explicit review.',
    'proposedBy': 'pre296_cleanup',
    'sourceEntryIds': ['entry_user_directive_pre296_spoiler_cleanup'],
    'metadata': {'spoilerCutoff': CUTOFF, 'createdAt': NOW},
    'serverVersion': 1,
    'createdAt': NOW,
    'updatedAt': NOW,
})

# Story policy/header cleanup.
story = copy.deepcopy(wd['story'])
story['id'] = STORY_ID
settings = story.setdefault('settings', {})
settings.update({
    'spoilerBoundary': CUTOFF,
    'spoilerCutoff': '296 AC',
    'seedStage': 'pre296_ordered_foundation',
    'canonPolicy': 'Pre-296 AC seed. Imported lore is evidence-backed but reviewable; post-296 main-series events/outcomes are removed and must not be used unless created through play.',
    'timelinePolicy': 'Use arcs/chapters for ordered historical lead-in. Do not use memoryNodes as a future-event timeline.',
})
story['description'] = 'Pre-296 AC ASOIAF/Game of Thrones lore seed. The database is ordered as a Road to 296 AC arc and excludes post-cutoff main-series spoiler events/outcomes from active lore, chapters, arcs, memories, and facts.'
story['headerPrompt'] = (
    'Use this world as a dangerous, politically dense ASOIAF-style canon substrate at the opening position of 296 AC. '
    'Hard rule: do not narrate, retrieve, imply, or rely on post-cutoff main-series conflicts, royal deaths, wedding disasters, major battles, or dragon-return outcomes unless they arise organically in play. '
    'Use the Road to 296 AC arc as ordered background; memories are not a timeline of future events. Treat imported lore as evidence-backed but reviewable.'
)
story.setdefault('metadata', {})['pre296CleanupAt'] = NOW
story['updatedAt'] = NOW
kept['story'] = story

# Reference integrity cleanup helpers.
entry_ids = {e['id'] for e in kept.get('entries', []) if isinstance(e, dict) and e.get('id')}
entity_ids = {e['id'] for e in kept.get('entities', []) if isinstance(e, dict) and e.get('id')}
event_ids = {e['id'] for e in kept.get('events', []) if isinstance(e, dict) and e.get('id')}
faction_ids = {f['id'] for f in kept.get('factions', []) if isinstance(f, dict) and f.get('id')}
patch_ids = {p['id'] for p in kept.get('statePatches', []) if isinstance(p, dict) and p.get('id')}
thread_ids = {t['id'] for t in kept.get('threads', []) if isinstance(t, dict) and t.get('id')}

def filter_ids(seq, allowed):
    if not isinstance(seq, list):
        return []
    return [x for x in seq if x in allowed]

def scrub_refs(row):
    if not isinstance(row, dict):
        return row
    if 'sourceEntryIds' in row:
        row['sourceEntryIds'] = filter_ids(row.get('sourceEntryIds'), entry_ids)
    if 'sourceEventIds' in row:
        row['sourceEventIds'] = filter_ids(row.get('sourceEventIds'), event_ids)
    if 'sourcePatchIds' in row:
        row['sourcePatchIds'] = filter_ids(row.get('sourcePatchIds'), patch_ids)
    if 'threadIds' in row:
        row['threadIds'] = filter_ids(row.get('threadIds'), thread_ids)
    if 'entityIds' in row:
        row['entityIds'] = filter_ids(row.get('entityIds'), entity_ids)
    if 'actorEntityIds' in row:
        row['actorEntityIds'] = filter_ids(row.get('actorEntityIds'), entity_ids)
    if 'targetEntityIds' in row:
        row['targetEntityIds'] = filter_ids(row.get('targetEntityIds'), entity_ids)
    if 'factionIds' in row:
        row['factionIds'] = filter_ids(row.get('factionIds'), faction_ids)
    if row.get('subjectEntityId') and row.get('subjectEntityId') not in entity_ids:
        row['subjectEntityId'] = None
    if row.get('targetEntityId') and row.get('targetEntityId') not in entity_ids:
        row['targetEntityId'] = None
    if row.get('firstSeenEntryId') and row.get('firstSeenEntryId') not in entry_ids:
        row['firstSeenEntryId'] = None
    if row.get('locationId') and row.get('locationId') not in entity_ids:
        row['locationId'] = None
    # JSON state nested references.
    state = row.get('state')
    if isinstance(state, dict):
        if isinstance(state.get('knownMembers'), list):
            state['knownMembers'] = filter_ids(state['knownMembers'], entity_ids)
        if isinstance(state.get('presentCharacters'), list):
            state['presentCharacters'] = filter_ids(state['presentCharacters'], entity_ids)
        if isinstance(state.get('presentItems'), list):
            state['presentItems'] = filter_ids(state['presentItems'], entity_ids)
    return row

for table, rows in kept.items():
    if isinstance(rows, list):
        kept[table] = [scrub_refs(r) for r in rows]

# Drop relation tables with missing FK-like refs.
def keep_fk(row, checks):
    return all(row.get(k) in allowed for k, allowed in checks)

# Factions depend on entities; all faction satellite tables then depend on the surviving factions.
if 'factions' in kept:
    before = len(kept['factions'])
    kept['factions'] = [r for r in kept['factions'] if keep_fk(r, [('entityId', entity_ids)])]
    if before - len(kept['factions']):
        removed['factions'].append({'id': '*fk_cleanup*', 'label': str(before - len(kept['factions'])), 'reason': 'removed factions whose backing entity was pruned'})
faction_ids = {f['id'] for f in kept.get('factions', []) if isinstance(f, dict) and f.get('id')}

fk_specs = {
    'entityAliases': [('entityId', entity_ids)],
    'relationships': [('fromEntityId', entity_ids), ('toEntityId', entity_ids)],
    'factionMemberships': [('factionId', faction_ids), ('entityId', entity_ids)],
    'factionResources': [('factionId', faction_ids)],
    'factionGoals': [('factionId', faction_ids)],
    'factionProjects': [('factionId', faction_ids)],
    'npcBeliefs': [('npcEntityId', entity_ids)],
    'npcEventLinks': [('eventId', event_ids), ('npcEntityId', entity_ids)],
}
for table, specs in fk_specs.items():
    if table in kept:
        before = len(kept[table])
        kept[table] = [r for r in kept[table] if keep_fk(r, specs)]
        if before - len(kept[table]):
            removed[table].append({'id': '*fk_cleanup*', 'label': str(before - len(kept[table])), 'reason': 'removed rows with references to pruned entities/events/factions'})

# Drop sourceRefs whose targets/sources point to removed rows where target is one of the core tables.
def source_ref_valid(r):
    target = r.get('targetTable')
    target_id = r.get('targetRecordId')
    if target in {'entities', 'characters', 'locations', 'items'} and target_id not in entity_ids:
        return False
    if target in {'events', 'story_events'} and target_id not in event_ids:
        return False
    if target in {'story_entries', 'entries', 'transcript'} and target_id not in entry_ids:
        return False
    if target in {'facts'} and target_id not in {f.get('id') for f in kept.get('facts', [])}:
        return False
    return True
if 'sourceRefs' in kept:
    before = len(kept['sourceRefs'])
    kept['sourceRefs'] = [r for r in kept['sourceRefs'] if source_ref_valid(r) and not has_forbidden(r) and not has_future_date(r)]
    if before - len(kept['sourceRefs']):
        removed['sourceRefs'].append({'id': '*source_ref_cleanup*', 'label': str(before - len(kept['sourceRefs'])), 'reason': 'removed refs to pruned/spoiler rows'})

# Recompute story source entry count.
kept['story']['settings']['sourceEntryCountActivePre296'] = len([e for e in kept.get('entries', []) if e.get('type') in {'source_lorebook_entry', 'source_awoiaf_page', 'source_westeros_concordance_page'}])

# Final validation and spoiler scan.
errors = []
for table, rows in kept.items():
    if isinstance(rows, list):
        ids = [r.get('id') for r in rows if isinstance(r, dict) and r.get('id')]
        dup = [x for x, c in Counter(ids).items() if c > 1]
        if dup:
            errors.append(f'duplicate ids in {table}: {dup[:10]}')
        for r in rows:
            if isinstance(r, dict) and r.get('storyId') not in (None, STORY_ID):
                errors.append(f'{table}/{r.get("id")} wrong storyId {r.get("storyId")}')
# Refresh IDs after fk cleanup.
entry_ids = {e['id'] for e in kept.get('entries', []) if isinstance(e, dict) and e.get('id')}
entity_ids = {e['id'] for e in kept.get('entities', []) if isinstance(e, dict) and e.get('id')}
event_ids = {e['id'] for e in kept.get('events', []) if isinstance(e, dict) and e.get('id')}
for row in kept.get('entityAliases', []):
    if row.get('entityId') not in entity_ids:
        errors.append(f'alias {row.get("id")} missing entity {row.get("entityId")}')
for row in kept.get('facts', []):
    if row.get('subjectEntityId') and row.get('subjectEntityId') not in entity_ids:
        errors.append(f'fact {row.get("id")} missing subject {row.get("subjectEntityId")}')
    for sid in row.get('sourceEntryIds', []):
        if sid not in entry_ids:
            errors.append(f'fact {row.get("id")} missing source entry {sid}')
for row in kept.get('events', []):
    for sid in row.get('sourceEntryIds', []):
        if sid not in entry_ids:
            errors.append(f'event {row.get("id")} missing source entry {sid}')

# Spoiler residual scan on active tables. Some historical names may remain; this scan is for explicit forbidden outcomes.
residual = []
for table in ['entries','entities','events','facts','memoryNodes','chapters','arcs','patchProposals','continuityWarnings']:
    for r in kept.get(table, []):
        m = FORBIDDEN_RE.search(row_text(r))
        if m:
            residual.append({'table': table, 'id': r.get('id'), 'match': m.group(0)[:160]})
        elif has_future_date(r):
            residual.append({'table': table, 'id': r.get('id'), 'match': 'future date >=297 AC'})

bundle['worldDatabase'] = kept
bundle['story'] = kept['story']
bundle['exportedAt'] = NOW
bundle['source'] = 'pre296_spoiler_cleaned_seed'
if 'storyEntries' in bundle:
    bundle['storyEntries'] = kept.get('entries', [])
if isinstance(bundle.get('backendCanon'), dict):
    for k, v in kept.items():
        if isinstance(v, list):
            bundle['backendCanon'][k] = v

counts = {k: len(v) for k, v in kept.items() if isinstance(v, list)}
report = {
    'valid': not errors and not residual,
    'errors': errors[:200],
    'residualSpoilerMatches': residual[:200],
    'cutoff': CUTOFF,
    'removedCounts': {k: len(v) for k, v in removed.items()},
    'removedSamples': {k: v[:25] for k, v in removed.items()},
    'counts': counts,
    'outputs': {'bundle': str(OUT), 'report': str(REPORT)},
    'updatedAt': NOW,
}
OUT.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding='utf-8')
REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
json.loads(OUT.read_text(encoding='utf-8'))
json.loads(REPORT.read_text(encoding='utf-8'))
print(json.dumps({'valid': report['valid'], 'errors': len(errors), 'residualSpoilerMatches': len(residual), 'counts': counts, 'removedCounts': report['removedCounts'], 'output': str(OUT)}, indent=2))
