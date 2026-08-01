import { describe, expect, it } from 'vitest';
import { memoryRetrieveRequestSchema } from '$lib/contracts/memory';
import { buildMemoryPacket } from './ranking';
import { transcriptMemoryCandidates } from './retrieval';

describe('transcriptMemoryCandidates', () => {
	it('recalls a cited fact from the oldest edge of 100 exchanges and drops unrelated rows', () => {
		const request = memoryRetrieveRequestSchema.parse({
			storyId: 'story_1',
			query: 'What promise did she make at the moon shrine?',
			sceneEntityIds: ['npc_akeno'],
		});
		const entries = [
			...Array.from({ length: 199 }, (_, index) => ({
				id: `entry_recent_${index}`, storyId: 'story_1', type: 'narration', position: 200 - index,
				content: `Akeno quietly adjusted her gloves for moment ${index}.`,
				createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
			})),
			{
				id: 'entry_old', storyId: 'story_1', type: 'narration', position: 1,
				content: `[ Time 22:00 | Moon Shrine ]\n\n${'Unrelated atmospheric opening. '.repeat(100)}\n\nAt the moon shrine, Akeno promised to return the silver bell before dawn.`,
				createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
			},
		];

		const candidates = transcriptMemoryCandidates(entries, request, [{ entityId: 'npc_akeno', label: 'Akeno' }]);
		const packet = buildMemoryPacket(candidates, request);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			id: 'transcript_entry_old',
			entityIds: ['npc_akeno'],
			sourceEntryIds: ['entry_old'],
		});
		expect(packet.nodes[0]?.id).toBe('transcript_entry_old');
		expect(packet.packet).toContain('[entries:entry_old]');
		expect(packet.packet).toContain('Akeno promised to return the silver bell before dawn.');
		expect(packet.packet).not.toContain('Unrelated atmospheric opening.');
		expect(packet.tokenEstimate).toBeLessThanOrEqual(request.tokenBudget);
	});
});
