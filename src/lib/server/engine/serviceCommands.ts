import {
	engineJobStatusArgsSchema,
	engineStoryVaultSyncJobArgsSchema,
	reindexStoryRequestSchema,
	type EngineJobStatusArgs,
	type EngineStoryVaultSyncJobArgs,
} from '$lib/contracts/engine';
import {
	memoryRetrieveRequestSchema,
	syncPullRequestSchema,
	syncPushRequestSchema,
	type MemoryRetrieveRequest,
	type RetrievedMemoryPacket,
	type SyncChange,
	type SyncOperation,
} from '$lib/contracts/memory';
import { retrieveMemoryPacket } from '$lib/server/memory/retrieval';
import { applySyncOperation, getSyncChanges } from '$lib/server/memory/canonical';
import { enqueueBackendJob } from '$lib/server/jobs/outbox';
import { getBackendJobStats, runBackendJobNow, runDueBackendJobs } from '$lib/server/jobs/processor';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { listStoryVaultFreshnessItems } from '$lib/server/wiki/storyVault';
import { getDb } from '$lib/server/db/client';
import { backendJobs } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';

type JsonRecord = Record<string, unknown>;

export interface SyncPullCommandResult {
	storyId: string;
	serverVersion: number;
	changes: SyncChange[];
}

export interface SyncPushCommandResult {
	storyId: string;
	serverVersion: number;
	appliedOpIds: string[];
	rejected: Array<{ opId: string; reason: string }>;
	repairItems: Array<{ opId: string; reason: string; payload: unknown }>;
	changes: SyncChange[];
}

export interface WorldSimJobCommandInput {
	storyId: string;
	localVersion?: number | null;
	force?: boolean;
	workerId?: string;
}

export interface RunDueJobsCommandInput {
	storyId?: string | null;
	workerId?: string;
	limit?: number;
	allStories?: boolean;
}

export interface JobStatusCommandInput extends EngineJobStatusArgs {
	storyId?: string | null;
}

export interface StoryVaultSyncJobCommandInput extends EngineStoryVaultSyncJobArgs {
	storyId?: string | null;
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function optionalString(value: unknown): string | undefined {
	if (value === undefined || value === null || value === false || value === true) return undefined;
	const clean = String(value).trim();
	return clean || undefined;
}

export async function runMemoryRetrieveCommand(input: MemoryRetrieveRequest): Promise<RetrievedMemoryPacket> {
	return retrieveMemoryPacket(memoryRetrieveRequestSchema.parse(input));
}

export async function runSyncPullCommand(input: { storyId: string; since?: number }): Promise<SyncPullCommandResult> {
	const request = syncPullRequestSchema.parse(input);
	const changes = await getSyncChanges(request.storyId, request.since);
	const serverVersion = changes.reduce((max, change) => Math.max(max, change.version), request.since);
	return { storyId: request.storyId, serverVersion, changes };
}

export async function runSyncPushCommand(input: {
	storyId: string;
	localVersion?: number;
	ops?: SyncOperation[];
}): Promise<SyncPushCommandResult> {
	const request = syncPushRequestSchema.parse(input);
	const appliedOpIds: string[] = [];
	const rejected: Array<{ opId: string; reason: string }> = [];
	const repairItems: Array<{ opId: string; reason: string; payload: unknown }> = [];

	for (const op of request.ops) {
		try {
			await applySyncOperation(op);
			appliedOpIds.push(op.id);
		} catch (error) {
			const reason = error instanceof Error ? error.message : 'Unknown sync failure.';
			rejected.push({ opId: op.id, reason });
			repairItems.push({ opId: op.id, reason, payload: op.payload });
		}
	}

	const changes = await getSyncChanges(request.storyId, request.localVersion);
	const serverVersion = changes.reduce((max, change) => Math.max(max, change.version), request.localVersion);
	return {
		storyId: request.storyId,
		serverVersion,
		appliedOpIds,
		rejected,
		repairItems,
		changes,
	};
}

export async function runWorldSimJobCommand(input: WorldSimJobCommandInput | JsonRecord): Promise<JsonRecord> {
	const body = asRecord(input);
	const storyId = optionalString(body.storyId) ?? '';
	if (!storyId) throw new Error('storyId is required.');
	const requestedAt = new Date().toISOString();
	const workerId = optionalString(body.workerId) ?? `manual_world_sim_${Date.now()}`;
	const force = body.force !== false;
	const before = await getBackendJobStats(storyId);
	const jobId = await enqueueBackendJob({
		storyId,
		type: 'evaluate_world_sim_tick',
		payload: {
			force,
			manual: true,
			requestedAt,
			clientVersion: typeof body.localVersion === 'number' ? body.localVersion : null,
		},
		metadata: {
			source: 'frontend_manual_world_sim',
			requestedAt,
		},
		maxAttempts: 2,
	});
	const job = await runBackendJobNow(jobId, workerId);
	const after = await getBackendJobStats(storyId);

	return {
		ok: job.completed,
		storyId,
		jobId,
		workerId,
		before,
		after,
		job,
	};
}

export async function runReindexStoryJobCommand(input: unknown): Promise<JsonRecord> {
	const request = reindexStoryRequestSchema.parse(input);
	const jobId = await enqueueBackendJob({
		storyId: request.storyId,
		type: 'index_canonical_records',
		dedupeKey: `manual-canonical-index-${request.storyId}-${request.recordTypes.join('-') || 'all'}-${request.recreate ? 'recreate' : 'update'}`,
		payload: {
			recordTypes: request.recordTypes,
			recreate: request.recreate,
			provider: request.provider,
			model: request.model,
			reason: 'manual_reindex_api',
		},
		maxAttempts: 3,
	});
	const job = request.runNow ? await runBackendJobNow(jobId, `manual_reindex_${Date.now()}`) : null;
	return {
		ok: job ? job.completed : true,
		storyId: request.storyId,
		jobId,
		job,
	};
}

export async function listBackendJobsCommand(input: JobStatusCommandInput | JsonRecord): Promise<JsonRecord> {
	const body = asRecord(input);
	const args = engineJobStatusArgsSchema.parse(body);
	const storyId = args.allStories ? null : optionalString(body.storyId) ?? null;
	const rows = await getDb()
		.select()
		.from(backendJobs)
		.where(storyId ? eq(backendJobs.storyId, storyId) : undefined)
		.orderBy(desc(backendJobs.updatedAt))
		.limit(args.limit);
	return {
		stats: await getBackendJobStats(storyId),
		jobs: rows,
	};
}

export async function runDueBackendJobsCommand(input: RunDueJobsCommandInput | JsonRecord): Promise<JsonRecord> {
	const body = asRecord(input);
	const allStories = body.allStories === true;
	const storyId = allStories ? null : optionalString(body.storyId);
	if (!allStories && !storyId) throw new Error('storyId is required.');
	const workerId = optionalString(body.workerId) ?? `terminal_${Date.now()}`;
	const limitValue = typeof body.limit === 'number' ? body.limit : 10;
	const limit = Math.max(1, Math.min(100, Math.trunc(Number.isFinite(limitValue) ? limitValue : 10)));
	const before = await getBackendJobStats(storyId);
	const result = await runDueBackendJobs(workerId, limit, storyId);
	const after = await getBackendJobStats(storyId);
	return {
		ok: true,
		storyId,
		workerId,
		limit,
		before,
		after,
		...result,
	};
}

export async function runStoryVaultSyncJobCommand(input: StoryVaultSyncJobCommandInput | JsonRecord): Promise<JsonRecord> {
	const body = asRecord(input);
	const args = engineStoryVaultSyncJobArgsSchema.parse(body);
	const allStories = args.allStories === true;
	const workerId = args.workerId ?? `manual_wiki_${Date.now()}`;
	const payload = (reason: string) => wikiJobPayload(args, reason);

	if (allStories) {
		const runNow = args.runNow === true;
		const items = await listStoryVaultFreshnessItems(getMtheriosAppConfig(), args.limit);
		const selected = items.filter((item) =>
			args.includeFresh ||
			!item.vaultFresh ||
			(args.index && !item.indexFresh) ||
			(args.lint && !item.lintFresh)
		);
		const before = await getBackendJobStats();
		const jobs = [];
		for (const item of selected) {
			const jobId = await enqueueBackendJob({
				storyId: item.storyId,
				type: 'sync_story_vault',
				dedupeKey: `manual-wiki-${item.storyId}-${item.serverVersion}-${args.index ? 'index' : 'sync'}-${args.lint ? 'lint' : 'nolint'}`,
				payload: payload('manual_bulk_api'),
				maxAttempts: 3,
			});
			const job = runNow ? await runBackendJobNow(jobId, workerId) : null;
			jobs.push({
				storyId: item.storyId,
				storyTitle: item.storyTitle,
				jobId,
				job,
			});
		}
		const after = await getBackendJobStats();

		return {
			ok: jobs.every((row) => !row.job || row.job.completed),
			mode: 'bulk',
			workerId,
			selected: selected.length,
			queued: jobs.length,
			runNow,
			before,
			after,
			jobs,
		};
	}

	const storyId = optionalString(body.storyId);
	if (!storyId) throw new Error('storyId is required.');
	const runNow = args.runNow !== false;
	const before = await getBackendJobStats(storyId);
	const jobId = await enqueueBackendJob({
		storyId,
		type: 'sync_story_vault',
		payload: payload('manual_api'),
		maxAttempts: 3,
	});
	const job = runNow ? await runBackendJobNow(jobId, workerId) : null;
	const after = await getBackendJobStats(storyId);

	return {
		ok: job ? job.completed : true,
		storyId,
		jobId,
		workerId,
		before,
		after,
		job,
	};
}

function wikiJobPayload(input: EngineStoryVaultSyncJobArgs, reason: string): Record<string, unknown> {
	return {
		index: input.index,
		recreate: input.recreate,
		dryRun: input.dryRun,
		clean: input.clean,
		lint: input.lint,
		thinChars: input.thinChars,
		orphanLayer: input.orphanLayer,
		provider: input.provider,
		model: input.model,
		reason,
	};
}
