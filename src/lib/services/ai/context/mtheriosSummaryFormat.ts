import { isNarrativeCommandInput, isNarrativeControlInput } from './controlInput';

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
	recentStoryNarrative?: string | null;
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

export function replaceMtheriosStoryNarrative(summary: string, narrative: string): string {
	const text = summary.trim();
	const start = new RegExp('\\[RECENT STORY STATE\\s*=\\s*\\n?', 'i').exec(text);
	if (!start) return formatMtheriosMemorySummary({ recentStoryNarrative: narrative });
	const bodyStart = start.index + start[0].length;
	const rest = text.slice(bodyStart);
	const next = rest.search(new RegExp('(?:\\n|\\s)\\s*\\[(?:CHARACTER STATE|ACTIVE THREADS|TONE TO CONTINUE)\\s*=', 'i'));
	if (next < 0) return `${text.slice(0, bodyStart)}${narrative.trim()}\n]`;
	return `${text.slice(0, bodyStart)}${narrative.trim()}\n\n${rest.slice(next).trimStart()}`;
}

function oocControlLine(value: string): boolean {
	const text = value.trim().replace(/^(?:opening|middle|ending|recent|current)\s*:\s*/i, '');
	return isNarrativeControlInput(text) || isNarrativeCommandInput(text);
}

function sectionToSynopsis(section: string): string {
	return section
		.split(/\r?\n/)
		.map((line) => cleanBullet(line))
		.filter((line) => line && !sectionSentinel(line) && !oocControlLine(line))
		.join(' ');
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
	const storySection = extractMtheriosSummarySection(raw, 'RECENT STORY STATE');
	const story = sectionToSynopsis(storySection || [
		extractMtheriosSummarySection(raw, 'BEGINNING'),
		extractMtheriosSummarySection(raw, 'RECENT'),
	].filter(Boolean).join('\n'));
	const scene = sectionToSynopsis(extractMtheriosSummarySection(raw, 'CURRENT SCENE') || extractMtheriosSummarySection(raw, 'CURRENTLY'));
	const characters = sectionToSynopsis(extractMtheriosSummarySection(raw, 'CHARACTER STATE') || extractMtheriosSummarySection(raw, '{{char}}'));
	const threads = sectionToSynopsis(extractMtheriosSummarySection(raw, 'ACTIVE THREADS'));
	// Budget whole records at the caller. Sampling here permanently removes
	// source facts before either rollup generation or retrieval can use them.
	return [
		story,
		scene ? `Scene at this checkpoint: ${scene}` : '',
		characters ? `Characters: ${characters}` : '',
		threads ? `Threads at this checkpoint: ${threads}` : '',
	].filter(Boolean).join(' ') || stripLegacyMemoryNoise(raw);
}

export function summarizeMtheriosMemoryForContext(summary: string | null | undefined): string {
	return summarizeMtheriosMemoryForRollup(summary);
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
	const recentStoryNarrative = clean(input.recentStoryNarrative, '');
	const activeThreads = input.activeThreads ?? input.importantStrings ?? [];

	return [
		`[CHECKPOINT = ${clean(checkpoint, 'Continuity checkpoint for the covered story window.')}]`,
		`[SOURCE COVERAGE =\n${bulletLines(sourceCoverage, 'No source coverage metadata was recorded.')}\n]`,
		`[CURRENT SCENE = ${clean(currentScene, 'date/time unknown | location unknown | weather or conditions unknown')}]`,
		`[RECENT STORY STATE =\n${recentStoryNarrative || bulletLines(recentStoryState, 'No new events were established in this memory window.')}\n]`,
		`[CHARACTER STATE =\n${characterStateLines(input)}\n]`,
		`[ACTIVE THREADS =\n${bulletLines(activeThreads, 'No durable threats, promises, objects, or setting rules were established in this window.')}\n]`,
		`[TONE TO CONTINUE = ${clean(input.toneToContinue, 'Continue from the established scene pressure, character choices, and unresolved consequences.')}]`,
	].join('\n\n');
}
