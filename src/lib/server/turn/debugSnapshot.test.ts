import { describe, expect, it } from 'vitest';
import { buildTurnDebugSnapshot } from './debugSnapshot';

describe('buildTurnDebugSnapshot', () => {
	it('keeps prompt and fact-source evidence while bounding long text', () => {
		const snapshot = buildTurnDebugSnapshot({
			kind: 'narration',
			playerText: 'Open the red door.',
			system: 'system prompt',
			prompt: 'prompt '.repeat(3000),
			messages: [
				{ role: 'user', content: 'previous action' },
				{ role: 'assistant', content: 'previous narration' },
			],
			retrievedMemory: {
				packet: 'memory packet '.repeat(2000),
				nodes: [
					{
						id: 'mem_1',
						title: 'Red Door',
						type: 'episodic',
						score: 12.5,
						sourceEntryIds: ['entry_1'],
						sourceEventIds: ['event_1'],
						sourcePatchIds: ['patch_1'],
					} as any,
				],
				retrievalDebug: ['candidates=8', 'selected=1'],
			},
			wikiContext: {
				markdown: 'wiki context '.repeat(2000),
				citations: ['Characters/Red Door.md'],
				pageCount: 1,
				seedCount: 1,
			},
			contextCounts: {
				entities: 3,
				factions: 1,
			},
			output: 'The red door opens.',
		});

		expect(snapshot.kind).toBe('narration');
		expect(snapshot.playerText).toBe('Open the red door.');
		expect((snapshot.prompt ?? '').length).toBeLessThan(13000);
		expect(snapshot.retrievedMemory?.packet.length).toBeLessThan(9000);
		expect(snapshot.wikiContext?.markdown.length).toBeLessThan(9000);
		expect(snapshot.retrievedMemory?.nodes[0]).toEqual({
			id: 'mem_1',
			title: 'Red Door',
			type: 'episodic',
			score: 12.5,
			sourceEntryIds: ['entry_1'],
			sourceEventIds: ['event_1'],
			sourcePatchIds: ['patch_1'],
		});
		expect(snapshot.contextCounts).toEqual({ entities: 3, factions: 1 });
		expect(snapshot.output).toBe('The red door opens.');
	});
});
