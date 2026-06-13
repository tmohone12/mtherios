/**
 * Story Export/Import — JSON-based sync between devices.
 * Export downloads a .mtherios.json file; import reads it and creates a new story.
 */

import { uuid } from '$lib/utils/uuid';
import {
	getStory,
	getStoryEntries,
	getCharacters,
	getLocations,
	getItems,
	getStoryBeats,
	getChapters,
	getLorebookEntries,
	getArcs,
	getSagas,
	getEntryRelationships,
	getConversationMemory,
	getWorldEvents,
	getAgreements,
	getFactionActions,
	getRumors,
	getSchemes,
	getStoryThreads,
	getSetting,
	setSetting,
	createStory,
	updateStory,
	createStoryEntry,
	putCharacter,
	putLocation,
	putItem,
	createStoryBeat,
	putChapter,
	putLorebookEntry,
	putArc,
	putSaga,
} from '$lib/services/database';
import { importStoryBundleToBackend } from '$lib/services/backendImport';
import type {
	Story,
	StoryEntry,
	Character,
	Location,
	Item,
	StoryBeat,
	Chapter,
	Arc,
	Saga,
	Entry,
	EntryRelationship,
	ConversationMemoryEntry,
	WorldEvent,
	Agreement,
	FactionActionRecord,
	RumorRecord,
	Scheme,
	StoryThread,
} from '$lib/types';

// ============================================================================
// Types
// ============================================================================

/** Settings keys bundled with the export so the receiving device can connect. */
interface ExportedSettings {
	apiProfiles?: string;
	activeProfileId?: string;
	narrativeModel?: string;
	serviceConfigs?: string;
}

export interface StoryExportData {
	version: 1;
	exportedAt: number;
	source?: 'backend_canon' | string;
	story: Story;
	storyEntries: StoryEntry[];
	characters: Character[];
	locations: Location[];
	items: Item[];
	storyBeats: StoryBeat[];
	chapters: Chapter[];
	lorebookEntries: Entry[];
	arcs: Arc[];
	sagas?: Saga[];
	entryRelationships?: EntryRelationship[];
	conversationMemory?: ConversationMemoryEntry[];
	worldEvents?: WorldEvent[];
	agreements?: Agreement[];
	factionActions?: FactionActionRecord[];
	rumors?: RumorRecord[];
	schemes?: Scheme[];
	storyThreads?: StoryThread[];
	backendCanon?: unknown;
	/** API profiles & service configs — lets the other device connect without re-setup. */
	settings?: ExportedSettings;
}

// ============================================================================
// Export
// ============================================================================

export async function exportStory(storyId: string): Promise<StoryExportData> {
	const story = await getStory(storyId);
	if (!story) throw new Error(`Story not found: ${storyId}`);
	if (story.serverStoryId) return fetchBackendStoryExport(story.serverStoryId);

	const [
		storyEntries,
		characters,
		locations,
		items,
		storyBeats,
		chapters,
		lorebookEntries,
		arcs,
		sagas,
		entryRelationships,
		conversationMemory,
		worldEvents,
		agreements,
		factionActions,
		rumors,
		schemes,
		storyThreads,
	] = await Promise.all([
		getStoryEntries(storyId),
		getCharacters(storyId),
		getLocations(storyId),
		getItems(storyId),
		getStoryBeats(storyId),
		getChapters(storyId),
		getLorebookEntries(storyId),
		getArcs(storyId),
		getSagas(storyId),
		getEntryRelationships(storyId),
		getConversationMemory(storyId),
		getWorldEvents(storyId),
		getAgreements(storyId),
		getFactionActions(storyId),
		getRumors(storyId),
		getSchemes(storyId),
		getStoryThreads(storyId),
	]);

	// Bundle API settings so the receiving device can connect
	const [apiProfiles, activeProfileId, narrativeModel, serviceConfigs] = await Promise.all([
		getSetting('apiProfiles'),
		getSetting('activeProfileId'),
		getSetting('narrativeModel'),
		getSetting('serviceConfigs'),
	]);
	const settings: ExportedSettings = {};
	if (apiProfiles) settings.apiProfiles = apiProfiles;
	if (activeProfileId) settings.activeProfileId = activeProfileId;
	if (narrativeModel) settings.narrativeModel = narrativeModel;
	if (serviceConfigs) settings.serviceConfigs = serviceConfigs;

	return {
		version: 1,
		exportedAt: Date.now(),
		story,
		storyEntries,
		characters,
		locations,
		items,
		storyBeats,
		chapters,
		lorebookEntries,
		arcs,
		sagas,
		entryRelationships,
		conversationMemory,
		worldEvents,
		agreements,
		factionActions,
		rumors,
		schemes,
		storyThreads,
		settings: Object.keys(settings).length > 0 ? settings : undefined,
	};
}

async function fetchBackendStoryExport(serverStoryId: string): Promise<StoryExportData> {
	const response = await fetch('/api/engine/command', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			storyId: serverStoryId,
			command: 'story.export',
			args: {},
		}),
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(typeof (body as { error?: unknown }).error === 'string'
			? (body as { error: string }).error
			: `Terminal export failed: ${response.status}`);
	}
	if ((body as { status?: unknown }).status !== 'succeeded') {
		throw new Error(typeof (body as { error?: unknown }).error === 'string'
			? (body as { error: string }).error
			: 'Terminal export failed.');
	}
	const data = (body as { result?: unknown }).result as StoryExportData;
	if (!data || data.version !== 1 || !data.story || !Array.isArray(data.storyEntries)) {
		throw new Error('Backend export returned an invalid story bundle.');
	}
	return data;
}

export async function downloadStoryAsJson(storyId: string): Promise<void> {
	const data = await exportStory(storyId);
	const json = JSON.stringify(data, null, 2);
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);

	const slug = data.story.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40);
	const date = new Date().toISOString().slice(0, 10);
	const filename = `${slug}-${date}.mtherios.json`;

	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

// ============================================================================
// Import
// ============================================================================

function newId(): string {
	return uuid();
}

function remapStoryBundle(data: StoryExportData): StoryExportData {
	const newStoryId = newId();
	const now = Date.now();
	const idMap = new Map<string, string>([[data.story.id, newStoryId]]);

	const remap = (oldId: string): string => {
		if (!oldId) return oldId;
		let mapped = idMap.get(oldId);
		if (!mapped) {
			mapped = newId();
			idMap.set(oldId, mapped);
		}
		return mapped;
	};
	const remapNullable = (oldId: string | null | undefined): string | null => oldId ? remap(oldId) : null;
	const remapList = (ids: string[] = []): string[] => ids.map((value) => remap(value));

	return {
		...data,
		exportedAt: now,
		story: {
			...data.story,
			id: newStoryId,
			createdAt: now,
			updatedAt: now,
			currentBranchId: remapNullable(data.story.currentBranchId),
			serverStoryId: null,
			serverVersion: null,
			syncStatus: 'syncing',
		},
		storyEntries: data.storyEntries.map((entry) => ({
			...entry,
			id: remap(entry.id),
			storyId: newStoryId,
			parentId: remapNullable(entry.parentId),
			branchId: remapNullable(entry.branchId),
		})),
		characters: data.characters.map((character) => ({
			...character,
			id: remap(character.id),
			storyId: newStoryId,
			branchId: remapNullable(character.branchId),
			overridesId: remapNullable(character.overridesId),
		})),
		locations: data.locations.map((location) => ({
			...location,
			id: remap(location.id),
			storyId: newStoryId,
			branchId: remapNullable(location.branchId),
			overridesId: remapNullable(location.overridesId),
		})),
		items: data.items.map((item) => ({
			...item,
			id: remap(item.id),
			storyId: newStoryId,
			branchId: remapNullable(item.branchId),
			overridesId: remapNullable(item.overridesId),
		})),
		storyBeats: data.storyBeats.map((beat) => ({
			...beat,
			id: remap(beat.id),
			storyId: newStoryId,
			branchId: remapNullable(beat.branchId),
			overridesId: remapNullable(beat.overridesId),
		})),
		chapters: data.chapters.map((chapter) => ({
			...chapter,
			id: remap(chapter.id),
			storyId: newStoryId,
			startEntryId: remap(chapter.startEntryId),
			endEntryId: remap(chapter.endEntryId),
			branchId: remapNullable(chapter.branchId),
		})),
		lorebookEntries: data.lorebookEntries.map((entry) => ({
			...entry,
			id: remap(entry.id),
			storyId: newStoryId,
			firstMentioned: remapNullable(entry.firstMentioned),
			lastMentioned: remapNullable(entry.lastMentioned),
			branchId: remapNullable(entry.branchId),
			overridesId: remapNullable(entry.overridesId),
		})),
		arcs: (data.arcs ?? []).map((arc) => ({
			...arc,
			id: remap(arc.id),
			storyId: newStoryId,
			chapterIds: remapList(arc.chapterIds),
			threadIds: remapList(arc.threadIds),
			resolvedThreadIds: remapList(arc.resolvedThreadIds),
			branchId: remapNullable(arc.branchId),
		})),
		sagas: data.sagas?.map((saga) => ({
			...saga,
			id: remap(saga.id),
			storyId: newStoryId,
			arcIds: remapList(saga.arcIds),
			branchId: remapNullable(saga.branchId),
		})),
		entryRelationships: data.entryRelationships?.map((relationship) => ({
			...relationship,
			id: remap(relationship.id),
			storyId: newStoryId,
			sourceEntryId: remap(relationship.sourceEntryId),
			targetEntryId: remap(relationship.targetEntryId),
		})),
		conversationMemory: data.conversationMemory?.map((memory) => ({
			...memory,
			id: remap(memory.id),
			storyId: newStoryId,
			npcEntryId: remap(memory.npcEntryId),
			storyEntryId: remap(memory.storyEntryId),
		})),
		worldEvents: data.worldEvents?.map((event) => ({
			...event,
			id: remap(event.id),
			storyId: newStoryId,
			triggerEntryId: remap(event.triggerEntryId),
			sourceEntityId: remapNullable(event.sourceEntityId),
			consequences: event.consequences.map((consequence) => ({
				...consequence,
				id: remap(consequence.id),
				targetEntityId: remapNullable(consequence.targetEntityId),
			})),
		})),
		agreements: data.agreements?.map((agreement) => ({
			...agreement,
			id: remap(agreement.id),
			storyId: newStoryId,
		})),
		factionActions: data.factionActions?.map((action) => ({
			...action,
			id: remap(action.id),
			storyId: newStoryId,
		})),
		rumors: data.rumors?.map((rumor) => ({
			...rumor,
			id: remap(rumor.id),
			storyId: newStoryId,
		})),
		schemes: data.schemes?.map((scheme) => ({
			...scheme,
			id: remap(scheme.id),
			storyId: newStoryId,
			ownerEntryId: remapNullable(scheme.ownerEntryId),
			triggerEntryId: remapNullable(scheme.triggerEntryId),
			branchId: remapNullable(scheme.branchId),
		})),
		storyThreads: data.storyThreads?.map((thread) => ({
			...thread,
			id: remap(thread.id),
			storyId: newStoryId,
			sourceArcId: remapNullable(thread.sourceArcId),
			sourceChapterId: remapNullable(thread.sourceChapterId),
			relatedFactionIds: remapList(thread.relatedFactionIds),
		})),
	};
}

async function writeImportedStoryProjection(bundle: StoryExportData): Promise<void> {
	for (const entry of bundle.storyEntries) await createStoryEntry(entry);
	for (const character of bundle.characters) await putCharacter(character);
	for (const location of bundle.locations) await putLocation(location);
	for (const item of bundle.items) await putItem(item);
	for (const beat of bundle.storyBeats) await createStoryBeat(beat);
	for (const chapter of bundle.chapters) await putChapter(chapter);
	for (const entry of bundle.lorebookEntries) await putLorebookEntry(entry);
	for (const arc of bundle.arcs ?? []) await putArc(arc);
	for (const saga of bundle.sagas ?? []) await putSaga(saga);
}

async function restoreImportedSettings(settings?: ExportedSettings): Promise<void> {
	if (!settings) return;
	const existingProfiles = await getSetting('apiProfiles');
	if (existingProfiles || !settings.apiProfiles) return;
	await setSetting('apiProfiles', settings.apiProfiles);
	if (settings.activeProfileId) await setSetting('activeProfileId', settings.activeProfileId);
	if (settings.narrativeModel) await setSetting('narrativeModel', settings.narrativeModel);
	if (settings.serviceConfigs) await setSetting('serviceConfigs', settings.serviceConfigs);
	await setSetting('onboardingComplete', 'true');
}

export async function importStoryFromJson(file: File): Promise<string> {
	const text = await file.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('Invalid JSON file — could not parse.');
	}

	const data = parsed as StoryExportData;

	if (!data || typeof data !== 'object') {
		throw new Error('Invalid story file — expected a JSON object.');
	}
	if (data.version !== 1) {
		throw new Error(`Unsupported export version: ${data.version}`);
	}
	if (!data.story || typeof data.story.id !== 'string' || typeof data.story.title !== 'string') {
		throw new Error('Invalid story file — missing or malformed story data.');
	}
	if (!Array.isArray(data.storyEntries)) {
		throw new Error('Invalid story file — missing storyEntries array.');
	}

	const bundle = remapStoryBundle(data);
	const newStoryId = bundle.story.id;

	await createStory(bundle.story);

	try {
		await importStoryBundleToBackend(bundle, newStoryId);
	} catch (error) {
		console.warn('[StorySync] Imported story remains local until backend is reachable:', error);
		await updateStory(newStoryId, { syncStatus: 'offline' });
	}

	await writeImportedStoryProjection(bundle);
	await restoreImportedSettings(bundle.settings);

	return newStoryId;
}
