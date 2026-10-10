import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '$lib/server/db/client';
import { SummaryGenerationError, postgresSummaryCheckpointStore, summaryFingerprint, withSummaryCheckpoint, type SummaryCheckpointInput } from './summaryCheckpoints';

const configured = process.env.SUMMARY_CHECKPOINT_TEST_DATABASE_URL;
const validTarget = Boolean(configured && /^mythengine_summary_repair_[a-z0-9_]+$/.test(new URL(configured).pathname.slice(1))
	&& ['localhost', '127.0.0.1'].includes(new URL(configured).hostname));

describe.skipIf(!validTarget)('summary receipts on disposable PostgreSQL', () => {
	let storyId: string;
	beforeAll(async () => {
		const [database] = await getDb().execute(sql`select current_database() as name`);
		if (database.name !== new URL(configured!).pathname.slice(1)) throw new Error('Refusing checkpoint integration test against a different database.');
	});
	beforeEach(async () => {
		storyId = `summary_checkpoint_test_${randomUUID()}`;
		await getDb().execute(sql`insert into stories(id,title) values (${storyId},'Synthetic summary checkpoint test')`);
	});
	afterEach(async () => { if (storyId) await getDb().execute(sql`delete from stories where id=${storyId}`); });
	afterAll(async () => { await closeDb(); });
	const validate = (value: unknown) => {
		if (!value || typeof value !== 'object' || typeof (value as { text?: unknown }).text !== 'string') throw new Error('Invalid stored summary');
		return value as { text: string };
	};
	const input = (name: string, extra: Partial<SummaryCheckpointInput> = {}) => ({ storyId, kind: 'chapter', stage: 'summary',
		fingerprint: summaryFingerprint([storyId, name]), validate, ...extra });

	it('serializes concurrent claims including different supporting context without duplicate dispatch', async () => {
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const started = new Promise<void>(resolve => { entered = resolve; });
		const generate = vi.fn(async () => { entered(); await gate; return { text: 'validated complete account' }; });
		const firstInput = input('first', { failureFingerprint: summaryFingerprint([storyId, 'immutable-source']) });
		const first = withSummaryCheckpoint(firstInput, generate);
		await started;
		await expect(withSummaryCheckpoint(firstInput, generate)).rejects.toMatchObject({ code: 'summary_busy', retryable: true });
		await expect(withSummaryCheckpoint(input('changed-support', { failureFingerprint: firstInput.failureFingerprint }), generate))
			.rejects.toMatchObject({ code: 'summary_busy' });
		release(); await first;
		await expect(withSummaryCheckpoint(firstInput, generate)).resolves.toEqual({ text: 'validated complete account' });
		expect(generate).toHaveBeenCalledTimes(1);
	});

	it('suppresses a permanent failed source across ancillary edits but permits a changed model/source identity', async () => {
		const original = input('full-context-1', { failureFingerprint: summaryFingerprint([storyId, 'same-sources-model']) });
		const failed = vi.fn(async () => { throw new SummaryGenerationError('Summary was truncated.', 'summary_truncated', false, true); });
		await expect(withSummaryCheckpoint(original, failed)).rejects.toMatchObject({ retryable: false });
		await expect(withSummaryCheckpoint(input('full-context-2', { failureFingerprint: original.failureFingerprint }), failed)).rejects.toMatchObject({ code: 'summary_truncated' });
		expect(failed).toHaveBeenCalledTimes(1);
		const corrected = vi.fn(async () => ({ text: 'complete with corrected configuration' }));
		await expect(withSummaryCheckpoint(input('new-model-and-identity'), corrected)).resolves.toMatchObject({ text: expect.any(String) });
		expect(corrected).toHaveBeenCalledTimes(1);
	});

	it('retains completed subwork after recorded transient failure and validates it on reuse', async () => {
		const parent = input('root', { stage: 'window', dispatchesProvider: false });
		const firstPart = input('part-1'); const secondPart = input('part-2');
		const first = vi.fn(async () => ({ text: 'validated first half' }));
		let recover = false;
		const second = vi.fn(async () => { if (!recover) throw new SummaryGenerationError('Service temporarily unavailable.', 'summary_provider_unavailable', true); return { text: 'validated second half' }; });
		const run = () => withSummaryCheckpoint(parent, async () => ({ text: (await withSummaryCheckpoint(firstPart, first)).text + (await withSummaryCheckpoint(secondPart, second)).text }));
		await expect(run()).rejects.toMatchObject({ retryable: true });
		recover = true;
		await expect(run()).resolves.toEqual({ text: 'validated first halfvalidated second half' });
		expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(2);
		await getDb().execute(sql`update summary_generation_checkpoints set result='{"wrong":true}'::jsonb where fingerprint=${firstPart.fingerprint}`);
		await expect(withSummaryCheckpoint(firstPart, first)).rejects.toMatchObject({ code: 'summary_checkpoint_invalid', retryable: false });
		expect(first).toHaveBeenCalledTimes(1);
	});

	it('recovers expired orchestration after a process crash and reuses completed children', async () => {
		const parent = input('crashed-root', { stage: 'window', dispatchesProvider: false });
		const child = input('finished-child');
		expect(await postgresSummaryCheckpointStore.claim(parent, 'dead-orchestrator')).toEqual({ state: 'claimed' });
		const provider = vi.fn(async () => ({ text: 'saved child before crash' }));
		await withSummaryCheckpoint(child, provider);
		await getDb().execute(sql`update summary_generation_checkpoints set lease_until=now()-interval '1 second' where fingerprint=${parent.fingerprint}`);
		await expect(withSummaryCheckpoint(parent, () => withSummaryCheckpoint(child, provider))).resolves.toEqual({ text: 'saved child before crash' });
		expect(provider).toHaveBeenCalledTimes(1);
		expect(await postgresSummaryCheckpointStore.complete(parent, 'dead-orchestrator', { text: 'late stale completion' })).toBe(false);
	});

	it('never reclaims an expired provider leaf even after its orchestration restarts', async () => {
		const parent = input('orchestrator', { stage: 'window', dispatchesProvider: false });
		const child = input('ambiguous-dispatch');
		await postgresSummaryCheckpointStore.claim(parent, 'dead-parent');
		await postgresSummaryCheckpointStore.claim(child, 'dead-provider-owner');
		await getDb().execute(sql`update summary_generation_checkpoints set lease_until=now()-interval '1 second' where story_id=${storyId}`);
		const dispatch = vi.fn(async () => ({ text: 'must not be generated' }));
		await expect(withSummaryCheckpoint(parent, () => withSummaryCheckpoint(child, dispatch)))
			.rejects.toMatchObject({ code: 'summary_interrupted', retryable: false });
		expect(dispatch).not.toHaveBeenCalled();
		const [row] = await getDb().execute(sql`select status,lease_owner from summary_generation_checkpoints where fingerprint=${child.fingerprint}`);
		expect(row).toMatchObject({ status: 'running', lease_owner: 'dead-provider-owner' });
	});

	it('reuses only the matching full context and preserves older successful context receipts', async () => {
		const failureFingerprint = summaryFingerprint([storyId, 'same-primary-sources']);
		const generate = vi.fn(async () => ({ text: 'complete account' }));
		await withSummaryCheckpoint(input('context-1', { failureFingerprint }), generate);
		await withSummaryCheckpoint(input('context-2', { failureFingerprint }), generate);
		await withSummaryCheckpoint(input('context-1', { failureFingerprint }), generate);
		expect(generate).toHaveBeenCalledTimes(2);
		const [count] = await getDb().execute(sql`select count(*)::int as count from summary_generation_checkpoints where story_id=${storyId} and status='complete'`);
		expect(count.count).toBe(2);
	});
});
