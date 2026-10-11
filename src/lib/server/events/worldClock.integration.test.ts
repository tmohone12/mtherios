import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { shelves, stories, storyEntries, storyEvents, worldClocks, worldTimeChanges } from '$lib/server/db/schema';
import { worldStateUpdateSchema } from '$lib/services/ai/tools/schemas';

vi.mock('$lib/server/turn/provider', async original => ({
	...await original<typeof import('$lib/server/turn/provider')>(), generateServerTextWithMetrics: vi.fn(() => { throw new Error('Provider calls forbidden'); }),
}));
import { applyWorldTimeChange, configureWorldClock, loadWorldClock } from './worldClock';
import { scheduleTimelineEvent } from './timeline';
import { applyValidatedTurnUpdate } from '$lib/server/turn/patchValidator';

const databaseUrl = process.env.SUMMARY_CHECKPOINT_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
afterAll(async () => { if (databaseUrl) await closeDb(); });

async function fixture(label: string | null, run: (storyId: string) => Promise<void>) {
	if (!databaseUrl || !/summary_repair|test/i.test(new URL(databaseUrl).pathname)) throw new Error('Disposable test database required');
	const db = getDb();
	const [current] = await db.execute(sql`select current_database() as name`);
	if (current.name !== decodeURIComponent(new URL(databaseUrl).pathname.slice(1))) throw new Error('Database target differs from disposable test database');
	const storyId = `story_world_clock_${randomUUID()}`;
	const shelfId = `shelf_${storyId}`;
	try {
		await db.insert(shelves).values({ id: shelfId, name: 'Disposable clock test', slug: shelfId });
		await db.insert(stories).values({ id: storyId, shelfId, title: 'Disposable clock test', currentWorldTime: label, currentTurn: 4 });
		await run(storyId);
	} finally {
		await db.delete(shelves).where(eq(shelves.id, shelfId));
	}
}

const story = async (storyId: string) => (await getDb().select().from(stories).where(eq(stories.id, storyId)))[0];
const changes = (storyId: string) => getDb().select().from(worldTimeChanges).where(eq(worldTimeChanges.storyId, storyId)).orderBy(worldTimeChanges.createdAt);
const advance = (storyId: string, opKey: string, minutes: number) => getDb().transaction(tx => applyWorldTimeChange(tx, {
	storyId, opKey, proposal: { kind: 'advance', minutes, text: `${minutes} minutes` }, proposer: 'classifier', reason: 'Fixture wait.' }));

let position = 0;
async function turn(storyId: string, input: { narration: string; timeDelta?: string; playerMetadata?: Record<string, unknown>; narrationMetadata?: Record<string, unknown>; mode?: 'turn' | 'supplemental'; assistantEntryId?: string }) {
	const playerEntryId = `${storyId}_p_${position}`;
	const assistantEntryId = input.assistantEntryId ?? `${storyId}_n_${position}`;
	if (!input.assistantEntryId) {
		await getDb().insert(storyEntries).values([
			{ id: playerEntryId, storyId, type: 'user_action', content: 'I wait by the gate.', position: ++position, metadata: input.playerMetadata ?? {} },
			{ id: assistantEntryId, storyId, type: 'narration', content: input.narration, position: ++position, parentId: playerEntryId, metadata: input.narrationMetadata ?? {} },
		]);
	}
	return applyValidatedTurnUpdate({ storyId, playerEntryId: input.assistantEntryId ? assistantEntryId.replace('_n_', '_p_') : playerEntryId, assistantEntryId,
		narration: input.narration, update: worldStateUpdateSchema.parse(input.timeDelta ? { time_delta: input.timeDelta } : {}), parseWarnings: [], retrievedMemoryIds: [],
		serverVersion: 2, mode: input.mode ?? 'turn', ...(input.mode === 'supplemental' ? { timelineTurn: 4 } : {}) }, { enqueueProjectionJobs: false });
}

integration('World Clock in disposable PostgreSQL', () => {
	it('stops a ten-minute wait at an event due after three minutes, exactly once', async () => {
		await fixture('Day 3 | 06:15', async storyId => {
			const event = await scheduleTimelineEvent({ storyId, type: 'reveal', title: 'The bell rings', body: 'The watch bell rings.', currentTurn: 4, delayTurns: 0,
				delayWorldMinutes: 3, now: new Date().toISOString() });
			expect(event).toMatchObject({ status: 'scheduled', scheduledTurn: null, metadata: { dueWorldMinutes: 378 } });
			const first = await advance(storyId, 'wait:1', 10);
			expect(first).toMatchObject({ status: 'applied', requestedMinutes: 10, appliedMinutes: 3, interrupted: true, dueEventIds: [event.id], label: 'Day 3 | 06:18' });
			const repeat = await advance(storyId, 'wait:1', 10);
			expect(repeat).toMatchObject({ status: 'duplicate', appliedMinutes: 0 });
			expect((await story(storyId)).currentWorldTime).toBe('Day 3 | 06:18');
			const [due] = await getDb().select().from(storyEvents).where(eq(storyEvents.id, event.id));
			// Due is not an outcome: nothing marks it occurred.
			expect(due).toMatchObject({ status: 'due', occurredTurn: null });
			expect(await changes(storyId)).toEqual([expect.objectContaining({ opKey: 'wait:1', requestedMinutes: 10, appliedMinutes: 3, beforeMinutes: 375, afterMinutes: 378,
				beforeLabel: 'Day 3 | 06:15', afterLabel: 'Day 3 | 06:18', interruptedBy: [event.id] })]);
			// The next wait continues past the already-due event.
			await expect(advance(storyId, 'wait:2', 10)).resolves.toMatchObject({ appliedMinutes: 10, interrupted: false, label: 'Day 3 | 06:28' });
		});
	}, 30_000);

	it('applies a turn once: delayed extraction and repeats never re-advance; OOC, thought and POV turns never move it', async () => {
		await fixture('Day 3 | 06:15', async storyId => {
			await turn(storyId, { narration: '[ 🕰️ Time 06:45 | 🗓️ Day 3 | 📍 Location - Gate ]\nThe gate opens.' });
			expect((await story(storyId)).currentWorldTime).toBe('Day 3 | 06:45');
			const assistantEntryId = (await changes(storyId))[0].sourceEntryId!;
			// The deferred classifier result for the same turn arrives later with its own duration.
			await turn(storyId, { narration: '[ 🕰️ Time 06:45 | 🗓️ Day 3 | 📍 Location - Gate ]\nThe gate opens.', timeDelta: 'two hours', mode: 'supplemental', assistantEntryId });
			expect((await story(storyId)).currentWorldTime).toBe('Day 3 | 06:45');
			for (const variant of [{ playerMetadata: { actionType: 'ooc' }, narrationMetadata: { actionType: 'ooc' } }, { playerMetadata: { actionType: 'think' } },
				{ playerMetadata: { narrativeMode: 'parallel_pov' }, narrationMetadata: { narrativeMode: 'parallel_pov' } }]) {
				await turn(storyId, { narration: '[ 🕰️ Time 11:00 | 🗓️ Day 3 | 📍 Location - Tower ]\nElsewhere, time runs on.', timeDelta: 'four hours', ...variant });
			}
			// A narrated earlier time is not a rewind.
			const backwards = await turn(storyId, { narration: '[ 🕰️ Time 05:00 | 🗓️ Day 3 | 📍 Location - Gate ]\nThe gate creaks.' });
			expect(backwards.warnings.join(' ')).toContain('header_time_earlier_than_clock');
			const after = await story(storyId);
			expect(after.currentWorldTime).toBe('Day 3 | 06:45');
			expect(after.currentTurn).toBe(9);
			expect((await changes(storyId)).filter(change => change.status === 'applied')).toHaveLength(1);
		});
	}, 30_000);

	it('anchors an unknown clock from the first usable header and re-anchors on the record after an external label change', async () => {
		await fixture('Twilight of Ashes', async storyId => {
			await turn(storyId, { narration: 'No header here.', timeDelta: 'one hour' });
			expect((await story(storyId)).currentWorldTime).toBe('Twilight of Ashes (+1h)');
			await turn(storyId, { narration: '[ Time 22:40 | Day 9 | Location - Road ]\nNight falls.' });
			expect((await story(storyId)).currentWorldTime).toBe('Day 9 | 22:40');
			// An import or checkpoint revert replaces the label outside the clock.
			await getDb().update(stories).set({ currentWorldTime: 'Day 2 | 08:00' }).where(eq(stories.id, storyId));
			expect(await loadWorldClock(storyId, getDb(), 'Day 2 | 08:00')).toMatchObject({ minutes: 480, anchor: { kind: 'day-number', day: 2 } });
			await turn(storyId, { narration: '[ Time 08:30 | Day 2 | Location - Road ]\nMorning.' });
			expect((await story(storyId)).currentWorldTime).toBe('Day 2 | 08:30');
			expect((await changes(storyId)).map(change => [change.kind, change.proposer, change.afterLabel])).toEqual([
				['advance', 'classifier', 'Twilight of Ashes (+1h)'], ['anchor', 'gm_header', 'Day 9 | 22:40'],
				['set', 'external_label', 'Day 2 | 08:00'], ['advance', 'gm_header', 'Day 2 | 08:30'],
			]);
		});
	}, 30_000);

	it('rolls over on a configured calendar and records the operator change', async () => {
		await fixture('Day Fireday, Ember Moon 30, 299 AC | 23:30', async storyId => {
			await configureWorldClock({ storyId, reviewedBy: 'fixture-operator', calendar: { hoursPerDay: 24, era: 'AC', weekdays: ['Sunday', 'Moonday', 'Fireday'],
				months: [{ name: 'Silver Moon', days: 30 }, { name: 'Ember Moon', days: 30 }, { name: 'Frost Moon', days: 28 }] } });
			await expect(advance(storyId, 'sleep', 8 * 60)).resolves.toMatchObject({ label: 'Day Sunday, Frost Moon 1, 299 AC | 07:30' });
			const [row] = await getDb().select().from(worldClocks).where(and(eq(worldClocks.storyId, storyId), eq(worldClocks.branch, 'primary')));
			expect(row).toMatchObject({ minutes: 23 * 60 + 30 + 480, precision: 'minute', revision: 2 });
			expect((await changes(storyId)).map(change => change.proposer)).toEqual(['operator', 'classifier']);
		});
	}, 30_000);
});
