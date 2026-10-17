import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), log: vi.fn(), resolve: vi.fn(), clearStore: () => {} }));
vi.mock('./summaryCheckpoints', async importOriginal => {
	const actual = await importOriginal<typeof import('./summaryCheckpoints')>();
	const { memorySummaryCheckpointStore } = await import('./summaryCheckpoints.testSupport');
	const memory = memorySummaryCheckpointStore(); mocks.clearStore = () => memory.rows.clear();
	return { ...actual, withSummaryCheckpoint: <T>(input: Parameters<typeof actual.withSummaryCheckpoint<T>>[0], generate: () => Promise<T>) => actual.withSummaryCheckpoint(input, generate, memory.store) };
});
vi.mock('$lib/server/engine/llmSettings', async importOriginal => ({ ...await importOriginal<typeof import('$lib/server/engine/llmSettings')>(), resolveServiceGeneration: mocks.resolve }));
vi.mock('$lib/server/engine/generationAccounting', async importOriginal => ({
	...await importOriginal<typeof import('$lib/server/engine/generationAccounting')>(), recordGenerationApiCalls: mocks.log, generationAttemptResult: (value: unknown) => value,
}));
vi.mock('$lib/server/turn/provider', async importOriginal => ({
	...await importOriginal<typeof import('$lib/server/turn/provider')>(), generateServerTextWithMetrics: mocks.generate,
}));

import {
	boundedCanonTimeline,
	buildWorldChroniclePrompt,
	dropPlayerMentions,
	effectiveStakes,
	generateWorldChronicle,
	parseWorldChronicleResponse,
	planWorldChronicleReview,
	planWorldHappeningRows,
	worldChronicleAdvanceMinutes,
	worldChronicleTargets,
	worldChronicleVisibility,
	type WorldChronicleContext,
	type WorldHappeningDraft,
} from './worldChronicle';
import { classifyBackendJobFailure } from './failureClassification';
import type { WorldClockState } from '$lib/server/events/worldClock';
import type { WorldChronicleJobPayload } from '$lib/contracts/worldChronicle';

type History = Parameters<typeof boundedCanonTimeline>[0];

const chapter = (number: number, text = `The company reached waypoint ${number}.`) => ({ id: `ch_${number}`, number, title: `Waypoint ${number}`, sceneOutcome: text });
const history = (input: { sagas?: unknown[]; arcs?: unknown[]; chapters?: unknown[] }): History =>
	({ sagas: input.sagas ?? [], arcs: input.arcs ?? [], chapters: input.chapters ?? [] }) as unknown as History;

function context(overrides: Partial<WorldChronicleContext> = {}, payload: Partial<WorldChronicleJobPayload> = {}): WorldChronicleContext {
	return {
		storyId: 'story_1',
		payload: { span: 'week', eventfulness: 'normal', creativity: 'balanced', source: 'manual', ...payload },
		story: { title: 'The Ashen Crown', description: 'A fractured realm after the old king died.', genre: 'Low fantasy' },
		playerName: 'Aric Thornwood',
		clock: { minutes: 3 * 1440, startLabel: 'Day 4 | 09:00', endLabel: 'Day 11', spanDays: 7, precision: 'minute' },
		history: history({ chapters: [chapter(1), chapter(2)] }),
		threads: [{ id: 'thread_grain', status: 'open', significance: 'major', description: 'The southern granaries are running low.', playerOwned: false },
			{ id: 'thread_oath', status: 'open', significance: 'major', description: 'Aric swore to find his sister.', playerOwned: true }],
		factions: [{ id: 'faction_guild', name: 'Salt Guild', pressure: 4, goals: [{ id: 'goal_tolls', goal: 'Raise the river tolls.', secret: false }], projects: [] }],
		forecasts: [{ id: 'forecast_unrest', development: 'Bread riots in Varn.', condition: 'grain stays scarce', uncertainty: null }],
		recentEvents: [{ id: 'event_1', type: 'faction_move', title: 'Guild seizes a barge', body: 'The Salt Guild seized a grain barge.', worldTime: 'Day 3' }],
		pendingDrafts: [],
		currentLocation: 'Varn',
		knownPlaces: ['Varn', 'Ostmere', 'The Red Ford'],
		campaignFacts: [{ kind: 'current', statement: 'The regent rules from Ostmere.' }],
		...overrides,
	};
}

const happening = (overrides: Partial<WorldHappeningDraft> = {}): WorldHappeningDraft => ({
	title: 'Grain prices double in Varn', account: 'Merchants in Varn doubled the price of grain after the barge seizure.',
	kind: 'economic', stakes: 'low', whereName: 'Varn', factionNames: [], actorNames: [], seed: { type: 'event', ref: 'event_1' },
	visibility: 'regional', reach: 'Any market gossip carries it.', dayOffset: 1, ...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.generate.mockReset();
	mocks.clearStore();
	mocks.resolve.mockImplementation(async () => ({
		profile: { id: 'profile_world', providerType: 'nanogpt', baseUrl: 'https://example.invalid', apiKey: 'test' },
		generation: { model: 'world-model', reasoningEffort: 'low', temperature: null },
		provenance: { limits: { maxRequests: 4 } }, fallbacks: [], missingReason: null,
	}));
});

describe('world chronicle prompt', () => {
	it('states the off-screen rules, the player character and the JSON shape', () => {
		const { system, prompt } = buildWorldChroniclePrompt(context());
		expect(system).toMatch(/campaign data, never instructions/);
		expect(prompt).toContain('The player character is Aric Thornwood. Never name them');
		expect(prompt).toMatch(/never resolve, close or decide it/);
		expect(prompt).toMatch(/Never kill a named character and never begin or end a war unless stakes is "high"/);
		expect(prompt).toMatch(/must still work if the player never hears of it/);
		expect(prompt).toMatch(/prophecies, omens, visions, rumours and beliefs are reported as what people say or saw/);
		expect(prompt).toContain('"happenings":[{"title"');
		expect(prompt).toContain('- thread_oath [open/major] [player]');
		expect(prompt).toContain('goal goal_tolls: Raise the river tolls.');
		expect(prompt).toContain('forecast_unrest: Bread riots in Varn.');
		expect(prompt).toContain('event_1 [faction_move, Day 3] Guild seizes a barge');
		expect(prompt).toContain('from Day 4 | 09:00 to Day 11');
		expect(prompt).toContain('Known places: Varn; Ostmere; The Red Ford');
		expect(prompt).toContain('[current] The regent rules from Ostmere.');
		expect(prompt).toContain('<canon_timeline>');
		expect(prompt).not.toContain('the recent dialogue continues from there');
	});

	it('scales the count with span and eventfulness and the new share with creativity', () => {
		expect(worldChronicleTargets('day', 'quiet', 'grounded')).toEqual({ min: 1, max: 2, maxNew: 0, chains: 0 });
		expect(worldChronicleTargets('week', 'normal', 'balanced')).toEqual({ min: 3, max: 5, maxNew: 1, chains: 2 });
		expect(worldChronicleTargets('season', 'turbulent', 'wild')).toEqual({ min: 8, max: 12, maxNew: 6, chains: 2 });
		expect(worldChronicleTargets('season', 'turbulent', 'balanced').maxNew).toBe(3);
		const quiet = buildWorldChroniclePrompt(context({}, { span: 'day', eventfulness: 'quiet', creativity: 'grounded' })).prompt;
		expect(quiet).toContain('Write between 1 and 2 happenings');
		expect(quiet).toContain('none may be new');
		expect(quiet).toContain('a causal link is optional');
		const wild = buildWorldChroniclePrompt(context({}, { span: 'season', eventfulness: 'turbulent', creativity: 'wild' })).prompt;
		expect(wild).toContain('Write between 8 and 12 happenings');
		expect(wild).toContain('At most 6 may be new');
		expect(wild).toContain('one or two causal chains');
		const unseeded = buildWorldChroniclePrompt(context({ threads: [], factions: [], forecasts: [], recentEvents: [] })).prompt;
		expect(unseeded).toContain('There are no listed seeds yet');
	});

	it('stays within 30k characters by keeping the newest history', () => {
		const sagas = [1, 2, 3, 4].map(number => ({ id: `saga_${number}`, number, title: `Saga Title ${number}`, summary: `Saga ${number} body. ${'Long canon history. '.repeat(320)}`,
			arcIds: [`arc_${number * 2 - 1}`, `arc_${number * 2}`], metadata: { summarySource: 'llm' } }));
		const arcs = [1, 2, 3, 4, 5, 6, 7, 8].map(number => ({ id: `arc_${number}`, number, title: `Arc ${number}`, summary: 'Arc summary.',
			chapterIds: [`ch_${number * 2 - 1}`, `ch_${number * 2}`], openThreadIds: [], metadata: {} }));
		const chapters = [...Array.from({ length: 16 }, (_, index) => chapter(index + 1)),
			...[17, 18, 19].map(number => chapter(number, `Recent chapter ${number}. ${'Fresh events. '.repeat(120)}`))];
		const large = context({ history: history({ sagas, arcs, chapters }),
			threads: Array.from({ length: 30 }, (_, index) => ({ id: `thread_${index}`, status: 'open', significance: 'minor', description: 'A long thread description. '.repeat(10), playerOwned: false })),
			recentEvents: Array.from({ length: 20 }, (_, index) => ({ id: `event_${index}`, type: 'rumor', title: `Rumour ${index}`, body: 'Whispers spread. '.repeat(20), worldTime: null })) });
		const { prompt, stats } = buildWorldChroniclePrompt(large);
		expect(prompt.length).toBeLessThanOrEqual(30_000);
		expect(stats.timelineChars).toBeLessThanOrEqual(20_000);
		expect(stats.timelineOmitted).toBeGreaterThan(0);
		expect(prompt).toContain('Recent chapter 19');
		expect(prompt).not.toContain('Saga Title 1');
		expect(prompt).toContain('[Earlier history is omitted here for length; it is still canon.]');
		expect(prompt).toContain('more not shown');
	});

	it('keeps the full canon timeline when it fits and the opening of an oversized newest entry', () => {
		expect(boundedCanonTimeline(history({ chapters: [chapter(1), chapter(2)] }), 20_000)).toMatchObject({ omitted: 0, total: 2 });
		const huge = boundedCanonTimeline(history({ chapters: [chapter(1), chapter(2, `Opening line. ${'x'.repeat(5000)}`)] }), 2000);
		expect(huge.text.length).toBeLessThanOrEqual(2000);
		expect(huge.text).toContain('Opening line.');
		expect(huge.omitted).toBe(1);
	});
});

describe('world chronicle response validation', () => {
	it('drops invalid happenings, normalizes enums and caps the batch at 12', () => {
		const raw = { happenings: [
			{ ...happening(), kind: 'Political', stakes: 'LOW', visibility: 'Public', dayOffset: '2' },
			{ ...happening({ title: 'A dragon is born' }), kind: 'magical' },
			...Array.from({ length: 13 }, (_, index) => happening({ title: `Happening number ${index}` })),
		] };
		const parsed = parseWorldChronicleResponse(raw);
		expect(parsed.happenings).toHaveLength(12);
		expect(parsed.happenings[0]).toMatchObject({ kind: 'political', stakes: 'low', visibility: 'public', dayOffset: 2 });
		expect(parsed.rejected).toEqual(expect.arrayContaining([
			expect.objectContaining({ title: 'A dragon is born', reason: expect.stringContaining('kind') }),
			expect.objectContaining({ reason: 'over the 12-happening cap' }),
		]));
	});

	it('rejects a batch with no usable happening or no happenings array', () => {
		expect(() => parseWorldChronicleResponse({ happenings: [{ ...happening(), kind: 'magical' }] })).toThrow(/no happening passed validation/);
		expect(() => parseWorldChronicleResponse({ events: [] })).toThrow(/no "happenings" array/);
		expect(parseWorldChronicleResponse({ happenings: [] })).toEqual({ happenings: [], rejected: [] });
	});

	it('drops happenings that name the player character', () => {
		const { kept, dropped } = dropPlayerMentions([
			happening({ title: 'Toll riot', account: 'Dockhands rioted over the tolls in Varn last night.' }),
			happening({ title: 'A letter for Aric', account: 'A courier left a sealed letter at the inn.' }),
			happening({ title: 'Thornwood banner seen', account: 'Riders under the Aric Thornwood banner crossed the ford.' }),
			happening({ title: 'Arica sails', account: 'The merchant ship Arica sailed for Ostmere with salt.' }),
			happening({ title: 'Hunters return', account: 'The hunters returned to Varn with deer.', actorNames: ['aric thornwood'] }),
		], ['Aric Thornwood']);
		expect(kept.map(item => item.title)).toEqual(['Toll riot', 'Arica sails']);
		expect(dropped).toHaveLength(3);
		expect(dropPlayerMentions([happening()], []).kept).toHaveLength(1);
	});
});

describe('world chronicle persistence mapping', () => {
	const clock: WorldClockState = { storyId: 'story_1', branch: 'primary', minutes: 3 * 1440 + 540, precision: 'minute', calendar: { hoursPerDay: 24 },
		anchor: { kind: 'day-number', day: 1 }, label: 'Day 4 | 09:00', revision: 3, persisted: true };
	const plan = (happenings: WorldHappeningDraft[], existingTitles: string[] = []) => planWorldHappeningRows({
		storyId: 'story_1', jobId: 'job_1', payload: { span: 'week', eventfulness: 'normal', creativity: 'balanced', source: 'manual' }, model: 'world-model',
		happenings, clock, startMinutes: clock.minutes, currentTurn: 42, serverVersion: 9, now: '2026-10-16T12:00:00.000Z',
		locations: [{ id: 'loc_varn', names: ['Varn', 'Varn-on-the-River'] }, { id: 'loc_ford', names: ['The Red Ford'] }],
		characters: [{ id: 'char_mira', names: ['Mira Vell'] }, { id: 'char_player', names: ['Aric Thornwood'] }],
		factions: [{ id: 'faction_guild', names: ['Salt Guild'] }, { id: 'faction_crown', names: ['The Crown'] }],
		threadIds: ['thread_grain'], goalFactions: new Map([['goal_tolls', 'faction_guild']]), playerId: 'char_player', existingTitles,
	});

	it('commits low stakes, proposes medium and high, and maps visibility', () => {
		const { rows } = plan([
			happening({ title: 'Market day', stakes: 'low', visibility: 'public' }),
			happening({ title: 'Guild raises tolls', stakes: 'medium', visibility: 'regional' }),
			happening({ title: 'The regent falls ill', stakes: 'high', visibility: 'secret' }),
		]);
		expect(rows.map(row => [row.status, row.visibility, row.occurredTurn])).toEqual([
			['committed', 'public', 42], ['proposed', 'player_known', null], ['proposed', 'secret', null]]);
		expect(rows[0]).toMatchObject({ type: 'world_happening', createdTurn: 42, serverVersion: 9,
			metadata: { sourceType: 'world_chronicle', chronicleJobId: 'job_1', span: 'week', autoAccepted: true, model: 'world-model' } });
		expect(rows[1].metadata).not.toHaveProperty('autoAccepted');
		expect(worldChronicleVisibility('regional')).toBe('player_known');
	});

	it('holds a "low" death or war for review', () => {
		expect(effectiveStakes(happening({ stakes: 'low', account: 'The old ferryman died in his sleep at the Red Ford.' }))).toEqual({ stakes: 'medium', raised: true });
		expect(effectiveStakes(happening({ stakes: 'low' }))).toEqual({ stakes: 'low', raised: false });
		const { rows } = plan([happening({ title: 'Ferryman dies', stakes: 'low', account: 'The old ferryman died in his sleep at the Red Ford.' })]);
		expect(rows[0]).toMatchObject({ status: 'proposed', metadata: { stakes: 'medium', requestedStakes: 'low', stakesRaised: true } });
	});

	it('resolves names case-insensitively and keeps unmatched names as text', () => {
		const { rows } = plan([happening({ whereName: 'the red ford', factionNames: ['salt guild', 'Iron Brotherhood'], actorNames: ['MIRA VELL', 'Old Tobin', 'Aric Thornwood'],
			seed: { type: 'faction_goal', ref: 'goal_tolls' } })]);
		expect(rows[0]).toMatchObject({ locationId: 'loc_ford', locationIds: ['loc_ford'], factionIds: ['faction_guild'], actorEntityIds: ['char_mira'] });
		expect(rows[0].metadata).toMatchObject({ unmatchedNames: { where: [], factions: ['Iron Brotherhood'], actors: ['Old Tobin'] }, whereName: 'the red ford' });
		const crown = plan([happening({ factionNames: [], seed: { type: 'faction_goal', ref: 'goal_tolls' } }), happening({ title: 'Thread news', seed: { type: 'thread', ref: 'thread_grain' } })]).rows;
		expect(crown[0].factionIds).toEqual(['faction_guild']);
		expect(crown[1].threadIds).toEqual(['thread_grain']);
		expect(plan([happening({ whereName: 'Atlantis' })]).rows[0]).toMatchObject({ locationId: null, locationIds: [] });
	});

	it('dates happenings by day offset within the span and skips duplicate titles', () => {
		const { rows, skippedDuplicates } = plan([
			happening({ title: 'First', dayOffset: 0 }),
			happening({ title: 'Second', dayOffset: 3 }),
			happening({ title: 'Late', dayOffset: 30 }),
			happening({ title: 'first' }),
			happening({ title: 'Guild Seizes a Barge' }),
		], ['Guild seizes a barge']);
		expect(rows.map(row => [row.title, row.worldTime])).toEqual([['First', 'Day 4'], ['Second', 'Day 7'], ['Late', 'Day 10']]);
		expect(rows[2].metadata).toMatchObject({ dayOffset: 6 });
		expect(skippedDuplicates).toEqual(['first', 'Guild Seizes a Barge']);
		expect(new Set(rows.map(row => row.id)).size).toBe(3);
	});

	it('advances the clock by whole calendar days per span', () => {
		expect(worldChronicleAdvanceMinutes('day', { hoursPerDay: 24 })).toBe(1440);
		expect(worldChronicleAdvanceMinutes('week', { hoursPerDay: 24 })).toBe(7 * 1440);
		expect(worldChronicleAdvanceMinutes('season', { hoursPerDay: 24 })).toBe(90 * 1440);
		expect(worldChronicleAdvanceMinutes('week', { hoursPerDay: 30 })).toBe(7 * 30 * 60);
		// The clock rejects any single step over a year; a 100-hour day stays inside it.
		expect(worldChronicleAdvanceMinutes('season', { hoursPerDay: 100 })).toBe(366 * 24 * 60);
	});
});

describe('world chronicle generation', () => {
	const input = (prompt = 'PROMPT') => ({ storyId: 'story_1', jobId: 'job_1', payload: { span: 'week' as const, eventfulness: 'normal' as const, creativity: 'balanced' as const, source: 'manual' },
		clockMinutes: 4320, system: 'SYSTEM', prompt });

	it('retries once with guidance after an invalid answer and checkpoints the result', async () => {
		mocks.generate
			.mockResolvedValueOnce({ model: 'world-model', text: JSON.stringify({ happenings: [{ ...happening(), kind: 'magical' }] }), finishReason: 'stop' })
			.mockResolvedValueOnce({ model: 'world-model', text: JSON.stringify({ happenings: [happening()] }), finishReason: 'stop' });
		const batch = await generateWorldChronicle(input());
		expect(batch.happenings).toHaveLength(1);
		expect(batch.model).toBe('world-model');
		expect(mocks.generate).toHaveBeenCalledTimes(2);
		expect(mocks.generate.mock.calls[1][0].prompt).toContain('Previous attempt failed');
		for (const [call] of mocks.generate.mock.calls) expect(call).toMatchObject({ maxRetries: 0, responseFormat: 'json_object', model: 'world-model', system: 'SYSTEM' });
		expect(mocks.log.mock.calls.some(([call]) => call.operation === 'world.chronicle' && call.serviceId === 'strategicWorldBrain' && call.status === 'success')).toBe(true);
		// A retried job replays the stored batch instead of buying it again.
		await generateWorldChronicle(input());
		expect(mocks.generate).toHaveBeenCalledTimes(2);
	});

	it('fails on missing model configuration before any request', async () => {
		mocks.resolve.mockResolvedValueOnce({ profile: null, generation: { model: '' }, missingReason: 'World planning has no model profile.', fallbacks: [] });
		const error = await generateWorldChronicle(input()).catch((cause: Error) => cause);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/^Model configuration needed: World planning has no model profile\./);
		expect(classifyBackendJobFailure((error as Error).message).cause).toBe('configuration');
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it('treats a truncated answer as provider output and stops after the corrected retry', async () => {
		mocks.generate.mockResolvedValue({ model: 'world-model', text: '{"happenings":[{"title":"Cut', finishReason: 'length' });
		const error = await generateWorldChronicle(input('OTHER PROMPT')).catch((cause: Error) => cause);
		expect((error as Error).message).toMatch(/finish_reason: length/);
		expect(classifyBackendJobFailure((error as Error).message).cause).toBe('provider_output');
		expect(mocks.generate).toHaveBeenCalledTimes(2);
	});
});

describe('world chronicle review', () => {
	const row = (overrides: Record<string, unknown> = {}) => ({ id: 'world_happening_1', storyId: 'story_1', status: 'proposed', title: 'Guild raises tolls',
		body: 'The Salt Guild raised river tolls.', visibility: 'player_known', metadata: { sourceType: 'world_chronicle', stakes: 'medium' }, ...overrides });
	const at = { now: '2026-10-16T12:00:00.000Z', currentTurn: 50 };

	it('accepts a draft, applying edits, and records when', () => {
		const plan = planWorldChronicleReview(row(), { storyId: 'story_1', eventId: 'world_happening_1', action: 'accept', title: 'Guild doubles tolls' }, at);
		expect(plan).toMatchObject({ changed: true, status: 'committed', patch: { status: 'committed', title: 'Guild doubles tolls', occurredTurn: 50,
			metadata: { sourceType: 'world_chronicle', acceptedAt: at.now, reviewedBy: 'author', editedFields: ['title'] } } });
		expect(planWorldChronicleReview(row({ status: 'committed' }), { storyId: 'story_1', eventId: 'world_happening_1', action: 'accept' }, at)).toEqual({ changed: false, status: 'committed' });
	});

	it('dismisses with a timestamp and edits without changing status', () => {
		expect(planWorldChronicleReview(row(), { storyId: 'story_1', eventId: 'world_happening_1', action: 'dismiss' }, at)).toMatchObject({
			changed: true, status: 'cancelled', patch: { status: 'cancelled', metadata: { dismissedAt: at.now, statusBeforeDismissal: 'proposed' } } });
		expect(planWorldChronicleReview(row({ status: 'cancelled', metadata: { sourceType: 'world_chronicle', dismissedAt: 'earlier' } }),
			{ storyId: 'story_1', eventId: 'world_happening_1', action: 'dismiss' }, at)).toEqual({ changed: false, status: 'cancelled' });
		const edit = planWorldChronicleReview(row(), { storyId: 'story_1', eventId: 'world_happening_1', action: 'edit', body: 'The guild raised the tolls on every barge.', visibility: 'public' }, at);
		expect(edit).toMatchObject({ changed: true, status: 'proposed', patch: { body: 'The guild raised the tolls on every barge.', visibility: 'public' } });
		expect(edit.changed && edit.patch).not.toHaveProperty('status');
		expect(planWorldChronicleReview(row(), { storyId: 'story_1', eventId: 'world_happening_1', action: 'edit', title: 'Guild raises tolls' }, at)).toEqual({ changed: false, status: 'proposed' });
		// Restoring a dismissed draft commits it.
		expect(planWorldChronicleReview(row({ status: 'cancelled', metadata: { sourceType: 'world_chronicle', dismissedAt: 'earlier' } }),
			{ storyId: 'story_1', eventId: 'world_happening_1', action: 'accept' }, at)).toMatchObject({ status: 'committed', patch: { metadata: expect.not.objectContaining({ dismissedAt: 'earlier' }) } });
	});

	it('refuses another story, a missing row and events that are not chronicle happenings', () => {
		expect(() => planWorldChronicleReview(row({ storyId: 'story_2' }), { storyId: 'story_1', eventId: 'world_happening_1', action: 'accept' }, at)).toThrow(/not found in this story/);
		expect(() => planWorldChronicleReview(undefined, { storyId: 'story_1', eventId: 'missing', action: 'accept' }, at)).toThrow(/not found in this story/);
		expect(() => planWorldChronicleReview(row({ metadata: { sourceType: 'faction_tick' } }), { storyId: 'story_1', eventId: 'world_happening_1', action: 'dismiss' }, at))
			.toThrow(/Only World Chronicle happenings/);
		expect(() => planWorldChronicleReview(row({ status: 'scheduled' }), { storyId: 'story_1', eventId: 'world_happening_1', action: 'accept' }, at)).toThrow(/cannot be accepted/);
	});
});
