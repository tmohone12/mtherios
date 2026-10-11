import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGrainNegotiationSandbox, negotiationActorPacket, negotiationPresentationCues, runNegotiationStep,
	type NegotiationAdapters, type NegotiationSandbox, type NegotiationStep } from './negotiationPrototype';
import { grainDemoAdapters, runGrainNegotiationDemo } from './negotiationPrototype.demo';

function adapters(optionId: string, proposals: unknown = []): NegotiationAdapters {
	return {
		plan: vi.fn().mockResolvedValue(proposals),
		decide: vi.fn(async input => ({ optionId, model: 'fixture-decision', confidence: 0.9,
			sourceIds: [...input.sourceIds], memoryId: null, usage: null })),
	};
}
function step(state: NegotiationSandbox, overrides: Partial<NegotiationStep> = {}): NegotiationStep {
	return { id: `step_${state.revision}`, actorId: state.supplier.id, day: state.day, expectedRevision: state.revision, enabled: true, ...overrides };
}
async function offered() {
	const state = createGrainNegotiationSandbox();
	return (await runNegotiationStep(state, step(state), grainDemoAdapters)).state;
}
async function agreed() {
	const state = await offered();
	return (await runNegotiationStep(state, step(state, { id: 'accept', actorId: state.recipient.id, day: 1 }),
		adapters('accept_0', [{ kind: 'accept', sourceIds: [state.offer!.id] }]))).state;
}
afterEach(() => vi.unstubAllGlobals());

describe('isolated grain-for-concession negotiation', () => {
	it('is off by default and never calls either adapter', async () => {
		const state = createGrainNegotiationSandbox();
		const models = adapters('wait');
		const result = await runNegotiationStep(state, { id: 'disabled', actorId: state.supplier.id, day: 0, expectedRevision: 0 }, models);
		expect(result).toEqual({ state, receipt: null, outcome: 'disabled' });
		expect(models.plan).not.toHaveBeenCalled(); expect(models.decide).not.toHaveBeenCalled();
	});
	it('offers, counters, agrees, delivers after travel, then completes the bounded concession', async () => {
		const demo = await runGrainNegotiationDemo();
		expect(demo.trace.map(row => [row.day, row.outcome, row.supplierGrain, row.reservedGrain, row.recipientGrain])).toEqual([
			[0, 'offer', 100, 0, 10], [1, 'counteroffer', 100, 0, 10], [2, 'agreed', 100, 40, 10],
			[3, 'agreed', 100, 40, 10], [4, 'delivered', 60, 0, 50], [14, 'completed', 60, 0, 50],
		]);
		expect(demo.state.agreement).toMatchObject({ terms: { grain: 40, tollDays: 10 }, deliveryDay: 4, tollUntilDay: 14,
			supplierObligation: 'fulfilled', recipientObligation: 'fulfilled' });
		expect(demo.events.map(event => event.kind)).toEqual(['offer', 'counteroffer', 'agreement', 'delivery', 'concession_ended']);
	});
	it('gives both model seams only personal knowledge, own resources and directly received offers', async () => {
		const state = await offered();
		const packet = negotiationActorPacket(state, state.recipient.id);
		expect(packet.actor.beliefs.map(belief => belief.id)).toEqual(['granary_count']);
		expect(packet.sourceIds).toContain(state.offer!.id);
		expect(JSON.stringify(packet)).not.toContain('steward_report');
		expect(JSON.stringify(packet)).not.toContain('sandbox_route_record');
		expect(packet.counterparty).not.toHaveProperty('grain');
		expect(packet.counterparty).not.toHaveProperty('goals');
		const models = adapters('wait');
		await runNegotiationStep(state, step(state, { id: 'respond', actorId: state.recipient.id, day: 1 }), models);
		expect(vi.mocked(models.plan).mock.calls[0][0].actorPacket).toEqual({ ...packet, day: 1 });
		expect(vi.mocked(models.decide).mock.calls[0][0].evidence).toEqual({ ...packet, day: 1 });
		expect(vi.mocked(models.decide).mock.calls[0][0].options.map(option => option.id)).toEqual(['wait', 'investigate', 'refuse']);
	});
	it('does not treat public visibility as learned knowledge', () => {
		const state = createGrainNegotiationSandbox();
		state.events.push({ id: 'remote_signal', kind: 'delivery', day: 0, body: 'A remote army mobilizes.', sourceIds: [],
			knownBy: [], visibility: 'public', locationId: 'remote_city' });
		expect(negotiationActorPacket(state, state.supplier.id).witnessed).toEqual([]);
	});
	it.each([
		[{ kind: 'offer', terms: { grain: 40, tollDays: 20 }, sourceIds: ['secret_enemy_plan'] }],
		[{ kind: 'offer', terms: { grain: 40, tollDays: 20 }, sourceIds: ['steward_report'], inventedOutcome: 'The rival agrees.' }],
		[{ kind: 'offer', terms: { grain: -1, tollDays: 20 }, sourceIds: ['steward_report'] }],
	])('rejects unsupported sources, invented outcome fields and invalid terms', async proposal => {
		const state = createGrainNegotiationSandbox();
		const models = adapters('offer_0', [proposal]);
		const result = await runNegotiationStep(state, step(state), models);
		expect(result.receipt?.reason).toBe('planner_rejected');
		expect(models.decide).not.toHaveBeenCalled(); expect(result.state.events).toEqual([]);
	});
	it('does not let an adapter add a choice to the authoritative option list', async () => {
		const state = createGrainNegotiationSandbox();
		const models = adapters('wait');
		models.decide = async input => {
			input.options.push({ id: 'instant_success', description: 'Invent success.' });
			return { optionId: 'instant_success', model: 'fixture', confidence: 1, sourceIds: input.sourceIds, memoryId: null, usage: null };
		};
		expect((await runNegotiationStep(state, step(state), models)).receipt?.reason).toBe('decision_rejected');
	});
	it('rejects a decision with another actor private source', async () => {
		const state = createGrainNegotiationSandbox();
		const models = adapters('wait');
		models.decide = async () => ({ optionId: 'wait', model: 'fixture', confidence: 1, sourceIds: ['granary_count'], memoryId: null, usage: null });
		expect((await runNegotiationStep(state, step(state), models)).receipt?.reason).toBe('decision_rejected');
	});
	it('rejects a counteroffer exceeding the recipient mandate', async () => {
		const state = await offered();
		const result = await runNegotiationStep(state, step(state, { id: 'counter', actorId: state.recipient.id, day: 1 }),
			adapters('counteroffer_0', [{ kind: 'counteroffer', terms: { grain: 40, tollDays: 25 }, sourceIds: [state.offer!.id] }]));
		expect(result.receipt?.reason).toBe('planner_rejected'); expect(result.state.offer).toEqual(state.offer);
	});
	it('rechecks insufficient resources and authority at acceptance without charging either party', async () => {
		const state = await offered(); state.supplier.grain = 20;
		const models = adapters('accept_0', [{ kind: 'accept', sourceIds: [state.offer!.id] }]);
		const result = await runNegotiationStep(state, step(state, { id: 'accept', actorId: state.recipient.id, day: 1 }), models);
		expect(result.receipt?.reason).toBe('insufficient_grain'); expect(result.state.agreement).toBeNull();
		expect(result.state.supplier.grain).toBe(20); expect(result.state.recipient.grain).toBe(10);
		state.supplier.grain = 100; state.recipient.maxTollDays = 5;
		expect((await runNegotiationStep(state, step(state, { id: 'accept', actorId: state.recipient.id, day: 1 }), models)).receipt?.reason).toBe('concession_not_authorized');
	});
	it('blocks an unaffordable initial offer', async () => {
		const state = createGrainNegotiationSandbox(); state.supplier.grain = 20;
		const result = await runNegotiationStep(state, step(state), grainDemoAdapters);
		expect(result.receipt?.reason).toBe('insufficient_grain'); expect(result.state.events).toEqual([]);
	});
	it.each(['wait', 'investigate', 'refuse'])('allows %s without automatic project progress or new knowledge', async option => {
		const state = await offered();
		const result = await runNegotiationStep(state, step(state, { id: 'respond', actorId: state.recipient.id, day: 1 }), adapters(option));
		expect(result.state.agreement).toBeNull(); expect(result.state.supplier.grain).toBe(100); expect(result.state.recipient.grain).toBe(10);
		expect(result.state.recipient.beliefs).toEqual(state.recipient.beliefs);
		expect(result.outcome).toBe(option === 'wait' ? 'held' : option === 'investigate' ? 'investigating' : 'refused');
	});
	it('records failure from a sourced route constraint, releases grain and does not invent betrayal', async () => {
		const state = await agreed(); state.route.blocked = true;
		const models = adapters('wait');
		const result = await runNegotiationStep(state, step(state, { id: 'delivery', day: 3 }), models);
		expect(result.outcome).toBe('failed'); expect(result.state.supplier.grain).toBe(100); expect(result.state.supplier.reservedGrain).toBe(0);
		expect(result.state.recipient.grain).toBe(10);
		expect(result.state.agreement).toMatchObject({ supplierObligation: 'broken', recipientObligation: 'released', tollUntilDay: null });
		expect(result.state.events.at(-1)?.sourceIds).toContain('sandbox_route_record');
		expect(JSON.stringify(negotiationPresentationCues(result.state, state.locationId))).not.toMatch(/betrayal|blocked|sandbox_route_record/);
		expect(models.plan).not.toHaveBeenCalled();
	});
	it('waits for travel and handles a large explicit time step once at the actual milestones', async () => {
		const state = await agreed(); const models = adapters('wait');
		const before = await runNegotiationStep(state, step(state, { id: 'before_delivery', day: 2 }), models);
		expect(before.outcome).toBe('agreed'); expect(before.state.recipient.grain).toBe(10);
		const after = await runNegotiationStep(before.state, step(before.state, { id: 'later', day: 30 }), models);
		expect(after.outcome).toBe('completed'); expect(after.state.events.slice(-2).map(event => event.day)).toEqual([3, 23]);
		expect(models.decide).not.toHaveBeenCalled();
	});
	it('expires an unanswered offer before model calls, with no agreement or resource movement', async () => {
		const state = await offered(); const models = adapters('accept_0');
		const result = await runNegotiationStep(state, step(state, { id: 'late', actorId: state.recipient.id, day: 3 }), models);
		expect(result.outcome).toBe('expired'); expect(result.state.agreement).toBeNull(); expect(result.state.supplier.grain).toBe(100);
		expect(models.plan).not.toHaveBeenCalled();
	});
	it('replays the same step without model calls, double settlement or duplicate events', async () => {
		const state = await agreed(); const command = step(state, { id: 'delivery', day: 3 });
		const first = await runNegotiationStep(state, command, adapters('wait'));
		const models = adapters('wait'); const replay = await runNegotiationStep(first.state, command, models);
		expect(replay).toEqual(first); expect(models.plan).not.toHaveBeenCalled(); expect(models.decide).not.toHaveBeenCalled();
		await expect(runNegotiationStep(first.state, { ...command, day: 4 }, models)).rejects.toThrow('Step ID reused');
	});
	it('rejects a stale revision, rewound time, foreign actor and wrong negotiation turn', async () => {
		const state = await offered(); const models = adapters('wait');
		await expect(runNegotiationStep(state, step(state, { actorId: state.recipient.id, expectedRevision: 0 }), models)).rejects.toThrow('revision conflict');
		state.day = 1;
		await expect(runNegotiationStep(state, step(state, { actorId: state.recipient.id, day: 0 }), models)).rejects.toThrow('cannot rewind');
		await expect(runNegotiationStep(state, step(state, { actorId: 'foreign' }), models)).rejects.toThrow('outside the sandbox');
		await expect(runNegotiationStep(state, step(state), models)).rejects.toThrow('no negotiation turn');
	});
	it('holds on planner/decision rejection and abstention without a deterministic success fallback', async () => {
		const state = createGrainNegotiationSandbox();
		const planner = adapters('wait'); planner.plan = vi.fn().mockRejectedValue(new Error('fixture rejection'));
		expect((await runNegotiationStep(state, step(state), planner)).receipt?.reason).toBe('planner_rejected');
		const decision = adapters('wait'); decision.decide = vi.fn().mockRejectedValue(new Error('fixture rejection'));
		expect((await runNegotiationStep(state, step(state), decision)).receipt?.reason).toBe('decision_rejected');
		decision.decide = vi.fn().mockResolvedValue(null);
		expect((await runNegotiationStep(state, step(state), decision)).receipt?.reason).toBe('decision_abstained');
		decision.decide = vi.fn().mockResolvedValue({ optionId: 'wait', model: 'fixture', confidence: 0.2, sourceIds: [], memoryId: null, usage: null });
		expect((await runNegotiationStep(state, step(state), decision)).receipt?.reason).toBe('decision_abstained');
	});
	it.each(['plan', 'decide'] as const)('bounds a hung %s adapter with cancellation and no mutation', async seam => {
		const state = createGrainNegotiationSandbox(); const original = structuredClone(state); const models = adapters('wait');
		let signal: AbortSignal | undefined;
		if (seam === 'plan') models.plan = async input => { signal = input.signal; return new Promise(() => {}); };
		else models.decide = async input => { signal = input.signal; return new Promise(() => {}); };
		const result = await runNegotiationStep(state, step(state, { timeoutMs: 10 }), models);
		expect(result.receipt?.reason).toBe('adapter_timeout'); expect(signal?.aborted).toBe(true);
		expect(result.state.events).toEqual([]); expect(state).toEqual(original);
	});
	it('presents only established local consequences, with no secret terms or invented pressure', async () => {
		const state = await agreed(); const original = structuredClone(state);
		expect(negotiationPresentationCues(state, state.locationId)).toEqual([]);
		expect(state).toEqual(original);
		const delivered = (await runNegotiationStep(state, step(state, { id: 'delivery', day: 3 }), adapters('wait'))).state;
		expect(negotiationPresentationCues(delivered, 'elsewhere')).toEqual([]);
		expect(negotiationPresentationCues(delivered, state.locationId)).toEqual([{ id: 'delivery:delivery', type: 'faction_signal', visibility: 'public',
			body: "40 units of relief grain arrive at Hillmarch Regency's granary." }]);
	});
	it('runs with network blocked, imports no live service and rejects a non-sandbox snapshot', async () => {
		const fetch = vi.fn(() => { throw new Error('Network forbidden in prototype.'); }); vi.stubGlobal('fetch', fetch);
		await runGrainNegotiationDemo(); expect(fetch).not.toHaveBeenCalled();
		const source = readFileSync(new URL('./negotiationPrototype.ts', import.meta.url), 'utf8');
		const runtimeImports = source.split(/\r?\n/).filter(line => /^import (?!type\b)/.test(line));
		expect(runtimeImports).toEqual(["import { z } from 'zod';"]);
		const state = createGrainNegotiationSandbox();
		await expect(runNegotiationStep({ ...state, scope: 'live-story' } as unknown as NegotiationSandbox, step(state), adapters('wait'))).rejects.toThrow();
	});
});
