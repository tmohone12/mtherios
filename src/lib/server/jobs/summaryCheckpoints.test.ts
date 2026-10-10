import { expect, it, vi } from 'vitest';
import { summaryFingerprint, withSummaryCheckpoint } from './summaryCheckpoints';
import { memorySummaryCheckpointStore } from './summaryCheckpoints.testSupport';

const input = { storyId: 'synthetic', kind: 'chapter', stage: 'summary', fingerprint: 'synthetic-provider-request',
	validate: (value: unknown) => String(value) };

it('canonicalizes object keys but preserves source ordering in checkpoint identities', () => {
	expect(summaryFingerprint({ b: 2, a: [1, 2] })).toBe(summaryFingerprint({ a: [1, 2], b: 2 }));
	expect(summaryFingerprint({ a: [1, 2] })).not.toBe(summaryFingerprint({ a: [2, 1] }));
});

it('does not dispatch when the claim cannot be persisted', async () => {
	const { store } = memorySummaryCheckpointStore();
	vi.spyOn(store, 'claim').mockRejectedValue(new Error('database unavailable'));
	const provider = vi.fn(async () => 'should not be called');
	await expect(withSummaryCheckpoint(input, provider, store)).rejects.toMatchObject({ code: 'summary_checkpoint_storage', retryable: true });
	expect(provider).not.toHaveBeenCalled();
});

it('blocks replay when completed provider work cannot be checkpointed', async () => {
	const { store } = memorySummaryCheckpointStore();
	vi.spyOn(store, 'complete').mockRejectedValue(new Error('database unavailable'));
	const provider = vi.fn(async () => 'already generated');
	await expect(withSummaryCheckpoint(input, provider, store)).rejects.toMatchObject({ code: 'summary_checkpoint_storage', retryable: false });
	await expect(withSummaryCheckpoint(input, provider, store)).rejects.toMatchObject({ code: 'summary_checkpoint_storage', retryable: false });
	expect(provider).toHaveBeenCalledTimes(1);
});
