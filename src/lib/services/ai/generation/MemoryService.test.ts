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
	it('keeps recent chapter endings after skipping an oversized middle entry', () => {
		const oversizedMiddle = entry('middle-huge', 4, 'oversized filler '.repeat(5000));
		const climax = entry('ending-climax', 30, 'The prince betrays the pact at the gate.', { importance: 'major' });
		const selected = selectEntriesForChapterMemory([
			entry('opening-1', 1, 'The chapter opens at the feast.'),
			entry('opening-2', 2, 'The envoy arrives.'),
			entry('opening-3', 3, 'The gate bells ring.'),
			oversizedMiddle,
			...Array.from({ length: 25 }, (_, index) => entry(`tail-${index}`, 5 + index, `quiet tail beat ${index}`)),
			climax,
		], 220);

		expect(selected.map((item) => item.id)).toContain('opening-1');
		expect(selected.map((item) => item.id)).not.toContain('middle-huge');
		expect(selected.map((item) => item.id)).toContain('ending-climax');
	});
});
