import { describe, expect, it } from 'vitest';
import {
	extractCampaignProjection,
	extractEngineCacheStatus,
	extractTurnContextReceipt,
	extractTurnPerformance,
	openEngineEventStream,
	parseEngineStreamEvent,
	shouldRefreshCampaignProjection,
} from './engineStream';

const projection = {
	mode: 'control_surface',
	story: { id: 'story_alpha', title: 'Long Campaign', serverVersion: 5 },
	entries: [{ id: 'entry_5', position: 5, type: 'assistant', content: 'The court waits.' }],
	chapters: [],
	arcs: [],
	sagas: [],
	counts: { entries: 5, entities: 3, events: 2, memoryNodes: 1, chapters: 0, arcs: 0, sagas: 0 },
	vault: { vaultPath: 'data/vaults/campaigns/story_alpha', fileCount: 8, lastIndexedVersion: 5 },
	cache: {
		storyId: 'story_alpha',
		entryCount: 4,
		hitCount: 9,
		missCount: 2,
		tokenEstimate: 1200,
		byKind: [{ kind: 'rules_pack', entryCount: 1, hitCount: 3, missCount: 0, invalidatedCount: 0, tokenEstimate: 250 }],
		segments: [],
	},
};

function event(type: string, data: Record<string, unknown>) {
	return {
		id: `evt_${type}`,
		storyId: 'story_alpha',
		type,
		data,
		createdAt: '2026-06-05T12:00:00.000Z',
	};
}

class FakeEventSource {
	readonly listeners = new Map<string, Set<(event: { data: string }) => void>>();
	closed = false;

	constructor(readonly url: string) {}

	addEventListener(type: string, listener: (event: { data: string }) => void): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: (event: { data: string }) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	close(): void {
		this.closed = true;
	}

	emit(type: string, payload: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener({ data: JSON.stringify(payload) });
		}
	}
}

describe('engine stream client helpers', () => {
	it('extracts full campaign projections and cache status from backend SSE payloads', () => {
		const parsed = parseEngineStreamEvent(JSON.stringify(event('campaign.status', { projection })));

		expect(parsed?.type).toBe('campaign.status');
		expect(extractCampaignProjection(parsed)).toEqual(projection);
		expect(extractEngineCacheStatus(parsed)).toEqual(projection.cache);
		expect(shouldRefreshCampaignProjection(parsed)).toBe(false);
	});

	it('requests a bounded projection refresh for command/state events that only carry deltas', () => {
		const parsed = parseEngineStreamEvent(JSON.stringify(event('command.succeeded', {
			commandId: 'cmd_1',
			command: 'timeline.schedule',
			projectionChanges: { counts: { events: 3 }, cache: projection.cache },
		})));

		expect(extractCampaignProjection(parsed)).toBeNull();
		expect(extractEngineCacheStatus(parsed)).toEqual(projection.cache);
		expect(shouldRefreshCampaignProjection(parsed)).toBe(true);
		expect(shouldRefreshCampaignProjection(event('engine.heartbeat', {}))).toBe(false);
	});

	it('extracts compact turn performance diagnostics from command projection changes', () => {
		const performance = {
			preparedCacheHit: true,
			prompt: { tokenEstimate: 1663, totalChars: 6652, messageCount: 12 },
			cache: { hitCount: 4, missCount: 1, tokenEstimate: 6000, segmentCount: 4 },
			generation: {
				operationCount: 2,
				durationMs: 900,
				requestTokens: 1000,
				responseTokens: 120,
				totalTokens: 1120,
			},
			waterfall: {},
			topSpans: [],
			slowTimings: [{ operation: 'turn.context_assembly', durationMs: 410 }],
		};
		const parsed = parseEngineStreamEvent(JSON.stringify(event('command.succeeded', {
			commandId: 'cmd_turn',
			command: 'turn.submit',
			projectionChanges: { performance },
		})));

		expect(extractTurnPerformance(parsed)).toMatchObject(performance);
		expect(shouldRefreshCampaignProjection(parsed)).toBe(true);
	});

	it('extracts backend context receipts from command projection changes', () => {
		const contextReceipt = {
			turnId: 'turn_1',
			storyId: 'story_alpha',
			truncated: true,
			included: {
				recentEntries: 12,
				memoryNodes: 4,
				wikiChunks: 2,
				timelineEvents: 3,
				chapters: 0,
				arcs: 0,
				chaptersSuppressedByArcs: 0,
				chaptersSent: 0,
				arcsSent: 0,
				chaptersSuppressedByArc: 0,
				memoryNodesSent: 0,
				totalChars: 0,
				totalTokens: null,
				facts: 5,
				patchProposals: 7,
				unresolvedCharacterReferences: 2,
				continuityWarnings: 1,
				factionSheets: ['faction_watch'],
			},
			skipped: [{ source: 'dynamic_context', reason: 'truncated_by_context_budget' }],
			unresolvedCharacterReferences: [
				{
					proposalId: 'proposal_hooded_envoy',
					name: 'Hooded Envoy',
					contextLabel: 'faction_member/Red Sails',
					reason: 'Faction member named in "Red Sails".',
					sourceEntryIds: ['entry_12'],
				},
			],
			continuityLedger: {
				facts: [
					{
						id: 'fact_red_sails_oath',
						statement: 'The Red Sails swore to blockade the harbor.',
						sourceEntryIds: ['entry_10'],
						sourcePatchIds: ['patch_fact_1'],
					},
				],
				patchProposals: [
					{
						id: 'proposal_harbor_blockade',
						status: 'pending',
						proposalType: 'turn_event',
						targetTable: 'events',
						targetRecordId: 'event_harbor_blockade',
						reason: 'Narration introduced a delayed blockade consequence.',
						sourceEntryIds: ['entry_11'],
						sourcePatchIds: ['patch_event_1'],
					},
				],
				warnings: [
					{
						id: 'warning_timeline_overlap',
						level: 'warning',
						status: 'open',
						title: 'Timeline overlap',
						sourceEntryIds: ['entry_12'],
						sourcePatchIds: ['patch_warning_1'],
					},
				],
			},
			cacheSegments: [
				{
					kind: 'prompt_system',
					cacheKey: 'engine-cache:story-alpha:prompt_system:stable',
					contentHash: 'hash-system',
					hit: true,
					invalidated: false,
					tokenEstimate: 640,
					dependencyCount: 2,
				},
			],
			budgets: {
				memoryTokensUsed: 1800,
				memoryTokensMax: 2400,
				wikiCharsUsed: 1200,
				wikiCharsMax: 6000,
			},
		};
		const parsed = parseEngineStreamEvent(JSON.stringify(event('command.succeeded', {
			commandId: 'cmd_turn',
			command: 'turn.submit',
			projectionChanges: { contextReceipt },
		})));

		expect(extractTurnContextReceipt(parsed)).toEqual(contextReceipt);
		expect(shouldRefreshCampaignProjection(parsed)).toBe(true);
	});

	it('treats compact campaign status events as refresh requests instead of full projections', () => {
		const parsed = parseEngineStreamEvent(JSON.stringify(event('campaign.status', {
			mode: 'control_surface',
			counts: projection.counts,
			vault: projection.vault,
			cache: projection.cache,
		})));

		expect(extractCampaignProjection(parsed)).toBeNull();
		expect(extractEngineCacheStatus(parsed)).toEqual(projection.cache);
		expect(shouldRefreshCampaignProjection(parsed)).toBe(true);
	});

	it('opens a story-scoped EventSource and routes named backend events to control-surface handlers', () => {
		const sources: FakeEventSource[] = [];
		const seen: string[] = [];
		const projections: unknown[] = [];
		const cacheStatuses: unknown[] = [];
		const turnPerformance: unknown[] = [];
		const contextReceipts: unknown[] = [];
		const refreshes: string[] = [];

		const subscription = openEngineEventStream({
			storyId: 'story alpha',
			replay: 7,
			eventSourceFactory: (url) => {
				const source = new FakeEventSource(url);
				sources.push(source);
				return source;
			},
			onEvent: (engineEvent) => seen.push(engineEvent.type),
			onProjection: (next) => projections.push(next),
			onCacheStatus: (next) => cacheStatuses.push(next),
			onTurnPerformance: (next) => turnPerformance.push(next),
			onTurnContextReceipt: (next) => contextReceipts.push(next),
			onRefreshRequested: (engineEvent) => refreshes.push(engineEvent.type),
		});

		expect(subscription.url).toBe('/api/engine/stream?storyId=story+alpha&replay=7');
		const source = sources[0];
		expect(source).toBeDefined();
		source.emit('campaign.status', event('campaign.status', { projection }));
		source.emit('command.succeeded', event('command.succeeded', {
			commandId: 'cmd_2',
			command: 'timeline.advance',
			projectionChanges: { counts: { events: 4 } },
		}));
		source.emit('state.changed', event('state.changed', {
			performance: {
				preparedCacheHit: false,
				prompt: { tokenEstimate: 800, totalChars: 3200, messageCount: 8 },
				cache: null,
				generation: {
					operationCount: 1,
					durationMs: 600,
					requestTokens: null,
					responseTokens: null,
					totalTokens: null,
				},
				waterfall: {},
				topSpans: [],
				slowTimings: [],
			},
			contextReceipt: {
				turnId: 'turn_2',
				storyId: 'story_alpha',
				truncated: false,
				included: {
					recentEntries: 6,
					memoryNodes: 1,
					wikiChunks: 0,
					timelineEvents: 2,
					facts: 3,
					patchProposals: 1,
					unresolvedCharacterReferences: 1,
					continuityWarnings: 0,
					factionSheets: [],
				},
				skipped: [],
				budgets: {
					memoryTokensUsed: 800,
					memoryTokensMax: 2400,
					wikiCharsUsed: 0,
					wikiCharsMax: 6000,
				},
			},
		}));

		expect(seen).toEqual(['campaign.status', 'command.succeeded', 'state.changed']);
		expect(projections).toEqual([projection]);
		expect(cacheStatuses).toEqual([projection.cache]);
		expect(turnPerformance).toHaveLength(1);
		expect(contextReceipts).toHaveLength(1);
		expect(contextReceipts[0]).toMatchObject({
			turnId: 'turn_2',
			included: {
				patchProposals: 1,
				unresolvedCharacterReferences: 1,
			},
		});
		expect(turnPerformance[0]).toMatchObject({
			preparedCacheHit: false,
			prompt: { tokenEstimate: 800, totalChars: 3200, messageCount: 8 },
			cache: null,
			generation: {
				operationCount: 1,
				durationMs: 600,
				requestTokens: null,
				responseTokens: null,
				totalTokens: null,
			},
			waterfall: {},
			topSpans: [],
			slowTimings: [],
		});
		expect(refreshes).toEqual(['command.succeeded', 'state.changed']);

		subscription.close();
		expect(source.closed).toBe(true);
	});
});
