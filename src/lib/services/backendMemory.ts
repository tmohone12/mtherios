import {
	indexedDbImportResponseSchema,
	memoryRetrieveRequestSchema,
	retrievedMemoryPacketSchema,
	syncPushResponseSchema,
	turnResponseSchema,
	type MemoryRetrieveRequest,
	type RetrievedMemoryPacket,
	type SyncOperation,
	type TurnRequest,
	type TurnResponse,
} from '$lib/contracts/memory';
import { exportStory } from '$lib/services/storySync';
import {
	enqueueSyncOp,
	getPendingSyncOps,
	updateStory,
	updateSyncOp,
} from '$lib/services/database';
import { uuid } from '$lib/utils/uuid';
import type { Story, SyncOutboxOp } from '$lib/types';

async function postJson(url: string, payload: unknown): Promise<unknown> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(typeof body.error === 'string' ? body.error : `Backend request failed: ${response.status}`);
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

export async function importLocalStoryToBackend(storyId: string): Promise<{
	serverStoryId: string;
	serverVersion: number;
	counts: Record<string, number>;
}> {
	const bundle = await exportStory(storyId);
	const raw = await postJson('/api/import/indexeddb', {
		bundle,
		options: { preserveIds: true, rebuildMemoryNodes: true },
	});
	const imported = indexedDbImportResponseSchema.parse(raw);
	await updateStory(storyId, {
		serverStoryId: imported.storyId,
		serverVersion: imported.serverVersion,
		syncStatus: 'synced',
	});
	return {
		serverStoryId: imported.storyId,
		serverVersion: imported.serverVersion,
		counts: imported.counts,
	};
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

export async function pushPendingBackendOps(story: Story): Promise<{ serverVersion: number; syncStatus: Story['syncStatus'] } | null> {
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
		for (const rejected of response.rejected) {
			await updateSyncOp(rejected.opId, { status: 'rejected', error: rejected.reason });
		}
		await updateStory(story.id, {
			serverVersion: response.serverVersion,
			syncStatus: response.rejected.length > 0 ? 'conflict' : 'synced',
		});
		return {
			serverVersion: response.serverVersion,
			syncStatus: response.rejected.length > 0 ? 'conflict' : 'synced',
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Backend sync failed.';
		for (const op of pending) await updateSyncOp(op.id, { status: 'pending', error: message });
		await updateStory(story.id, { syncStatus: 'offline' });
		return { serverVersion: story.serverVersion ?? 0, syncStatus: 'offline' };
	}
}
