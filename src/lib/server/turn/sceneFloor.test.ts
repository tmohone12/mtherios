import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFloorCandidates, floorAdherence, floorModeFrom, floorQuestions, interpretFloorAnswers, renderFloorNote, turnsSinceSpoke, type FloorCandidate } from './sceneFloor';

const mocks = vi.hoisted(() => ({ resolveServiceGeneration: vi.fn(), requestSceneFloorDecision: vi.fn() }));
vi.mock('$lib/server/engine/llmSettings', async original => ({ ...await original<typeof import('$lib/server/engine/llmSettings')>(), resolveServiceGeneration: mocks.resolveServiceGeneration }));
vi.mock('./jev', async original => ({ ...await original<typeof import('./jev')>(), requestSceneFloorDecision: mocks.requestSceneFloorDecision }));
import { decideTurnSceneFloor } from './orchestrator';

const character = (id: string, name: string, state: Record<string, unknown> = {}) => ({ id, name, type: 'character', state, metadata: {} });
const daenerys = character('dany', 'Daenerys', { personality: 'Proud and just.', motivations: ['Hold the city'], knownFacts: ['The fleet sails at dawn'], relationship: { status: 'ally' } });
const barristan = character('barristan', 'Barristan', { motivations: ['Keep the queen safe'], currentGoal: 'Find the assassin' });
const missandei = character('missandei', 'Missandei', {});
const entities = [daenerys, barristan, missandei];
const cast = entities.map(({ id, name }) => ({ id, name }));
const narration = (content: string, id = `n_${content.length}`) => ({ id, type: 'narration', content });
const choice = (choice: string, confidence = 0.9, others: Record<string, number> = {}) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: confidence, ...others } });

describe('scene floor', () => {
	it('builds candidates with their own stakes and how long since they spoke', () => {
		const recent = [narration('Barristan says, "Your Grace, the walls are watched."', 'n1'), narration('The hall is quiet.', 'n2'), narration('Daenerys says, "Then we wait."', 'n3')];
		expect(Object.fromEntries(turnsSinceSpoke(recent, cast))).toEqual({ dany: 0, barristan: 2, missandei: null });
		const [dany, ser] = buildFloorCandidates({ cast, entities, recentEntries: recent,
			beliefs: [{ believerEntityId: 'barristan', belief: 'The cupbearer is a spy.', updatedAt: '2026-10-12' }] });
		expect(dany).toMatchObject({ key: 'a0', turnsSinceSpoke: 0, stakes: [{ id: 's0', kind: 'goal', text: 'Hold the city' }, { id: 's1', kind: 'knowledge', text: 'The fleet sails at dawn' }] });
		expect(ser.stakes.map(stake => stake.kind)).toEqual(['goal', 'goal', 'belief']);
		expect(ser.evidence).toMatchObject({ id: 'a1', name: 'Barristan', turnsSinceSpoke: 2 });
		// Only characters are candidates.
		expect(buildFloorCandidates({ cast: [{ id: 'loc', name: 'Hall' }], entities: [{ id: 'loc', name: 'Hall', type: 'location' }], beliefs: [], recentEntries: [] })).toEqual([]);
	});

	it('asks one addressee question and, per character, what they do and why', () => {
		const candidates = buildFloorCandidates({ cast, entities, beliefs: [], recentEntries: [] });
		const questions = floorQuestions(candidates) as Record<string, { criteria: Record<string, string> }>;
		expect(Object.keys(questions)).toEqual(['addressee', 'floor_a0', 'reason_a0', 'floor_a1', 'reason_a1', 'floor_a2']);
		expect(Object.keys(questions.addressee.criteria)).toEqual(['a0', 'a1', 'a2', 'room', 'none']);
		expect(Object.keys(questions.floor_a1.criteria)).toEqual(['answer', 'speak', 'gesture', 'silent']);
		expect(questions.reason_a0.criteria).toMatchObject({ none: expect.any(String), s0: 'goal: Hold the city' });
	});

	it('limits the floor: two answers, one interjection, the quiet character favoured, unsure answers left to the narrator', () => {
		const people = ['a', 'b', 'c', 'd'].map((key, index) => ({ key: `a${index}`, id: key, name: key.toUpperCase(), turnsSinceSpoke: key === 'd' ? null : 0,
			stakes: [{ id: 's0', kind: 'goal', text: `goal of ${key}` }], evidence: {} })) as FloorCandidate[];
		const floor = interpretFloorAnswers(people, { model: 'jev', answers: {
			addressee: choice('a0'), floor_a0: choice('answer'), reason_a0: choice('s0'),
			floor_a1: choice('speak', 0.82), floor_a2: choice('speak', 0.8), floor_a3: choice('speak', 0.78), reason_a3: choice('s0'),
		} }, 'on');
		expect(floor).toMatchObject({ status: 'decided', addresseeId: 'a', addressesRoom: false });
		expect(floor.actors.map(actor => [actor.id, actor.role, actor.heldBack])).toEqual([
			['a', 'answer', false], ['b', 'gesture', true], ['c', 'gesture', true], ['d', 'speak', false]]);
		expect(floor.actors[0].reason).toBe('goal: goal of a');
		const unsure = interpretFloorAnswers(people.slice(0, 1), { model: 'jev', answers: { addressee: choice('none'), floor_a0: choice('speak', 0.6) } }, 'on');
		expect(unsure).toMatchObject({ status: 'abstained', actors: [{ role: 'undecided', confidence: null }] });
	});

	it('tells the narrator who speaks, and checks who actually did', () => {
		const people = buildFloorCandidates({ cast, entities, beliefs: [], recentEntries: [] });
		const floor = interpretFloorAnswers(people, { model: 'jev', answers: {
			addressee: choice('a0'), floor_a0: choice('answer'), reason_a0: choice('s1'), floor_a1: choice('speak'), floor_a2: choice('silent') } }, 'on');
		const note = renderFloorNote(floor);
		expect(note).toContain('Addressed: Daenerys.');
		expect(note).toContain('Speaks: Daenerys answers the player (their knowledge: The fleet sails at dawn); Barristan may interject.');
		expect(note).toContain('Stays silent: Missandei.');
		const prose = 'Daenerys says, "We sail at dawn." Missandei whispers, "As you command." Barristan only nods.';
		expect(floorAdherence(floor, prose, 'I ask when we sail.')).toEqual({ spoke: ['dany', 'missandei'], unexpected: ['missandei'], missing: [] });
		expect(renderFloorNote({ ...floor, status: 'abstained' })).toBe('');
		expect(floorModeFrom({ floorMode: 'shadow' })).toBe('shadow');
		expect(floorModeFrom({})).toBe('on');
	});
});

describe('deciding the floor for a turn', () => {
	const ctx = { entities: entities as never, beliefs: [], recentEntries: [{ id: 'n1', type: 'narration', content: 'The throne room is cold.', parentId: null, metadata: {} }] as never };
	const service = (metadata: Record<string, unknown> = {}) => ({ profile: { id: 'jev', providerType: 'openrouter', apiKey: 'key' },
		generation: { model: 'typesafe/jev-1.13' }, setting: { metadata }, provenance: { enabled: true } });
	beforeEach(() => { vi.resetAllMocks(); });

	it('makes one Decisions request and returns the interpreted floor', async () => {
		mocks.resolveServiceGeneration.mockResolvedValue(service());
		mocks.requestSceneFloorDecision.mockResolvedValue({ durationMs: 10, json: { model: 'typesafe/jev-1.13', answers: {
			addressee: choice('a0'), floor_a0: choice('answer'), floor_a1: choice('gesture'), floor_a2: choice('silent') } } });
		const warnings: string[] = [];
		const result = await decideTurnSceneFloor({ request: { storyId: 'story', playerText: 'I ask Daenerys when we sail.' }, cast, ctx, location: 'Throne room', warnings });
		expect(result).toMatchObject({ requestsUsed: 1, floor: { mode: 'on', status: 'decided', addresseeId: 'dany' } });
		const sent = mocks.requestSceneFloorDecision.mock.calls[0][0];
		expect(sent).toMatchObject({ operation: 'turn.scene_floor', state: { playerAction: 'I ask Daenerys when we sail.', location: 'Throne room', latestNarration: 'The throne room is cold.' } });
		expect(sent.state.characters).toHaveLength(3);
	});

	it('is skipped when off or without Decisions, and never fails the turn', async () => {
		mocks.resolveServiceGeneration.mockResolvedValue(service({ floorMode: 'off' }));
		expect(await decideTurnSceneFloor({ request: { storyId: 'story', playerText: 'x' }, cast, ctx, location: null, warnings: [] })).toEqual({ floor: null, requestsUsed: 0 });
		mocks.resolveServiceGeneration.mockResolvedValue({ ...service(), provenance: { enabled: false } });
		expect(await decideTurnSceneFloor({ request: { storyId: 'story', playerText: 'x' }, cast, ctx, location: null, warnings: [] })).toEqual({ floor: null, requestsUsed: 0 });
		mocks.resolveServiceGeneration.mockResolvedValue(service({ floorMode: 'shadow' }));
		mocks.requestSceneFloorDecision.mockRejectedValue(new Error('Jev provider cooling down; retry in 30 seconds.'));
		const warnings: string[] = [];
		const failed = await decideTurnSceneFloor({ request: { storyId: 'story', playerText: 'x' }, cast, ctx, location: null, warnings });
		expect(failed).toMatchObject({ requestsUsed: 1, floor: { mode: 'shadow', status: 'unavailable', reason: expect.stringContaining('cooling down') } });
		expect(warnings[0]).toContain('Scene floor unavailable');
		mocks.requestSceneFloorDecision.mockResolvedValue({ durationMs: 1, json: { answers: 'wrong' } });
		expect((await decideTurnSceneFloor({ request: { storyId: 'story', playerText: 'x' }, cast, ctx, location: null, warnings: [] })).floor?.status).toBe('invalid');
	});
});
