import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, updateStory } from './database';

afterEach(() => vi.restoreAllMocks());

describe('story cache timestamps', () => {
	it('preserves an explicit backend timestamp during projection refresh', async () => {
		const update = vi.spyOn(db.stories, 'update').mockResolvedValue(1);
		await updateStory('story_a', { title: 'Canon title', updatedAt: 1000 });
		expect(update).toHaveBeenCalledExactlyOnceWith('story_a', { title: 'Canon title', updatedAt: 1000 });
	});
	it('still timestamps local edits that do not supply a time', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(5000);
		const update = vi.spyOn(db.stories, 'update').mockResolvedValue(1);
		await updateStory('story_a', { title: 'Local edit' });
		expect(update).toHaveBeenCalledExactlyOnceWith('story_a', { title: 'Local edit', updatedAt: 5000 });
	});
});
