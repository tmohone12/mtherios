/**
 * Mtherios Database — IndexedDB via Dexie.js
 * Replaces Aventuras' Tauri SQLite plugin with browser-native storage.
 * Works on iPhone Safari, Chrome, Firefox — no native dependencies.
 */

import Dexie, { type Table } from 'dexie';
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
	EmbeddedImage,
	MemoryConfig,
	StorySettings,
	VisualDescriptors,
	TimeTracker,
	PersistentRetryState,
	PersistentStyleReviewState,
	ProceduralRule,
	EmbeddingCacheEntry,
	EntryRelationship,
	ConversationMemoryEntry,
	WorldEvent,
	Agreement,
	FactionActionRecord,
	RumorRecord,
} from '$lib/types';

// ============================================================================
// Database Schema
// ============================================================================

interface MtheriosDB extends Dexie {
	stories: Table<Story, string>;
	storyEntries: Table<StoryEntry, string>;
	characters: Table<Character, string>;
	locations: Table<Location, string>;
	items: Table<Item, string>;
	storyBeats: Table<StoryBeat, string>;
	chapters: Table<Chapter, string>;
	lorebookEntries: Table<Entry, string>;
	embeddedImages: Table<EmbeddedImage, string>;
	arcs: Table<Arc, string>;
	proceduralRules: Table<ProceduralRule, string>;
	embeddingCache: Table<EmbeddingCacheEntry, string>;
	entryRelationships: Table<EntryRelationship, string>;
	conversationMemory: Table<ConversationMemoryEntry, string>;
	worldEvents: Table<WorldEvent, string>;
	agreements: Table<Agreement, string>;
	factionActions: Table<FactionActionRecord, string>;
	rumors: Table<RumorRecord, string>;
	appSettings: Table<{ key: string; value: string }, string>;
}

const db = new Dexie('mtherios') as MtheriosDB;

// Version 4: Clean schema with explicit upgrade to clear lorebook issues
db.version(4).stores({
	stories: 'id, title, createdAt, updatedAt',
	storyEntries: 'id, storyId, position, type, [storyId+position], [storyId+branchId+position]',
	characters: 'id, storyId, name, [storyId+name]',
	locations: 'id, storyId, name, [storyId+name]',
	items: 'id, storyId, name, [storyId+name]',
	storyBeats: 'id, storyId, type, status',
	chapters: 'id, storyId, number, [storyId+number]',
	lorebookEntries: 'id, storyId, name, type, [storyId+type]',
	embeddedImages: 'id, storyId, entryId, status, [storyId+entryId]',
	appSettings: 'key',
}).upgrade(async (tx) => {
	console.log('Upgrading to v4 - checking lorebookEntries table');
	// Clear lorebook entries on upgrade to fix any schema issues
	await tx.table('lorebookEntries').clear();
	console.log('Cleared lorebookEntries table during upgrade');
});

db.version(5).stores({
	stories: 'id, title, createdAt, updatedAt',
	storyEntries: 'id, storyId, position, type, [storyId+position], [storyId+branchId+position]',
	characters: 'id, storyId, name, [storyId+name]',
	locations: 'id, storyId, name, [storyId+name]',
	items: 'id, storyId, name, [storyId+name]',
	storyBeats: 'id, storyId, type, status',
	chapters: 'id, storyId, number, [storyId+number]',
	lorebookEntries: 'id, storyId, name, type, [storyId+type]',
	embeddedImages: 'id, storyId, entryId, status, [storyId+entryId]',
	appSettings: 'key',
	arcs: 'id, storyId, arcNumber, [storyId+arcNumber]',
});

// Version 6: Procedural memory + embedding cache (CASS-inspired)
db.version(6).stores({
	stories: 'id, title, createdAt, updatedAt',
	storyEntries: 'id, storyId, position, type, [storyId+position], [storyId+branchId+position]',
	characters: 'id, storyId, name, [storyId+name]',
	locations: 'id, storyId, name, [storyId+name]',
	items: 'id, storyId, name, [storyId+name]',
	storyBeats: 'id, storyId, type, status',
	chapters: 'id, storyId, number, [storyId+number]',
	lorebookEntries: 'id, storyId, name, type, [storyId+type]',
	embeddedImages: 'id, storyId, entryId, status, [storyId+entryId]',
	appSettings: 'key',
	arcs: 'id, storyId, arcNumber, [storyId+arcNumber]',
	proceduralRules: 'id, storyId, category, maturity, [storyId+category], [storyId+maturity]',
	embeddingCache: 'id, sourceId, sourceType, [sourceType+sourceId]',
});

// Version 7: Tier 2 living world — relationships, conversation memory, world events
db.version(7).stores({
	stories: 'id, title, createdAt, updatedAt',
	storyEntries: 'id, storyId, position, type, [storyId+position], [storyId+branchId+position]',
	characters: 'id, storyId, name, [storyId+name]',
	locations: 'id, storyId, name, [storyId+name]',
	items: 'id, storyId, name, [storyId+name]',
	storyBeats: 'id, storyId, type, status',
	chapters: 'id, storyId, number, [storyId+number]',
	lorebookEntries: 'id, storyId, name, type, [storyId+type]',
	embeddedImages: 'id, storyId, entryId, status, [storyId+entryId]',
	appSettings: 'key',
	arcs: 'id, storyId, arcNumber, [storyId+arcNumber]',
	proceduralRules: 'id, storyId, category, maturity, [storyId+category], [storyId+maturity]',
	embeddingCache: 'id, sourceId, sourceType, [sourceType+sourceId]',
	entryRelationships: 'id, storyId, sourceEntryId, targetEntryId, type, [storyId+sourceEntryId], [storyId+targetEntryId]',
	conversationMemory: 'id, storyId, npcEntryId, storyPosition, [storyId+npcEntryId], [storyId+storyPosition]',
	worldEvents: 'id, storyId, triggerPosition, type, [storyId+triggerPosition]',
});

// Version 8: Living-world persistence — agreements, faction-action log, rumor log
db.version(8).stores({
	stories: 'id, title, createdAt, updatedAt',
	storyEntries: 'id, storyId, position, type, [storyId+position], [storyId+branchId+position]',
	characters: 'id, storyId, name, [storyId+name]',
	locations: 'id, storyId, name, [storyId+name]',
	items: 'id, storyId, name, [storyId+name]',
	storyBeats: 'id, storyId, type, status',
	chapters: 'id, storyId, number, [storyId+number]',
	lorebookEntries: 'id, storyId, name, type, [storyId+type]',
	embeddedImages: 'id, storyId, entryId, status, [storyId+entryId]',
	appSettings: 'key',
	arcs: 'id, storyId, arcNumber, [storyId+arcNumber]',
	proceduralRules: 'id, storyId, category, maturity, [storyId+category], [storyId+maturity]',
	embeddingCache: 'id, sourceId, sourceType, [sourceType+sourceId]',
	entryRelationships: 'id, storyId, sourceEntryId, targetEntryId, type, [storyId+sourceEntryId], [storyId+targetEntryId]',
	conversationMemory: 'id, storyId, npcEntryId, storyPosition, [storyId+npcEntryId], [storyId+storyPosition]',
	worldEvents: 'id, storyId, triggerPosition, type, [storyId+triggerPosition]',
	agreements: 'id, storyId, status, category, createdChapterNumber, [storyId+status], [storyId+category]',
	factionActions: 'id, storyId, factionName, chapterNumber, urgency, [storyId+chapterNumber]',
	rumors: 'id, storyId, status, chapterNumber, relatedFaction, [storyId+status]',
});

// Debug function to check DB status
export async function debugDatabaseStatus(): Promise<void> {
	console.log('=== Database Debug Info ===');
	console.log('DB Name:', db.name);
	console.log('DB Version:', db.verno);
	console.log('Is Open:', db.isOpen());
	console.log('Tables:', db.tables.map(t => t.name));
	
	if (db.isOpen()) {
		try {
			const count = await db.lorebookEntries.count();
			console.log('Lorebook entries count:', count);
		} catch (e) {
			console.error('Error counting lorebook entries:', e);
		}
	}
	console.log('=========================');
}

// ============================================================================
// Story CRUD
// ============================================================================

export async function createStory(story: Story): Promise<void> {
	await db.stories.add(story);
}

export async function getStory(id: string): Promise<Story | undefined> {
	return db.stories.get(id);
}

export async function getAllStories(): Promise<Story[]> {
	return db.stories.orderBy('updatedAt').reverse().toArray();
}

export async function updateStory(id: string, updates: Partial<Story>): Promise<void> {
	await db.stories.update(id, { ...updates, updatedAt: Date.now() });
}

export async function deleteStory(id: string): Promise<void> {
	await db.transaction('rw', [db.stories, db.storyEntries, db.characters, db.locations, db.items, db.storyBeats, db.chapters, db.lorebookEntries, db.embeddedImages, db.arcs, db.proceduralRules, db.entryRelationships, db.conversationMemory, db.worldEvents, db.agreements, db.factionActions, db.rumors], async () => {
		await db.stories.delete(id);
		await db.storyEntries.where('storyId').equals(id).delete();
		await db.characters.where('storyId').equals(id).delete();
		await db.locations.where('storyId').equals(id).delete();
		await db.items.where('storyId').equals(id).delete();
		await db.storyBeats.where('storyId').equals(id).delete();
		await db.chapters.where('storyId').equals(id).delete();
		await db.lorebookEntries.where('storyId').equals(id).delete();
		await db.embeddedImages.where('storyId').equals(id).delete();
		await db.arcs.where('storyId').equals(id).delete();
		await db.proceduralRules.where('storyId').equals(id).delete();
		await db.entryRelationships.where('storyId').equals(id).delete();
		await db.conversationMemory.where('storyId').equals(id).delete();
		await db.worldEvents.where('storyId').equals(id).delete();
		await db.agreements.where('storyId').equals(id).delete();
		await db.factionActions.where('storyId').equals(id).delete();
		await db.rumors.where('storyId').equals(id).delete();
	});
}

// ============================================================================
// Story Entries CRUD
// ============================================================================

export async function createStoryEntry(entry: StoryEntry): Promise<void> {
	await db.storyEntries.add(entry);
}

export async function getStoryEntries(storyId: string, branchId?: string | null): Promise<StoryEntry[]> {
	let entries: StoryEntry[];
	if (branchId) {
		entries = await db.storyEntries.where({ storyId, branchId }).sortBy('position');
	} else {
		entries = await db.storyEntries.where('storyId').equals(storyId).sortBy('position');
	}
	return entries;
}

export async function updateStoryEntry(id: string, updates: Partial<StoryEntry>): Promise<void> {
	await db.storyEntries.update(id, updates);
}

export async function deleteStoryEntry(id: string): Promise<void> {
	await db.storyEntries.delete(id);
}

export async function deleteStoryEntriesFromPosition(storyId: string, fromPosition: number): Promise<void> {
	const entries = await db.storyEntries
		.where('storyId').equals(storyId)
		.filter(e => e.position >= fromPosition)
		.toArray();
	await db.storyEntries.bulkDelete(entries.map(e => e.id));
}

// ============================================================================
// Characters CRUD
// ============================================================================

export async function createCharacter(character: Character): Promise<void> {
	await db.characters.add(character);
}

export async function getCharacters(storyId: string): Promise<Character[]> {
	return db.characters.where('storyId').equals(storyId).toArray();
}

export async function updateCharacter(id: string, updates: Partial<Character>): Promise<void> {
	await db.characters.update(id, updates);
}

export async function deleteCharacter(id: string): Promise<void> {
	await db.characters.delete(id);
}

// ============================================================================
// Locations CRUD
// ============================================================================

export async function createLocation(location: Location): Promise<void> {
	await db.locations.add(location);
}

export async function getLocations(storyId: string): Promise<Location[]> {
	return db.locations.where('storyId').equals(storyId).toArray();
}

export async function updateLocation(id: string, updates: Partial<Location>): Promise<void> {
	await db.locations.update(id, updates);
}

export async function deleteLocation(id: string): Promise<void> {
	await db.locations.delete(id);
}

// ============================================================================
// Items CRUD
// ============================================================================

export async function createItem(item: Item): Promise<void> {
	await db.items.add(item);
}

export async function getItems(storyId: string): Promise<Item[]> {
	return db.items.where('storyId').equals(storyId).toArray();
}

export async function updateItem(id: string, updates: Partial<Item>): Promise<void> {
	await db.items.update(id, updates);
}

export async function deleteItem(id: string): Promise<void> {
	await db.items.delete(id);
}

// ============================================================================
// Story Beats CRUD
// ============================================================================

export async function createStoryBeat(beat: StoryBeat): Promise<void> {
	await db.storyBeats.add(beat);
}

export async function getStoryBeats(storyId: string): Promise<StoryBeat[]> {
	return db.storyBeats.where('storyId').equals(storyId).toArray();
}

export async function updateStoryBeat(id: string, updates: Partial<StoryBeat>): Promise<void> {
	await db.storyBeats.update(id, updates);
}

export async function deleteStoryBeat(id: string): Promise<void> {
	await db.storyBeats.delete(id);
}

// ============================================================================
// Chapters CRUD
// ============================================================================

export async function createChapter(chapter: Chapter): Promise<void> {
	await db.chapters.add(chapter);
}

export async function getChapters(storyId: string): Promise<Chapter[]> {
	return db.chapters.where('storyId').equals(storyId).sortBy('number');
}

export async function updateChapter(id: string, updates: Partial<Chapter>): Promise<void> {
	await db.chapters.update(id, updates);
}

export async function deleteChapter(id: string): Promise<void> {
	await db.chapters.delete(id);
}

// ============================================================================
// Arcs CRUD
// ============================================================================

export async function createArc(arc: Arc): Promise<void> {
	await db.arcs.add(arc);
}

export async function getArcs(storyId: string): Promise<Arc[]> {
	return db.arcs.where('storyId').equals(storyId).sortBy('arcNumber');
}

export async function updateArc(id: string, updates: Partial<Arc>): Promise<void> {
	await db.arcs.update(id, updates);
}

export async function deleteArc(id: string): Promise<void> {
	await db.arcs.delete(id);
}

// ============================================================================
// Lorebook Entries CRUD
// ============================================================================

export async function createLorebookEntry(entry: Entry): Promise<void> {
	// Sanitize entry - remove any potential circular refs or undefined values
	const cleanEntry: Entry = JSON.parse(JSON.stringify(entry));
	
	try {
		await db.lorebookEntries.put(cleanEntry);
	} catch (e: unknown) {
		console.error('Lorebook save failed:', e);
		throw e;
	}
}

export async function getLorebookEntries(storyId: string): Promise<Entry[]> {
	return db.lorebookEntries.where('storyId').equals(storyId).toArray();
}

export async function updateLorebookEntry(id: string, updates: Partial<Entry>): Promise<void> {
	await db.lorebookEntries.update(id, updates);
}

export async function deleteLorebookEntry(id: string): Promise<void> {
	await db.lorebookEntries.delete(id);
}

// ============================================================================
// Embedded Images CRUD
// ============================================================================

export async function createEmbeddedImage(image: Omit<EmbeddedImage, 'createdAt'>): Promise<void> {
	await db.embeddedImages.add({ ...image, createdAt: Date.now() } as EmbeddedImage);
}

export async function getEmbeddedImages(storyId: string): Promise<EmbeddedImage[]> {
	return db.embeddedImages.where('storyId').equals(storyId).toArray();
}

export async function getEntryImages(storyId: string, entryId: string): Promise<EmbeddedImage[]> {
	return db.embeddedImages.where({ storyId, entryId }).toArray();
}

export async function updateEmbeddedImage(id: string, updates: Partial<EmbeddedImage>): Promise<void> {
	await db.embeddedImages.update(id, updates);
}

export async function deleteEmbeddedImage(id: string): Promise<void> {
	await db.embeddedImages.delete(id);
}

// ============================================================================
// Procedural Rules CRUD (CASS-inspired)
// ============================================================================

export async function createProceduralRule(rule: ProceduralRule): Promise<void> {
	await db.proceduralRules.put(rule);
}

export async function getProceduralRules(storyId: string): Promise<ProceduralRule[]> {
	return db.proceduralRules.where('storyId').equals(storyId).toArray();
}

export async function getProceduralRulesByCategory(storyId: string, category: string): Promise<ProceduralRule[]> {
	return db.proceduralRules.where({ storyId, category }).toArray();
}

export async function updateProceduralRule(id: string, updates: Partial<ProceduralRule>): Promise<void> {
	await db.proceduralRules.update(id, updates);
}

export async function deleteProceduralRule(id: string): Promise<void> {
	await db.proceduralRules.delete(id);
}

export async function bulkPutProceduralRules(rules: ProceduralRule[]): Promise<void> {
	await db.proceduralRules.bulkPut(rules);
}

// ============================================================================
// Embedding Cache CRUD
// ============================================================================

export async function getEmbedding(sourceType: string, sourceId: string): Promise<EmbeddingCacheEntry | undefined> {
	return db.embeddingCache.where({ sourceType, sourceId }).first();
}

export async function putEmbedding(entry: EmbeddingCacheEntry): Promise<void> {
	await db.embeddingCache.put(entry);
}

export async function getEmbeddingsByType(sourceType: string): Promise<EmbeddingCacheEntry[]> {
	return db.embeddingCache.where('sourceType').equals(sourceType).toArray();
}

export async function deleteEmbedding(id: string): Promise<void> {
	await db.embeddingCache.delete(id);
}

export async function deleteEmbeddingsBySource(sourceType: string, sourceId: string): Promise<void> {
	await db.embeddingCache.where({ sourceType, sourceId }).delete();
}

// ============================================================================
// App Settings
// ============================================================================

export async function getSetting(key: string): Promise<string | undefined> {
	const record = await db.appSettings.get(key);
	return record?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
	await db.appSettings.put({ key, value });
}

export async function deleteSetting(key: string): Promise<void> {
	await db.appSettings.delete(key);
}

export async function getAllSettings(): Promise<Record<string, string>> {
	const records = await db.appSettings.toArray();
	return Object.fromEntries(records.map(r => [r.key, r.value]));
}

// ============================================================================
// Export the database instance
// ============================================================================

// ============================================================================
// Entry Relationships (Tier 2)
// ============================================================================

export async function createEntryRelationship(rel: EntryRelationship): Promise<void> {
	await db.entryRelationships.add(rel);
}

export async function getEntryRelationships(storyId: string): Promise<EntryRelationship[]> {
	return db.entryRelationships.where('storyId').equals(storyId).toArray();
}

export async function getRelationshipsForEntry(storyId: string, entryId: string): Promise<EntryRelationship[]> {
	return db.entryRelationships.where('[storyId+sourceEntryId]').equals([storyId, entryId]).toArray();
}

export async function updateEntryRelationship(id: string, updates: Partial<EntryRelationship>): Promise<void> {
	await db.entryRelationships.update(id, updates);
}

export async function deleteEntryRelationship(id: string): Promise<void> {
	await db.entryRelationships.delete(id);
}

// ============================================================================
// Conversation Memory (Tier 2)
// ============================================================================

export async function createConversationMemory(entry: ConversationMemoryEntry): Promise<void> {
	await db.conversationMemory.add(entry);
}

export async function getConversationMemory(storyId: string): Promise<ConversationMemoryEntry[]> {
	return db.conversationMemory.where('storyId').equals(storyId).toArray();
}

export async function getNpcConversationMemory(storyId: string, npcEntryId: string): Promise<ConversationMemoryEntry[]> {
	return db.conversationMemory.where('[storyId+npcEntryId]').equals([storyId, npcEntryId]).toArray();
}

// ============================================================================
// World Events (Tier 2)
// ============================================================================

export async function createWorldEvent(event: WorldEvent): Promise<void> {
	await db.worldEvents.add(event);
}

export async function getWorldEvents(storyId: string): Promise<WorldEvent[]> {
	return db.worldEvents.where('storyId').equals(storyId).toArray();
}

export async function updateWorldEvent(id: string, updates: Partial<WorldEvent>): Promise<void> {
	await db.worldEvents.update(id, updates);
}

// ============================================================================
// Agreements (v8 — living-world commitments)
// ============================================================================

export async function createAgreement(agreement: Agreement): Promise<void> {
	await db.agreements.add(agreement);
}

export async function getAgreements(storyId: string): Promise<Agreement[]> {
	return db.agreements.where('storyId').equals(storyId).toArray();
}

export async function getAgreementsByStatus(
	storyId: string,
	status: Agreement['status'],
): Promise<Agreement[]> {
	return db.agreements.where({ storyId, status }).toArray();
}

export async function updateAgreement(id: string, updates: Partial<Agreement>): Promise<void> {
	await db.agreements.update(id, updates);
}

export async function deleteAgreement(id: string): Promise<void> {
	await db.agreements.delete(id);
}

// ============================================================================
// Faction Actions (v8 — persisted WorldSim output)
// ============================================================================

export async function createFactionAction(action: FactionActionRecord): Promise<void> {
	await db.factionActions.add(action);
}

export async function bulkPutFactionActions(actions: FactionActionRecord[]): Promise<void> {
	if (actions.length === 0) return;
	await db.factionActions.bulkPut(actions);
}

export async function getFactionActions(storyId: string): Promise<FactionActionRecord[]> {
	return db.factionActions.where('storyId').equals(storyId).toArray();
}

export async function getFactionActionsByFaction(
	storyId: string,
	factionName: string,
): Promise<FactionActionRecord[]> {
	return db.factionActions
		.where('storyId')
		.equals(storyId)
		.and((a) => a.factionName === factionName)
		.toArray();
}

export async function updateFactionAction(
	id: string,
	updates: Partial<FactionActionRecord>,
): Promise<void> {
	await db.factionActions.update(id, updates);
}

// ============================================================================
// Rumors (v8 — persisted WorldSim output)
// ============================================================================

export async function createRumor(rumor: RumorRecord): Promise<void> {
	await db.rumors.add(rumor);
}

export async function bulkPutRumors(rumors: RumorRecord[]): Promise<void> {
	if (rumors.length === 0) return;
	await db.rumors.bulkPut(rumors);
}

export async function getRumors(storyId: string): Promise<RumorRecord[]> {
	return db.rumors.where('storyId').equals(storyId).toArray();
}

export async function getRumorsByStatus(
	storyId: string,
	status: RumorRecord['status'],
): Promise<RumorRecord[]> {
	return db.rumors.where({ storyId, status }).toArray();
}

export async function updateRumor(id: string, updates: Partial<RumorRecord>): Promise<void> {
	await db.rumors.update(id, updates);
}

export { db };
export type { MtheriosDB };
