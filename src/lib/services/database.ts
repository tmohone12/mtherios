/**
 * Mtherios Database — IndexedDB via Dexie.js
 * Replaces Aventuras' Tauri SQLite plugin with browser-native storage.
 * Works on iPhone Safari, Chrome, Firefox — no native dependencies.
 */

import Dexie, { type EntityTable } from 'dexie';
import type {
	Story,
	StoryEntry,
	Character,
	Location,
	Item,
	StoryBeat,
	Chapter,
	Entry,
	EmbeddedImage,
	MemoryConfig,
	StorySettings,
	VisualDescriptors,
	TimeTracker,
	PersistentRetryState,
	PersistentStyleReviewState,
} from '$lib/types';

// ============================================================================
// Database Schema
// ============================================================================

interface MtheriosDB extends Dexie {
	stories: EntityTable<Story, 'id'>;
	storyEntries: EntityTable<StoryEntry, 'id'>;
	characters: EntityTable<Character, 'id'>;
	locations: EntityTable<Location, 'id'>;
	items: EntityTable<Item, 'id'>;
	storyBeats: EntityTable<StoryBeat, 'id'>;
	chapters: EntityTable<Chapter, 'id'>;
	lorebookEntries: EntityTable<Entry, 'id'>;
	embeddedImages: EntityTable<EmbeddedImage, 'id'>;
	appSettings: EntityTable<{ key: string; value: string }, 'key'>;
}

const db = new Dexie('mtherios') as MtheriosDB;

db.version(1).stores({
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
});

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
	await db.transaction('rw', [db.stories, db.storyEntries, db.characters, db.locations, db.items, db.storyBeats, db.chapters, db.lorebookEntries, db.embeddedImages], async () => {
		await db.stories.delete(id);
		await db.storyEntries.where('storyId').equals(id).delete();
		await db.characters.where('storyId').equals(id).delete();
		await db.locations.where('storyId').equals(id).delete();
		await db.items.where('storyId').equals(id).delete();
		await db.storyBeats.where('storyId').equals(id).delete();
		await db.chapters.where('storyId').equals(id).delete();
		await db.lorebookEntries.where('storyId').equals(id).delete();
		await db.embeddedImages.where('storyId').equals(id).delete();
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
// Lorebook Entries CRUD
// ============================================================================

export async function createLorebookEntry(entry: Entry): Promise<void> {
	try {
		await db.lorebookEntries.add(entry);
	} catch (e) {
		console.error('createLorebookEntry failed:', { id: entry.id, storyId: entry.storyId, name: entry.name, type: entry.type }, e);
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

export { db };
export type { MtheriosDB };
