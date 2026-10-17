import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { backendJobs, entities, factionGoals, factions, npcEventLinks, shelves, stories, storyEvents, storyThreads, worldTimeChanges } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('$lib/server/turn/provider', async original => ({
	...await original<typeof import('$lib/server/turn/provider')>(), generateServerTextWithMetrics: mocks.generate,
}));
vi.mock('$lib/server/engine/llmSettings', async original => ({
	...await original<typeof import('$lib/server/engine/llmSettings')>(),
	resolveServiceGeneration: vi.fn(async () => ({
		profile: { id: 'profile_world', providerType: 'nanogpt', baseUrl: 'https://example.invalid', apiKey: 'test' },
		generation: { model: 'world-fixture', reasoningEffort: 'off', temperature: 0.7 }, provenance: { limits: { maxRequests: 2 } }, fallbacks: [], missingReason: null,
	})),
}));
vi.mock('$lib/server/engine/generationAccounting', async original => ({
	...await original<typeof import('$lib/server/engine/generationAccounting')>(), recordGenerationApiCalls: vi.fn(async () => undefined),
}));
import { runWorldChronicleAdvanceCommand } from '$lib/server/engine/worldChronicleCommands';
import { executeEngineCommand } from '$lib/server/engine/command';
import { loadGmTimelineBrief } from '$lib/server/events/timeline';
import { listWorldChronicleEvents, reviewWorldChronicleEvent, simulateWorldHappenings } from './worldChronicle';

const databaseUrl = process.env.SUMMARY_CHECKPOINT_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (databaseUrl) await closeDb(); });

async function fixture(run: (storyId: string) => Promise<void>) {
	if (!databaseUrl || !/summary_repair|test/i.test(new URL(databaseUrl).pathname)) throw new Error('Disposable test database required');
	const db = getDb();
	const [current] = await db.execute(sql`select current_database() as name`);
	if (current.name !== decodeURIComponent(new URL(databaseUrl).pathname.slice(1))) throw new Error('Database target differs from disposable test database');
	const storyId = `story_world_chronicle_${randomUUID()}`;
	const shelfId = `shelf_${storyId}`;
	try {
		await db.insert(shelves).values({ id: shelfId, name: 'Disposable chronicle test', slug: shelfId });
		await db.insert(stories).values({ id: storyId, shelfId, title: 'The Ashen Crown', description: 'A fractured realm.', genre: 'Low fantasy',
			currentTurn: 12, currentWorldTime: 'Day 4 | 09:00', settings: { playerEntityId: `${storyId}_aric` } });
		await db.insert(entities).values([
			{ id: `${storyId}_varn`, storyId, type: 'location', name: 'Varn' },
			{ id: `${storyId}_ostmere`, storyId, type: 'location', name: 'Ostmere' },
			{ id: `${storyId}_mira`, storyId, type: 'character', name: 'Mira Vell' },
			{ id: `${storyId}_aric`, storyId, type: 'character', name: 'Aric Thornwood' },
		]);
		await db.insert(factions).values({ id: `${storyId}_guild`, storyId, name: 'Salt Guild', pressure: 4 });
		await db.insert(factionGoals).values({ id: `${storyId}_goal_tolls`, storyId, factionId: `${storyId}_guild`, goal: 'Raise the river tolls.' });
		await db.insert(storyThreads).values({ id: `${storyId}_thread_grain`, storyId, description: 'The southern granaries are running low.' });
		await db.insert(storyEvents).values({ id: `${storyId}_barge`, storyId, type: 'faction_move', title: 'Guild seizes a barge', body: 'The Salt Guild seized a grain barge.', createdTurn: 11 });
		await run(storyId);
	} finally {
		await db.delete(shelves).where(eq(shelves.id, shelfId));
	}
}

function batch(storyId: string) {
	const base = { factionNames: [], actorNames: [], visibility: 'public', reach: 'Market gossip carries it.', dayOffset: 0 };
	return JSON.stringify({ happenings: [
		{ ...base, title: 'Mira opens a soup kitchen', account: 'Mira Vell opened a soup kitchen in the Varn market for the hungry.', kind: 'social', stakes: 'low',
			whereName: 'varn', actorNames: ['Mira Vell'], seed: { type: 'thread', ref: `${storyId}_thread_grain` }, dayOffset: 1 },
		{ ...base, title: 'Guild doubles the river tolls', account: 'The Salt Guild doubled the tolls on every barge passing Ostmere.', kind: 'economic', stakes: 'medium',
			whereName: 'Ostmere', factionNames: ['salt guild'], seed: { type: 'faction_goal', ref: `${storyId}_goal_tolls` }, visibility: 'regional', dayOffset: 3 },
		{ ...base, title: 'Fire at the Black Keep', account: 'A fire gutted the archive of the Black Keep; nobody knows who set it.', kind: 'political', stakes: 'high',
			whereName: 'Black Keep', seed: { type: 'new', ref: 'arson' }, visibility: 'secret', reach: 'Only the keep garrison knows.', dayOffset: 5 },
		{ ...base, title: 'A rider seeks Aric', account: 'A rider asked for Aric Thornwood at every inn on the road.', kind: 'personal', stakes: 'low', whereName: 'Varn', seed: { type: 'new', ref: 'rider' } },
		{ ...base, title: 'Guild Seizes a Barge', account: 'The Salt Guild seized yet another grain barge on the river.', kind: 'economic', stakes: 'low', whereName: 'Ostmere', seed: { type: 'event', ref: `${storyId}_barge` } },
	] });
}

integration('World Chronicle in disposable PostgreSQL', () => {
	it('writes a reviewed batch, advances the clock once, replays on rerun, and delivers accepted happenings to the GM brief', async () => {
		await fixture(async storyId => {
			const db = getDb();
			mocks.generate.mockImplementation(async () => ({ model: 'world-fixture', text: batch(storyId), finishReason: 'stop', usage: {}, promptChars: 1, responseChars: 1, durationMs: 1, endpoint: 'fixture' }));
			const [before] = await db.select().from(stories).where(eq(stories.id, storyId));

			// A double click at the same story version finds the same job instead of buying a second batch.
			const queued = await runWorldChronicleAdvanceCommand({ storyId, span: 'week', eventfulness: 'turbulent', creativity: 'wild', runNow: false });
			const again = await runWorldChronicleAdvanceCommand({ storyId, span: 'week', eventfulness: 'quiet', runNow: false });
			expect(again.jobId).toBe(queued.jobId);
			expect(again).toMatchObject({ eventfulness: 'turbulent', creativity: 'wild' });

			const outcome = await runWorldChronicleAdvanceCommand({ storyId, span: 'week', runNow: true });
			expect(outcome.jobId).toBe(queued.jobId);
			expect(outcome).toMatchObject({ ok: true, status: 'complete' });
			const result = (outcome.job as { result: Record<string, unknown> }).result;
			expect(result).toMatchObject({ created: 3, proposed: 2, autoAccepted: 1, skippedDuplicates: 1, clockAdvancedMinutes: 7 * 1440, clockLabel: 'Day 11 | 09:00' });
			expect(result.dropped).toEqual([{ title: 'A rider seeks Aric', reason: 'mentions the player character' }]);
			expect(mocks.generate).toHaveBeenCalledTimes(1);
			expect(mocks.generate.mock.calls[0][0].prompt).toContain('Write between 5 and 7 happenings');

			const rows = await db.select().from(storyEvents).where(and(eq(storyEvents.storyId, storyId), sql`${storyEvents.metadata}->>'chronicleJobId' = ${String(queued.jobId)}`));
			const byTitle = new Map(rows.map(row => [row.title, row]));
			expect(byTitle.get('Mira opens a soup kitchen')).toMatchObject({ type: 'world_happening', status: 'committed', visibility: 'public', locationIds: [`${storyId}_varn`],
				actorEntityIds: [`${storyId}_mira`], threadIds: [`${storyId}_thread_grain`], worldTime: 'Day 5', occurredTurn: 12 });
			expect(byTitle.get('Guild doubles the river tolls')).toMatchObject({ status: 'proposed', visibility: 'player_known', locationIds: [`${storyId}_ostmere`], factionIds: [`${storyId}_guild`], worldTime: 'Day 7' });
			expect(byTitle.get('Fire at the Black Keep')).toMatchObject({ status: 'proposed', visibility: 'secret', locationIds: [], worldTime: 'Day 9',
				metadata: expect.objectContaining({ whereName: 'Black Keep', stakes: 'high', reach: 'Only the keep garrison knows.' }) });
			const links = await db.select().from(npcEventLinks).where(eq(npcEventLinks.storyId, storyId));
			expect(links.map(link => [link.eventId, link.npcEntityId])).toEqual([[byTitle.get('Mira opens a soup kitchen')!.id, `${storyId}_mira`]]);

			const [after] = await db.select().from(stories).where(eq(stories.id, storyId));
			expect(after.currentWorldTime).toBe('Day 11 | 09:00');
			expect(after.serverVersion).toBe(before.serverVersion + 1);
			expect(after.metadata).toMatchObject({ worldChronicle: { eventfulness: 'turbulent', creativity: 'wild', lastSpan: 'week' } });
			const changes = await db.select().from(worldTimeChanges).where(eq(worldTimeChanges.storyId, storyId));
			expect(changes.filter(change => change.status === 'applied' && change.kind === 'advance')).toEqual([expect.objectContaining({ proposer: 'world_chronicle', appliedMinutes: 7 * 1440 })]);

			// A rerun of the committed job returns its receipt: no request, no rows, no second clock move.
			const [jobRow] = await db.select().from(backendJobs).where(eq(backendJobs.id, String(queued.jobId)));
			expect(jobRow.metadata).toHaveProperty('chronicleReceipt');
			const replay = await simulateWorldHappenings({ ...jobRow, storyId });
			expect(replay).toMatchObject({ replayed: true, created: 3 });
			expect(mocks.generate).toHaveBeenCalledTimes(1);
			expect((await db.select().from(storyEvents).where(eq(storyEvents.storyId, storyId))).length).toBe(4);
			expect((await db.select().from(stories).where(eq(stories.id, storyId)))[0].currentWorldTime).toBe('Day 11 | 09:00');

			// Review: accept one draft, dismiss the other; drafts never reach the GM brief.
			const draftBrief = await loadGmTimelineBrief({ storyId, includeSecret: true });
			expect(draftBrief.recentEvents.map(event => event.title)).toContain('Mira opens a soup kitchen');
			expect(draftBrief.recentEvents.map(event => event.title)).not.toContain('Guild doubles the river tolls');
			const accepted = await executeEngineCommand({ storyId, command: 'world.chronicle.review',
				args: { eventId: byTitle.get('Guild doubles the river tolls')!.id, action: 'accept', body: 'The Salt Guild doubled the tolls on every barge at Ostmere.' } });
			expect(accepted).toMatchObject({ status: 'succeeded', result: { changed: true, event: { status: 'committed', body: 'The Salt Guild doubled the tolls on every barge at Ostmere.' } },
				projectionChanges: { worldChronicle: { review: { action: 'accept', status: 'committed' } } } });
			const dismissed = await reviewWorldChronicleEvent({ storyId, eventId: byTitle.get('Fire at the Black Keep')!.id, action: 'dismiss' });
			expect(dismissed).toMatchObject({ changed: true, event: { status: 'cancelled', metadata: expect.objectContaining({ dismissedAt: expect.any(String) }) } });
			const brief = await loadGmTimelineBrief({ storyId, includeSecret: true });
			expect(brief.recentEvents.map(event => event.title)).toEqual(expect.arrayContaining(['Guild doubles the river tolls', 'Mira opens a soup kitchen']));
			expect(brief.recentEvents.map(event => event.title)).not.toContain('Fire at the Black Keep');

			const refused = await executeEngineCommand({ storyId, command: 'world.chronicle.review', args: { eventId: `${storyId}_barge`, action: 'dismiss' } });
			expect(refused).toMatchObject({ status: 'failed', error: 'Only World Chronicle happenings can be reviewed here.' });
			await expect(reviewWorldChronicleEvent({ storyId: `${storyId}_other`, eventId: byTitle.get('Mira opens a soup kitchen')!.id, action: 'dismiss' })).rejects.toThrow(/Story not found/);

			const listed = await listWorldChronicleEvents(storyId);
			expect(listed.settings).toEqual({ eventfulness: 'turbulent', creativity: 'wild' });
			expect(listed.events.map(event => [event.title, event.status])).toEqual([
				['Fire at the Black Keep', 'cancelled'], ['Guild doubles the river tolls', 'committed'], ['Mira opens a soup kitchen', 'committed']]);
		});
	});
});
