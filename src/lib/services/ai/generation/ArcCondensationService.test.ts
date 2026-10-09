import { describe, expect, it } from 'vitest';
import type { Chapter } from '$lib/types';
import { ArcCondensationService } from './ArcCondensationService';

describe('arc chapter selection', () => {
	const service = new ArcCondensationService();
	const chapters = Array.from({ length: 21 }, (_, index) => ({
		id: `chapter-${index + 1}`, number: index + 1, pinned: index === 5,
	} as Chapter));

	it('uses consecutive ten-chapter blocks including pinned chapters', () => {
		expect(service.getCondensableChapters(chapters.slice(0, 9), 0)).toEqual([]);
		expect(service.getCondensableChapters(chapters, 0).map(chapter => chapter.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(service.getCondensableChapters([...chapters].reverse(), 1).map(chapter => chapter.number)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
	});

	it('does not condense past a missing chapter', () => {
		expect(service.getCondensableChapters(chapters.filter(chapter => chapter.number !== 4), 0)).toEqual([]);
	});
});
