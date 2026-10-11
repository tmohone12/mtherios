import { chatgptCsrfHeaders } from './chatgptBrowser';
import {
	syncPullResponseSchema,
	syncPushResponseSchema,
	storyEntriesAroundResponseSchema,
	turnPreviewResponseSchema,
	type SyncChange,
	type SyncOperation,
	type StoryEntriesAroundResponse,
	type TurnRequest,
	type TurnPreviewResponse,
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

export interface BackendArcRollupResult {
	jobId: string | null;
	created: boolean;
	arcNumber: number | null;
	/** Why no arc was written, e.g. `arc_threshold_not_met`. */
	reason: string | null;
	/** The job's recorded failure; the job row keeps it for retry and diagnostics. */
	error: string | null;
}

/** Runs the server's `rollup_arc` job now; it applies the same 10-consecutive-chapter rule as the worker. */
export async function runBackendArcRollup(serverStoryId: string): Promise<BackendArcRollupResult> {
	const raw = await postEngineCommand(serverStoryId, 'jobs.rollupArc', { runNow: true }) as Record<string, unknown>;
	const job = raw.job && typeof raw.job === 'object' ? raw.job as Record<string, unknown> : {};
	const result = job.result && typeof job.result === 'object' ? job.result as Record<string, unknown> : {};
	return {
		jobId: typeof raw.jobId === 'string' ? raw.jobId : null,
		created: result.created === true,
		arcNumber: typeof result.number === 'number' ? result.number : null,
		reason: typeof result.reason === 'string' ? result.reason : null,
		error: job.completed === false ? (typeof job.error === 'string' && job.error ? job.error : 'The arc job failed.') : null,
	};
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
