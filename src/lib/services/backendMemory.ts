import {
	memoryRetrieveRequestSchema,
	retrievedMemoryPacketSchema,
	syncPullResponseSchema,
	syncPushResponseSchema,
	turnResponseSchema,
	type MemoryRetrieveRequest,
	type RetrievedMemoryPacket,
	type SyncChange,
	type SyncOperation,
	type TurnRequest,
	type TurnResponse,
} from '$lib/contracts/memory';
import { importStoryBundleToBackend } from '$lib/services/backendImport';
import { exportStory } from '$lib/services/storySync';
import {
	enqueueSyncOp,
	getPendingSyncOps,
	updateStory,
	updateSyncOp,
} from '$lib/services/database';
import { uuid } from '$lib/utils/uuid';
import type { Story, SyncOutboxOp } from '$lib/types';

export class TerminalRequestError extends Error {
	status: number;
	code: string | null;

	constructor(message: string, status: number, code: string | null = null) {
		super(message);
		this.name = 'TerminalRequestError';
		this.status = status;
		this.code = code;
	}
}

export function isTerminalReachabilityError(error: unknown): boolean {
	if (error instanceof TerminalRequestError) {
		return error.code === 'BACKEND_NOT_CONFIGURED' || error.status === 502 || error.status === 504;
	}
	return error instanceof TypeError;
}

async function postJson(url: string, payload: unknown): Promise<unknown> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
		throw new TerminalRequestError(
			typeof body.error === 'string' ? body.error : `Terminal request failed: ${response.status}`,
			response.status,
			typeof body.code === 'string' ? body.code : null,
		);
	}
	return response.json();
}

async function getJson(url: string): Promise<unknown> {
	const response = await fetch(url);
	if (!response.ok) {
		const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
		throw new TerminalRequestError(
			typeof body.error === 'string' ? body.error : `Terminal request failed: ${response.status}`,
			response.status,
			typeof body.code === 'string' ? body.code : null,
		);
	}
	return response.json();
}

export async function retrieveBackendMemory(
	request: MemoryRetrieveRequest,
): Promise<RetrievedMemoryPacket | null> {
	const parsed = memoryRetrieveRequestSchema.parse(request);
	try {
		const raw = await postJson('/api/memory/retrieve', parsed);
		return retrievedMemoryPacketSchema.parse(raw);
	} catch (error) {
		console.warn('[BackendMemory] Retrieval fell back to local memory:', error);
		return null;
	}
}

export async function processBackendTurn(request: TurnRequest): Promise<TurnResponse> {
	const raw = await postJson('/api/turn', request);
	return turnResponseSchema.parse(raw);
}

export async function runBackendWorldSimTick(story: Story): Promise<Record<string, unknown> | null> {
	if (!story.serverStoryId) return null;
	return postJson('/api/app/jobs/world-sim', {
		storyId: story.serverStoryId,
		localVersion: story.serverVersion ?? 0,
		force: true,
	}) as Promise<Record<string, unknown>>;
}

export async function importLocalStoryToBackend(storyId: string): Promise<{
	serverStoryId: string;
	serverVersion: number;
	counts: Record<string, number>;
}> {
	const bundle = await exportStory(storyId);
	return importStoryBundleToBackend(bundle, storyId);
}

export async function queueBackendSyncOp(
	story: Story,
	type: SyncOutboxOp['type'],
	payload: Record<string, unknown>,
): Promise<void> {
	const now = Date.now();
	await enqueueSyncOp({
		id: uuid(),
		storyId: story.id,
		serverStoryId: story.serverStoryId ?? null,
		type,
		payload,
		localVersion: story.serverVersion ?? 0,
		status: 'pending',
		error: null,
		createdAt: now,
		updatedAt: now,
	});
}

function toServerOp(op: SyncOutboxOp): SyncOperation {
	return {
		id: op.id,
		storyId: op.serverStoryId ?? op.storyId,
		type: op.type,
		payload: op.payload,
		clientVersion: op.localVersion,
		clientCreatedAt: new Date(op.createdAt).toISOString(),
	};
}

export async function pullBackendChanges(story: Story): Promise<{ serverVersion: number; changes: SyncChange[] } | null> {
	const serverStoryId = story.serverStoryId;
	if (!serverStoryId) return null;
	const params = new URLSearchParams({
		storyId: serverStoryId,
		since: String(story.serverVersion ?? 0),
	});
	const raw = await getJson(`/api/sync/pull?${params.toString()}`);
	const response = syncPullResponseSchema.parse(raw);
	return {
		serverVersion: response.serverVersion,
		changes: response.changes,
	};
}

export async function pushPendingBackendOps(story: Story): Promise<{ serverVersion: number; syncStatus: Story['syncStatus']; changes: SyncChange[] } | null> {
	const serverStoryId = story.serverStoryId;
	if (!serverStoryId) return null;
	const pending = await getPendingSyncOps(story.id);
	if (pending.length === 0) return null;

	for (const op of pending) await updateSyncOp(op.id, { status: 'pushing', error: null });

	try {
		const raw = await postJson('/api/sync/push', {
			storyId: serverStoryId,
			localVersion: story.serverVersion ?? 0,
			ops: pending.map(toServerOp),
		});
		const response = syncPushResponseSchema.parse(raw);
		for (const opId of response.appliedOpIds) await updateSyncOp(opId, { status: 'applied', error: null });
		const repairByOpId = new Map(response.repairItems.map((item) => [item.opId, item]));
		for (const rejected of response.rejected) {
			const repair = repairByOpId.get(rejected.opId);
			await updateSyncOp(rejected.opId, {
				status: repair ? 'needs_repair' : 'rejected',
				error: rejected.reason,
				repairPayload: repair?.payload ?? null,
				repairReason: repair?.reason ?? rejected.reason,
				repairCreatedAt: Date.now(),
			});
		}
		await updateStory(story.id, {
			serverVersion: response.serverVersion,
			syncStatus: response.rejected.length > 0 ? 'conflict' : 'synced',
		});
		return {
			serverVersion: response.serverVersion,
			syncStatus: response.rejected.length > 0 ? 'conflict' : 'synced',
			changes: response.changes,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Backend sync failed.';
		for (const op of pending) await updateSyncOp(op.id, { status: 'pending', error: message });
		await updateStory(story.id, { syncStatus: 'offline' });
		return { serverVersion: story.serverVersion ?? 0, syncStatus: 'offline', changes: [] };
	}
}
