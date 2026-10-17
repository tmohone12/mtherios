import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { backendJobs, stories } from '$lib/server/db/schema';
import type { EngineWorldChronicleAdvanceArgs } from '$lib/contracts/engine';
import { readWorldChronicleSettings, worldChronicleJobPayloadSchema, type WorldChronicleJobPayload, type WorldChronicleSpan } from '$lib/contracts/worldChronicle';
import { backendJobRetryBlockReason, enqueueBackendJob, retryBackendJob } from '$lib/server/jobs/outbox';
import { runBackendJobNow } from '$lib/server/jobs/processor';
import { MutationError } from './mutationSafety';

type JsonRecord = Record<string, unknown>;

/** One batch per span and story version: a double click finds the same job instead of buying a second batch. */
export function worldChronicleDedupeKey(span: WorldChronicleSpan, storyServerVersion: number): string {
	return `world-chronicle-${span}-${storyServerVersion}`;
}

/**
 * `world.chronicle.advance`: queue one `simulate_world_happenings` job and, by default, run it now.
 * The job keeps its first payload (a repeat request at the same story version reuses it). A job that
 * failed on missing model configuration is requeued through the shared retry policy; other failures
 * are reported and need review. The dials are remembered when the batch commits.
 */
export async function runWorldChronicleAdvanceCommand(input: EngineWorldChronicleAdvanceArgs & { storyId: string }): Promise<JsonRecord> {
	const db = getDb();
	const [story] = await db.select({ serverVersion: stories.serverVersion, metadata: stories.metadata }).from(stories).where(eq(stories.id, input.storyId)).limit(1);
	if (!story) throw new MutationError('NOT_FOUND', `Story not found: ${input.storyId}`);
	const remembered = readWorldChronicleSettings(story.metadata);
	const requestedAt = new Date().toISOString();
	const payload: WorldChronicleJobPayload = {
		span: input.span,
		eventfulness: input.eventfulness ?? remembered.eventfulness,
		creativity: input.creativity ?? remembered.creativity,
		requestedAt,
		source: 'manual',
	};
	const dedupeKey = worldChronicleDedupeKey(input.span, story.serverVersion);
	const jobId = await enqueueBackendJob({
		storyId: input.storyId,
		type: 'simulate_world_happenings',
		dedupeKey,
		requeueExisting: false,
		payload,
		metadata: { source: 'world_chronicle_manual', requestedAt },
		maxAttempts: 2,
	});
	const readJob = async () => (await db.select().from(backendJobs).where(eq(backendJobs.id, jobId)).limit(1))[0];
	let row = await readJob();
	if (!row) throw new Error('The World Chronicle job could not be queued.');
	const stored = worldChronicleJobPayloadSchema.safeParse(row.payload);
	const base = {
		storyId: input.storyId,
		jobId,
		dedupeKey,
		span: input.span,
		eventfulness: stored.success ? stored.data.eventfulness : payload.eventfulness,
		creativity: stored.success ? stored.data.creativity : payload.creativity,
		runNow: input.runNow !== false,
	};
	if (row.status === 'failed') {
		const blocked = backendJobRetryBlockReason(row);
		if (blocked) return { ok: false, ...base, status: 'failed', error: row.lastError ?? 'The World Chronicle job failed.', retryBlocked: blocked };
		await retryBackendJob({ storyId: input.storyId, jobId, expectedUpdatedAt: row.updatedAt });
		row = (await readJob()) ?? row;
	}
	if (row.status === 'running') return { ok: false, ...base, status: 'running', error: 'A World Chronicle batch for this span is already running.' };
	if (row.status === 'complete') return { ok: true, ...base, status: 'complete', alreadyComplete: true };
	if (input.runNow === false) return { ok: true, ...base, status: row.status, job: null };
	try {
		const job = await runBackendJobNow(jobId, input.workerId ?? `manual_world_chronicle_${Date.now()}`);
		return { ok: job.completed, ...base, status: job.completed ? 'complete' : 'failed', job, ...(job.error ? { error: job.error } : {}) };
	} catch (error) {
		// Claimed by the story's job lane in the meantime, or waiting for an automatic retry.
		const current = await readJob();
		return { ok: false, ...base, status: current?.status ?? 'unknown',
			error: error instanceof Error ? error.message : String(error) };
	}
}
