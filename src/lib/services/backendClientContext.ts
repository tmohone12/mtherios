import { DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET, normalizeRecentDialogueTokens, normalizeRecentDialogueTurns } from '$lib/services/memorySettings';
import { FIXED_CHAPTER_SETTINGS } from './chapterCadence';
import { normalizeBackendContextBudget } from '$lib/services/backendTurnContext';
import { containsSceneActorMention } from '$lib/services/ai/context/sceneActorMention';

interface CharacterLike {
	id: string;
	name: string;
	status?: string | null;
	relationship?: string | null;
	metadata?: unknown;
}

interface LocationLike {
	id: string;
	name: string;
	current?: boolean | null;
}

interface EntryLike {
	type: string;
	content: string;
}

export interface BackendClientContextInput {
	characters: CharacterLike[];
	locations: LocationLike[];
	entries?: EntryLike[];
	promptEntries?: EntryLike[];
	currentActionText?: string;
	backendMemoryTokenBudget?: number | null;
	contextBudget?: number | null;
	recentDialogueTokens?: number | null;
	recentDialogueTurns?: number | null;
}

const MAX_RELEVANT_NPCS = 8;
const CURRENT_SCENE_CHAR_LIMIT = 1400;
const CURRENT_SCENE_PARAGRAPH_LIMIT = 4;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeLookup(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function containsPhrase(haystack: string, phrase: string): boolean {
	const needle = normalizeLookup(phrase);
	if (needle.length < 3) return false;
	return ` ${normalizeLookup(haystack)} `.includes(` ${needle} `);
}

function metadataWithOriginal(character: CharacterLike): Record<string, unknown> {
	const metadata = asRecord(character.metadata);
	return { ...asRecord(metadata.originalMetadata), ...metadata };
}

function isPlayerCharacter(character: CharacterLike): boolean {
	const metadata = metadataWithOriginal(character);
	const relationship = asString(character.relationship).toLowerCase();
	return relationship === 'self'
		|| relationship === 'player_character'
		|| asString(metadata.relationship).toLowerCase() === 'self'
		|| asString(metadata.relationship).toLowerCase() === 'player_character'
		|| Boolean(metadata.isProtagonist)
		|| typeof metadata.playerPrompt === 'string';
}

function latestNarrationText(entries: EntryLike[]): string {
	const content = [...entries].reverse().find((entry) => entry.type === 'narration')?.content.trim() ?? '';
	if (!content) return '';
	const headerMatch = content.match(/^\s*(\[[^\r\n]*\])/);
	const header = headerMatch?.[1] ?? '';
	const body = headerMatch ? content.slice(headerMatch[0].length).trim() : content;
	const finalBeat = body.split(/\r?\n\s*\r?\n/).filter(Boolean).slice(-CURRENT_SCENE_PARAGRAPH_LIMIT).join('\n\n');
	const safeHeader = header.length > 360 ? `${header.slice(0, 357)}...` : header;
	const tailBudget = Math.max(0, CURRENT_SCENE_CHAR_LIMIT - safeHeader.length - 1);
	const tail = finalBeat.length > tailBudget ? `...${finalBeat.slice(-(tailBudget - 3))}` : finalBeat;
	return [safeHeader, tail].filter(Boolean).join('\n');
}

function characterAliases(character: CharacterLike): string[] {
	const metadata = metadataWithOriginal(character);
	return [...new Set([
		character.name,
		...asStringArray(metadata.aliases),
		...asStringArray(metadata.localAliases),
	])];
}

function characterLocationText(character: CharacterLike): string {
	const metadata = metadataWithOriginal(character);
	return [
		asString(metadata.currentLocation),
		asString(metadata.lastSeenLocation),
		asString(metadata.location),
		asString(metadata.currentLocationId),
	].filter(Boolean).join(' ');
}

function matchesCurrentLocation(character: CharacterLike, currentLocation: LocationLike | null): boolean {
	if (!currentLocation) return false;
	const locationText = characterLocationText(character);
	if (!locationText) return false;
	return containsPhrase(locationText, currentLocation.id)
		|| containsPhrase(locationText, currentLocation.name)
		|| containsPhrase(currentLocation.name, locationText);
}

function isMarkedPresent(character: CharacterLike): boolean {
	const metadata = metadataWithOriginal(character);
	return metadata.present === true || metadata.isPresent === true;
}

function npcRelevanceRank(character: CharacterLike, sceneText: string, currentLocation: LocationLike | null): number | null {
	if (character.status && character.status !== 'active') return null;
	if (isPlayerCharacter(character)) return null;
	const aliases = characterAliases(character);
	if (aliases.some((alias) => containsSceneActorMention(sceneText, alias))) return 0;
	if (matchesCurrentLocation(character, currentLocation)) return 1;
	// A contradictory location is stronger evidence than a stale presence bit.
	if (isMarkedPresent(character) && !currentLocation) return 2;
	return null;
}

/**
 * Build the compact client hint sent to the terminal backend before a turn.
 * This is intentionally conservative: "active" means canon-live, not scene-present.
 * Only the player, current location, and NPCs marked/mentioned as present should
 * become scene entities. The backend prompt builder has a second guard for stale
 * or over-broad callers, but this keeps the hot path lean.
 */
export function buildBackendClientContext(input: BackendClientContextInput) {
	const currentLocation = input.locations.find((location) => location.current) ?? null;
	const sourceEntries = input.promptEntries?.length ? input.promptEntries : input.entries ?? [];
	const sceneText = latestNarrationText(sourceEntries);
	const protagonistIds = input.characters
		.filter((character) => (!character.status || character.status === 'active') && isPlayerCharacter(character))
		.map((character) => character.id);
	const relevantNpcIds = input.characters
		.map((character, index) => ({ character, index, rank: npcRelevanceRank(character, sceneText, currentLocation) }))
		.filter((candidate): candidate is typeof candidate & { rank: number } => candidate.rank !== null)
		.sort((left, right) => left.rank - right.rank || left.index - right.index)
		.slice(0, MAX_RELEVANT_NPCS)
		.map(({ character }) => character.id);
	const sceneEntityIds = [...new Set([
		...protagonistIds,
		...(currentLocation ? [currentLocation.id] : []),
		...relevantNpcIds,
	])];

	return {
		sceneEntityIds,
		presentNpcIds: relevantNpcIds,
		locationId: currentLocation?.id ?? null,
		threadIds: [],
		memoryTokenBudget: input.backendMemoryTokenBudget || DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET,
		contextBudget: normalizeBackendContextBudget(input.contextBudget ?? 0),
		...(input.recentDialogueTurns === undefined && input.recentDialogueTokens !== undefined
			? { recentDialogueTokens: normalizeRecentDialogueTokens(input.recentDialogueTokens) }
			: { recentDialogueTurns: normalizeRecentDialogueTurns(input.recentDialogueTurns) }),
		// Older servers read these wire keys; the cadence itself is fixed in chapterCadence.ts.
		...FIXED_CHAPTER_SETTINGS,
	};
}
