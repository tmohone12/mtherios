import { describe, expect, it } from 'vitest';
import { createMemoryEngineCacheRepository } from '$lib/server/engine/cache';
import { applyPromptContextBudget, buildTurnPerformanceSummary, loadServerWikiContextWithCache } from './orchestrator';

describe('turn orchestrator prompt budgeting', () => {
	it('keeps unbounded dynamic prompt text unchanged', () => {
		const prompt = 'A'.repeat(5000);

		expect(applyPromptContextBudget(prompt, 0)).toEqual({
			value: prompt,
			truncated: false,
		});
		expect(applyPromptContextBudget(prompt, 6000)).toEqual({
			value: prompt,
			truncated: false,
		});
	});

	it('bounds dynamic prompt text while preserving the final narration instruction', () => {
		const finalInstruction = 'Return only the narration prose for the player action. Do not include JSON in this response.';
		const prompt = [
			'Story: Long Campaign',
			'Faction canon:',
			'House detail. '.repeat(500),
			finalInstruction,
		].join('\n\n');

		const result = applyPromptContextBudget(prompt, 1200);

		expect(result.truncated).toBe(true);
		expect(result.value.length).toBeLessThanOrEqual(1200);
		expect(result.value).toContain('Backend context budget truncated');
		expect(result.value.endsWith(finalInstruction)).toBe(true);
	});

	it('reuses wiki context when cached source hashes still match', async () => {
		const repository = createMemoryEngineCacheRepository();
		let loadCount = 0;

		const first = await loadServerWikiContextWithCache('story_alpha', 'Mira harbor', {
			repository,
			loadContext: async () => {
				loadCount += 1;
				return {
					contextMarkdown: '# Wiki Context\nMira knows the harbor.',
					citations: ['[1] Mira <wiki/mira.md>'],
					pageCount: 1,
					seedCount: 1,
					pages: [{ path: 'wiki/mira.md', updatedAt: '2026-06-06T00:00:00.000Z' }],
				};
			},
			sourceHash: async (sourcePaths) => sourcePaths.map((sourcePath) => `${sourcePath}:hash-a`),
		});
		const second = await loadServerWikiContextWithCache('story_alpha', 'Mira harbor', {
			repository,
			loadContext: async () => {
				loadCount += 1;
				return {
					contextMarkdown: '# Wiki Context\nThis should not be loaded.',
					citations: [],
					pageCount: 0,
					seedCount: 0,
					pages: [],
				};
			},
			sourceHash: async (sourcePaths) => sourcePaths.map((sourcePath) => `${sourcePath}:hash-a`),
		});

		expect(loadCount).toBe(1);
		expect(first.cacheHit).toBe(false);
		expect(second.cacheHit).toBe(true);
		expect(second.markdown).toBe('# Wiki Context\nMira knows the harbor.');
		expect(second.citations).toEqual(['[1] Mira <wiki/mira.md>']);
	});

	it('reloads wiki context when cached source hashes change', async () => {
		const repository = createMemoryEngineCacheRepository();
		let loadCount = 0;
		let currentHash = 'hash-a';
		const loadContext = async () => {
			loadCount += 1;
			return {
				contextMarkdown: `# Wiki Context\nVersion ${loadCount}.`,
				citations: ['[1] Mira <wiki/mira.md>'],
				pageCount: 1,
				seedCount: 1,
				pages: [{ path: 'wiki/mira.md', updatedAt: `2026-06-06T00:00:0${loadCount}.000Z` }],
			};
		};
		const sourceHash = async (sourcePaths: string[]) => sourcePaths.map((sourcePath) => `${sourcePath}:${currentHash}`);

		await loadServerWikiContextWithCache('story_alpha', 'Mira harbor', {
			repository,
			loadContext,
			sourceHash,
		});
		currentHash = 'hash-b';
		const second = await loadServerWikiContextWithCache('story_alpha', 'Mira harbor', {
			repository,
			loadContext,
			sourceHash,
		});

		expect(loadCount).toBe(2);
		expect(second.cacheHit).toBe(false);
		expect(second.markdown).toBe('# Wiki Context\nVersion 2.');
	});

	it('builds compact turn performance diagnostics for generation speed debugging', () => {
		const summary = buildTurnPerformanceSummary({
			preparedCacheHit: true,
			prompt: {
				tokenEstimate: 1663,
				totalChars: 6652,
				messageCount: 12,
			},
			cache: {
				hitCount: 3,
				missCount: 1,
				tokenEstimate: 2400,
				segments: [
					{ kind: 'prompt_system', cacheKey: 'cache-system', hit: true, invalidated: false, tokenEstimate: 800, contentHash: 'hash-a' },
					{ kind: 'retrieved_memory', cacheKey: 'cache-memory', hit: false, invalidated: false, tokenEstimate: 1600, contentHash: 'hash-b' },
				],
			},
			generationTimings: [
				{ operation: 'turn.narration', serviceId: 'narrative', model: 'gpt-test', status: 'success', durationMs: 900, requestTokens: 1000, responseTokens: 150, totalTokens: 1150 },
				{ operation: 'turn.state_extraction', serviceId: 'classifier', model: 'gpt-test-mini', status: 'success', durationMs: 320, requestTokens: 300, responseTokens: 40, totalTokens: 340 },
			],
			timings: [
				{ phase: 'turn.context_assembly', durationMs: 410, metadata: { parallel: true } },
				{ phase: 'turn.prompt_assembly', durationMs: 12 },
				{ phase: 'turn.final_response.readback', durationMs: 275 },
			],
			slowTimingThresholdMs: 250,
		});

		expect(summary).toEqual({
			preparedCacheHit: true,
			prompt: {
				tokenEstimate: 1663,
				totalChars: 6652,
				messageCount: 12,
			},
			cache: {
				hitCount: 3,
				missCount: 1,
				tokenEstimate: 2400,
				segmentCount: 2,
			},
			generation: {
				operationCount: 2,
				durationMs: 1220,
				requestTokens: 1300,
				responseTokens: 190,
				totalTokens: 1490,
			},
			slowTimings: [
				{ operation: 'turn.context_assembly', durationMs: 410 },
				{ operation: 'turn.final_response.readback', durationMs: 275 },
			],
		});
	});
});
