import { describe, expect, it, vi } from 'vitest';
import { allocateStoryEntryPosition, type StoryEntryPositionTransaction } from './storyEntryPositions';

function transactionWithRows(rows: unknown[][]) {
	const order: string[] = [];
	const execute = vi.fn(async () => { order.push('lock'); });
	const select = vi.fn(() => {
		order.push('select');
		const result = rows.shift() ?? [];
		const chain = {
			from: vi.fn(() => chain),
			where: vi.fn(() => chain),
			orderBy: vi.fn(() => chain),
			limit: vi.fn(async () => result),
		};
		return chain;
	});
	return {
		tx: { execute, select } as unknown as StoryEntryPositionTransaction,
		execute,
		select,
		order,
	};
}

describe('story entry position allocation', () => {
	it('takes the per-story transaction lock before reading the next position', async () => {
		const fixture = transactionWithRows([[{ position: 9 }]]);
		await expect(allocateStoryEntryPosition(fixture.tx, 'story_alpha')).resolves.toBe(10);
		expect(fixture.execute).toHaveBeenCalledTimes(1);
		expect(fixture.order).toEqual(['lock', 'select']);
	});

	it('keeps an unused preferred position and moves a collision to the current tail', async () => {
		const available = transactionWithRows([[]]);
		await expect(allocateStoryEntryPosition(available.tx, 'story_alpha', 4)).resolves.toBe(4);
		expect(available.select).toHaveBeenCalledTimes(1);

		const occupied = transactionWithRows([[{ id: 'entry_existing' }], [{ position: 12 }]]);
		await expect(allocateStoryEntryPosition(occupied.tx, 'story_alpha', 4)).resolves.toBe(13);
		expect(occupied.order).toEqual(['lock', 'select', 'select']);
	});
});
