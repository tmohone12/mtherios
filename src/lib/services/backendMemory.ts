import { chatgptCsrfHeaders } from './chatgptBrowser';
import {
	memoryRetrieveRequestSchema,
	retrievedMemoryPacketSchema,
	syncPullResponseSchema,
	syncPushResponseSchema,
	storyEntriesAroundResponseSchema,
	turnPreviewResponseSchema,
	turnSubmissionResponseSchema,
	type MemoryRetrieveRequest,
	type RetrievedMemoryPacket,
	type SyncChange,
	type SyncOperation,
	type StoryEntriesAroundResponse,
	type TurnRequest,
	type TurnPreviewResponse,
	type TurnSubmissionResponse,
} from '$lib/contracts/memory';
import { engineCommandResponseSchema } from '$lib/contracts/engine';
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
		headers: { 'Content-Type': 'application/json', ...chatgptCsrfHeaders() },
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

export async function postEngineCommand(
	storyId: string,
	command: string,
	args: Record<string, unknown>,
	clientCommandId?: string,
): Promise<unknown> {
	const raw = await postJson('/api/engine/command', {
		storyId,
		command,
		...(clientCommandId ? { clientCommandId } : {}),
		args,
	});
	const response = engineCommandResponseSchema.parse(raw);
	if (response.status !== 'succeeded') {
		throw new TerminalRequestError(
			response.error ?? `Engine command failed: ${response.command}`,
			502,
			'ENGINE_COMMAND_FAILED',
		);
	}
	return response.result;
}

export async function retrieveBackendMemory(
	request: MemoryRetrieveRequest,
): Promise<RetrievedMemoryPacket | null> {
	const parsed = memoryRetrieveRequestSchema.parse(request);
	try {
		const raw = await postEngineCommand(parsed.storyId, 'memory.retrieve', parsed);
		return retrievedMemoryPacketSchema.parse(raw);
	} catch (error) {
		console.warn('[BackendMemory] Retrieval fell back to local memory:', error);
		return null;
	}
}

export interface ProcessBackendTurnOptions {
	signal?: AbortSignal;
	onNarrationChunk?: (chunk: string) => void | Promise<void>;
}

export async function processBackendTurn(
	request: TurnRequest,
	options: ProcessBackendTurnOptions = {},
): Promise<TurnSubmissionResponse> {
	const response = await fetch('/api/turn/stream', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(request),
		signal: options.signal,
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
		throw new TerminalRequestError(
			typeof body.error === 'string' ? body.error : `Terminal request failed: ${response.status}`,
			response.status,
			typeof body.code === 'string' ? body.code : null,
		);
	}
	if (!response.headers.get('content-type')?.includes('text/event-stream')) {
		const raw = await response.json();
		const commandResponse = engineCommandResponseSchema.safeParse(raw);
		if (commandResponse.success) {
			if (commandResponse.data.status !== 'succeeded') {
				throw new TerminalRequestError(
					commandResponse.data.error ?? `Engine command failed: ${commandResponse.data.command}`,
					502,
					'ENGINE_COMMAND_FAILED',
				);
			}
			return turnSubmissionResponseSchema.parse(commandResponse.data.result);
		}
		return turnSubmissionResponseSchema.parse(raw);
	}
	if (!response.body) throw new TerminalRequestError('Terminal turn stream returned no response body.', 502, 'EMPTY_TURN_STREAM');

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let completed: TurnSubmissionResponse | null = null;
	const handleFrame = async (frame: string) => {
		let event = 'message';
		const data: string[] = [];
		for (const line of frame.split('\n')) {
			if (line.startsWith('event:')) event = line.slice(6).trim();
			else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
		}
		if (data.length === 0) return;
		const payload = JSON.parse(data.join('\n')) as Record<string, unknown>;
		if (event === 'narration.chunk' && typeof payload.text === 'string') {
			await options.onNarrationChunk?.(payload.text);
		} else if (event === 'done' || event === 'pending') {
			completed = turnSubmissionResponseSchema.parse(payload);
		} else if (event === 'error') {
			throw new TerminalRequestError(
				typeof payload.error === 'string' ? payload.error : 'Terminal turn stream failed.',
				502,
				'TURN_STREAM_FAILED',
			);
		}
	};

	while (true) {
		const { value, done } = await reader.read();
		buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
		let boundary = buffer.indexOf('\n\n');
		while (boundary >= 0) {
			const frame = buffer.slice(0, boundary).trim();
			buffer = buffer.slice(boundary + 2);
			if (frame) await handleFrame(frame);
			boundary = buffer.indexOf('\n\n');
		}
		if (done) break;
	}
	if (buffer.trim()) await handleFrame(buffer.trim());
	if (!completed) throw new TerminalRequestError('Terminal turn stream ended before a final response.', 502, 'INCOMPLETE_TURN_STREAM');
	return completed;
}

export async function previewBackendTurn(request: TurnRequest): Promise<TurnPreviewResponse> {
	const raw = await postEngineCommand(request.storyId, 'turn.preview', request as unknown as Record<string, unknown>, request.clientTurnId);
	return turnPreviewResponseSchema.parse(raw);
}

export async function fetchBackendEntriesAround(storyId: string, position: number, radius = 2): Promise<StoryEntriesAroundResponse> {
	const raw = await postEngineCommand(storyId, 'campaign.entriesAround', {
		position: Math.trunc(position),
		radius: Math.max(0, Math.min(100, Math.trunc(radius))),
	});
	return storyEntriesAroundResponseSchema.parse(raw);
}

export async function runBackendWorldSimTick(story: Story): Promise<Record<string, unknown> | null> {
	if (!story.serverStoryId) return null;
	return postEngineCommand(story.serverStoryId, 'jobs.worldSim', {
		localVersion: story.serverVersion ?? 0,
		force: true,
	}) as Promise<Record<string, unknown>>;
}

export async function saveBackendPlotEdit(story: Story, edit: import('$lib/contracts/plotEditing').PlotEdit) {
	if (!story.serverStoryId) throw new Error('This action requires a backend story.');
	return postEngineCommand(story.serverStoryId, 'plot.edit', edit as unknown as Record<string, unknown>);
}

export async function fetchBackendCommitments(story: Story) {
	if (!story.serverStoryId) throw new Error('This editor requires a backend story.');
	return postEngineCommand(story.serverStoryId, 'plot.commitments', {}) as Promise<{ serverVersion: number; agreements: (import('$lib/types').Agreement & { deleted: boolean })[]; schemes: (import('$lib/types').Scheme & { deleted: boolean })[] }>;
}

export async function retireBackendPlot(story: Story, serverVersion: number) {
	if (!story.serverStoryId) throw new Error('This action requires a backend story.');
	return postEngineCommand(story.serverStoryId, 'plotBrain.retire', { serverVersion, reason: 'Retired from the Plot Director editor.', quietTurns: 5 });
}

export async function runBackendPlotBrainPlan(
	story: Story,
	options: {
		trigger?: string;
		execute?: boolean;
		currentTurn?: number;
		currentWorldTime?: string | null;
		includeSecret?: boolean;
		frameId?: string;
		replacePendingFrameId?: string;
	} = {},
): Promise<Record<string, unknown> | null> {
	if (!story.serverStoryId) return null;
	return postEngineCommand(story.serverStoryId, 'plotBrain.plan', {
		trigger: options.trigger ?? 'manual',
		execute: options.execute ?? false,
		currentTurn: options.currentTurn ?? 0,
		currentWorldTime: options.currentWorldTime ?? null,
		includeSecret: options.includeSecret ?? true,
		...(options.frameId ? { frameId: options.frameId } : {}),
		...(options.replacePendingFrameId ? { replacePendingFrameId: options.replacePendingFrameId } : {}),
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
	const raw = await postEngineCommand(serverStoryId, 'sync.pull', {
		since: story.serverVersion ?? 0,
	});
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
		const raw = await postEngineCommand(serverStoryId, 'sync.push', {
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
