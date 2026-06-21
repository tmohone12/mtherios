const UNKNOWN = 'not established in the source yet';

export interface MtheriosCharacterState {
	name?: string | null;
	entityId?: string | null;
	bullets?: string[];
}

export interface MtheriosMemorySummaryInput {
	checkpoint?: string | null;
	sourceCoverage?: string[];
	currentScene?: string | null;
	recentStoryState?: string[];
	characterStates?: MtheriosCharacterState[];
	activeThreads?: string[];
	toneToContinue?: string | null;

	// Legacy summary fields. Kept so older call sites are upgraded into the
	// continuity format instead of producing the old machine-checkpoint shape.
	beginning?: string | null;
	recent?: string[];
	charAppearance?: string | null;
	charDemeanor?: string | null;
	userAppearance?: string | null;
	sideCharacters?: string[];
	importantStrings?: string[];
	currently?: string | null;
}

export const MTHERIOS_SUMMARY_FORMAT = `[CHECKPOINT = concise checkpoint label for this memory layer, not the main story summary.]
[SOURCE COVERAGE =
- transcript/source range, source event count, and any freshness note needed for audit.
]
[CURRENT SCENE = date/time | place | weather/conditions, if established.]
[RECENT STORY STATE =
- coherent chapter-synopsis memory of what happened, what changed, and what context a future narrator must keep.
- use complete, concrete story-memory sentences instead of raw transcript dumps.
- for chapter summaries, end this section with "Time passed in this chapter: ...".
]
[CHARACTER STATE =
Character Name [entity_id]:
- current status, pressure, relationship posture, knowledge, wounds, possessions, secrets, or unresolved intent.
- include relevant absent characters too, especially when a POV switch may need them.
]
[ACTIVE THREADS =
- unresolved promises, dangers, questions, debts, political pressures, objects, secrets, or relationship tensions.
]
[TONE TO CONTINUE = short tone and pressure note for the next scene.]`;

export function buildMtheriosSummaryInstruction(scope: 'chapter' | 'arc' | 'saga' | 'memory' = 'memory'): string {
	return [
		`MTHERIOS ${scope.toUpperCase()} SUMMARY FORMAT: The JSON "summary" field must be one clean string using this bracketed continuity-memory structure exactly.`,
		MTHERIOS_SUMMARY_FORMAT,
		'Rules:',
		'- The memory system is the spine of continuity. Write a useful record of what happened, not a process log.',
		'- SOURCE COVERAGE is audit metadata only; keep machine details out of RECENT STORY STATE.',
		'- RECENT STORY STATE should read like a clear chapter synopsis in past tense, preserving causal context: exile wounds, promises, family pressure, political danger, relationship changes, and consequences.',
		'- For chapter summaries, include a final sentence in RECENT STORY STATE using this exact label: "Time passed in this chapter: ...". Infer it from timestamps when possible; otherwise say "not established".',
		'- For arc summaries, synthesize the covered chapter summaries into a readable arc synopsis instead of listing clipped checkpoint fragments.',
		'- CHARACTER STATE is mandatory for important present, recently active, or relevant absent characters.',
		'- Use the label form "Character Name [entity_id]" whenever an entity id is available. If no id is available, use "Character Name [unknown_entity]".',
		'- Preserve entity ids exactly as provided so POV switches, character resolvers, and canon repair can track identity without duplicating characters.',
		'- Do not create new character canon. Mention unverified names as story evidence only until a human approves or creates them.',
		'- Track who knows what. Separate public facts, narrator-known truths, NPC beliefs, and player-visible knowledge when the source makes that distinction.',
		'- Prefer concrete canon: names, places, debts, injuries, reputation, known secrets, object ownership, and unresolved threats.',
		'- Use "not established" rather than inventing clothing, weather, temperature, dates, motives, or private thoughts.',
		'- Keep the whole summary coherent and scannable; avoid duplicate facts, raw transcript dumps, and bookkeeping language.',
	].join('\n');
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SUMMARY_SECTION_LABEL_PATTERN = [
	'CHECKPOINT',
	'SOURCE COVERAGE',
	'CURRENT SCENE',
	'RECENT STORY STATE',
	'CHARACTER STATE',
	'ACTIVE THREADS',
	'TONE TO CONTINUE',
	'BEGINNING',
	'RECENT',
	'CURRENTLY',
	'\\{\\{char\\}\\}',
].join('|');

export function extractMtheriosSummarySection(summary: string | null | undefined, label: string): string {
	const text = (summary ?? '').trim();
	if (!text) return '';
	const start = new RegExp(`\\[${escapeRegExp(label)}\\s*=\\s*\\n?`, 'i').exec(text);
	if (!start) return '';
	const bodyStart = start.index + start[0].length;
	const rest = text.slice(bodyStart);
	const nextSection = rest.search(new RegExp(`(?:\\n|\\s)\\s*\\[(?:${SUMMARY_SECTION_LABEL_PATTERN})\\s*=`, 'i'));
	const body = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
	return body.replace(/\]\s*$/u, '').trim();
}

function sectionSentinel(value: string): boolean {
	return /^No (?:new events|character-specific state|durable threats)/i.test(value)
		|| /^not established$/i.test(value);
}

function sectionToInline(section: string): string {
	const lines = section
		.split(/\r?\n/)
		.map((line) => cleanBullet(line))
		.filter((line) => line && !sectionSentinel(line));
	return clean(lines.join(' '), '');
}

function stripLegacyMemoryNoise(summary: string): string {
	return clean(summary
		.replace(/\[SOURCE COVERAGE\s*=\s*[\s\S]*?\n\]/gi, ' ')
		.replace(/\[CHECKPOINT\s*=\s*[^\]]*\]/gi, ' ')
		.replace(/\[BEGINNING\s*=\s*[^\]]*\]/gi, ' ')
		.replace(/\[(?:SOURCE COVERAGE|CHECKPOINT|RECENT STORY STATE|CHARACTER STATE|ACTIVE THREADS|CURRENT SCENE|RECENT|CURRENTLY)\s*=\s*/gi, ' ')
		.replace(/\[TONE TO CONTINUE\s*=\s*/gi, 'Tone: ')
		.replace(/\[\{\{char\}\}\s*=\s*[\s\S]*?\n\]/gi, ' ')
		.replace(/\b\d+\s+more transcript entries are covered by this checkpoint\./gi, ' ')
		.replace(/\n\]/g, ' '), '');
}

export function summarizeMtheriosMemoryForRollup(summary: string | null | undefined): string {
	const raw = summary ?? '';
	const story = sectionToInline(extractMtheriosSummarySection(raw, 'RECENT STORY STATE'));
	const characters = sectionToInline(extractMtheriosSummarySection(raw, 'CHARACTER STATE'));
	const threads = sectionToInline(extractMtheriosSummarySection(raw, 'ACTIVE THREADS'));
	const parts = [
		story,
		characters ? `Characters: ${characters}` : '',
		threads ? `Open threads: ${threads}` : '',
	].filter(Boolean);
	return parts.length ? clean(parts.join(' '), '') : stripLegacyMemoryNoise(raw);
}

function clean(value: string | null | undefined, fallback = UNKNOWN): string {
	const text = (value ?? '').replace(/\s+/g, ' ').trim();
	return text || fallback;
}

function cleanBullet(value: string): string {
	let text = clean(value, '');
	while (/^[-*]\s+/.test(text)) {
		text = text.replace(/^[-*]\s+/, '').trim();
	}
	return text;
}

function bulletLines(values: string[], fallback: string): string {
	const lines = values.map(cleanBullet).filter(Boolean);
	return (lines.length ? lines : [fallback]).map((value) => `- ${value}`).join('\n');
}

function legacyCharacterStates(input: MtheriosMemorySummaryInput): MtheriosCharacterState[] {
	const states: MtheriosCharacterState[] = [];
	const charBullets = [
		input.charAppearance ? `Appearance: ${input.charAppearance}` : '',
		input.charDemeanor ? `Demeanor: ${input.charDemeanor}` : '',
	].filter(Boolean);
	if (charBullets.length > 0) {
		states.push({ name: 'Focal NPC or narrator-side cast', entityId: 'unknown_entity', bullets: charBullets });
	}
	if (input.userAppearance) {
		states.push({ name: 'Player character', entityId: 'unknown_entity', bullets: [`Appearance: ${input.userAppearance}`] });
	}
	for (const sideCharacter of input.sideCharacters ?? []) {
		states.push({ name: sideCharacter, entityId: sideCharacter, bullets: ['Relevant in this memory window.'] });
	}
	return states;
}

function characterStateLines(input: MtheriosMemorySummaryInput): string {
	const states = (input.characterStates?.length ? input.characterStates : legacyCharacterStates(input))
		.map((state) => ({
			name: clean(state.name, 'Unknown character'),
			entityId: clean(state.entityId, 'unknown_entity'),
			bullets: (state.bullets ?? []).map(cleanBullet).filter(Boolean),
		}));

	if (states.length === 0) return '- No character-specific state was established in this memory window.';

	return states
		.map((state) => [
			`${state.name} [${state.entityId}]:`,
			bulletLines(state.bullets, 'Relevant to continuity; no finer character state was established.'),
		].join('\n'))
		.join('\n\n');
}

export function formatMtheriosMemorySummary(input: MtheriosMemorySummaryInput): string {
	const checkpoint = input.checkpoint ?? input.beginning;
	const sourceCoverage = input.sourceCoverage ?? [];
	const currentScene = input.currentScene ?? input.currently;
	const recentStoryState = input.recentStoryState ?? input.recent ?? [];
	const activeThreads = input.activeThreads ?? input.importantStrings ?? [];

	return [
		`[CHECKPOINT = ${clean(checkpoint, 'Continuity checkpoint for the covered story window.')}]`,
		`[SOURCE COVERAGE =\n${bulletLines(sourceCoverage, 'No source coverage metadata was recorded.')}\n]`,
		`[CURRENT SCENE = ${clean(currentScene, 'date/time unknown | location unknown | weather or conditions unknown')}]`,
		`[RECENT STORY STATE =\n${bulletLines(recentStoryState, 'No new events were established in this memory window.')}\n]`,
		`[CHARACTER STATE =\n${characterStateLines(input)}\n]`,
		`[ACTIVE THREADS =\n${bulletLines(activeThreads, 'No durable threats, promises, objects, or setting rules were established in this window.')}\n]`,
		`[TONE TO CONTINUE = ${clean(input.toneToContinue, 'Continue from the established scene pressure, character choices, and unresolved consequences.')}]`,
	].join('\n\n');
}
