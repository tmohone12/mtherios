import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';

export class SummaryGenerationError extends Error {
	readonly result?: { retryAfterMs: number };
	constructor(message: string, readonly code: string, readonly retryable = false, readonly responseReceived = false) {
		super(message);
		this.name = 'SummaryGenerationError';
		if (code === 'summary_busy') this.result = { retryAfterMs: 30_000 };
	}
}

export interface SummaryCheckpointFailure { message: string; code: string; retryable: boolean; responseReceived: boolean }
export interface SummaryCheckpointInput { storyId: string; kind: string; stage: string; fingerprint: string; failureFingerprint?: string; dispatchesProvider?: boolean }
export type SummaryCheckpointClaim = { state: 'claimed' } | { state: 'complete'; value: unknown }
	| { state: 'failed'; failure: SummaryCheckpointFailure } | { state: 'busy' | 'uncertain' };
export interface SummaryCheckpointStore {
	claim(input: SummaryCheckpointInput, owner: string): Promise<SummaryCheckpointClaim>;
	complete(input: SummaryCheckpointInput, owner: string, value: unknown): Promise<boolean>;
	fail(input: SummaryCheckpointInput, owner: string, failure: SummaryCheckpointFailure): Promise<boolean>;
	renew(input: SummaryCheckpointInput, owner: string): Promise<void>;
}

/** Canonical object ordering; source arrays remain ordered. Only the digest is persisted. */
export function summaryFingerprint(value: unknown): string {
	const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
		: item && typeof item === 'object'
			? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, ordered(value)]))
			: item;
	return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}

function storedFailure(value: unknown): SummaryCheckpointFailure {
	const row = value && typeof value === 'object' ? value as Partial<SummaryCheckpointFailure> : {};
	return { message: typeof row.message === 'string' ? row.message : 'A previous identical summary failed; review it before retrying.',
		code: typeof row.code === 'string' ? row.code : 'summary_failed', retryable: row.retryable === true, responseReceived: row.responseReceived === true };
}

export const postgresSummaryCheckpointStore: SummaryCheckpointStore = {
	async claim(input, owner) {
		// A durable leaf claim precedes every dispatch. Only orchestration may resume
		// automatically; an expired provider claim could already have been billed.
		const failureFingerprint = input.failureFingerprint ?? input.fingerprint;
		return getDb().transaction(async (tx): Promise<SummaryCheckpointClaim> => {
			// The source guard also covers requests whose supporting facts changed. Only
			// exact full-context matches reuse a completion; ancillary edits do not clear
			// a permanent failure or let two workers buy the same window concurrently.
			await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`summary:${input.storyId}:${failureFingerprint}`}, 0))`);
			const [complete] = await tx.execute(sql`select result from summary_generation_checkpoints
				where fingerprint=${input.fingerprint} and story_id=${input.storyId} and status='complete'`);
			if (complete) return { state: 'complete', value: complete.result };
			const blockedRows = await tx.execute(sql`select fingerprint, status, failure, dispatches_provider, lease_until > now() as active from summary_generation_checkpoints
				where failure_fingerprint=${failureFingerprint} and story_id=${input.storyId}
				and (status='running' or (status='failed' and coalesce(failure->>'retryable','false') <> 'true'))
				order by case when status='failed' then 0 else 1 end, created_at`);
			for (const blocked of blockedRows) {
				if (blocked.status === 'failed') return { state: 'failed', failure: storedFailure(blocked.failure) };
				if (blocked.active === true) return { state: 'busy' };
				if (blocked.dispatches_provider !== false) return { state: 'uncertain' };
				const released = await tx.execute(sql`update summary_generation_checkpoints set status='failed', lease_owner=null, lease_until=null,
					failure=${JSON.stringify({ message: 'Interrupted orchestration can resume through its durable provider receipts.', code: 'summary_orchestration_interrupted', retryable: true, responseReceived: false })}::jsonb,
					updated_at=now() where fingerprint=${blocked.fingerprint} and story_id=${input.storyId}
					and status='running' and dispatches_provider=false and lease_until<=now() returning fingerprint`);
				if (!released.length) return { state: 'busy' };
			}
			const claimed = await tx.execute(sql`insert into summary_generation_checkpoints
				(fingerprint, failure_fingerprint, story_id, kind, stage, dispatches_provider, status, lease_owner, lease_until)
				values (${input.fingerprint}, ${failureFingerprint}, ${input.storyId}, ${input.kind}, ${input.stage}, ${input.dispatchesProvider !== false}, 'running', ${owner}, now() + interval '5 minutes')
				on conflict (fingerprint) do update set status='running', lease_owner=excluded.lease_owner,
				lease_until=excluded.lease_until, failure=null, updated_at=now()
				where summary_generation_checkpoints.status='failed'
					and summary_generation_checkpoints.failure->>'retryable'='true'
				returning fingerprint`);
			if (!claimed.length) throw new SummaryGenerationError('Summary checkpoint changed before its claim; no provider request was made.', 'summary_checkpoint_conflict');
			return { state: 'claimed' };
		});
	},
	async complete(input, owner, value) {
		const rows = await getDb().execute(sql`update summary_generation_checkpoints set status='complete', result=${JSON.stringify(value)}::jsonb,
			failure=null, lease_owner=null, lease_until=null, updated_at=now()
			where fingerprint=${input.fingerprint} and story_id=${input.storyId} and status='running' and lease_owner=${owner} returning fingerprint`);
		return rows.length === 1;
	},
	async fail(input, owner, failure) {
		const rows = await getDb().execute(sql`update summary_generation_checkpoints set status='failed', failure=${JSON.stringify(failure)}::jsonb,
			lease_owner=null, lease_until=null, updated_at=now()
			where fingerprint=${input.fingerprint} and story_id=${input.storyId} and status='running' and lease_owner=${owner} returning fingerprint`);
		return rows.length === 1;
	},
	async renew(input, owner) {
		await getDb().execute(sql`update summary_generation_checkpoints set lease_until=now() + interval '5 minutes', updated_at=now()
			where fingerprint=${input.fingerprint} and story_id=${input.storyId} and status='running' and lease_owner=${owner}`);
	},
};

export async function withSummaryCheckpoint<T>(input: SummaryCheckpointInput & { validate(value: unknown): T }, generate: () => Promise<T>,
	store: SummaryCheckpointStore = postgresSummaryCheckpointStore): Promise<T> {
	const owner = randomUUID();
	let claim: SummaryCheckpointClaim;
	try { claim = await store.claim(input, owner); }
	catch (error) {
		if (error instanceof SummaryGenerationError) throw error;
		throw new SummaryGenerationError('Summary checkpoint storage is unavailable; no new provider request was dispatched.', 'summary_checkpoint_storage', true);
	}
	if (claim.state === 'complete') {
		try { return input.validate(claim.value); }
		catch { throw new SummaryGenerationError('Saved summary checkpoint failed validation; review the retained result before regenerating.', 'summary_checkpoint_invalid'); }
	}
	if (claim.state === 'failed') throw new SummaryGenerationError(claim.failure.message, claim.failure.code, claim.failure.retryable, claim.failure.responseReceived);
	if (claim.state === 'busy') throw new SummaryGenerationError('An identical summary is already being generated; no duplicate request was sent.', 'summary_busy', true);
	if (claim.state === 'uncertain') throw new SummaryGenerationError('An interrupted summary has an uncertain provider outcome. Manual recovery is required; no duplicate request was sent.', 'summary_interrupted');
	const heartbeat = setInterval(() => { void store.renew(input, owner).catch(() => { /* Never transfer ownership after a failed heartbeat. */ }); }, 30_000);
	heartbeat.unref?.();
	try {
		const value = input.validate(await generate());
		let saved: boolean;
		try { saved = await store.complete(input, owner, value); }
		catch { throw new SummaryGenerationError('The generated summary could not be checkpointed; review its provider receipt before regenerating.', 'summary_checkpoint_storage'); }
		if (!saved) throw new SummaryGenerationError('Summary checkpoint ownership changed before completion; retained work requires review.', 'summary_checkpoint_lost');
		return value;
	} catch (error) {
		// Only explicitly typed known failures may be retried. Unknown dispatch outcomes
		// and validation failures remain blocked for the same immutable input identity.
		const failure: SummaryCheckpointFailure = { message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
			code: error instanceof SummaryGenerationError ? error.code : 'summary_failed',
			retryable: error instanceof SummaryGenerationError && error.retryable,
			responseReceived: error instanceof SummaryGenerationError && error.responseReceived };
		try { await store.fail(input, owner, failure); }
		catch { throw new SummaryGenerationError('Summary outcome could not be saved; review its durable claim before regenerating.', 'summary_checkpoint_storage'); }
		throw error;
	} finally { clearInterval(heartbeat); }
}
