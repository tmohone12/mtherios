import { describe, expect, it } from 'vitest';
import { selectEntriesForChapterMemory } from './MemoryService';
import type { StoryEntry } from '$lib/types';

function entry(id: string, position: number, content: string, metadata: Record<string, unknown> | null = null): StoryEntry {
	return {
		id,
		storyId: 'story-1',
		type: 'narration',
		content,
		parentId: null,
		position,
		createdAt: position,
		metadata,
		branchId: null,
	};
}

describe('selectEntriesForChapterMemory', () => {
	it('keeps every source including quiet middle scenes and oversized entries', () => {
		const oversizedMiddle = entry('middle-huge', 4, 'oversized filler '.repeat(5000));
		const climax = entry('ending-climax', 30, 'The prince betrays the pact at the gate.', { importance: 'major' });
		const selected = selectEntriesForChapterMemory([
			entry('opening-1', 1, 'The chapter opens at the feast.'),
			entry('opening-2', 2, 'The envoy arrives.'),
			entry('opening-3', 3, 'The gate bells ring.'),
			oversizedMiddle,
			...Array.from({ length: 25 }, (_, index) => entry(`tail-${index}`, 5 + index, `quiet tail beat ${index}`)),
			climax,
		]);

		expect(selected.map((item) => item.id)).toContain('opening-1');
		expect(selected.map((item) => item.id)).toContain('middle-huge');
		expect(selected.map((item) => item.id)).toContain('ending-climax');
		expect(selected).toHaveLength(30);
	});

	it('fails an explicit insufficient input budget instead of silently saving selected highlights', () => {
		expect(() => selectEntriesForChapterMemory([
			entry('opening', 1, 'The envoy arrives.'),
			entry('middle', 2, 'A detailed consequential exchange. '.repeat(2000)),
			entry('ending', 3, 'The envoy leaves.'),
		], 220)).toThrow('No partial summary was saved');
	});
});
