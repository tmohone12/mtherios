import { describe, expect, it, vi } from 'vitest';
import { createMemoryEngineCacheRepository } from '$lib/server/engine/cache';
import { applyPromptContextBudget, buildTurnContextReceipt, buildTurnPerformanceSummary, loadServerWikiContextWithCache, logSlowTurn, withBudget } from './orchestrator';

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

	it('returns a fallback when optional turn context exceeds its budget', async () => {
		vi.useFakeTimers();
		try {
			const resultPromise = withBudget(
				() => new Promise<string>((resolve) => setTimeout(() => resolve('loaded'), 1_000)),
				25,
				'fallback',
			);

			await vi.advanceTimersByTimeAsync(25);

			await expect(resultPromise).resolves.toBe('fallback');
		} finally {
			vi.useRealTimers();
		}
	});

	it('builds turn waterfall diagnostics for generation speed debugging', () => {
		const summary = buildTurnPerformanceSummary({
			turnId: 'turn-1',
			storyId: 'story-alpha',
			totalMs: 1962,
			model: 'gpt-test',
			profile: 'openai',
			stateExtractionMode: 'deferred',
			stablePromptHash: 'stable-hash',
			dynamicContextHash: 'dynamic-hash',
			recentMessageCount: 8,
			wikiChunkCount: 2,
			memoryItemCount: 3,
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
				{ phase: 'turn.service_config.narrative', durationMs: 40 },
				{ phase: 'turn.context_assembly', durationMs: 410, metadata: { parallel: true } },
				{ phase: 'turn.memory_retrieval', durationMs: 120 },
				{ phase: 'turn.context_load', durationMs: 80 },
				{ phase: 'turn.gm_timeline_brief', durationMs: 260 },
				{ phase: 'turn.wiki_context', durationMs: 700 },
				{ phase: 'turn.prompt_assembly', durationMs: 12 },
				{ phase: 'turn.persistence.allocate_position_version', durationMs: 20 },
				{ phase: 'turn.persistence.entries', durationMs: 60 },
				{ phase: 'turn.state_extraction.enqueue', durationMs: 15 },
				{ phase: 'turn.campaign_vault.append_evidence', durationMs: 180 },
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
			waterfall: {
				turnId: 'turn-1',
				storyId: 'story-alpha',
				model: 'gpt-test',
				profile: 'openai',
				totalMs: 1962,
				frontendOutboxFlushMs: null,
				commandRouterMs: null,
				resolveNarrativeMs: 40,
				retrieveMemoryPacketMs: 120,
				loadDbContextMs: 80,
				loadTimelineBriefMs: 260,
				loadWikiContextMs: 700,
				buildPromptMs: 12,
				inputTokens: 1300,
				outputTokens: 190,
				promptBytes: 6652,
				recentMessageCount: 8,
				wikiChunkCount: 2,
				memoryItemCount: 3,
				providerTimeToFirstTokenMs: null,
				providerTotalMs: 900,
				providerRetries: 0,
				providerTimeoutHit: false,
				persistMs: 80,
				stateExtractionMode: 'deferred',
				stateExtractionMs: 15,
				vaultAppendMs: 180,
				projectionBuildMs: 275,
				cacheHit: true,
				stablePromptHash: 'stable-hash',
				dynamicContextHash: 'dynamic-hash',
			},
			topSpans: [
				{ operation: 'turn.wiki_context', durationMs: 700 },
				{ operation: 'turn.context_assembly', durationMs: 410 },
				{ operation: 'turn.final_response.readback', durationMs: 275 },
				{ operation: 'turn.gm_timeline_brief', durationMs: 260 },
				{ operation: 'turn.campaign_vault.append_evidence', durationMs: 180 },
				{ operation: 'turn.memory_retrieval', durationMs: 120 },
				{ operation: 'turn.context_load', durationMs: 80 },
				{ operation: 'turn.persistence.entries', durationMs: 60 },
			],
			slowTimings: [
				{ operation: 'turn.wiki_context', durationMs: 700 },
				{ operation: 'turn.context_assembly', durationMs: 410 },
				{ operation: 'turn.final_response.readback', durationMs: 275 },
				{ operation: 'turn.gm_timeline_brief', durationMs: 260 },
			],
		});
	});

	it('builds context receipts that show included, skipped, and budgeted turn inputs', () => {
		const receipt = buildTurnContextReceipt({
			turnId: 'turn-1',
			storyId: 'story-alpha',
			truncated: true,
			recentEntryCount: 12,
			memoryNodeCount: 8,
			wikiChunkCount: 3,
			timelineEventCount: 5,
			factionIds: ['faction_red_sails'],
			skipped: [
				{ source: 'wiki', reason: 'budget_exceeded' },
				{ source: 'recent_transcript', reason: 'entry_limit' },
			],
			budgets: {
				memoryTokensUsed: 780,
				memoryTokensMax: 800,
				wikiCharsUsed: 3900,
				wikiCharsMax: 4000,
			},
		});

		expect(receipt).toEqual({
			turnId: 'turn-1',
			storyId: 'story-alpha',
			truncated: true,
			included: {
				recentEntries: 12,
				memoryNodes: 8,
				wikiChunks: 3,
				timelineEvents: 5,
				factionSheets: ['faction_red_sails'],
			},
			skipped: [
				{ source: 'wiki', reason: 'budget_exceeded' },
				{ source: 'recent_transcript', reason: 'entry_limit' },
			],
			budgets: {
				memoryTokensUsed: 780,
				memoryTokensMax: 800,
				wikiCharsUsed: 3900,
				wikiCharsMax: 4000,
			},
		});
	});

	it('logs compact slow-turn summaries above the configured threshold', () => {
		const summary = buildTurnPerformanceSummary({
			turnId: 'turn-2',
			storyId: 'story-beta',
			totalMs: 9_200,
			model: 'gpt-test',
			profile: 'openai',
			preparedCacheHit: false,
			prompt: {
				tokenEstimate: 1000,
				totalChars: 4000,
				messageCount: 6,
			},
			cache: null,
			generationTimings: [
				{ operation: 'turn.narration', serviceId: 'narrative', model: 'gpt-test', status: 'success', durationMs: 5_100, requestTokens: 800, responseTokens: 200, totalTokens: 1000 },
			],
			timings: [
				{ phase: 'turn.wiki_context', durationMs: 700 },
				{ phase: 'turn.final_response.readback', durationMs: 650 },
			],
		});
		const warn = vi.fn();

		logSlowTurn(summary, 8_000, warn);

		expect(warn).toHaveBeenCalledWith('[slow-turn]', {
			turnId: 'turn-2',
			storyId: 'story-beta',
			totalMs: 9200,
			model: 'gpt-test',
			topSpans: [
				{ operation: 'turn.wiki_context', durationMs: 700 },
				{ operation: 'turn.final_response.readback', durationMs: 650 },
			],
		});
	});
});
