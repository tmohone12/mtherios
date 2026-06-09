import { describe, expect, it } from 'vitest';
import { proposeContinuityChangeFromStoryText } from './continuity';

describe('continuity ledger examples', () => {
	it('turns a short story sentence into a proposed canon change with source refs', () => {
		const bundle = proposeContinuityChangeFromStoryText({
			storyId: 'story_1',
			sourceEntryId: 'entry_1',
			text: 'Mara now carries the black key.',
			entityNameToId: {
				Mara: 'entity_mara',
				mara: 'entity_mara',
			},
			serverVersion: 12,
			now: '2026-06-02T00:00:00.000Z',
		});

		expect(bundle).not.toBeNull();
		const ledger = bundle!;
		expect(ledger.facts).toHaveLength(1);
		expect(ledger.patchProposals).toHaveLength(1);
		expect(ledger.sourceRefs).toHaveLength(2);
		expect(ledger.continuityWarnings).toEqual([]);
		expect(ledger.facts[0]).toMatchObject({
			storyId: 'story_1',
			type: 'observation',
			subjectEntityId: 'entity_mara',
			title: 'Mara and the black key',
			statement: 'Mara now carries the black key.',
			confidence: 0.94,
			sourceEntryIds: ['entry_1'],
		});
		expect(ledger.patchProposals[0]).toMatchObject({
			proposalType: 'fact_upsert',
			targetTable: 'facts',
			targetRecordId: ledger.facts[0].id,
			status: 'pending',
			affectedEntityIds: ['entity_mara'],
			confidence: 0.94,
		});
		expect(ledger.sourceRefs.map((ref) => ref.targetTable)).toEqual(['facts', 'patch_proposals']);
	});
});
