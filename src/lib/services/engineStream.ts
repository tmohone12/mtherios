import {
	campaignProjectionSchema,
	engineCacheStatusSchema,
	type CampaignProjection,
	type EngineCacheStatus,
} from '$lib/contracts/engine';

export interface EngineStreamEvent {
	id: string;
	storyId: string | null;
	type: string;
	data: Record<string, unknown>;
	createdAt: string;
}

type EngineStreamMessage = { data: string };
type EngineStreamListener = (event: EngineStreamMessage) => void;

export interface EngineStreamEventSource {
	addEventListener(type: string, listener: EngineStreamListener): void;
	removeEventListener?(type: string, listener: EngineStreamListener): void;
	close(): void;
}

export interface EngineStreamSubscription {
	url: string;
	close(): void;
}

export interface OpenEngineEventStreamOptions {
	storyId: string;
	replay?: number;
	eventSourceFactory?: (url: string) => EngineStreamEventSource;
	onEvent?: (event: EngineStreamEvent) => void;
	onProjection?: (projection: CampaignProjection, event: EngineStreamEvent) => void;
	onCacheStatus?: (cache: EngineCacheStatus, event: EngineStreamEvent) => void;
	onRefreshRequested?: (event: EngineStreamEvent) => void;
	onError?: (error: unknown) => void;
}

export const ENGINE_STREAM_EVENT_TYPES = [
	'engine.connected',
	'engine.ready',
	'engine.heartbeat',
	'engine.error',
	'command.received',
	'command.running',
	'command.succeeded',
	'command.failed',
	'campaign.status',
	'cache.status',
	'timeline.brief',
	'timeline.eventScheduled',
	'timeline.eventsDue',
	'job.status',
	'state.changed',
	'narration.chunk',
] as const;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function defaultEventSourceFactory(url: string): EngineStreamEventSource {
	if (typeof EventSource === 'undefined') {
		throw new Error('EventSource is not available in this runtime.');
	}
	return new EventSource(url);
}

export function buildEngineStreamUrl(storyId: string, replay = 25): string {
	const params = new URLSearchParams();
	params.set('storyId', storyId);
	params.set('replay', String(Math.max(0, Math.min(100, Math.trunc(replay)))));
	return `/api/engine/stream?${params}`;
}

export function parseEngineStreamEvent(raw: string | unknown): EngineStreamEvent | null {
	let value = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw) as unknown;
		} catch {
			return null;
		}
	}
	const record = asRecord(value);
	const type = asString(record.type).trim();
	if (!type) return null;
	return {
		id: asString(record.id),
		storyId: asNullableString(record.storyId),
		type,
		data: asRecord(record.data),
		createdAt: asString(record.createdAt),
	};
}

export function extractCampaignProjection(event: EngineStreamEvent | null | undefined): CampaignProjection | null {
	if (!event) return null;
	const candidates = [
		event.data.projection,
		event.data.result,
		event.data,
	];
	for (const candidate of candidates) {
		const parsed = campaignProjectionSchema.safeParse(candidate);
		if (parsed.success) return parsed.data;
	}
	return null;
}

export function extractEngineCacheStatus(event: EngineStreamEvent | null | undefined): EngineCacheStatus | null {
	if (!event) return null;
	const projection = extractCampaignProjection(event);
	const candidates = [
		projection?.cache,
		event.data.cache,
		asRecord(event.data.projection).cache,
		asRecord(event.data.projectionChanges).cache,
		asRecord(event.data.result).cache,
	];
	for (const candidate of candidates) {
		const parsed = engineCacheStatusSchema.safeParse(candidate);
		if (parsed.success) return parsed.data;
	}
	return null;
}

export function shouldRefreshCampaignProjection(event: EngineStreamEvent | null | undefined): boolean {
	if (!event) return false;
	if (extractCampaignProjection(event)) return false;
	if (event.type === 'campaign.status') return true;
	if (event.type === 'state.changed') return true;
	if (event.type === 'timeline.eventScheduled' || event.type === 'timeline.eventsDue') return true;
	if (event.type === 'command.succeeded') {
		return Object.keys(asRecord(event.data.projectionChanges)).length > 0;
	}
	return false;
}

export function openEngineEventStream(options: OpenEngineEventStreamOptions): EngineStreamSubscription {
	const url = buildEngineStreamUrl(options.storyId, options.replay ?? 25);
	const source = (options.eventSourceFactory ?? defaultEventSourceFactory)(url);
	const listeners = new Map<string, EngineStreamListener>();

	const handleMessage = (message: EngineStreamMessage) => {
		const event = parseEngineStreamEvent(message.data);
		if (!event) return;
		options.onEvent?.(event);
		const projection = extractCampaignProjection(event);
		if (projection) options.onProjection?.(projection, event);
		const cache = extractEngineCacheStatus(event);
		if (cache) options.onCacheStatus?.(cache, event);
		if (shouldRefreshCampaignProjection(event)) options.onRefreshRequested?.(event);
	};

	for (const eventType of ENGINE_STREAM_EVENT_TYPES) {
		listeners.set(eventType, handleMessage);
		source.addEventListener(eventType, handleMessage);
	}
	const errorListener: EngineStreamListener = (message) => {
		options.onError?.(message);
	};
	listeners.set('error', errorListener);
	source.addEventListener('error', errorListener);

	return {
		url,
		close() {
			for (const [eventType, listener] of listeners) {
				source.removeEventListener?.(eventType, listener);
			}
			listeners.clear();
			source.close();
		},
	};
}
