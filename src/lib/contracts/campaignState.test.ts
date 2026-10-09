import { describe, expect, it } from 'vitest';
import { applyChapterCampaignFactReview, campaignStateChangeSchema, campaignStateExtractionContext, mergeCampaignState, readCampaignState, type CampaignStateChange } from './campaignState';

const change: CampaignStateChange = { key: 'yin_betrothal', kind: 'current', statement: 'The Yin betrothal was annulled.', evidence: 'The Yin betrothal was annulled.', expected_source_entry_id: null };
const source = { id: 'entry_20', position: 20, content: change.evidence };

describe('campaign continuity state', () => {
	it('adds sourced facts, replaces the same topic, and preserves unrelated facts', () => {
		const first = mergeCampaignState([], [change], source);
		const next = { ...change, statement: 'The Yin betrothal has been reinstated.', evidence: 'The Yin betrothal has been reinstated.', expected_source_entry_id: source.id };
		const updated = mergeCampaignState(first.facts, [next], { id: 'entry_22', position: 22, content: next.evidence });
		expect(updated.facts).toEqual([{ key: change.key, kind: 'current', statement: next.statement, evidence: next.evidence, sourceEntryId: 'entry_22', sourcePosition: 22 }]);
		expect(mergeCampaignState(updated.facts, [], source).facts).toEqual(updated.facts);
		expect(campaignStateExtractionContext({ campaignState: updated.facts })).toContain('entry_22');
	});
	it('rejects invented evidence, stale snapshots, out-of-order results, and duplicate replay', () => {
		const current = mergeCampaignState([], [change], source).facts;
		for (const [delta, entry] of [
			[{ ...change, evidence: 'Invented supporting evidence.' }, source],
			[change, { ...source, id: 'entry_21', position: 21 }],
			[{ ...change, expected_source_entry_id: source.id }, { ...source, id: 'entry_19', position: 19 }],
			[{ ...change, expected_source_entry_id: source.id }, source],
		] as const) {
			const result = mergeCampaignState(current, [delta], entry);
			expect(result.facts).toEqual(current);
			expect(result.accepted).toHaveLength(0);
			expect(result.warnings).toHaveLength(1);
		}
	});
	it('validates persisted shape and never silently evicts facts when full', () => {
		expect(readCampaignState({ campaignState: [{ statement: 'unsupported' }] })).toEqual([]);
		expect(campaignStateChangeSchema.safeParse({ ...change, key: '../bad' }).success).toBe(false);
		const full = Array.from({ length: 32 }, (_, i) => ({ ...change, key: `fact_${i}`, sourceEntryId: source.id, sourcePosition: 20 }));
		const result = mergeCampaignState(full, [change], source);
		expect(result.facts).toHaveLength(32);
		expect(result.warnings[0]).toContain('brief is full');
	});
	it('refreshes a chapter fact only from exact primary narration and rejects stale or parallel evidence', () => {
		const current = mergeCampaignState([], [change], source).facts;
		const evidence = 'The council publicly reinstated the Yin betrothal.';
		const action = { action: 'upsert' as const, sourceId: 'narration_22', key: change.key, kind: 'current' as const,
			statement: evidence, evidence, expected_source_entry_id: source.id };
		const primary = { id: 'narration_22', type: 'narration', content: evidence, position: 22, branchId: null };
		expect(applyChapterCampaignFactReview(current, [action], [primary]).facts[0].statement).toBe(evidence);
		expect(applyChapterCampaignFactReview(current, [action], [{ ...primary, branchId: 'other' }]).accepted).toHaveLength(0);
		expect(applyChapterCampaignFactReview(current, [{ ...action, expected_source_entry_id: 'stale' }], [primary]).accepted).toHaveLength(0);
		expect(applyChapterCampaignFactReview(current, [{ action: 'remove', sourceId: primary.id, key: change.key,
			evidence, expected_source_entry_id: source.id }], [primary]).facts).toEqual([]);
		expect(applyChapterCampaignFactReview(current, [{ action: 'remove', sourceId: primary.id, key: change.key,
			evidence: 'The betrothal ended without a scene.', expected_source_entry_id: source.id }], [primary]).facts).toEqual(current);
	});
});
