import { describe, expect, it } from 'vitest';
import type { StoryEntry } from '$lib/types';
import {
	mergeControlSurfaceEntryWindow,
	mergePromptEntryWindow,
	removePromptEntriesById,
	removePromptEntriesFromPosition,
} from './promptEntries';

function entry(id: string, position: number, content = id): StoryEntry {
	return {
		id,
		storyId: 'story_alpha',
		type: position % 2 === 0 ? 'narration' : 'user_action',
		content,
		parentId: null,
		position,
		createdAt: position,
		metadata: null,
		branchId: null,
	};
}

describe('prompt entry window', () => {
	it('keeps a bounded newest-first prompt source even when older UI pages are loaded', () => {
		const recent = [entry('entry_8', 8), entry('entry_9', 9), entry('entry_10', 10)];
		const olderPage = [entry('entry_1', 1), entry('entry_2', 2), entry('entry_3', 3)];

		expect(mergePromptEntryWindow(recent, olderPage, 3).map((row) => row.id)).toEqual([
			'entry_8',
			'entry_9',
			'entry_10',
		]);
	});

	it('upserts matching rows and keeps the newest bounded slice sorted by position', () => {
		const current = [entry('entry_1', 1), entry('entry_2', 2), entry('entry_3', 3)];
		const updated = entry('entry_2', 2, 'updated');
		const next = entry('entry_4', 4);

		const window = mergePromptEntryWindow(current, [updated, next], 3);

		expect(window.map((row) => row.id)).toEqual(['entry_2', 'entry_3', 'entry_4']);
		expect(window[0].content).toBe('updated');
	});

	it('removes entries from the prompt window when local display rows are deleted', () => {
		const current = [entry('entry_1', 1), entry('entry_2', 2), entry('entry_3', 3)];

		expect(removePromptEntriesById(current, new Set(['entry_2'])).map((row) => row.id)).toEqual([
			'entry_1',
			'entry_3',
		]);
		expect(removePromptEntriesFromPosition(current, 2).map((row) => row.id)).toEqual(['entry_1']);
	});

	it('keeps backend projection refreshes from accumulating an unbounded display transcript', () => {
		const current = Array.from({ length: 120 }, (_, index) => entry(`entry_${index}`, index));
		const projection = Array.from({ length: 80 }, (_, index) => entry(`entry_${120 + index}`, 120 + index));

		const window = mergeControlSurfaceEntryWindow(current, projection, { limit: 80, anchor: 'newest' });

		expect(window).toHaveLength(80);
		expect(window[0].id).toBe('entry_120');
		expect(window.at(-1)?.id).toBe('entry_199');
	});

	it('keeps older transcript pages bounded without polluting the prompt window', () => {
		const latest = Array.from({ length: 160 }, (_, index) => entry(`entry_${1000 + index}`, 1000 + index));
		const older = Array.from({ length: 80 }, (_, index) => entry(`entry_${920 + index}`, 920 + index));

		const visible = mergeControlSurfaceEntryWindow(latest, older, { limit: 120, anchor: 'oldest' });
		const prompt = mergePromptEntryWindow(latest, older, 80);

		expect(visible).toHaveLength(120);
		expect(visible[0].id).toBe('entry_920');
		expect(visible.at(-1)?.id).toBe('entry_1039');
		expect(prompt[0].id).toBe('entry_1080');
		expect(prompt.at(-1)?.id).toBe('entry_1159');
	});
});
