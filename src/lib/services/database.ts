/**
 * Mtherios Database — IndexedDB via Dexie.js
 * Replaces Aventuras' Tauri SQLite plugin with browser-native storage.
 * Works on iPhone Safari, Chrome, Firefox — no native dependencies.
 */

import Dexie, { type Table, type UpdateSpec } from 'dexie';
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
	Scheme,
	StoryThread,
	SyncOutboxOp,
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
	sagas: Table<Saga, string>;
	proceduralRules: Table<ProceduralRule, string>;
	embeddingCache: Table<EmbeddingCacheEntry, string>;
	entryRelationships: Table<EntryRelationship, string>;
	conversationMemory: Table<ConversationMemoryEntry, string>;
	worldEvents: Table<WorldEvent, string>;
	agreements: Table<Agreement, string>;
	factionActions: Table<FactionActionRecord, string>;
	rumors: Table<RumorRecord, string>;
	schemes: Table<Scheme, string>;
	storyThreads: Table<StoryThread, string>;
	syncOutbox: Table<SyncOutboxOp, string>;
	appSettings: Table<{ key: string; value: string }, string>;
}

const db = new Dexie('mtherios') as MtheriosDB;

function toIndexedDbValue<T>(value: T): T {
	if (value === null || value === undefined) return value;
	try {
		return structuredClone(value);
	} catch {
		const seen = new WeakSet<object>();
		const json = JSON.stringify(value, (_key, nested) => {
			if (typeof nested === 'function' || typeof nested === 'symbol') return undefined;
			if (typeof nested === 'bigint') return nested.toString();
			if (nested && typeof nested === 'object') {
				if (seen.has(nested)) return undefined;
				seen.add(nested);
			}
			return nested;
		});
		if (json === undefined) return undefined as T;
		return JSON.parse(json) as T;
	}
}

async function addRecord<T>(table: Table<T, string>, value: T): Promise<void> {
	await table.add(toIndexedDbValue(value));
}

async function putRecord<T>(table: Table<T, string>, value: T): Promise<void> {
	await table.put(toIndexedDbValue(value));
}

async function bulkPutRecords<T>(table: Table<T, string>, values: T[]): Promise<void> {
	if (values.length === 0) return;
	await table.bulkPut(values.map((value) => toIndexedDbValue(value)));
}

async function updateRecord<T>(table: Table<T, string>, id: string, updates: Partial<T>): Promise<void> {
	await table.update(id, toIndexedDbValue(updates) as UpdateSpec<T>);
}

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

// Version 9: Antagonist + player schemes (multi-stage plans with proactive injection)
db.version(9).stores({
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
	schemes: 'id, storyId, status, ownerType, ownerEntryId, branchId, [storyId+status], [storyId+ownerType], [storyId+branchId]',
});

// Version 10: Structured story threads with lifecycle
db.version(10).stores({
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
	schemes: 'id, storyId, status, ownerType, ownerEntryId, branchId, [storyId+status], [storyId+ownerType], [storyId+branchId]',
	storyThreads: 'id, storyId, status, significance, [storyId+status], [storyId+significance]',
});

// Version 11: Backend sync outbox. Browser writes become replayable ops when a
// story is bound to canonical Postgres storage.
db.version(11).stores({
	stories: 'id, title, createdAt, updatedAt, serverStoryId, serverVersion',
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
	schemes: 'id, storyId, status, ownerType, ownerEntryId, branchId, [storyId+status], [storyId+ownerType], [storyId+branchId]',
	storyThreads: 'id, storyId, status, significance, [storyId+status], [storyId+significance]',
	syncOutbox: 'id, storyId, serverStoryId, status, createdAt, [storyId+status]',
});

// Version 12: Saga condensation layer above arcs.
db.version(12).stores({
	stories: 'id, title, createdAt, updatedAt, serverStoryId, serverVersion',
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
	sagas: 'id, storyId, sagaNumber, [storyId+sagaNumber]',
	proceduralRules: 'id, storyId, category, maturity, [storyId+category], [storyId+maturity]',
	embeddingCache: 'id, sourceId, sourceType, [sourceType+sourceId]',
	entryRelationships: 'id, storyId, sourceEntryId, targetEntryId, type, [storyId+sourceEntryId], [storyId+targetEntryId]',
	conversationMemory: 'id, storyId, npcEntryId, storyPosition, [storyId+npcEntryId], [storyId+storyPosition]',
	worldEvents: 'id, storyId, triggerPosition, type, [storyId+triggerPosition]',
	agreements: 'id, storyId, status, category, createdChapterNumber, [storyId+status], [storyId+category]',
	factionActions: 'id, storyId, factionName, chapterNumber, urgency, [storyId+chapterNumber]',
	rumors: 'id, storyId, status, chapterNumber, relatedFaction, [storyId+status]',
	schemes: 'id, storyId, status, ownerType, ownerEntryId, branchId, [storyId+status], [storyId+ownerType], [storyId+branchId]',
	storyThreads: 'id, storyId, status, significance, [storyId+status], [storyId+significance]',
	syncOutbox: 'id, storyId, serverStoryId, status, createdAt, [storyId+status]',
});

// Version 13: First-class shelves. Existing cached stories are attached to
// the compatibility shelf used by the terminal backend migration.
db.version(13).stores({
	stories: 'id, shelfId, title, createdAt, updatedAt, serverStoryId, serverVersion, [shelfId+updatedAt]',
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
	sagas: 'id, storyId, sagaNumber, [storyId+sagaNumber]',
	proceduralRules: 'id, storyId, category, maturity, [storyId+category], [storyId+maturity]',
	embeddingCache: 'id, sourceId, sourceType, [sourceType+sourceId]',
	entryRelationships: 'id, storyId, sourceEntryId, targetEntryId, type, [storyId+sourceEntryId], [storyId+targetEntryId]',
	conversationMemory: 'id, storyId, npcEntryId, storyPosition, [storyId+npcEntryId], [storyId+storyPosition]',
	worldEvents: 'id, storyId, triggerPosition, type, [storyId+triggerPosition]',
	agreements: 'id, storyId, status, category, createdChapterNumber, [storyId+status], [storyId+category]',
	factionActions: 'id, storyId, factionName, chapterNumber, urgency, [storyId+chapterNumber]',
	rumors: 'id, storyId, status, chapterNumber, relatedFaction, [storyId+status]',
	schemes: 'id, storyId, status, ownerType, ownerEntryId, branchId, [storyId+status], [storyId+ownerType], [storyId+branchId]',
	storyThreads: 'id, storyId, status, significance, [storyId+status], [storyId+significance]',
	syncOutbox: 'id, storyId, serverStoryId, status, createdAt, [storyId+status]',
}).upgrade(async (tx) => {
	await tx.table('stories').toCollection().modify((story) => {
		story.shelfId ??= 'shelf_default';
	});
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
	await addRecord(db.stories, story);
}

export async function getStory(id: string): Promise<Story | undefined> {
	return db.stories.get(id);
}

export async function getAllStories(): Promise<Story[]> {
	return db.stories.orderBy('updatedAt').reverse().toArray();
}

export async function updateStory(id: string, updates: Partial<Story>): Promise<void> {
	await updateRecord(db.stories, id, { ...updates, updatedAt: Date.now() });
}

export async function deleteStory(id: string): Promise<void> {
	await db.transaction('rw', [
		db.stories,
		db.storyEntries,
		db.characters,
		db.locations,
		db.items,
		db.storyBeats,
		db.chapters,
		db.lorebookEntries,
		db.embeddedImages,
		db.arcs,
		db.sagas,
		db.proceduralRules,
		db.embeddingCache,
		db.entryRelationships,
		db.conversationMemory,
		db.worldEvents,
		db.agreements,
		db.factionActions,
		db.rumors,
		db.schemes,
		db.storyThreads,
		db.syncOutbox,
	], async () => {
		const [chapterIds, lorebookEntryIds] = await Promise.all([
			db.chapters.where('storyId').equals(id).primaryKeys(),
			db.lorebookEntries.where('storyId').equals(id).primaryKeys(),
		]);
		const embeddedSourceIds = new Set<string>([...chapterIds, ...lorebookEntryIds].map(String));

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
		await db.sagas.where('storyId').equals(id).delete();
		await db.proceduralRules.where('storyId').equals(id).delete();
		if (embeddedSourceIds.size > 0) {
			await db.embeddingCache.filter(e => embeddedSourceIds.has(e.sourceId)).delete();
		}
		await db.entryRelationships.where('storyId').equals(id).delete();
		await db.conversationMemory.where('storyId').equals(id).delete();
		await db.worldEvents.where('storyId').equals(id).delete();
		await db.agreements.where('storyId').equals(id).delete();
		await db.factionActions.where('storyId').equals(id).delete();
		await db.rumors.where('storyId').equals(id).delete();
		await db.schemes.where('storyId').equals(id).delete();
		await db.storyThreads.where('storyId').equals(id).delete();
		await db.syncOutbox.where('storyId').equals(id).delete();
	});
}

// ============================================================================
// Story Entries CRUD
// ============================================================================

export async function createStoryEntry(entry: StoryEntry): Promise<void> {
	await addRecord(db.storyEntries, entry);
}

export async function putStoryEntry(entry: StoryEntry): Promise<void> {
	await putRecord(db.storyEntries, entry);
}

export async function getStoryEntry(id: string): Promise<StoryEntry | undefined> {
	return db.storyEntries.get(id);
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

export async function countStoryEntries(storyId: string, branchId?: string | null): Promise<number> {
	if (branchId) {
		return db.storyEntries.where({ storyId, branchId }).count();
	}
	return db.storyEntries.where('storyId').equals(storyId).count();
}

export async function getRecentStoryEntries(
	storyId: string,
	limit: number,
	branchId?: string | null,
): Promise<StoryEntry[]> {
	if (limit <= 0) return [];
	const entries = branchId
		? await db.storyEntries
			.where('[storyId+branchId+position]')
			.between([storyId, branchId, Dexie.minKey], [storyId, branchId, Dexie.maxKey])
			.reverse()
			.limit(limit)
			.toArray()
		: await db.storyEntries
			.where('[storyId+position]')
			.between([storyId, Dexie.minKey], [storyId, Dexie.maxKey])
			.reverse()
			.limit(limit)
			.toArray();
	return entries.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
}

export async function getStoryEntriesAfterPosition(
	storyId: string,
	afterPosition: number,
	limit: number,
	branchId?: string | null,
): Promise<StoryEntry[]> {
	if (limit <= 0) return [];
	const entries = branchId
		? await db.storyEntries
			.where('[storyId+branchId+position]')
			.between([storyId, branchId, afterPosition], [storyId, branchId, Dexie.maxKey], false, true)
			.limit(limit)
			.toArray()
		: await db.storyEntries
			.where('[storyId+position]')
			.between([storyId, afterPosition], [storyId, Dexie.maxKey], false, true)
			.limit(limit)
			.toArray();
	return entries.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
}

export async function getStoryEntriesBeforePosition(
	storyId: string,
	beforePosition: number,
	limit: number,
	branchId?: string | null,
): Promise<StoryEntry[]> {
	if (limit <= 0) return [];
	const entries = branchId
		? await db.storyEntries
			.where('[storyId+branchId+position]')
			.between([storyId, branchId, Dexie.minKey], [storyId, branchId, beforePosition], true, false)
			.reverse()
			.limit(limit)
			.toArray()
		: await db.storyEntries
			.where('[storyId+position]')
			.between([storyId, Dexie.minKey], [storyId, beforePosition], true, false)
			.reverse()
			.limit(limit)
			.toArray();
	return entries.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
}

export async function getLastStoryEntryPosition(storyId: string, branchId?: string | null): Promise<number> {
	const latest = await getRecentStoryEntries(storyId, 1, branchId);
	return latest[0]?.position ?? -1;
}

export async function updateStoryEntry(id: string, updates: Partial<StoryEntry>): Promise<void> {
	await updateRecord(db.storyEntries, id, updates);
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
	await addRecord(db.characters, character);
}

export async function putCharacter(character: Character): Promise<void> {
	await putRecord(db.characters, character);
}

export async function getCharacters(storyId: string): Promise<Character[]> {
	return db.characters.where('storyId').equals(storyId).toArray();
}

export async function updateCharacter(id: string, updates: Partial<Character>): Promise<void> {
	await updateRecord(db.characters, id, updates);
}

export async function deleteCharacter(id: string): Promise<void> {
	await db.characters.delete(id);
}

// ============================================================================
// Locations CRUD
// ============================================================================

export async function createLocation(location: Location): Promise<void> {
	await addRecord(db.locations, location);
}

export async function putLocation(location: Location): Promise<void> {
	await putRecord(db.locations, location);
}

export async function getLocations(storyId: string): Promise<Location[]> {
	return db.locations.where('storyId').equals(storyId).toArray();
}

export async function updateLocation(id: string, updates: Partial<Location>): Promise<void> {
	await updateRecord(db.locations, id, updates);
}

export async function deleteLocation(id: string): Promise<void> {
	await db.locations.delete(id);
}

// ============================================================================
// Items CRUD
// ============================================================================

export async function createItem(item: Item): Promise<void> {
	await addRecord(db.items, item);
}

export async function putItem(item: Item): Promise<void> {
	await putRecord(db.items, item);
}

export async function getItems(storyId: string): Promise<Item[]> {
	return db.items.where('storyId').equals(storyId).toArray();
}

export async function updateItem(id: string, updates: Partial<Item>): Promise<void> {
	await updateRecord(db.items, id, updates);
}

export async function deleteItem(id: string): Promise<void> {
	await db.items.delete(id);
}

// ============================================================================
// Story Beats CRUD
// ============================================================================

export async function createStoryBeat(beat: StoryBeat): Promise<void> {
	await addRecord(db.storyBeats, beat);
}

export async function getStoryBeats(storyId: string): Promise<StoryBeat[]> {
	return db.storyBeats.where('storyId').equals(storyId).toArray();
}

export async function updateStoryBeat(id: string, updates: Partial<StoryBeat>): Promise<void> {
	await updateRecord(db.storyBeats, id, updates);
}

export async function deleteStoryBeat(id: string): Promise<void> {
	await db.storyBeats.delete(id);
}

// ============================================================================
// Chapters CRUD
// ============================================================================

export async function createChapter(chapter: Chapter): Promise<void> {
	await addRecord(db.chapters, chapter);
}

export async function putChapter(chapter: Chapter): Promise<void> {
	await putRecord(db.chapters, chapter);
}

export async function getChapters(storyId: string): Promise<Chapter[]> {
	return db.chapters.where('storyId').equals(storyId).sortBy('number');
}

export async function updateChapter(id: string, updates: Partial<Chapter>): Promise<void> {
	await updateRecord(db.chapters, id, updates);
}

export async function deleteChapter(id: string): Promise<void> {
	await db.chapters.delete(id);
}

// ============================================================================
// Arcs CRUD
// ============================================================================

export async function createArc(arc: Arc): Promise<void> {
	await addRecord(db.arcs, arc);
}

export async function putArc(arc: Arc): Promise<void> {
	await putRecord(db.arcs, arc);
}

export async function getArcs(storyId: string): Promise<Arc[]> {
	return db.arcs.where('storyId').equals(storyId).sortBy('arcNumber');
}

export async function updateArc(id: string, updates: Partial<Arc>): Promise<void> {
	await updateRecord(db.arcs, id, updates);
}

export async function deleteArc(id: string): Promise<void> {
	await db.arcs.delete(id);
}

// ============================================================================
// Sagas CRUD
// ============================================================================

export async function createSaga(saga: Saga): Promise<void> {
	await addRecord(db.sagas, saga);
}

export async function putSaga(saga: Saga): Promise<void> {
	await putRecord(db.sagas, saga);
}

export async function getSagas(storyId: string): Promise<Saga[]> {
	return db.sagas.where('storyId').equals(storyId).sortBy('sagaNumber');
}

export async function updateSaga(id: string, updates: Partial<Saga>): Promise<void> {
	await updateRecord(db.sagas, id, updates);
}

export async function deleteSaga(id: string): Promise<void> {
	await db.sagas.delete(id);
}

// ============================================================================
// Lorebook Entries CRUD
// ============================================================================

export async function createLorebookEntry(entry: Entry): Promise<void> {
	// Sanitize entry - remove any potential circular refs or undefined values
	const cleanEntry: Entry = JSON.parse(JSON.stringify(entry));
	
	try {
		await putRecord(db.lorebookEntries, cleanEntry);
	} catch (e: unknown) {
		console.error('Lorebook save failed:', e);
		throw e;
	}
}

export async function putLorebookEntry(entry: Entry): Promise<void> {
	const cleanEntry: Entry = JSON.parse(JSON.stringify(entry));
	await putRecord(db.lorebookEntries, cleanEntry);
}

export async function getLorebookEntries(storyId: string): Promise<Entry[]> {
	return db.lorebookEntries.where('storyId').equals(storyId).toArray();
}

export async function getLorebookEntry(id: string): Promise<Entry | undefined> {
	return db.lorebookEntries.get(id);
}

export async function updateLorebookEntry(id: string, updates: Partial<Entry>): Promise<void> {
	// Sanitize through JSON to strip Svelte 5 reactive proxies, undefineds, and
	// circular refs before handing the payload to Dexie. Without this, edits made
	// via $state-bound forms can silently fail to persist
	// because the structuredClone path chokes on proxy objects. Mirrors the
	// treatment in createLorebookEntry above.
	const clean: Partial<Entry> = JSON.parse(JSON.stringify(updates));
	await updateRecord(db.lorebookEntries, id, clean);
}

export async function deleteLorebookEntry(id: string): Promise<void> {
	await db.lorebookEntries.delete(id);
}

// ============================================================================
// Embedded Images CRUD
// ============================================================================

export async function createEmbeddedImage(image: Omit<EmbeddedImage, 'createdAt'>): Promise<void> {
	await addRecord(db.embeddedImages, { ...image, createdAt: Date.now() } as EmbeddedImage);
}

export async function getEmbeddedImages(storyId: string): Promise<EmbeddedImage[]> {
	return db.embeddedImages.where('storyId').equals(storyId).toArray();
}

export async function getEntryImages(storyId: string, entryId: string): Promise<EmbeddedImage[]> {
	return db.embeddedImages.where({ storyId, entryId }).toArray();
}

export async function getEmbeddedImagesForEntryIds(storyId: string, entryIds: string[]): Promise<EmbeddedImage[]> {
	const uniqueIds = [...new Set(entryIds.filter(Boolean))];
	if (uniqueIds.length === 0) return [];
	const groups = await Promise.all(uniqueIds.map((entryId) => getEntryImages(storyId, entryId)));
	return groups.flat();
}

export async function updateEmbeddedImage(id: string, updates: Partial<EmbeddedImage>): Promise<void> {
	await updateRecord(db.embeddedImages, id, updates);
}

export async function deleteEmbeddedImage(id: string): Promise<void> {
	await db.embeddedImages.delete(id);
}

// ============================================================================
// Procedural Rules CRUD (CASS-inspired)
// ============================================================================

export async function createProceduralRule(rule: ProceduralRule): Promise<void> {
	await putRecord(db.proceduralRules, rule);
}

export async function getProceduralRules(storyId: string): Promise<ProceduralRule[]> {
	return db.proceduralRules.where('storyId').equals(storyId).toArray();
}

export async function getProceduralRulesByCategory(storyId: string, category: string): Promise<ProceduralRule[]> {
	return db.proceduralRules.where({ storyId, category }).toArray();
}

export async function updateProceduralRule(id: string, updates: Partial<ProceduralRule>): Promise<void> {
	await updateRecord(db.proceduralRules, id, updates);
}

export async function deleteProceduralRule(id: string): Promise<void> {
	await db.proceduralRules.delete(id);
}

export async function bulkPutProceduralRules(rules: ProceduralRule[]): Promise<void> {
	await bulkPutRecords(db.proceduralRules, rules);
}

// ============================================================================
// Embedding Cache CRUD
// ============================================================================

export async function getEmbedding(sourceType: string, sourceId: string): Promise<EmbeddingCacheEntry | undefined> {
	return db.embeddingCache.where({ sourceType, sourceId }).first();
}

export async function putEmbedding(entry: EmbeddingCacheEntry): Promise<void> {
	await putRecord(db.embeddingCache, entry);
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
	await putRecord(db.appSettings, { key, value });
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
	await addRecord(db.entryRelationships, rel);
}

export async function getEntryRelationships(storyId: string): Promise<EntryRelationship[]> {
	return db.entryRelationships.where('storyId').equals(storyId).toArray();
}

export async function getRelationshipsForEntry(storyId: string, entryId: string): Promise<EntryRelationship[]> {
	return db.entryRelationships.where('[storyId+sourceEntryId]').equals([storyId, entryId]).toArray();
}

export async function updateEntryRelationship(id: string, updates: Partial<EntryRelationship>): Promise<void> {
	await updateRecord(db.entryRelationships, id, updates);
}

export async function deleteEntryRelationship(id: string): Promise<void> {
	await db.entryRelationships.delete(id);
}

// ============================================================================
// Conversation Memory (Tier 2)
// ============================================================================

export async function createConversationMemory(entry: ConversationMemoryEntry): Promise<void> {
	await addRecord(db.conversationMemory, entry);
}

export async function putConversationMemory(entry: ConversationMemoryEntry): Promise<void> {
	await putRecord(db.conversationMemory, entry);
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
	await addRecord(db.worldEvents, event);
}

export async function putWorldEvent(event: WorldEvent): Promise<void> {
	await putRecord(db.worldEvents, event);
}

export async function getWorldEvents(storyId: string): Promise<WorldEvent[]> {
	return db.worldEvents.where('storyId').equals(storyId).toArray();
}

export async function updateWorldEvent(id: string, updates: Partial<WorldEvent>): Promise<void> {
	await updateRecord(db.worldEvents, id, updates);
}

// ============================================================================
// Agreements (v8 — living-world commitments)
// ============================================================================

export async function createAgreement(agreement: Agreement): Promise<void> {
	await addRecord(db.agreements, agreement);
}

export async function putAgreement(agreement: Agreement): Promise<void> {
	await putRecord(db.agreements, agreement);
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
	await updateRecord(db.agreements, id, updates);
}

export async function deleteAgreement(id: string): Promise<void> {
	await db.agreements.delete(id);
}

// ============================================================================
// Faction Actions (v8 — persisted WorldSim output)
// ============================================================================

export async function createFactionAction(action: FactionActionRecord): Promise<void> {
	await addRecord(db.factionActions, action);
}

export async function bulkPutFactionActions(actions: FactionActionRecord[]): Promise<void> {
	await bulkPutRecords(db.factionActions, actions);
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
	await updateRecord(db.factionActions, id, updates);
}

// ============================================================================
// Rumors (v8 — persisted WorldSim output)
// ============================================================================

export async function createRumor(rumor: RumorRecord): Promise<void> {
	await addRecord(db.rumors, rumor);
}

export async function bulkPutRumors(rumors: RumorRecord[]): Promise<void> {
	await bulkPutRecords(db.rumors, rumors);
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
	await updateRecord(db.rumors, id, updates);
}

// ============================================================================
// Schemes (v9 — multi-stage antagonist + player plans)
// ============================================================================

export async function createScheme(scheme: Scheme): Promise<void> {
	await addRecord(db.schemes, scheme);
}

export async function bulkPutSchemes(schemes: Scheme[]): Promise<void> {
	await bulkPutRecords(db.schemes, schemes);
}

export async function getSchemes(storyId: string): Promise<Scheme[]> {
	return db.schemes.where('storyId').equals(storyId).toArray();
}

export async function getActiveSchemes(storyId: string): Promise<Scheme[]> {
	return db.schemes
		.where('storyId').equals(storyId)
		.and(s => s.status === 'active' || s.status === 'climaxing' || s.status === 'incubating')
		.toArray();
}

export async function updateScheme(id: string, updates: Partial<Scheme>): Promise<void> {
	await updateRecord(db.schemes, id, updates);
}

export async function deleteScheme(id: string): Promise<void> {
	await db.schemes.delete(id);
}

// ============================================================================
// Story Threads (v10 — structured plot thread lifecycle)
// ============================================================================

export async function createStoryThread(thread: StoryThread): Promise<void> {
	await addRecord(db.storyThreads, thread);
}

export async function putStoryThread(thread: StoryThread): Promise<void> {
	await putRecord(db.storyThreads, thread);
}

export async function getStoryThreads(storyId: string): Promise<StoryThread[]> {
	return db.storyThreads.where('storyId').equals(storyId).toArray();
}

export async function getStoryThreadsByStatus(
	storyId: string,
	status: StoryThread['status'],
): Promise<StoryThread[]> {
	return db.storyThreads.where({ storyId, status }).toArray();
}

export async function updateStoryThread(id: string, updates: Partial<StoryThread>): Promise<void> {
	await updateRecord(db.storyThreads, id, updates);
}

export async function deleteStoryThread(id: string): Promise<void> {
	await db.storyThreads.delete(id);
}

// ============================================================================
// Backend Sync Outbox
// ============================================================================

export async function enqueueSyncOp(op: SyncOutboxOp): Promise<void> {
	await putRecord(db.syncOutbox, op);
}

export async function getPendingSyncOps(storyId: string): Promise<SyncOutboxOp[]> {
	const retryCutoff = Date.now() - 30_000;
	const rows = await db.syncOutbox
		.where('storyId')
		.equals(storyId)
		.toArray();
	return rows
		.filter((op) => op.status === 'pending' || (op.status === 'pushing' && op.updatedAt < retryCutoff))
		.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getSyncOpsForStory(storyId: string): Promise<SyncOutboxOp[]> {
	const rows = await db.syncOutbox
		.where('storyId')
		.equals(storyId)
		.toArray();
	return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function updateSyncOp(id: string, updates: Partial<SyncOutboxOp>): Promise<void> {
	await updateRecord(db.syncOutbox, id, { ...updates, updatedAt: Date.now() });
}

export async function deleteSyncOp(id: string): Promise<void> {
	await db.syncOutbox.delete(id);
}

export { db };
export type { MtheriosDB };
