import { describe, expect, it } from 'vitest';
import { eligibleNpcBackgroundActors } from './processor';

const actor = (id: string, state: Record<string, unknown>, sourceEntryIds = ['entry_1']) => ({
	id, storyId: 'story_1', type: 'character', name: id, status: 'active', state, sourceEntryIds, sourceEventIds: [],
}) as unknown as Parameters<typeof eligibleNpcBackgroundActors>[0][number];

describe('background NPC eligibility', () => {
	it('requires saved evidence and a plan, and excludes the player and on-scene actors', () => {
		const rows = [
			actor('Mira', { currentPlan: 'Recruit a courier.' }),
			actor('Player', { currentPlan: 'Travel north.', isProtagonist: true }),
			actor('Unsourced', { currentPlan: 'Write a letter.' }, []),
			actor('RecentlyActive', { currentPlan: 'Map the port.', lastIndependentActionTurn: 9 }),
			actor('Away', { currentPlan: 'Seek a patron.' }),
		];
		expect(eligibleNpcBackgroundActors(rows, 'Mira speaks to the player.', 10).map((row) => row.id)).toEqual(['Away']);
	});
	it('excludes the configured player even when imported state lacks the protagonist flag', () => {
		expect(eligibleNpcBackgroundActors([actor('Aurion', { currentPlan: 'Travel north.' })], '', 10, 'Aurion')).toEqual([]);
	});
});
