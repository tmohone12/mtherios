const UNKNOWN = 'not established in the source yet';

export const MTHERIOS_SUMMARY_FORMAT = `[BEGINNING= brief overview of the initial scenario at the beginning of the chat history. If there already is one present, use it unchanged.]
[RECENT=
- brief bullet point summary of relevant events that have not been mentioned in BEGINNING.
]
[{{char}} =
- Appearance: current clothing, visible state, wounds, carried items, or notable condition not already in their character description.
- Demeanor: current demeanor, posture, mood, pressure, or social mask.
]
[{{user}} =
- Appearance: current clothing, visible state, wounds, carried items, or notable condition.
]
[Side Characters=
- brief overview of characters currently present, recently active, or relevant-but-absent.
]
[IMPORTANT STRINGS=
- Setting rules that remain true regardless of scene.
- Possible threats, unresolved threads, promises, debts, objects with significance, secrets, and continuity details that remain relevant.
]
[CURRENTLY — day, date | time | location | weather, temp°C] concise current scene anchor`;

export function buildMtheriosSummaryInstruction(scope: 'chapter' | 'arc' | 'saga' | 'memory' = 'memory'): string {
	return [
		`MTHERIOS ${scope.toUpperCase()} SUMMARY FORMAT: The JSON "summary" field must be one clean string using this bracketed structure exactly.`,
		MTHERIOS_SUMMARY_FORMAT,
		'Rules:',
		'- Preserve an existing BEGINNING block unchanged if the source already has one.',
		'- Put new developments in RECENT as short bullets, not a wall of prose.',
		'- Use {{char}} for the active focal NPC/GM-side cast when no single NPC is obvious; do not replace the literal tag.',
		'- Use {{user}} literally for the player character; never summarize their thoughts or decisions beyond observable actions and consequences.',
		'- Prefer concrete canon: names, places, debts, injuries, reputation, known secrets, object ownership, and unresolved threats.',
		'- Use "not established" rather than inventing clothing, weather, temperature, or exact dates.',
		'- Keep the whole summary coherent and scannable; avoid duplicate facts and raw transcript dumps.',
	].join('\n');
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

export function formatMtheriosMemorySummary(input: {
	beginning?: string | null;
	recent?: string[];
	charAppearance?: string | null;
	charDemeanor?: string | null;
	userAppearance?: string | null;
	sideCharacters?: string[];
	importantStrings?: string[];
	currently?: string | null;
}): string {
	return [
		`[BEGINNING= ${clean(input.beginning, 'not established; no prior beginning summary was found.')}]`,
		`[RECENT=\n${bulletLines(input.recent ?? [], 'No new events were established in this summary window.')}\n]`,
		`[{{char}} =\n- Appearance: ${clean(input.charAppearance)}\n- Demeanor: ${clean(input.charDemeanor)}\n]`,
		`[{{user}} =\n- Appearance: ${clean(input.userAppearance)}\n]`,
		`[Side Characters=\n${bulletLines(input.sideCharacters ?? [], 'No side characters are currently established as present or relevant.')}\n]`,
		`[IMPORTANT STRINGS=\n${bulletLines(input.importantStrings ?? [], 'No durable threats, promises, objects, or setting rules were established in this window.')}\n]`,
		`[CURRENTLY — ${clean(input.currently, 'day unknown, date unknown | time unknown | location unknown | weather unknown, temp°C unknown')}]`,
	].join('\n\n');
}
