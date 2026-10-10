import { characterStateView } from '$lib/utils/characterState';
import { durableCharacterEventMemoryList, durableCharacterKnownFactList } from './characterEventMemory';

/**
 * Character contract v1 and its context builder. Legacy state/metadata aliases are normalized
 * by explicit adapters that record where each value came from; stored records are never
 * rewritten. Knowledge stays in separate buckets: actor-known facts and memories are distinct
 * from GM-only links, and beliefs (npc_beliefs) are supplied separately by callers.
 */

export const CHARACTER_CONTRACT_VERSION = 1;

export type CharacterCardTier = 'addressed' | 'scene';
/** narrator: GM view, may include GM-only links. actor: what the character itself knows. */
export type CharacterCardView = 'narrator' | 'actor';

export interface CharacterCardV1 {
	contractVersion: 1;
	entityId: string;
	name: string;
	aliases: string[];
	identity: { description: string; biography: string; appearance: string; presentation: string; culture: string };
	personality: { summary: string; descriptors: string[]; motives: string[]; goals: string[] };
	voice: { guidance: string; mannerisms: string[]; examples: string[] };
	/** Current scene state, including the relationship to the player. */
	scene: string[];
	/** Relationship history reasons, newest first. */
	relationshipHistory: string[];
	affiliations: string[];
	knowledge: {
		/** Facts the character holds (state.knownFacts), oldest first. */
		knownFacts: string[];
		/** The character's own event memory, newest first within each kind. */
		memories: Array<{ kind: 'did' | 'saw' | 'knew' | 'knows'; text: string }>;
		/** GM timeline links: narrator context, never part of the actor view. */
		gmLinks: Array<{ text: string; secret: boolean }>;
	};
	/** Card field -> the stored key it was read from. */
	provenance: Record<string, string>;
}

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [];
const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];
const whitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Transient status ("currently travelling") is scene state, not identity. */
export function durableIdentityText(value: string): string {
	return value
		.split(/(?<=[.!?])\s+|;\s+/)
		.map((part) => part.trim())
		.filter(Boolean)
		.filter((part) => !/\b(?:currently|at present|right now|today|tonight|tomorrow|recently|en route|on (?:his|her|their) way|sail(?:s|ing)? (?:toward|to|for)|travell?ing (?:toward|to|for)|head(?:s|ed|ing)? (?:toward|to|for)|unattached|(?:is|remains) (?:politically )?(?:single|betrothed|engaged|married))\b/i.test(part))
		.join('; ');
}

/** First non-empty value among aliases, recording which stored key supplied it. */
function pick(provenance: Record<string, string>, field: string, sources: Array<[string, unknown]>): string {
	for (const [key, value] of sources) {
		const text = typeof value === 'string' ? whitespace(value) : Array.isArray(value) ? strings(value).join('; ') : '';
		if (text) { provenance[field] = key; return text; }
	}
	return '';
}

function list(provenance: Record<string, string>, field: string, sources: Array<[string, unknown]>): string[] {
	const used = sources.filter(([, value]) => strings(value).length || (typeof value === 'string' && value.trim()));
	if (used.length) provenance[field] = used.map(([key]) => key).join('+');
	return unique(used.flatMap(([, value]) => typeof value === 'string' ? [value] : strings(value)));
}

function relationshipText(value: unknown): string {
	if (typeof value === 'string') return whitespace(value);
	const relationship = asRecord(value);
	const status = typeof relationship.status === 'string' ? relationship.status.trim() : '';
	const level = typeof relationship.level === 'number' ? `level ${relationship.level}` : '';
	return [status, level].filter(Boolean).join(', ');
}

function relationshipHistory(state: JsonRecord, metadata: JsonRecord): string[] {
	const relationship = asRecord(state.relationship ?? metadata.relationship);
	const history = Array.isArray(relationship.history) ? relationship.history : [];
	return history.map(item => {
		const row = asRecord(item);
		const text = (typeof item === 'string' ? item : String(row.description ?? row.reason ?? '')).replace(/^\[[+-]?\d+\]\s*/, '').trim();
		return text && !/^Narrated relationship shift\.?$/i.test(text) ? `${text}${typeof row.entryId === 'string' ? ` [entry:${row.entryId}]` : ''}` : '';
	}).filter(Boolean).reverse();
}

function sceneLines(entity: { status?: string | null }, state: JsonRecord, metadata: JsonRecord): string[] {
	const value = (keys: string[]) => {
		for (const source of [state, metadata]) for (const key of keys) if (typeof source[key] === 'string' && String(source[key]).trim()) return whitespace(String(source[key]));
		return '';
	};
	const status = value(['status']) || String(entity.status ?? '').trim();
	const present = typeof state.isPresent === 'boolean' ? state.isPresent : typeof state.present === 'boolean' ? state.present : null;
	const party = state.partyMember === true || metadata.partyMember === true;
	const relationship = relationshipText(state.relationship) || relationshipText(metadata.relationship);
	return [
		party ? `active party member${value(['partyRole']) ? ` (${value(['partyRole'])})` : ''}` : '',
		present === null ? '' : present ? 'present in the current scene' : 'not currently visible',
		status && status !== 'active' ? `status: ${status}` : '',
		value(['rank']) ? `rank: ${value(['rank'])}` : '',
		value(['currentLocation', 'location']) ? `location: ${value(['currentLocation', 'location'])}` : '',
		value(['currentAction']) ? `action: ${value(['currentAction'])}` : '',
		value(['emotionalState']) ? `emotional state: ${value(['emotionalState'])}` : '',
		value(['currentDisposition']) ? `disposition: ${value(['currentDisposition'])}` : '',
		relationship ? `relationship: ${relationship}` : '',
		...unique([...strings(state.pressures), ...strings(metadata.pressures)]).slice(0, 2).map(item => `pressure: ${item}`),
	].filter(Boolean).slice(0, 8);
}

export interface CharacterCardInput {
	entity: { id: string; name: string; description?: string | null; status?: string | null; state?: unknown; metadata?: unknown };
	affiliations?: string[];
	/** GM timeline summaries linked to this character, with their most restrictive visibility. */
	gmLinks?: Array<{ text: string; secret: boolean }>;
}

/** Explicit adapter from stored entity state/metadata (any legacy alias) to contract v1. */
export function normalizeCharacterCard(input: CharacterCardInput): CharacterCardV1 {
	const state = asRecord(input.entity.state);
	const rawMetadata = asRecord(input.entity.metadata);
	const metadata = { ...asRecord(rawMetadata.originalState), ...rawMetadata };
	const view = characterStateView(state, metadata);
	const provenance: Record<string, string> = {};
	const description = durableIdentityText(whitespace(input.entity.description ?? ''));
	if (description) provenance['identity.description'] = 'entity.description';
	const eventMemory = asRecord(state.eventMemory ?? state.npcEventMemory);
	const metadataMemory = asRecord(metadata.eventMemory ?? metadata.npcEventMemory);
	const memorySource = (['did', 'saw', 'knew', 'knows'] as const).some(key => Array.isArray(eventMemory[key])) ? eventMemory : metadataMemory;
	if (Object.keys(memorySource).length) provenance['knowledge.memories'] = memorySource === eventMemory ? 'state.eventMemory' : 'metadata.eventMemory';
	const knownFacts = unique(durableCharacterKnownFactList(Array.isArray(state.knownFacts) ? state.knownFacts : metadata.knownFacts));
	if (knownFacts.length) provenance['knowledge.knownFacts'] = Array.isArray(state.knownFacts) ? 'state.knownFacts' : 'metadata.knownFacts';
	return {
		contractVersion: 1,
		entityId: input.entity.id,
		name: input.entity.name,
		aliases: list(provenance, 'aliases', [['state.aliases', state.aliases], ['metadata.aliases', metadata.aliases]]),
		identity: {
			description,
			biography: durableIdentityText(pick(provenance, 'identity.biography', [['state.bio', state.bio], ['state.background', state.background], ['metadata.bio', metadata.bio], ['metadata.background', metadata.background]])),
			appearance: pick(provenance, 'identity.appearance', [['state.appearance', state.appearance], ['metadata.appearance', metadata.appearance]]),
			presentation: pick(provenance, 'identity.presentation', [['state.presentation', state.presentation], ['metadata.presentation', metadata.presentation]]),
			culture: pick(provenance, 'identity.culture', [['state.culture', state.culture], ['metadata.culture', metadata.culture]]),
		},
		personality: {
			summary: pick(provenance, 'personality.summary', [['state.personality', view.personality], ['metadata.personality', metadata.personality]]),
			descriptors: list(provenance, 'personality.descriptors', [['state.personalityDescriptors', state.personalityDescriptors], ['metadata.personalityDescriptors', metadata.personalityDescriptors]]),
			motives: list(provenance, 'personality.motives', [['state.motivations', state.motivations], ['metadata.motivations', metadata.motivations]]),
			goals: list(provenance, 'personality.goals', [['state.goals', state.goals], ['metadata.goals', metadata.goals], ['state.goal', state.goal], ['metadata.goal', metadata.goal]]),
		},
		voice: {
			guidance: pick(provenance, 'voice.guidance', [['state.speechStyle', state.speechStyle], ['state.voice', state.voice], ['metadata.speechStyle', metadata.speechStyle], ['metadata.voice', metadata.voice]]),
			mannerisms: list(provenance, 'voice.mannerisms', [['state.mannerisms', state.mannerisms], ['metadata.mannerisms', metadata.mannerisms]]),
			examples: list(provenance, 'voice.examples', [['state.dialogueExamples', state.dialogueExamples], ['state.exampleDialogue', state.exampleDialogue], ['metadata.dialogueExamples', metadata.dialogueExamples], ['metadata.exampleDialogue', metadata.exampleDialogue]]),
		},
		scene: sceneLines(input.entity, state, metadata),
		relationshipHistory: relationshipHistory(state, metadata),
		affiliations: unique(input.affiliations ?? []),
		knowledge: {
			knownFacts,
			memories: (['did', 'saw', 'knew', 'knows'] as const).flatMap(kind => unique(durableCharacterEventMemoryList(memorySource[kind])).slice(-4).reverse().map(text => ({ kind, text }))),
			gmLinks: input.gmLinks ?? [],
		},
		provenance,
	};
}

const STOPWORDS = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'have', 'what', 'when', 'where', 'there', 'their', 'about', 'into', 'then',
	'than', 'they', 'them', 'your', 'you', 'for', 'are', 'was', 'were', 'will', 'would', 'could', 'should', 'after', 'before', 'again', 'just', 'like',
	'tell', 'ask', 'said', 'says']);
const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function relevance(text: string, tokens: string[]): number {
	const haystack = ` ${normalize(text)} `;
	return tokens.filter(token => haystack.includes(` ${token} `)).length;
}

interface TierLimits { budget: number; budgetWithContinuity: number; appearance: number; personality: number; biography: number; goals: number;
	keyHistoryItem: number; affiliations: number; voice: number; continuityLines: number; continuityLine: number; examples: number }
/** Scene limits match the card budget used before the contract; the addressed character gets room to be portrayed. */
const TIERS: Record<CharacterCardTier, TierLimits> = {
	scene: { budget: 1400, budgetWithContinuity: 1800, appearance: 140, personality: 260, biography: 280, goals: 180, keyHistoryItem: 95, affiliations: 100, voice: 200, continuityLines: 5, continuityLine: 220, examples: 0 },
	addressed: { budget: 4200, budgetWithContinuity: 4200, appearance: 500, personality: 1200, biography: 900, goals: 500, keyHistoryItem: 160, affiliations: 300, voice: 900, continuityLines: 8, continuityLine: 320, examples: 900 },
};

function capped(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const cut = text.slice(0, cap);
	const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
	return `${(sentence > cap * 0.6 ? cut.slice(0, sentence + 1) : cut).trimEnd()}…`;
}

export interface RenderedCharacterCard {
	text: string;
	includedSections: string[];
	omittedSections: string[];
	contractVersion: 1;
}

/**
 * Render a card for its tier. Personality and voice are required and only trimmed at their
 * caps. Other sections are kept whole in priority order (continuity first, as before); one that
 * does not fit is omitted and named on the card, so a partial card never looks complete.
 */
export function renderCharacterCard(card: CharacterCardV1, options: { tier: CharacterCardTier; view: CharacterCardView; query?: string }): RenderedCharacterCard {
	const limits = TIERS[options.tier];
	const tokens = [...new Set(normalize(options.query ?? '').split(/\s+/).filter(token => token.length > 2 && !STOPWORDS.has(token)))].slice(0, 32);
	const facts = card.knowledge.knownFacts.map((text, index) => ({ text, index }))
		.sort((left, right) => relevance(right.text, tokens) - relevance(left.text, tokens) || right.index - left.index).map(item => item.text);
	const history = card.relationshipHistory.map((text, index) => ({ text, index }))
		.sort((left, right) => relevance(right.text, tokens) - relevance(left.text, tokens) || left.index - right.index)[0]?.text;
	const kinds = new Set<string>();
	const memories = [
		...card.knowledge.memories,
		// GM-only timeline links stay out of anything the character itself is given.
		...(options.view === 'narrator' ? card.knowledge.gmLinks.map(link => ({ kind: 'linked', text: link.text, secret: link.secret })) : []),
	].filter(memory => { if (kinds.has(memory.kind)) return false; kinds.add(memory.kind); return true; })
		.map(memory => `${'secret' in memory && memory.secret ? '[secret narrator-only] ' : ''}${memory.kind}: ${memory.text}`);
	const continuity = [facts[0] ? `known fact: ${facts[0]}` : '', history ? `relationship history: ${history}` : '', ...memories, facts[1] ? `known fact: ${facts[1]}` : '']
		.filter(Boolean).slice(0, limits.continuityLines).map(line => capped(line, limits.continuityLine));
	const personality = card.personality.summary || card.personality.descriptors.join('; ');
	const voice = [card.voice.guidance, options.tier === 'addressed' && card.voice.mannerisms.length ? `mannerisms: ${card.voice.mannerisms.join('; ')}` : ''].filter(Boolean).join(' | ');
	const goals = unique([...card.personality.motives, ...card.personality.goals]).slice(0, options.tier === 'addressed' ? 6 : 2);
	const appearance = [card.identity.appearance, card.identity.presentation ? `Current presentation: ${card.identity.presentation}` : ''].filter(Boolean).join('; ');
	const biography = unique([card.identity.description, card.identity.biography]).join('; ');
	type Section = { id: string; text: string; priority: number; required?: boolean };
	const sections: Section[] = [
		{ id: 'Appearance', priority: 7, text: appearance ? `[Appearance]: ${capped(appearance, limits.appearance)}` : '' },
		// Required for portrayal; "." marks a personality that has not been recorded.
		{ id: 'Personality', priority: 1, required: true, text: `[Personality]: ${personality ? capped(personality, limits.personality) : '.'}` },
		{ id: 'Biography', priority: 6, text: biography ? `[bio]: ${capped(biography, limits.biography)}` : '' },
		{ id: 'Goals', priority: 5, text: goals.length ? `[Goals]: ${capped(goals.join('; '), limits.goals)}` : '' },
		{ id: 'Current state', priority: 4, text: card.scene.length ? `[Key History]: ${card.scene.map(line => capped(line, limits.keyHistoryItem)).join('; ')}` : '' },
		{ id: 'Affiliations', priority: 8, text: card.affiliations.length ? `[Affiliations]: ${capped(card.affiliations.join('; '), limits.affiliations)}` : '' },
		{ id: 'Voice', priority: 2, required: true, text: voice ? `[Voice]: ${capped(voice, limits.voice)}` : '' },
		{ id: 'Remembered continuity', priority: 3, text: continuity.length ? `[Remembered continuity]:\n${continuity.map(line => `- ${line}`).join('\n')}` : '' },
		{ id: 'Dialogue examples', priority: 9, text: limits.examples && card.voice.examples.length ? `[Dialogue examples]:\n${card.voice.examples.map(line => `- ${capped(line, 300)}`).join('\n')}` : '' },
	];
	const header = `Character ${card.entityId} / ${card.name}`;
	const budget = continuity.length ? limits.budgetWithContinuity : limits.budget;
	const kept = new Set<string>();
	const omitted: string[] = [];
	const noteLength = (names: string[]) => names.length ? `\n[Omitted for context budget: ${names.join(', ')}]`.length : 0;
	let used = header.length;
	for (const section of [...sections].filter(section => section.text).sort((left, right) => left.priority - right.priority)) {
		const remainingLater = sections.filter(other => other.text && !other.required && other.priority > section.priority).map(other => other.id);
		if (section.required || used + section.text.length + 1 + noteLength([...omitted, ...remainingLater.slice(0, 1)]) <= budget) {
			kept.add(section.id); used += section.text.length + 1;
		} else if (section.text) omitted.push(section.id);
	}
	const body = sections.filter(section => kept.has(section.id)).map(section => section.text);
	return {
		text: [header, ...body, omitted.length ? `[Omitted for context budget: ${omitted.join(', ')}]` : ''].filter(Boolean).join('\n'),
		includedSections: sections.filter(section => kept.has(section.id)).map(section => section.id),
		omittedSections: omitted,
		contractVersion: 1,
	};
}
