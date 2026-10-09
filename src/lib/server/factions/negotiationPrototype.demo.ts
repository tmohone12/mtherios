import { pathToFileURL } from 'node:url';
import { createGrainNegotiationSandbox, negotiationPresentationCues, runNegotiationStep,
	type NegotiationAdapters, type NegotiationSandbox, type negotiationActorPacket } from './negotiationPrototype.ts';

// These fixtures stand in for the planning LLM and the existing bounded decision API.
// Each receives only its actor packet; neither reads the sandbox or the other actor.
export const grainDemoAdapters: NegotiationAdapters = {
	async plan({ actorPacket: packet }) {
		if (!packet.pendingOffer) return [{ kind: 'offer', terms: { grain: 40, tollDays: 20 }, sourceIds: ['steward_report'] }];
		if (packet.actor.role === 'recipient') return [{ kind: 'counteroffer', terms: { grain: 40, tollDays: 10 },
			sourceIds: [packet.pendingOffer.id, 'council_mandate'] }];
		return [{ kind: 'accept', sourceIds: [packet.pendingOffer.id] }];
	},
	async decide(input) {
		const packet = input.evidence as ReturnType<typeof negotiationActorPacket>;
		const optionId = packet.phase === 'idle' ? 'offer_0' : packet.actor.role === 'recipient' ? 'counteroffer_0' : 'accept_0';
		return { optionId, confidence: 0.9, model: 'fixture-decision', sourceIds: input.sourceIds, memoryId: null, usage: null };
	},
};

export async function runGrainNegotiationDemo() {
	let state = createGrainNegotiationSandbox();
	const trace: Array<{ day: number; outcome: string; supplierGrain: number; reservedGrain: number; recipientGrain: number;
		agreement: NegotiationSandbox['agreement'] }> = [];
	for (const [day, actorId] of [[0, 'granary_league'], [1, 'hillmarch_regency'], [2, 'granary_league'],
		[3, 'granary_league'], [4, 'granary_league'], [14, 'hillmarch_regency']] as const) {
		const result = await runNegotiationStep(state, { id: `demo_day_${day}`, actorId, day,
			expectedRevision: state.revision, enabled: true }, grainDemoAdapters);
		state = result.state;
		trace.push({ day, outcome: result.outcome, supplierGrain: state.supplier.grain, reservedGrain: state.supplier.reservedGrain,
			recipientGrain: state.recipient.grain, agreement: structuredClone(state.agreement) });
	}
	return { mode: 'fixtures-only; no live AI or database', trace, events: state.events,
		directorCues: negotiationPresentationCues(state, state.locationId), state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { state: _state, ...demo } = await runGrainNegotiationDemo();
	console.log(JSON.stringify(demo, null, 2));
}
