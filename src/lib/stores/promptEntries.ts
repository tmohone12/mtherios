import type { StoryEntry } from '$lib/types';

export const DEFAULT_PROMPT_ENTRY_WINDOW = 120;
export const DEFAULT_CONTROL_SURFACE_ENTRY_WINDOW = 240;

function compareEntries(a: StoryEntry, b: StoryEntry): number {
	return a.position - b.position || a.createdAt - b.createdAt;
}

export function sortPromptEntries(entries: StoryEntry[]): StoryEntry[] {
	return [...entries].sort(compareEntries);
}

export function mergePromptEntryWindow(
	current: StoryEntry[],
	incoming: StoryEntry[],
	limit = DEFAULT_PROMPT_ENTRY_WINDOW,
): StoryEntry[] {
	const max = Math.max(0, Math.trunc(limit));
	if (max === 0) return [];
	const byId = new Map<string, StoryEntry>();
	for (const entry of current) byId.set(entry.id, entry);
	for (const entry of incoming) byId.set(entry.id, entry);
	return sortPromptEntries([...byId.values()]).slice(-max);
}

export function mergeControlSurfaceEntryWindow(
	current: StoryEntry[],
	incoming: StoryEntry[],
	options: {
		limit?: number;
		anchor?: 'newest' | 'oldest';
	} = {},
): StoryEntry[] {
	const max = Math.max(0, Math.trunc(options.limit ?? DEFAULT_CONTROL_SURFACE_ENTRY_WINDOW));
	if (max === 0) return [];
	const byId = new Map<string, StoryEntry>();
	for (const entry of current) byId.set(entry.id, entry);
	for (const entry of incoming) byId.set(entry.id, entry);
	const sorted = sortPromptEntries([...byId.values()]);
	if (sorted.length <= max) return sorted;
	return options.anchor === 'oldest' ? sorted.slice(0, max) : sorted.slice(-max);
}

export function removePromptEntriesById(entries: StoryEntry[], ids: Set<string>): StoryEntry[] {
	if (ids.size === 0) return entries;
	return entries.filter((entry) => !ids.has(entry.id));
}

export function removePromptEntriesFromPosition(entries: StoryEntry[], position: number): StoryEntry[] {
	return entries.filter((entry) => entry.position < position);
}
