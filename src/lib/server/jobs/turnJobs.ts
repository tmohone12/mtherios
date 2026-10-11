import { outsideRequestScopes } from '$lib/server/requestScopes';
import { memoryJobTypes, nextBackendJobDueAt, projectJobTypes, worldJobTypes, type BackendJobType } from './outbox';

/**
 * Queued jobs run in this process as soon as the work that queued them is saved; nothing polls.
 * Each story has a memory lane (what a turn's context reads: extraction, scene checkpoint, memory
 * nodes, chapters, search) and a world lane (faction pressure, world simulation, Director
 * forecasts) that runs after it. A turn waits for its story's memory lane before reading context
 * (`settleStoryMemory`), so memory never falls behind the story; world jobs never hold a turn up.
 * Project jobs (images, settings checks, assistant batches) have their own lane. Lanes start
 * outside the queuing request's async stores, so a job never uses a turn's provider budget,
 * checkpoints or caller identity. A job retried
 * with a backoff wakes its lane once when it is due. `MTHERIOS_TURN_JOBS=false` turns all of this
 * off (tests, evals, isolated copies); `jobs.runDue` still runs jobs by hand.
 */

export type TurnJobScope = { storyId: string; projectId?: undefined } | { projectId: string; storyId?: undefined };

export interface TurnJobDeps {
	runDue: (workerId: string, limit: number, scope: TurnJobScope, types: readonly BackendJobType[]) => Promise<{ claimed: number }>;
	nextDueAt: (scope: TurnJobScope, types: readonly BackendJobType[]) => Promise<number | null>;
	enabled: () => boolean;
	setTimer: (run: () => void, ms: number) => unknown;
	clearTimer: (timer: unknown) => void;
	now: () => number;
	log: (message: string, error?: unknown) => void;
	/** Starts lane work outside the caller's request-scoped async stores. */
	detach: <T>(work: () => T) => T;
}

const BATCH = 5;
/** Jobs per pass are capped; a larger backlog continues on the next kick. */
const MAX_ROUNDS = 40;
/** Lets the transaction that queued a job commit before its lane looks for it. */
const KICK_DELAY_MS = 1_000;
/** Backoffs further out are picked up by the story's next turn instead of a timer. */
const MAX_WAKE_MS = 15 * 60_000;

interface Lane { running: Promise<void> | null; again: boolean }

export function createTurnJobs(deps: TurnJobDeps) {
	const lanes = new Map<string, Lane>();
	const wakes = new Map<string, { at: number; timer: unknown }>();
	const kicks = new Map<string, unknown>();
	const workerId = `turn_jobs_${process.pid}`;

	/** Runs `work` now, or once more after the pass in progress; callers share one promise. */
	function runLane(key: string, work: () => Promise<void>): Promise<void> {
		const lane = lanes.get(key) ?? { running: null, again: false };
		lanes.set(key, lane);
		lane.again = true;
		lane.running ??= deps.detach(async () => {
			try {
				while (lane.again) {
					lane.again = false;
					await work();
				}
			} finally {
				lane.running = null;
			}
		});
		return lane.running;
	}

	async function drain(scope: TurnJobScope, types: readonly BackendJobType[]): Promise<void> {
		try {
			for (let round = 0; round < MAX_ROUNDS; round += 1) {
				if ((await deps.runDue(workerId, BATCH, scope, types)).claimed === 0) break;
			}
			await scheduleWake(scope, types);
		} catch (error) {
			deps.log(`[jobs] ${scopeKey(scope)} could not run its jobs`, error);
		}
	}

	async function scheduleWake(scope: TurnJobScope, types: readonly BackendJobType[]): Promise<void> {
		const dueAt = await deps.nextDueAt(scope, types);
		if (dueAt === null) return;
		const delay = Math.max(KICK_DELAY_MS, dueAt - deps.now());
		if (delay > MAX_WAKE_MS) return;
		const key = scopeKey(scope);
		const existing = wakes.get(key);
		if (existing && existing.at <= dueAt) return;
		if (existing) deps.clearTimer(existing.timer);
		const timer = deps.setTimer(() => { wakes.delete(key); kick(scope); }, delay);
		wakes.set(key, { at: dueAt, timer });
	}

	function memoryPass(storyId: string): Promise<void> {
		return runLane(`story:${storyId}:memory`, () => drain({ storyId }, memoryJobTypes));
	}

	function kick(scope: TurnJobScope): void {
		if (!deps.enabled()) return;
		if (scope.projectId !== undefined) {
			void runLane(`project:${scope.projectId}`, () => drain(scope, projectJobTypes));
			return;
		}
		const memory = memoryPass(scope.storyId);
		void runLane(`story:${scope.storyId}:world`, async () => {
			await memory;
			await drain(scope, worldJobTypes);
		});
	}

	return {
		/** Runs a story's or project's due jobs now, memory before world. */
		kick,
		/** Kick shortly, after the enqueuing transaction has committed; repeated calls coalesce. */
		scheduleKick(scope: TurnJobScope): void {
			if (!deps.enabled()) return;
			const key = scopeKey(scope);
			if (kicks.has(key)) return;
			kicks.set(key, deps.setTimer(() => { kicks.delete(key); kick(scope); }, KICK_DELAY_MS));
		},
		/**
		 * Wait until the story's due memory jobs have run. A cancelled turn stops waiting; the
		 * jobs keep running. Job failures are recorded on the jobs and never fail the turn.
		 */
		async settleStoryMemory(storyId: string, signal?: AbortSignal): Promise<void> {
			if (!deps.enabled()) return;
			const pass = memoryPass(storyId);
			if (!signal) return pass;
			signal.throwIfAborted();
			let onAbort!: () => void;
			const aborted = new Promise<never>((_, reject) => {
				onAbort = () => reject(signal.reason ?? new Error('Turn cancelled.'));
				signal.addEventListener('abort', onAbort, { once: true });
			});
			try { await Promise.race([pass, aborted]); }
			finally { signal.removeEventListener('abort', onAbort); }
		},
	};
}

function scopeKey(scope: TurnJobScope): string {
	return scope.projectId ? `project:${scope.projectId}` : `story:${scope.storyId}`;
}

const turnJobs = createTurnJobs({
	// Loaded lazily: the job processor reaches the turn pipeline, which uses this module.
	runDue: async (workerId, limit, scope, types) => (await import('./processor'))
		.runDueBackendJobs(workerId, limit, scope.storyId ?? null, types, scope.projectId),
	nextDueAt: nextBackendJobDueAt,
	enabled: () => process.env.MTHERIOS_TURN_JOBS !== 'false',
	setTimer: (run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; },
	clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
	now: () => Date.now(),
	log: (message, error) => console.error(message, error instanceof Error ? error.message : error ?? ''),
	detach: outsideRequestScopes,
});

export const kickStoryJobs = (storyId: string) => turnJobs.kick({ storyId });
export const scheduleJobKick = turnJobs.scheduleKick;
export const settleStoryMemory = turnJobs.settleStoryMemory;
