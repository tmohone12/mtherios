import { randomUUID } from 'node:crypto';

export type EngineEventType =
	| 'engine.connected'
	| 'engine.ready'
	| 'engine.heartbeat'
	| 'engine.error'
	| 'command.received'
	| 'command.running'
	| 'command.succeeded'
	| 'command.failed'
	| 'campaign.status'
	| 'cache.status'
	| 'timeline.brief'
	| 'timeline.eventScheduled'
	| 'timeline.eventsDue'
	| 'orchestrator.completed'
	| 'job.status'
	| 'state.changed'
	| 'narration.chunk';

export interface EngineEventInput {
	storyId?: string | null;
	type: EngineEventType | string;
	data?: Record<string, unknown>;
}

export interface EngineEvent {
	id: string;
	storyId: string | null;
	type: string;
	data: Record<string, unknown>;
	createdAt: string;
}

type EngineEventListener = (event: EngineEvent) => void;

const MAX_RECENT_EVENTS = 500;
const listeners = new Map<number, { storyId: string | null; listener: EngineEventListener }>();
const recentEvents: EngineEvent[] = [];
let listenerSequence = 0;

function nowIso(): string {
	return new Date().toISOString();
}

function eventId(): string {
	return `engine_evt_${randomUUID()}`;
}

function shouldDeliver(subscribedStoryId: string | null, eventStoryId: string | null): boolean {
	return !subscribedStoryId || !eventStoryId || subscribedStoryId === eventStoryId;
}

export function publishEngineEvent(input: EngineEventInput): EngineEvent {
	const event: EngineEvent = {
		id: eventId(),
		storyId: input.storyId ?? null,
		type: input.type,
		data: input.data ?? {},
		createdAt: nowIso(),
	};
	recentEvents.push(event);
	if (recentEvents.length > MAX_RECENT_EVENTS) {
		recentEvents.splice(0, recentEvents.length - MAX_RECENT_EVENTS);
	}
	for (const subscription of listeners.values()) {
		if (!shouldDeliver(subscription.storyId, event.storyId)) continue;
		try {
			subscription.listener(event);
		} catch (error) {
			console.warn('[engine-events] listener failed:', error);
		}
	}
	return event;
}

export function subscribeEngineEvents(storyId: string | null | undefined, listener: EngineEventListener): () => void {
	const id = listenerSequence++;
	listeners.set(id, { storyId: storyId ?? null, listener });
	return () => {
		listeners.delete(id);
	};
}

export function getRecentEngineEvents(storyId?: string | null, limit = 100): EngineEvent[] {
	const max = Math.max(1, Math.min(MAX_RECENT_EVENTS, Math.trunc(limit)));
	return recentEvents
		.filter((event) => shouldDeliver(storyId ?? null, event.storyId))
		.slice(-max);
}

export function resetEngineEventsForTest(): void {
	listeners.clear();
	recentEvents.splice(0, recentEvents.length);
	listenerSequence = 0;
}
