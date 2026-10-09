import { containsSceneActorMention } from '$lib/services/ai/context/sceneActorMention';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
}

/** Read compatibility only: never migrate or overwrite canonical records on read. */
export function characterStateView(value: unknown, metadata: unknown = {}): Record<string, unknown> {
	const state = { ...record(metadata), ...record(value) };
	const text = (...values: unknown[]) => values.find((v): v is string => typeof v === 'string' && !!v.trim());
	const memory = record(state.eventMemory ?? state.npcEventMemory);
	return {
		...state,
		bio: text(state.bio, state.background),
		personality: text(state.personality, [...strings(state.traits), ...strings(state.personalityDescriptors)].join('; ')),
		speechStyle: text(state.speechStyle, state.speech_style, state.voice),
		motivations: [...new Set([...strings(state.motivations), ...strings(state.goals)])],
		// Past knowledge and observed events are not necessarily current beliefs.
		knownFacts: [...new Set([...strings(state.knownFacts), ...strings(memory.knows)])],
	};
}

export interface CharacterContextRecord {
	id: string;
	name: string;
	state?: unknown;
	metadata?: unknown;
	aliases?: string[];
}

/** An explicit editor clear also clears the legacy values displayed in that field. */
export function editCharacterState(value: unknown, key: string, nextValue: unknown): Record<string, unknown> {
	const next = { ...record(value), [key]: nextValue };
	if (key === 'nextOpportunity') delete next.nextOpportunityRecordedAt;
	const fallbacks: Record<string, string[]> = { bio: ['background'], personality: ['traits', 'personalityDescriptors'], speechStyle: ['voice', 'speech_style'] };
	// These fields display a union with legacy lists. An edit replaces that whole
	// displayed list, including removals, while leaving other history intact.
	if (key === 'motivations') next.goals = [];
	if (key === 'knownFacts') {
		for (const memoryKey of ['eventMemory', 'npcEventMemory']) {
			if (next[memoryKey] && typeof next[memoryKey] === 'object' && !Array.isArray(next[memoryKey])) {
				next[memoryKey] = { ...record(next[memoryKey]), knows: [] };
			}
		}
	}
	if (nextValue === null || nextValue === '') {
		for (const alias of fallbacks[key] ?? []) next[alias] = Array.isArray(next[alias]) ? [] : null;
	}
	return next;
}

export function characterAliases(character: CharacterContextRecord): string[] {
	const state = record(character.state);
	const metadata = record(character.metadata);
	return [...new Set([...(character.aliases ?? []), ...strings(state.aliases), ...strings(metadata.aliases), ...strings(metadata.localAliases)])];
}

/** Relevance is selection, not an assertion that a mentioned person is present. */
export function selectRelevantCharacters<T extends CharacterContextRecord>(characters: T[], scene: string[], limit = 32, linkedIds: string[] = [], positiveOnly = false): T[] {
	const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
	const names = characters.map(c => [...new Set([c.name, ...characterAliases(c)].map(normalize).filter(Boolean))]);
	const owners = new Map<string, Set<string>>();
	for (const [i, c] of characters.entries()) {
		for (const token of names[i].flatMap(name => name.split(' ')).filter(token => token.length >= 4)) {
			const ids = owners.get(token) ?? new Set<string>();
			ids.add(c.id);
			owners.set(token, ids);
		}
	}
	const excerpts = scene.slice(-8);
	const linked = new Set(linkedIds);
	return characters.map((character, i) => {
		const state = record(character.state);
		const self = state.isProtagonist === true || ['self', 'player_character'].includes(String(record(state.relationship).status)) || character.name.toLowerCase() === 'player';
		const terms = [...names[i], ...names[i].flatMap(name => name.split(' ')).filter(token => owners.get(token)?.size === 1)];
		let score = self ? 1000 : 0;
		if (linked.has(character.id)) score += 60;
		if (state.isPresent === true || state.present === true) score += 30;
		for (const [j, text] of excerpts.entries()) {
			if (terms.some(term => (` ${normalize(text)} `).includes(` ${term} `))) score += (j + 1) * 10;
			if (terms.some(term => containsSceneActorMention(text, term))) score += (j + 1) * 20;
		}
		return { character, score, i };
	}).filter(row => !positiveOnly || row.score > 0).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, limit).map(row => row.character);
}
