import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { memoryNodes, storyEvents, type backendJobs } from '$lib/server/db/schema';
import type { MemoryNode } from '$lib/contracts/memory';
import { claimBackendJobs, markBackendJobComplete, markBackendJobFailed, type BackendJobType } from './outbox';

type BackendJobRow = typeof backendJobs.$inferSelect;
type StoryEventRow = typeof storyEvents.$inferSelect;

function nowIso(): string {
	return new Date().toISOString();
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function eventMemoryType(row: StoryEventRow): MemoryNode['type'] {
	if (row.type === 'faction_move') return 'faction';
	if (row.type === 'agreement' || row.type === 'promise' || row.type === 'betrayal') return 'plot_ledger';
	return 'episodic';
}

function eventImportance(row: StoryEventRow): number {
	if (row.type === 'promise' || row.type === 'betrayal' || row.type === 'agreement') return 0.9;
	if (row.type === 'faction_move' || row.type === 'death' || row.type === 'reveal') return 0.8;
	return 0.65;
}

async function loadEventRows(storyId: string, eventIds: string[]): Promise<StoryEventRow[]> {
	const db = getDb();
	if (eventIds.length > 0) {
		return db.select().from(storyEvents).where(and(
			eq(storyEvents.storyId, storyId),
			inArray(storyEvents.id, eventIds),
		));
	}
	return db
		.select()
		.from(storyEvents)
		.where(eq(storyEvents.storyId, storyId))
		.orderBy(desc(storyEvents.updatedAt))
		.limit(200);
}

async function createMemoryNodesFromEvents(job: BackendJobRow): Promise<number> {
	const db = getDb();
	const payload = asRecord(job.payload);
	const eventIds = asStringArray(payload.eventIds);
	const rows = await loadEventRows(job.storyId, eventIds);
	const updatedAt = nowIso();
	for (const row of rows) {
		await db.insert(memoryNodes).values({
			id: `mem_event_${row.id}`,
			storyId: row.storyId,
			type: eventMemoryType(row),
			title: row.title,
			content: row.body,
			summary: row.body.replace(/\s+/g, ' ').slice(0, 360),
			keywords: [row.type],
			entityIds: [...asStringArray(row.actorEntityIds), ...asStringArray(row.targetEntityIds)],
			factionIds: [],
			threadIds: asStringArray(row.threadIds),
			locationId: row.locationId ?? null,
			visibility: row.visibility,
			importance: eventImportance(row),
			sourceEntryIds: asStringArray(row.sourceEntryIds),
			sourceEventIds: [row.id],
			sourcePatchIds: asStringArray(row.sourcePatchIds),
			metadata: { sourceType: 'event_projection', jobId: job.id },
			serverVersion: row.serverVersion,
			createdAt: row.createdAt,
			updatedAt,
		}).onConflictDoUpdate({
			target: memoryNodes.id,
			set: {
				type: eventMemoryType(row),
				title: row.title,
				content: row.body,
				summary: row.body.replace(/\s+/g, ' ').slice(0, 360),
				keywords: [row.type],
				entityIds: [...asStringArray(row.actorEntityIds), ...asStringArray(row.targetEntityIds)],
				threadIds: asStringArray(row.threadIds),
				locationId: row.locationId ?? null,
				visibility: row.visibility,
				importance: eventImportance(row),
				sourceEntryIds: asStringArray(row.sourceEntryIds),
				sourceEventIds: [row.id],
				sourcePatchIds: asStringArray(row.sourcePatchIds),
				metadata: { sourceType: 'event_projection', jobId: job.id },
				serverVersion: row.serverVersion,
				updatedAt,
			},
		});
	}
	return rows.length;
}

async function processBackendJob(job: BackendJobRow): Promise<Record<string, unknown>> {
	const type = job.type as BackendJobType;
	switch (type) {
		case 'create_memory_nodes_from_events':
		case 'rebuild_retrieval_projection':
		case 'update_faction_pressure':
			return { materializedEventMemories: await createMemoryNodesFromEvents(job) };
		case 'embed_memory_nodes':
			return { deferred: true, reason: 'Embedding provider worker is not configured in this pass.' };
		case 'summarize_chapter':
		case 'rollup_arc':
		case 'evaluate_world_sim_tick':
			return { deferred: true, reason: 'Structured background processor placeholder; job remains traceable.' };
		default:
			throw new Error(`Unknown backend job type: ${job.type}`);
	}
}

export async function runDueBackendJobs(workerId = `worker_${Date.now()}`, limit = 10): Promise<{
	claimed: number;
	completed: number;
	failed: Array<{ jobId: string; error: string }>;
}> {
	const jobs = await claimBackendJobs(workerId, limit);
	const failed: Array<{ jobId: string; error: string }> = [];
	let completed = 0;
	for (const job of jobs) {
		try {
			await processBackendJob(job);
			await markBackendJobComplete(job.id);
			completed += 1;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await markBackendJobFailed(job.id, error);
			failed.push({ jobId: job.id, error: message });
		}
	}
	return { claimed: jobs.length, completed, failed };
}
