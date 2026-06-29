import { describe, expect, it } from 'vitest';
import { buildEngineCacheDebug, buildTurnDebugSnapshot } from './debugSnapshot';

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
				retrievalTrace: [
					{
						id: 'mem_1',
						title: 'Red Door',
						type: 'episodic',
						rank: 1,
						score: 12.5,
						included: true,
						reason: 'selected',
						tokenEstimate: 120,
						ageDays: 3,
						importance: 0.8,
						visibility: 'player_known',
						entityIds: ['npc_1'],
						factionIds: ['faction_1'],
						threadIds: ['thread_1'],
						sourceEntryIds: ['entry_1'],
						sourceEventIds: ['event_1'],
						sourcePatchIds: ['patch_1'],
						signals: ['query door', 'scene entity npc_1'],
					},
				],
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
			engineCache: {
				hitCount: 2,
				missCount: 1,
				tokenEstimate: 1200,
				segments: [
					{
						kind: 'prompt_system',
						cacheKey: 'engine-cache:story:prompt_system:stable',
						contentHash: 'hash-system',
						hit: true,
						invalidated: false,
						tokenEstimate: 800,
						hitCount: 5,
						missCount: 1,
						dependencyHashes: ['dep-a', 'dep-b'],
						value: 'this cached prompt text must not leak',
					} as any,
					{
						kind: 'retrieved_memory',
						cacheKey: 'engine-cache:story:retrieved_memory:scene',
						contentHash: 'hash-memory',
						hit: false,
						invalidated: true,
						tokenEstimate: 400,
						hitCount: 0,
						missCount: 2,
						dependencyHashes: ['dep-c'],
					} as any,
				],
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
		expect(snapshot.retrievedMemory?.retrievalTrace[0]).toEqual({
			id: 'mem_1',
			title: 'Red Door',
			type: 'episodic',
			rank: 1,
			score: 12.5,
			included: true,
			reason: 'selected',
			tokenEstimate: 120,
			ageDays: 3,
			importance: 0.8,
			visibility: 'player_known',
			entityIds: ['npc_1'],
			factionIds: ['faction_1'],
			threadIds: ['thread_1'],
			sourceEntryIds: ['entry_1'],
			sourceEventIds: ['event_1'],
			sourcePatchIds: ['patch_1'],
			signals: ['query door', 'scene entity npc_1'],
		});
		expect(snapshot.contextCounts).toEqual({ entities: 3, factions: 1 });
		expect(snapshot.engineCache).toEqual({
			hitCount: 2,
			missCount: 1,
			tokenEstimate: 1200,
			segments: [
				{
					kind: 'prompt_system',
					cacheKey: 'engine-cache:story:prompt_system:stable',
					contentHash: 'hash-system',
					hit: true,
					invalidated: false,
					tokenEstimate: 800,
					hitCount: 5,
					missCount: 1,
					dependencyCount: 2,
				},
				{
					kind: 'retrieved_memory',
					cacheKey: 'engine-cache:story:retrieved_memory:scene',
					contentHash: 'hash-memory',
					hit: false,
					invalidated: true,
					tokenEstimate: 400,
					hitCount: 0,
					missCount: 2,
					dependencyCount: 1,
				},
			],
		});
		expect(JSON.stringify(snapshot.engineCache)).not.toContain('this cached prompt text must not leak');
		expect(snapshot.output).toBe('The red door opens.');
	});

	it('bounds engine cache segment diagnostics in prompt audit snapshots', () => {
		const snapshot = buildTurnDebugSnapshot({
			kind: 'narration',
			playerText: 'Test cache bounds.',
			engineCache: {
				hitCount: 20,
				missCount: 10,
				tokenEstimate: 6000,
				segments: Array.from({ length: 40 }, (_, index) => ({
					kind: `segment_${index}`,
					cacheKey: `cache_${index}`,
					contentHash: `hash_${index}`,
					hit: index % 2 === 0,
					invalidated: index % 3 === 0,
					tokenEstimate: index + 1,
					hitCount: index,
					missCount: 40 - index,
					dependencyHashes: [`dep_${index}`],
				})),
			},
		});

		expect(snapshot.engineCache?.segments).toHaveLength(24);
		expect(snapshot.engineCache?.segments.at(-1)?.kind).toBe('segment_23');
	});

	it('keeps bounded prompt section trace diagnostics without leaking section content', () => {
		const snapshot = buildTurnDebugSnapshot({
			kind: 'narration',
			playerText: 'Trace this prompt.',
			promptSectionTrace: Array.from({ length: 30 }, (_, index) => ({
				id: index === 0 ? 'prompt_system' : `section_${index}`,
				lane: index === 0 ? 'engine_static' : 'turn_dynamic',
				priority: 100 - index,
				maxTokens: 10 + index,
				tokenEstimate: 10 + index,
				charCount: 40 + index,
				contentHash: `hash-${index}`,
				sourceIds: [`source_${index}`],
				sourceIdCount: 1,
				content: `secret section text ${index} must not leak`,
			})),
		} as any);

		expect(snapshot.promptSectionTrace).toHaveLength(24);
		expect(snapshot.promptSectionTrace?.[0]).toEqual({
			id: 'prompt_system',
			lane: 'engine_static',
			priority: 100,
			maxTokens: 10,
			tokenEstimate: 10,
			charCount: 40,
			contentHash: 'hash-0',
			sourceIds: ['source_0'],
			sourceIdCount: 1,
		});
		expect(snapshot.promptSectionTrace?.at(-1)?.id).toBe('section_23');
		expect(JSON.stringify(snapshot.promptSectionTrace)).not.toContain('secret section text');
	});

	it('maps prompt cache segment results into prompt audit diagnostics', () => {
		const diagnostics = buildEngineCacheDebug({
			hitCount: 1,
			missCount: 1,
			segments: [
				{
					hit: true,
					invalidated: false,
					entry: {
						kind: 'prompt_system',
						cacheKey: 'cache-system',
						contentHash: 'hash-system',
						tokenEstimate: 800,
						hitCount: 3,
						missCount: 1,
						dependencyHashes: ['dep-a', 'dep-b'],
						value: 'cached text must not appear',
					},
				},
				{
					hit: false,
					invalidated: true,
					entry: {
						kind: 'wiki_context',
						cacheKey: 'cache-wiki',
						contentHash: 'hash-wiki',
						tokenEstimate: 400,
						hitCount: 0,
						missCount: 2,
						dependencyHashes: ['dep-c'],
						value: 'wiki markdown must not appear',
					},
				},
			],
		} as any);

		expect(diagnostics).toEqual({
			hitCount: 1,
			missCount: 1,
			tokenEstimate: 1200,
			segments: [
				{
					kind: 'prompt_system',
					cacheKey: 'cache-system',
					contentHash: 'hash-system',
					hit: true,
					invalidated: false,
					tokenEstimate: 800,
					hitCount: 3,
					missCount: 1,
					dependencyCount: 2,
				},
				{
					kind: 'wiki_context',
					cacheKey: 'cache-wiki',
					contentHash: 'hash-wiki',
					hit: false,
					invalidated: true,
					tokenEstimate: 400,
					hitCount: 0,
					missCount: 2,
					dependencyCount: 1,
				},
			],
		});
		expect(JSON.stringify(diagnostics)).not.toContain('must not appear');
	});
});
