import { expect, it } from 'vitest';
import { memoryRetrieveRequestSchema, type MemoryNode } from '$lib/contracts/memory';
import { isCurrentAgreement, resolveAgreementTarget } from '$lib/contracts/agreements';
import { activeMemoryCandidates, buildMemoryPacket } from './ranking';
import { agreementToMemoryNode, transcriptMemoryCandidates } from './retrieval';

const request = memoryRetrieveRequestSchema.parse({ storyId: 'campaign', query: 'silver bell promise', currentTurn: 150, tokenBudget: 2400 });
const memory = (id: string, metadata: Record<string, unknown> = {}): MemoryNode & { metadata: Record<string, unknown> } => ({
	id, storyId: 'campaign', type: 'episodic', title: 'Silver bell promise', content: `Silver bell promise ${id}.`,
	summary: null, keywords: ['silver', 'bell', 'promise'], entityIds: [], factionIds: [], threadIds: [], locationId: null,
	visibility: 'player_known', importance: 1, sourceEntryIds: [`source_${id}`], sourceEventIds: [], sourcePatchIds: [], metadata,
	createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});

it('retains the corrected answer when only its superseded source matches the question', () => {
	const old = memory('old');
	const latest = { ...memory('latest', { supersedesIds: ['old'], validFromTurn: 100 }),
		title: 'Judgment 49', content: 'The obligation was discharged in full.', keywords: [], importance: 0 };
	const distractors = Array.from({ length: 20 }, (_, index) => ({ ...memory(`noise_${index}`),
		title: 'Routine inspection', content: 'The council counted grain.', keywords: [] }));
	const packet = buildMemoryPacket([old, latest, ...distractors], request);
	expect(packet.nodes[0].id).toBe('latest');
	expect(packet.packet).toContain('discharged in full');
	expect(packet.nodes.map(node => node.id)).not.toContain('old');
});

it('keeps a chain of superseded promises historical, with closed validity and future facts bounded by turn', () => {
	const old = memory('old', { temporalKey: 'bell', validFromTurn: 1 });
	const middle = memory('middle', { temporalKey: 'bell', validFromTurn: 50, status: 'superseded', supersedesId: 'old' });
	const latest = memory('latest', { temporalKey: 'bell', validFromTurn: 100, supersedesId: 'middle' });
	const expired = memory('expired', { validFromTurn: 2, validToTurn: 150 });
	const future = memory('future', { validFromTurn: 151 });
	const candidates = [old, middle, latest, expired, future];
	expect(activeMemoryCandidates(candidates, 150).map(node => node.id)).toEqual(['latest']);
	const history = buildMemoryPacket(candidates, { ...request, includeHistorical: true });
	expect(history.nodes.map(node => node.id)).toEqual(expect.arrayContaining(['old', 'middle', 'latest', 'expired']));
	expect(history.nodes.map(node => node.id)).not.toContain('future');
	expect(history.packet).toContain('historical evidence');
	expect(history.tokenEstimate).toBeLessThanOrEqual(request.tokenBudget);
	// Cancelling the newest revision cannot resurrect an earlier one.
	expect(activeMemoryCandidates([old, { ...latest, metadata: { ...latest.metadata, status: 'cancelled' } }], 150)).toEqual([]);
});

it('keeps corrected rumors scoped to their believer and excludes secrets and removed sources even in historical lookup', () => {
	const first = { ...memory('first', { correctionKey: 'bell', validFromTurn: 1, believerEntityId: 'mira' }), type: 'npc_belief' as const, entityIds: ['mira'] };
	const corrected = { ...first, id: 'corrected', metadata: { ...first.metadata, validFromTurn: 100 } };
	const anotherBelief = { ...first, id: 'valen_belief', entityIds: ['valen'], metadata: { ...first.metadata, believerEntityId: 'valen' } };
	const objective = memory('objective', { correctionKey: 'bell', validFromTurn: 1 });
	expect(activeMemoryCandidates([first, corrected, anotherBelief, objective], 150).map(node => node.id)).toEqual(['corrected', 'valen_belief', 'objective']);
	const secret = { ...memory('secret'), visibility: 'secret' as const };
	const removed = memory('removed');
	const marker = memory('marker', { supersessionMarker: true, supersedesEntryIds: removed.sourceEntryIds });
	expect(activeMemoryCandidates([{ ...removed, type: 'npc_belief', entityIds: ['mira'] }, marker], 150)).toEqual([]);
	const history = buildMemoryPacket([first, corrected, secret, removed, marker, { ...memory('foreign'), storyId: 'other' }], { ...request, includeHistorical: true });
	expect(history.nodes.map(node => node.id)).toEqual(expect.arrayContaining(['first', 'corrected']));
	for (const id of ['secret', 'removed', 'marker', 'foreign']) expect(history.nodes.map(node => node.id)).not.toContain(id);
	expect(history.packet).toContain('NPC belief; may be false; owner:mira');
});

it('returns a fulfilled agreement as resolved history and accepts only an unambiguous same-campaign target', () => {
	const agreement = { id: 'bell', storyId: 'campaign', parties: ['Mira', 'Valen'], category: 'promise', terms: 'Return the silver bell', status: 'fulfilled', secrecy: 'known', consequences: [], sourceEntryIds: ['promise', 'fulfilled'], sourceEventIds: ['resolution'], sourcePatchIds: [], serverVersion: 3, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' };
	const result = buildMemoryPacket([agreementToMemoryNode(agreement)], request);
	expect(result.packet).toContain('historical agreement; no current duty; fulfilled');
	expect(result.packet).toContain('entries:promise,fulfilled');
	expect(isCurrentAgreement(agreement)).toBe(false);
	expect(isCurrentAgreement({ status: 'contested' })).toBe(true);
	const current = { ...agreement, status: 'active' };
	expect(resolveAgreementTarget([current], 'campaign', { parties: ['valen', ' MIRA '], category: 'promise' })?.id).toBe('bell');
	expect(resolveAgreementTarget([current], 'campaign', { id: 'wrong', parties: current.parties, category: 'promise' })).toBeUndefined();
	expect(resolveAgreementTarget([current, { ...current, id: 'duplicate' }], 'campaign', { parties: current.parties, category: 'promise' })).toBeUndefined();
});

it('does not mistake transcript positions for world turns after a long campaign', () => {
	const nodes = transcriptMemoryCandidates([{ id: 'late_entry', storyId: 'campaign', type: 'narration', position: 298, content: 'Mira returned the silver bell.', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], request, []);
	expect(buildMemoryPacket(nodes, request).nodes.map(node => node.id)).toContain('transcript_late_entry');
});
