import { playerCapabilitiesSchema } from '$lib/contracts/playerCapabilities';
import { automaticCharacterUpdate } from '$lib/contracts/automaticCharacterUpdate';
import {
	deleteLorebookEntry,
	deleteArc,
	deleteChapter,
	getArcs,
	getLorebookEntry,
	getStory,
	putArc,
	putChapter,
	putCharacter,
	putLorebookEntry,
	updateLorebookEntry,
	updateStory,
} from '$lib/services/database';
import {
	createBackendArc,
	createBackendChapter,
	createBackendLorebookEntry,
	deleteBackendArc,
	deleteBackendChapter,
	deleteBackendLorebookEntry,
	upsertBackendArc,
	upsertBackendChapter,
	upsertBackendLorebookEntry,
} from '$lib/services/serverStories';
import type { Arc, Chapter, Character, CharacterEntryState, Entry, Story } from '$lib/types';

export type CanonicalWriteMode = 'create' | 'update';

export interface ResolvedCharacterReference {
	proposalId: string;
	name: string;
	entityId: string;
}

interface CanonicalLorebookWriteResult {
	serverVersion: number | null;
	entry: Entry;
	entity?: Record<string, unknown>;
	resolvedCharacterReferences?: ResolvedCharacterReference[];
}

async function applyBackendVersion(story: Story, serverVersion: number): Promise<void> {
	await updateStory(story.id, {
		serverVersion,
		syncStatus: 'synced',
	});
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

function stringListFrom(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function numberFrom(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function entryWithResolvedEntity(entry: Entry, entity: Record<string, unknown> | undefined): Entry {
	if (!entity) return entry;
	const resolvedId = stringFrom(entity.id);
	const resolvedName = stringFrom(entity.name);
	const resolvedDescription = stringFrom(entity.description);
	if (!resolvedId && !resolvedName && !resolvedDescription) return entry;
	return {
		...entry,
		...(entry.metadata?.automaticCharacterUpdate ? { state: entity.state as Entry['state'], metadata: { ...entry.metadata, automaticCharacterUpdate: undefined, identityReviewProposalId: (entity.metadata as Record<string, unknown> | undefined)?.identityReviewProposalId } } : {}),
		id: resolvedId ?? entry.id,
		name: resolvedName ?? entry.name,
		description: resolvedDescription ?? entry.description,
	};
}

function characterWithResolvedEntry(character: Character, entry: Entry): Character {
	return {
		...character,
		id: entry.id,
		name: entry.name,
		description: entry.description || null,
	};
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
	const affinity = numberFrom(metadata.affinity) ?? relationship.level;
	const currentDisposition = stringFrom(metadata.currentDisposition) ?? character.relationship ?? previousState?.currentDisposition ?? null;
	const lastSeenLocation = stringFrom(metadata.lastSeenLocation) ?? previousState?.lastSeenLocation ?? null;
	const playerPrompt = stringFrom(metadata.playerPrompt) ?? stringFrom(previousStateRecord?.playerPrompt);
	const assets = Array.isArray(metadata.assets)
		? metadata.assets.filter((asset): asset is string => typeof asset === 'string' && asset.trim().length > 0)
		: Array.isArray(previousStateRecord?.assets)
			? (previousStateRecord.assets as unknown[]).filter((asset): asset is string => typeof asset === 'string' && asset.trim().length > 0)
			: [];
	const appearance = stringFrom(metadata.appearance) ?? stringFrom(previousStateRecord?.appearance);
	const bio = stringFrom(metadata.bio) ?? previousState?.bio ?? character.description ?? null;
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
	const personality = stringFrom(metadata.personality)
		?? previousState?.personality
		?? (personalityDescriptors.length > 0 ? personalityDescriptors.join(', ') : null);
	const motivations = stringListFrom(metadata.motivations) ?? previousState?.motivations ?? null;
	const knownFacts = stringListFrom(metadata.knownFacts) ?? previousState?.knownFacts ?? [];
	const factionName = stringFrom(metadata.factionName) ?? stringFrom(previousStateRecord?.factionName);
	const factionTags = stringListFrom(metadata.factionTags) ?? previousState?.factionTags ?? (factionName ? [factionName] : []);
	const partyMember = typeof metadata.partyMember === 'boolean' ? metadata.partyMember : previousState?.partyMember ?? false;
	const partyRole = partyMember === false ? null
		: Object.prototype.hasOwnProperty.call(metadata, 'partyRole') ? stringFrom(metadata.partyRole) ?? null
			: previousState?.partyRole ?? null;
	const visibilityNote = stringFrom(metadata.visibilityNote) ?? stringFrom(previousStateRecord?.visibilityNote);
	const playerSheet = record(metadata.playerSheet);
	const playerCapabilities = metadata.playerCapabilities ?? previousState?.playerCapabilities;
	const state = {
		...(previousState ?? {}),
		type: 'character',
		isPresent: previousState?.isPresent ?? (isSelf || Boolean(lastSeenLocation)),
		lastSeenLocation,
		currentDisposition,
		relationship: {
			...relationship,
			level: affinity,
			status: isSelf ? 'self' : currentDisposition ?? relationship.status,
		},
		knownFacts,
		revealedSecrets: previousState?.revealedSecrets ?? [],
		pressures: previousState?.pressures ?? [],
		traits: character.traits,
		visualDescriptors: character.visualDescriptors,
		portrait: character.portrait,
		status: character.status,
		playerPrompt,
		assets,
		...(Object.keys(playerSheet).length > 0 ? { playerSheet } : {}),
		// The effect revision this projection saw; the server keeps newer HP and conditions.
		...(typeof metadata.mechanicsRevision === 'number' ? { mechanicsRevision: metadata.mechanicsRevision } : {}),
		...(playerCapabilities !== undefined ? { playerCapabilities: playerCapabilitiesSchema.parse(playerCapabilities) } : {}),
		bio,
		appearance,
		personality,
		motivations,
		factionTags,
		partyMember,
		partyRole,
		voice,
		mannerisms,
		personalityDescriptors,
		factionName,
		rank: stringFrom(metadata.rank) ?? stringFrom(previousStateRecord?.rank),
		role: stringFrom(metadata.role) ?? stringFrom(previousStateRecord?.role),
		visibilityNote,
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

async function writeCanonicalLorebookEntry(entry: Entry, mode: CanonicalWriteMode = 'update'): Promise<CanonicalLorebookWriteResult> {
	const owner = await getStory(entry.storyId);
	let result: {
		serverVersion: number;
		entity?: Record<string, unknown>;
		resolvedCharacterReferences?: ResolvedCharacterReference[];
	} | null = null;
	if (owner?.serverStoryId) {
		result = mode === 'create'
			? await createBackendLorebookEntry(owner.serverStoryId, entry)
			: await upsertBackendLorebookEntry(owner.serverStoryId, entry);
		await applyBackendVersion(owner, result.serverVersion);
	}
	const canonicalEntry = entryWithResolvedEntity(entry, result?.entity);
	await putLorebookEntry(canonicalEntry);
	return {
		serverVersion: result?.serverVersion ?? null,
		entry: canonicalEntry,
		...(result?.entity ? { entity: result.entity } : {}),
		...(result?.resolvedCharacterReferences?.length
			? { resolvedCharacterReferences: result.resolvedCharacterReferences }
			: {}),
	};
}

export async function saveCanonicalLorebookEntry(entry: Entry, mode: CanonicalWriteMode = 'update'): Promise<number | null> {
	const result = await writeCanonicalLorebookEntry(entry, mode);
	return result.serverVersion;
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
	const result = await writeCanonicalLorebookEntry(entry, 'update');
	return { entry: result.entry, serverVersion: result.serverVersion };
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

export async function saveCanonicalCharacter(character: Character, mode: CanonicalWriteMode = 'update', automatic?: { changes: Record<string, unknown>; sourceEntryIds: string[] }): Promise<{ serverVersion: number | null; entry: Entry; character: Character; resolvedCharacterReferences?: ResolvedCharacterReference[] }> {
	const existing = await getLorebookEntry(character.id);
	const entry = characterToEntry(character, existing);
	if (automatic) {
		if (!existing) throw new Error('Automatic character update requires an existing canonical entry.');
		const baseline = { ...existing.state as unknown as Record<string, unknown>, description: existing.description };
		entry.state = { ...existing.state, ...automatic.changes } as Entry['state'];
		delete (entry.state as unknown as Record<string, unknown>).description;
		entry.description = existing.description;
		entry.metadata = { ...existing.metadata, automaticCharacterUpdate: automaticCharacterUpdate(baseline, { ...baseline, ...automatic.changes }, automatic.sourceEntryIds) };
	}
	const result = await writeCanonicalLorebookEntry(entry, mode);
	const canonicalCharacter = characterWithResolvedEntry(character, result.entry);
	await putCharacter(canonicalCharacter);
	return {
		serverVersion: result.serverVersion,
		entry: result.entry,
		character: canonicalCharacter,
		...(result.resolvedCharacterReferences?.length
			? { resolvedCharacterReferences: result.resolvedCharacterReferences }
			: {}),
	};
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

async function unwrapLocalChapterFromArcs(storyId: string, chapterId: string): Promise<void> {
	const arcs = await getArcs(storyId);
	const updates = arcs
		.filter((arc) => arc.chapterIds.includes(chapterId))
		.map((arc) => putArc({
			...arc,
			chapterIds: arc.chapterIds.filter((id) => id !== chapterId),
		}));
	await Promise.all(updates);
}

export async function deleteCanonicalChapter(storyId: string, chapterId: string): Promise<number | null> {
	const owner = await getStory(storyId);
	let serverVersion: number | null = null;
	if (owner?.serverStoryId) {
		const result = await deleteBackendChapter(owner.serverStoryId, chapterId);
		serverVersion = result.serverVersion;
		await applyBackendVersion(owner, result.serverVersion);
	}
	await deleteChapter(chapterId);
	await unwrapLocalChapterFromArcs(storyId, chapterId);
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

export async function deleteCanonicalArc(storyId: string, arcId: string): Promise<number | null> {
	const owner = await getStory(storyId);
	let serverVersion: number | null = null;
	if (owner?.serverStoryId) {
		const result = await deleteBackendArc(owner.serverStoryId, arcId);
		serverVersion = result.serverVersion;
		await applyBackendVersion(owner, result.serverVersion);
	}
	await deleteArc(arcId);
	return serverVersion;
}
