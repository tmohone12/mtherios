import { describe, expect, it } from 'vitest';
import {
	extractCampaignProjection,
	extractEngineCacheStatus,
	extractTurnPerformance,
	openEngineEventStream,
	parseEngineStreamEvent,
	shouldRefreshCampaignProjection,
} from './engineStream';

const projection = {
	mode: 'control_surface',
	story: { id: 'story_alpha', title: 'Long Campaign', serverVersion: 5 },
	entries: [{ id: 'entry_5', position: 5, type: 'assistant', content: 'The court waits.' }],
	counts: { entries: 5, entities: 3, events: 2, memoryNodes: 1 },
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
		}));

		expect(seen).toEqual(['campaign.status', 'command.succeeded', 'state.changed']);
		expect(projections).toEqual([projection]);
		expect(cacheStatuses).toEqual([projection.cache]);
		expect(turnPerformance).toHaveLength(1);
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
