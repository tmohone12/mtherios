import {
	deleteLorebookEntry,
	createConversationMemory,
	getLorebookEntry,
	getStory,
	bulkPutFactionActions,
	bulkPutRumors,
	bulkPutSchemes,
	putArc,
	putChapter,
	putSaga,
	putCharacter,
	putItem,
	putLocation,
	putLorebookEntry,
	putWorldEvent,
	updateLorebookEntry,
	updateStory,
} from '$lib/services/database';
import {
	createBackendArc,
	createBackendChapter,
	createBackendLorebookEntry,
	createBackendSaga,
	deleteBackendLorebookEntry,
	upsertBackendArc,
	upsertBackendChapter,
	upsertBackendLivingMemory,
	upsertBackendLorebookEntry,
	upsertBackendSaga,
} from '$lib/services/serverStories';
import type { Arc, Chapter, Character, CharacterEntryState, ConversationMemoryEntry, Entry, FactionActionRecord, Item, ItemEntryState, Location, LocationEntryState, RumorRecord, Saga, Scheme, Story, WorldEvent } from '$lib/types';
import type { LivingMemoryKind } from '$lib/services/serverStories';

export type CanonicalWriteMode = 'create' | 'update';

async function applyBackendVersion(story: Story, serverVersion: number): Promise<void> {
	await updateStory(story.id, {
		serverVersion,
		syncStatus: 'synced',
	});
}

async function saveCanonicalLivingRecords<T extends { storyId: string }>(
	storyId: string,
	kind: LivingMemoryKind,
	records: T[],
	writeLocal: () => Promise<void>,
): Promise<number | null> {
	if (records.length === 0) return null;
	const owner = await getStory(storyId);
	let serverVersion: number | null = null;
	if (owner?.serverStoryId) {
		const result = await upsertBackendLivingMemory(
			owner.serverStoryId,
			kind,
			records as Array<Record<string, unknown>>,
		);
		serverVersion = result.serverVersion;
		await applyBackendVersion(owner, result.serverVersion);
	}
	await writeLocal();
	return serverVersion;
}

function keywordsForName(name: string): string[] {
	return [...new Set([name, ...name.split(/\s+/)])]
		.map((keyword) => keyword.trim())
		.filter((keyword) => keyword.length > 2);
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringFrom(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function characterToEntry(character: Character, existing?: Entry | null): Entry {
	const now = Date.now();
	const metadata = record(character.metadata);
	const previousState = existing?.state?.type === 'character'
		? existing.state as CharacterEntryState
		: null;
	const previousStateRecord = previousState as unknown as Record<string, unknown> | null;
	const isSelf = character.relationship === 'self';
	const relationship = previousState?.relationship ?? { level: isSelf ? 100 : 0, status: isSelf ? 'self' : 'neutral', history: [] };
	const lastSeenLocation = stringFrom(metadata.lastSeenLocation) ?? previousState?.lastSeenLocation ?? null;
	const playerPrompt = stringFrom(metadata.playerPrompt) ?? stringFrom(previousStateRecord?.playerPrompt);
	const assets = Array.isArray(metadata.assets)
		? metadata.assets.filter((asset): asset is string => typeof asset === 'string' && asset.trim().length > 0)
		: Array.isArray(previousStateRecord?.assets)
			? (previousStateRecord.assets as unknown[]).filter((asset): asset is string => typeof asset === 'string' && asset.trim().length > 0)
			: [];
	const appearance = stringFrom(metadata.appearance) ?? stringFrom(previousStateRecord?.appearance);
	const voice = stringFrom(metadata.voice) ?? stringFrom(previousStateRecord?.voice);
	const mannerisms = Array.isArray(metadata.mannerisms)
		? metadata.mannerisms.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
		: Array.isArray(previousStateRecord?.mannerisms)
			? (previousStateRecord.mannerisms as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
			: [];
	const personalityDescriptors = Array.isArray(metadata.personalityDescriptors)
		? metadata.personalityDescriptors.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
		: Array.isArray(previousStateRecord?.personalityDescriptors)
			? (previousStateRecord.personalityDescriptors as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
			: [];
	const state = {
		...(previousState ?? {}),
		type: 'character',
		isPresent: previousState?.isPresent ?? (isSelf || Boolean(lastSeenLocation)),
		lastSeenLocation,
		currentDisposition: character.relationship ?? previousState?.currentDisposition ?? null,
		relationship: {
			...relationship,
			status: character.relationship ?? relationship.status,
		},
		knownFacts: previousState?.knownFacts ?? [],
		revealedSecrets: previousState?.revealedSecrets ?? [],
		pressures: previousState?.pressures ?? [],
		traits: character.traits,
		visualDescriptors: character.visualDescriptors,
		portrait: character.portrait,
		status: character.status,
		playerPrompt,
		assets,
		appearance,
		voice,
		mannerisms,
		personalityDescriptors,
		factionName: stringFrom(metadata.factionName) ?? stringFrom(previousStateRecord?.factionName),
		rank: stringFrom(metadata.rank) ?? stringFrom(previousStateRecord?.rank),
		role: stringFrom(metadata.role) ?? stringFrom(previousStateRecord?.role),
	} as CharacterEntryState;
	return {
		id: character.id,
		storyId: character.storyId,
		branchId: character.branchId ?? null,
		name: character.name,
		type: 'character',
		description: character.description ?? '',
		hiddenInfo: existing?.hiddenInfo ?? null,
		aliases: existing?.aliases ?? [],
		state,
		adventureState: existing?.adventureState ?? null,
		creativeState: existing?.creativeState ?? null,
		injection: existing?.injection ?? {
			mode: character.relationship === 'self' ? 'always' : 'keyword',
			keywords: keywordsForName(character.name),
			priority: character.relationship === 'self' ? 1000 : 80,
		},
		firstMentioned: existing?.firstMentioned ?? null,
		lastMentioned: existing?.lastMentioned ?? null,
		mentionCount: existing?.mentionCount ?? 0,
		createdBy: existing?.createdBy ?? 'user',
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		loreManagementBlacklisted: existing?.loreManagementBlacklisted ?? character.relationship === 'self',
	};
}

function locationToEntry(location: Location, existing?: Entry | null): Entry {
	const now = Date.now();
	const previousState = existing?.state?.type === 'location'
		? existing.state as LocationEntryState
		: null;
	const state = {
		...(previousState ?? {}),
		type: 'location',
		isCurrentLocation: location.current,
		visitCount: Math.max(previousState?.visitCount ?? 0, location.visited || location.current ? 1 : 0),
		changes: previousState?.changes ?? [],
		presentCharacters: previousState?.presentCharacters ?? [],
		presentItems: previousState?.presentItems ?? [],
		connections: previousState?.connections ?? [],
		legacyConnections: location.connections ?? [],
	} as LocationEntryState;
	return {
		id: location.id,
		storyId: location.storyId,
		branchId: location.branchId ?? null,
		name: location.name,
		type: 'location',
		description: location.description ?? '',
		hiddenInfo: existing?.hiddenInfo ?? null,
		aliases: existing?.aliases ?? [],
		state,
		adventureState: existing?.adventureState ?? null,
		creativeState: existing?.creativeState ?? null,
		injection: existing?.injection ?? {
			mode: location.current ? 'always' : 'keyword',
			keywords: keywordsForName(location.name),
			priority: location.current ? 250 : 70,
		},
		firstMentioned: existing?.firstMentioned ?? null,
		lastMentioned: existing?.lastMentioned ?? null,
		mentionCount: existing?.mentionCount ?? 0,
		createdBy: existing?.createdBy ?? 'user',
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		loreManagementBlacklisted: existing?.loreManagementBlacklisted ?? false,
	};
}

function itemToEntry(item: Item, existing?: Entry | null): Entry {
	const now = Date.now();
	const previousState = existing?.state?.type === 'item'
		? existing.state as ItemEntryState
		: null;
	const state = {
		...(previousState ?? {}),
		type: 'item',
		inInventory: item.equipped || item.location === 'inventory',
		currentLocation: item.location || previousState?.currentLocation || null,
		condition: previousState?.condition ?? null,
		uses: previousState?.uses ?? [],
		quantity: item.quantity,
		equipped: item.equipped,
	} as ItemEntryState;
	return {
		id: item.id,
		storyId: item.storyId,
		branchId: item.branchId ?? null,
		name: item.name,
		type: 'item',
		description: item.description ?? '',
		hiddenInfo: existing?.hiddenInfo ?? null,
		aliases: existing?.aliases ?? [],
		state,
		adventureState: existing?.adventureState ?? null,
		creativeState: existing?.creativeState ?? null,
		injection: existing?.injection ?? {
			mode: item.equipped ? 'always' : 'keyword',
			keywords: keywordsForName(item.name),
			priority: item.equipped ? 180 : 60,
		},
		firstMentioned: existing?.firstMentioned ?? null,
		lastMentioned: existing?.lastMentioned ?? null,
		mentionCount: existing?.mentionCount ?? 0,
		createdBy: existing?.createdBy ?? 'user',
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		loreManagementBlacklisted: existing?.loreManagementBlacklisted ?? false,
	};
}

export async function saveCanonicalLorebookEntry(entry: Entry, mode: CanonicalWriteMode = 'update'): Promise<number | null> {
	const owner = await getStory(entry.storyId);
	let serverVersion: number | null = null;
	if (owner?.serverStoryId) {
		const result = mode === 'create'
			? await createBackendLorebookEntry(owner.serverStoryId, entry)
			: await upsertBackendLorebookEntry(owner.serverStoryId, entry);
		serverVersion = result.serverVersion;
		await applyBackendVersion(owner, result.serverVersion);
	}
	await putLorebookEntry(entry);
	return serverVersion;
}

export async function patchCanonicalLorebookEntry(id: string, updates: Partial<Entry>): Promise<{ entry: Entry | null; serverVersion: number | null }> {
	const existing = await getLorebookEntry(id);
	if (!existing) {
		await updateLorebookEntry(id, updates);
		return { entry: null, serverVersion: null };
	}
	const entry: Entry = {
		...existing,
		...updates,
		updatedAt: updates.updatedAt ?? Date.now(),
	};
	const serverVersion = await saveCanonicalLorebookEntry(entry, 'update');
	return { entry, serverVersion };
}

export async function deleteCanonicalLorebookEntry(storyId: string, entryId: string): Promise<number | null> {
	const owner = await getStory(storyId);
	let serverVersion: number | null = null;
	if (owner?.serverStoryId) {
		const result = await deleteBackendLorebookEntry(owner.serverStoryId, entryId);
		serverVersion = result.serverVersion;
		await applyBackendVersion(owner, result.serverVersion);
	}
	await deleteLorebookEntry(entryId);
	return serverVersion;
}

export async function saveCanonicalCharacter(character: Character, mode: CanonicalWriteMode = 'update'): Promise<{ serverVersion: number | null; entry: Entry }> {
	const existing = await getLorebookEntry(character.id);
	const entry = characterToEntry(character, existing);
	const serverVersion = await saveCanonicalLorebookEntry(entry, mode);
	await putCharacter(character);
	return { serverVersion, entry };
}

export async function saveCanonicalLocation(location: Location, mode: CanonicalWriteMode = 'update'): Promise<{ serverVersion: number | null; entry: Entry }> {
	const existing = await getLorebookEntry(location.id);
	const entry = locationToEntry(location, existing);
	const serverVersion = await saveCanonicalLorebookEntry(entry, mode);
	await putLocation(location);
	return { serverVersion, entry };
}

export async function saveCanonicalItem(item: Item, mode: CanonicalWriteMode = 'update'): Promise<{ serverVersion: number | null; entry: Entry }> {
	const existing = await getLorebookEntry(item.id);
	const entry = itemToEntry(item, existing);
	const serverVersion = await saveCanonicalLorebookEntry(entry, mode);
	await putItem(item);
	return { serverVersion, entry };
}

export async function saveCanonicalChapter(chapter: Chapter, mode: CanonicalWriteMode = 'update'): Promise<number | null> {
	const owner = await getStory(chapter.storyId);
	let serverVersion: number | null = null;
	if (owner?.serverStoryId) {
		const result = mode === 'create'
			? await createBackendChapter(owner.serverStoryId, chapter)
			: await upsertBackendChapter(owner.serverStoryId, chapter);
		serverVersion = result.serverVersion;
		await applyBackendVersion(owner, result.serverVersion);
	}
	await putChapter(chapter);
	return serverVersion;
}

export async function saveCanonicalArc(arc: Arc, mode: CanonicalWriteMode = 'update'): Promise<number | null> {
	const owner = await getStory(arc.storyId);
	let serverVersion: number | null = null;
	if (owner?.serverStoryId) {
		const result = mode === 'create'
			? await createBackendArc(owner.serverStoryId, arc)
			: await upsertBackendArc(owner.serverStoryId, arc);
		serverVersion = result.serverVersion;
		await applyBackendVersion(owner, result.serverVersion);
	}
	await putArc(arc);
	return serverVersion;
}

export async function saveCanonicalSaga(saga: Saga, mode: CanonicalWriteMode = 'update'): Promise<number | null> {
	const owner = await getStory(saga.storyId);
	let serverVersion: number | null = null;
	if (owner?.serverStoryId) {
		const result = mode === 'create'
			? await createBackendSaga(owner.serverStoryId, saga)
			: await upsertBackendSaga(owner.serverStoryId, saga);
		serverVersion = result.serverVersion;
		await applyBackendVersion(owner, result.serverVersion);
	}
	await putSaga(saga);
	return serverVersion;
}

export async function saveCanonicalConversationMemory(entry: ConversationMemoryEntry): Promise<number | null> {
	return saveCanonicalLivingRecords(entry.storyId, 'conversationMemory', [entry], () => createConversationMemory(entry));
}

export async function saveCanonicalWorldEvent(event: WorldEvent): Promise<number | null> {
	return saveCanonicalLivingRecords(event.storyId, 'worldEvent', [event], () => putWorldEvent(event));
}

export async function saveCanonicalFactionActions(actions: FactionActionRecord[]): Promise<number | null> {
	const storyId = actions[0]?.storyId;
	if (!storyId) return null;
	return saveCanonicalLivingRecords(storyId, 'factionAction', actions, () => bulkPutFactionActions(actions));
}

export async function saveCanonicalRumors(rumors: RumorRecord[]): Promise<number | null> {
	const storyId = rumors[0]?.storyId;
	if (!storyId) return null;
	return saveCanonicalLivingRecords(storyId, 'rumor', rumors, () => bulkPutRumors(rumors));
}

export async function saveCanonicalScheme(scheme: Scheme): Promise<number | null> {
	return saveCanonicalLivingRecords(scheme.storyId, 'scheme', [scheme], () => bulkPutSchemes([scheme]));
}

export async function saveCanonicalSchemes(schemes: Scheme[]): Promise<number | null> {
	const storyId = schemes[0]?.storyId;
	if (!storyId) return null;
	return saveCanonicalLivingRecords(storyId, 'scheme', schemes, () => bulkPutSchemes(schemes));
}
