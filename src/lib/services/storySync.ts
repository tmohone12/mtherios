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
	getEntryRelationships,
	getConversationMemory,
	getWorldEvents,
	getAgreements,
	getFactionActions,
	getRumors,
	getSchemes,
	getStoryThreads,
	getStrategicWorldFrames,
	getSetting,
	setSetting,
	createStory,
	createStoryEntry,
	createCharacter,
	createLocation,
	createItem,
	createStoryBeat,
	createChapter,
	createLorebookEntry,
	createArc,
	createStrategicWorldFrame,
} from '$lib/services/database';
import type {
	Story,
	StoryEntry,
	Character,
	Location,
	Item,
	StoryBeat,
	Chapter,
	Arc,
	Entry,
	EntryRelationship,
	ConversationMemoryEntry,
	WorldEvent,
	Agreement,
	FactionActionRecord,
	RumorRecord,
	Scheme,
	StoryThread,
	StrategicWorldFrame,
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
	story: Story;
	storyEntries: StoryEntry[];
	characters: Character[];
	locations: Location[];
	items: Item[];
	storyBeats: StoryBeat[];
	chapters: Chapter[];
	lorebookEntries: Entry[];
	arcs: Arc[];
	entryRelationships?: EntryRelationship[];
	conversationMemory?: ConversationMemoryEntry[];
	worldEvents?: WorldEvent[];
	agreements?: Agreement[];
	factionActions?: FactionActionRecord[];
	rumors?: RumorRecord[];
	schemes?: Scheme[];
	storyThreads?: StoryThread[];
	strategicWorldFrames?: StrategicWorldFrame[];
	/** API profiles & service configs — lets the other device connect without re-setup. */
	settings?: ExportedSettings;
}

// ============================================================================
// Export
// ============================================================================

export async function exportStory(storyId: string): Promise<StoryExportData> {
	const story = await getStory(storyId);
	if (!story) throw new Error(`Story not found: ${storyId}`);

	const [
		storyEntries,
		characters,
		locations,
		items,
		storyBeats,
		chapters,
		lorebookEntries,
		arcs,
		entryRelationships,
		conversationMemory,
		worldEvents,
		agreements,
		factionActions,
		rumors,
		schemes,
		storyThreads,
		strategicWorldFrames,
	] = await Promise.all([
		getStoryEntries(storyId),
		getCharacters(storyId),
		getLocations(storyId),
		getItems(storyId),
		getStoryBeats(storyId),
		getChapters(storyId),
		getLorebookEntries(storyId),
		getArcs(storyId),
		getEntryRelationships(storyId),
		getConversationMemory(storyId),
		getWorldEvents(storyId),
		getAgreements(storyId),
		getFactionActions(storyId),
		getRumors(storyId),
		getSchemes(storyId),
		getStoryThreads(storyId),
		getStrategicWorldFrames(storyId),
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
		entryRelationships,
		conversationMemory,
		worldEvents,
		agreements,
		factionActions,
		rumors,
		schemes,
		storyThreads,
		strategicWorldFrames,
		settings: Object.keys(settings).length > 0 ? settings : undefined,
	};
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

	// Generate new IDs
	const newStoryId = newId();
	const idMap = new Map<string, string>();
	idMap.set(data.story.id, newStoryId);

	const remap = (oldId: string): string => {
		if (!oldId) return oldId;
		let mapped = idMap.get(oldId);
		if (!mapped) {
			mapped = newId();
			idMap.set(oldId, mapped);
		}
		return mapped;
	};

	// Story
	const now = Date.now();
	const story: Story = {
		...data.story,
		id: newStoryId,
		createdAt: now,
		updatedAt: now,
	};
	await createStory(story);

	// Story entries
	for (const entry of data.storyEntries) {
		const mapped: StoryEntry = {
			...entry,
			id: remap(entry.id),
			storyId: newStoryId,
			parentId: entry.parentId ? remap(entry.parentId) : null,
			branchId: entry.branchId ? remap(entry.branchId) : null,
		};
		await createStoryEntry(mapped);
	}

	// Characters
	for (const c of data.characters) {
		const mapped: Character = {
			...c,
			id: remap(c.id),
			storyId: newStoryId,
			branchId: c.branchId ? remap(c.branchId) : null,
			overridesId: c.overridesId ? remap(c.overridesId) : null,
		};
		await createCharacter(mapped);
	}

	// Locations
	for (const l of data.locations) {
		const mapped: Location = {
			...l,
			id: remap(l.id),
			storyId: newStoryId,
			branchId: l.branchId ? remap(l.branchId) : null,
			overridesId: l.overridesId ? remap(l.overridesId) : null,
		};
		await createLocation(mapped);
	}

	// Items
	for (const i of data.items) {
		const mapped: Item = {
			...i,
			id: remap(i.id),
			storyId: newStoryId,
			branchId: i.branchId ? remap(i.branchId) : null,
			overridesId: i.overridesId ? remap(i.overridesId) : null,
		};
		await createItem(mapped);
	}

	// Story beats
	for (const b of data.storyBeats) {
		const mapped: StoryBeat = {
			...b,
			id: remap(b.id),
			storyId: newStoryId,
			branchId: b.branchId ? remap(b.branchId) : null,
			overridesId: b.overridesId ? remap(b.overridesId) : null,
		};
		await createStoryBeat(mapped);
	}

	// Chapters
	for (const ch of data.chapters) {
		const mapped: Chapter = {
			...ch,
			id: remap(ch.id),
			storyId: newStoryId,
			startEntryId: remap(ch.startEntryId),
			endEntryId: remap(ch.endEntryId),
			branchId: ch.branchId ? remap(ch.branchId) : null,
		};
		await createChapter(mapped);
	}

	// Lorebook entries
	for (const le of data.lorebookEntries) {
		const mapped: Entry = {
			...le,
			id: remap(le.id),
			storyId: newStoryId,
			firstMentioned: le.firstMentioned ? remap(le.firstMentioned) : null,
			lastMentioned: le.lastMentioned ? remap(le.lastMentioned) : null,
			branchId: le.branchId ? remap(le.branchId) : null,
			overridesId: le.overridesId ? remap(le.overridesId) : null,
		};
		await createLorebookEntry(mapped);
	}

	// Arcs
	if (data.arcs) {
		for (const arc of data.arcs) {
			const mapped: Arc = {
				...arc,
				id: remap(arc.id),
				storyId: newStoryId,
				chapterIds: arc.chapterIds.map(cid => remap(cid)),
				branchId: arc.branchId ? remap(arc.branchId) : null,
			};
			await createArc(mapped);
		}
	}

	if (data.strategicWorldFrames) {
		for (const frame of data.strategicWorldFrames) {
			const mapped: StrategicWorldFrame = {
				...frame,
				id: remap(frame.id),
				storyId: newStoryId,
				arcId: frame.arcId ? remap(frame.arcId) : null,
			};
			await createStrategicWorldFrame(mapped);
		}
	}

	// Restore API settings if this device has none configured
	if (data.settings) {
		const existingProfiles = await getSetting('apiProfiles');
		if (!existingProfiles && data.settings.apiProfiles) {
			await setSetting('apiProfiles', data.settings.apiProfiles);
			if (data.settings.activeProfileId) {
				await setSetting('activeProfileId', data.settings.activeProfileId);
			}
			if (data.settings.narrativeModel) {
				await setSetting('narrativeModel', data.settings.narrativeModel);
			}
			if (data.settings.serviceConfigs) {
				await setSetting('serviceConfigs', data.settings.serviceConfigs);
			}
			// Mark onboarding complete so the wizard doesn't re-trigger
			await setSetting('onboardingComplete', 'true');
		}
	}

	return newStoryId;
}
