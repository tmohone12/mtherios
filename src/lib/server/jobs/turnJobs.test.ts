import { describe, expect, it } from 'vitest';
import { outsideRequestScopes, requestScope } from '$lib/server/requestScopes';
import { memoryJobTypes, projectJobTypes, worldJobTypes, type BackendJobType } from './outbox';
import { createTurnJobs, type TurnJobDeps, type TurnJobScope } from './turnJobs';

type Call = { scope: TurnJobScope; group: 'memory' | 'world' | 'project' };

function harness(overrides: Partial<TurnJobDeps> & { queue?: Record<string, number> } = {}) {
	const calls: Call[] = [];
	const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
	const logs: string[] = [];
	// Due jobs left per lane; each runDue claims up to the batch size.
	const queue: Record<string, number> = { memory: 0, world: 0, project: 0, ...overrides.queue };
	const groupOf = (types: readonly BackendJobType[]) => types === memoryJobTypes ? 'memory' : types === worldJobTypes ? 'world' : 'project';
	const deps: TurnJobDeps = {
		runDue: async (_worker, limit, scope, types) => {
			const group = groupOf(types);
			calls.push({ scope, group });
			const claimed = Math.min(limit, queue[group]);
			queue[group] -= claimed;
			return { claimed };
		},
		nextDueAt: async () => null,
		enabled: () => true,
		setTimer: (run, ms) => { const timer = { run, ms, cleared: false }; timers.push(timer); return timer; },
		clearTimer: timer => { (timer as { cleared: boolean }).cleared = true; },
		now: () => 1_000_000,
		log: message => { logs.push(message); },
		detach: work => work(),
		...overrides,
	};
	return { jobs: createTurnJobs(deps), calls, timers, logs, queue };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('turn jobs', () => {
	it('runs a story\'s memory jobs to empty before its world jobs', async () => {
		const { jobs, calls } = harness({ queue: { memory: 7, world: 2 } });
		jobs.kick({ storyId: 'story_1' });
		await jobs.settleStoryMemory('story_1');
		await settle();
		expect(calls.map(call => call.group)).toEqual(['memory', 'memory', 'memory', 'memory', 'world', 'world']);
		expect(calls.every(call => call.scope.storyId === 'story_1')).toBe(true);
	});

	it('lets a turn wait for memory without waiting for world jobs', async () => {
		let releaseWorld!: () => void;
		const world = new Promise<void>(resolve => { releaseWorld = resolve; });
		const { jobs, calls } = harness({
			runDue: async (_worker, _limit, _scope, types) => {
				if (types === worldJobTypes) { calls.push({ scope: _scope, group: 'world' }); await world; }
				return { claimed: 0 };
			},
		});
		jobs.kick({ storyId: 'story_1' });
		await settle();
		expect(calls).toHaveLength(1);
		await expect(jobs.settleStoryMemory('story_1')).resolves.toBeUndefined();
		releaseWorld();
	});

	it('runs one more memory pass when a turn arrives during a pass, so newly queued jobs are included', async () => {
		let releaseFirst!: () => void;
		const first = new Promise<void>(resolve => { releaseFirst = resolve; });
		let memoryPasses = 0;
		const { jobs } = harness({
			runDue: async (_worker, _limit, _scope, types) => {
				if (types !== memoryJobTypes) return { claimed: 0 };
				memoryPasses += 1;
				if (memoryPasses === 1) await first;
				return { claimed: 0 };
			},
		});
		jobs.kick({ storyId: 'story_1' });
		const waiting = jobs.settleStoryMemory('story_1');
		releaseFirst();
		await waiting;
		expect(memoryPasses).toBe(2);
	});

	it('wakes a story once when a retried job becomes due, and not for distant backoffs', async () => {
		const near = harness({ nextDueAt: async () => 1_000_000 + 5_000 });
		near.jobs.kick({ storyId: 'story_1' });
		await near.jobs.settleStoryMemory('story_1');
		await settle();
		expect(near.timers.map(timer => timer.ms)).toEqual([5_000]);
		near.timers[0].run();
		await settle();
		expect(near.calls.length).toBeGreaterThan(2);

		const far = harness({ nextDueAt: async () => 1_000_000 + 60 * 60_000 });
		far.jobs.kick({ storyId: 'story_1' });
		await far.jobs.settleStoryMemory('story_1');
		await settle();
		expect(far.timers).toHaveLength(0);
	});

	it('coalesces kicks scheduled while the enqueuing transaction commits', () => {
		const { jobs, timers } = harness();
		jobs.scheduleKick({ storyId: 'story_1' });
		jobs.scheduleKick({ storyId: 'story_1' });
		jobs.scheduleKick({ projectId: 'project_1' });
		expect(timers).toHaveLength(2);
	});

	it('runs project jobs in their own lane', async () => {
		const { jobs, calls } = harness({ queue: { project: 1 } });
		jobs.kick({ projectId: 'project_1' });
		await settle();
		await settle();
		expect(calls[0]).toEqual({ scope: { projectId: 'project_1' }, group: 'project' });
		expect(projectJobTypes).toContain('assistant_batch_child');
	});

	it('does nothing when turn jobs are off', async () => {
		const { jobs, calls, timers } = harness({ enabled: () => false, queue: { memory: 3 } });
		jobs.kick({ storyId: 'story_1' });
		jobs.scheduleKick({ storyId: 'story_1' });
		await jobs.settleStoryMemory('story_1');
		expect(calls).toHaveLength(0);
		expect(timers).toHaveLength(0);
	});

	it('stops waiting when the turn is cancelled and keeps the jobs running', async () => {
		let release!: () => void;
		const hold = new Promise<void>(resolve => { release = resolve; });
		let finished = false;
		const { jobs } = harness({ runDue: async () => { await hold; finished = true; return { claimed: 0 }; } });
		const controller = new AbortController();
		const waiting = jobs.settleStoryMemory('story_1', controller.signal);
		controller.abort(new Error('Turn cancelled.'));
		await expect(waiting).rejects.toThrow('Turn cancelled.');
		release();
		await settle();
		expect(finished).toBe(true);
	});

	it('logs a lane that cannot run and still lets the turn proceed', async () => {
		const { jobs, logs } = harness({ runDue: async () => { throw new Error('database unavailable'); } });
		await expect(jobs.settleStoryMemory('story_1')).resolves.toBeUndefined();
		expect(logs).toEqual(['[jobs] story:story_1 could not run its jobs']);
	});

	it('starts jobs outside the queuing run\'s provider hooks and caller identity', async () => {
		const runScope = requestScope<string>();
		const seen: Array<string | undefined> = [];
		const { jobs } = harness({
			detach: outsideRequestScopes,
			runDue: async () => { seen.push(runScope.getStore()); return { claimed: 0 }; },
		});
		await runScope.run('agent-run-budget', () => jobs.settleStoryMemory('story_1'));
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every(value => value === undefined)).toBe(true);
	});

	it('classifies every runnable job type exactly once', () => {
		const groups = [...memoryJobTypes, ...worldJobTypes, ...projectJobTypes];
		expect(new Set(groups).size).toBe(groups.length);
		expect(memoryJobTypes).toEqual(expect.arrayContaining(['extract_turn_state', 'refresh_scene_checkpoint', 'summarize_chapter']));
		expect(worldJobTypes).toEqual(expect.arrayContaining(['update_faction_pressure', 'evaluate_world_sim_tick', 'plan_plot_brain']));
	});
});
