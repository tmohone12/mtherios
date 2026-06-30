import { DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET } from '$lib/services/memorySettings';
import { normalizeBackendContextBudget } from '$lib/services/backendTurnContext';

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
	chapterThreshold?: number | null;
	postChapterBuffer?: number | null;
	chaptersPerArc?: number | null;
}

const MAX_RELEVANT_NPCS = 8;

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
	return [...entries].reverse().find((entry) => entry.type === 'narration')?.content ?? '';
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

function isRelevantNpc(character: CharacterLike, sceneText: string, actionText: string, currentLocation: LocationLike | null): boolean {
	if (character.status && character.status !== 'active') return false;
	if (isPlayerCharacter(character)) return false;
	if (isMarkedPresent(character)) return true;
	if (matchesCurrentLocation(character, currentLocation)) return true;
	const lookupText = `${sceneText}\n${actionText}`;
	return characterAliases(character).some((alias) => containsPhrase(lookupText, alias));
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
	const actionText = input.currentActionText ?? '';
	const protagonistIds = input.characters
		.filter((character) => (!character.status || character.status === 'active') && isPlayerCharacter(character))
		.map((character) => character.id);
	const relevantNpcIds = input.characters
		.filter((character) => isRelevantNpc(character, sceneText, actionText, currentLocation))
		.slice(0, MAX_RELEVANT_NPCS)
		.map((character) => character.id);
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
		chapterThreshold: input.chapterThreshold || 20,
		postChapterBuffer: input.postChapterBuffer ?? 10,
		chaptersPerArc: input.chaptersPerArc || 5,
	};
}
