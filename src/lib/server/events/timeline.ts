import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type {
	GmTimelineBrief,
	GmTimelineBriefEvent,
	GmTimelineNpcEvent,
	MemoryVisibility,
	NpcEventLinkRole,
	StoryEventStatus,
	StoryEventType,
} from '$lib/contracts/memory';
import { getDb } from '$lib/server/db/client';
import { npcEventLinks, stories, storyEvents } from '$lib/server/db/schema';

export type StoryEventRow = typeof storyEvents.$inferSelect;
export type StoryEventInsert = typeof storyEvents.$inferInsert;
export type NpcEventLinkRow = typeof npcEventLinks.$inferSelect;
export type NpcEventLinkInsert = typeof npcEventLinks.$inferInsert;

export const DEFAULT_RECENT_LIMIT = 12;
export const DEFAULT_SCHEDULED_LIMIT = 10;
export const DEFAULT_DUE_LIMIT = 10;
export const DEFAULT_NPC_LIMIT = 8;

const PUBLIC_VISIBILITIES = new Set<string>(['public', 'player_known']);

export function selectDueTimelineEvents(events: StoryEventRow[], currentTurn: number): StoryEventRow[] {
	return events
		.filter((event) => {
			if (event.status === 'due') return true;
			return event.status === 'scheduled'
				&& event.scheduledTurn !== null
				&& event.scheduledTurn <= currentTurn;
		})
		.sort((left, right) => compareNullableTurn(left.scheduledTurn, right.scheduledTurn));
}

export function buildNpcEventLinksForEvent(input: {
	storyId: string;
	eventId: string;
	actorEntityIds?: string[];
	targetEntityIds?: string[];
	actorNpcEntityIds?: string[];
	targetNpcEntityIds?: string[];
	visibility: MemoryVisibility | string;
	sourceEntryIds: string[];
	sourcePatchIds: string[];
	serverVersion: number;
	now: string;
}): NpcEventLinkInsert[] {
	const byNpc = new Map<string, NpcEventLinkRole>();
	const actorNpcEntityIds = input.actorNpcEntityIds ?? [];
	const targetNpcEntityIds = input.targetNpcEntityIds ?? [];

	for (const npcEntityId of actorNpcEntityIds) {
		if (npcEntityId) byNpc.set(npcEntityId, 'actor');
	}

	for (const npcEntityId of targetNpcEntityIds) {
		if (npcEntityId && !byNpc.has(npcEntityId)) byNpc.set(npcEntityId, 'target');
	}

	return Array.from(byNpc.entries()).map(([npcEntityId, role]) => ({
		id: `npc_event_${input.eventId}_${npcEntityId}`,
		storyId: input.storyId,
		eventId: input.eventId,
		npcEntityId,
		role,
		visibility: input.visibility,
		evidenceStrength: role === 'actor' ? 0.9 : 0.75,
		sourceEntryIds: input.sourceEntryIds ?? [],
		sourcePatchIds: input.sourcePatchIds ?? [],
		serverVersion: input.serverVersion,
		createdAt: input.now,
		updatedAt: input.now,
	}));
}

export function buildScheduledTimelineEventInsert(input: {
	id?: string;
	storyId: string;
	type: StoryEventType;
	title: string;
	body: string;
	currentTurn: number;
	delayTurns: number;
	now: string;
	actorEntityIds?: string[];
	targetEntityIds?: string[];
	locationId?: string | null;
	locationIds?: string[];
	factionIds?: string[];
	threadIds?: string[];
	visibility?: MemoryVisibility;
	worldTime?: string | null;
	currentWorldTime?: string | null;
	memoryImpact?: Record<string, unknown>;
	sourceEntryIds?: string[];
	sourcePatchIds?: string[];
	metadata?: Record<string, unknown>;
	serverVersion?: number;
}): StoryEventInsert {
	const delayTurns = Math.max(0, Math.floor(Number.isFinite(input.delayTurns) ? input.delayTurns : 0));

	return {
		id: input.id ?? buildId('story_event'),
		storyId: input.storyId,
		type: input.type,
		status: 'scheduled',
		title: input.title,
		body: input.body,
		actorEntityIds: input.actorEntityIds ?? [],
		targetEntityIds: input.targetEntityIds ?? [],
		locationId: input.locationId ?? null,
		locationIds: input.locationIds ?? [],
		factionIds: input.factionIds ?? [],
		threadIds: input.threadIds ?? [],
		visibility: input.visibility ?? 'player_known',
		createdTurn: input.currentTurn,
		occurredTurn: null,
		scheduledTurn: input.currentTurn + delayTurns,
		worldTime: input.worldTime ?? input.currentWorldTime ?? null,
		memoryImpact: input.memoryImpact ?? {},
		sourceEntryIds: input.sourceEntryIds ?? [],
		sourcePatchIds: input.sourcePatchIds ?? [],
		metadata: {
			...(input.metadata ?? {}),
			inWorldDelayTurns: delayTurns,
		},
		serverVersion: input.serverVersion ?? 1,
		createdAt: input.now,
		updatedAt: input.now,
	};
}

export function buildDueTimelineEventPromotionPatch(now: string): {
	status: 'due';
	updatedAt: string;
} {
	return {
		status: 'due',
		updatedAt: now,
	};
}

export function buildGmTimelineBrief(input: {
	storyId: string;
	currentTurn: number;
	currentWorldTime: string | null;
	events: StoryEventRow[];
	npcLinks: NpcEventLinkRow[];
	presentNpcIds?: string[];
	sceneEntityIds?: string[];
	includeSecret?: boolean;
	recentLimit?: number;
	scheduledLimit?: number;
	dueLimit?: number;
	npcLimit?: number;
}): GmTimelineBrief {
	const includeSecret = input.includeSecret ?? false;
	const visibleEvents = input.events.filter(event => isVisible(event.visibility, includeSecret));
	const visibleEventIds = new Set(visibleEvents.map(event => event.id));
	const visibleLinks = input.npcLinks.filter(link =>
		visibleEventIds.has(link.eventId) && isVisible(link.visibility, includeSecret));

	const dueRows = selectDueTimelineEvents(visibleEvents, input.currentTurn)
		.slice(0, input.dueLimit ?? DEFAULT_DUE_LIMIT);
	const dueIds = new Set(dueRows.map(event => event.id));

	const recentRows = visibleEvents
		.filter(event => !dueIds.has(event.id) && event.status === 'committed')
		.sort((left, right) =>
			compareNullableTurn(right.occurredTurn ?? right.createdTurn, left.occurredTurn ?? left.createdTurn))
		.slice(0, input.recentLimit ?? DEFAULT_RECENT_LIMIT);

	const scheduledRows = visibleEvents
		.filter(event =>
			!dueIds.has(event.id)
			&& event.status === 'scheduled'
			&& event.scheduledTurn !== null
			&& event.scheduledTurn > input.currentTurn)
		.sort((left, right) => compareNullableTurn(left.scheduledTurn, right.scheduledTurn))
		.slice(0, input.scheduledLimit ?? DEFAULT_SCHEDULED_LIMIT);

	return {
		storyId: input.storyId,
		currentTurn: input.currentTurn,
		currentWorldTime: input.currentWorldTime,
		dueEvents: dueRows.map(event => toBriefEvent(event, input.currentTurn, 'due', visibleLinks)),
		recentEvents: recentRows.map(event => toBriefEvent(event, input.currentTurn, undefined, visibleLinks)),
		scheduledEvents: scheduledRows.map(event => toBriefEvent(event, input.currentTurn, undefined, visibleLinks)),
		npcEvents: buildNpcTimelineEvents({
			eventRows: visibleEvents,
			linkRows: visibleLinks,
			npcEntityIds: unique([...(input.presentNpcIds ?? []), ...(input.sceneEntityIds ?? [])]),
			limit: input.npcLimit ?? DEFAULT_NPC_LIMIT,
		}),
	};
}

export async function loadGmTimelineBrief(input: {
	storyId: string;
	currentTurn?: number;
	presentNpcIds?: string[];
	sceneEntityIds?: string[];
	includeSecret?: boolean;
	recentLimit?: number;
	scheduledLimit?: number;
	dueLimit?: number;
	npcLimit?: number;
}): Promise<GmTimelineBrief> {
	const db = getDb();
	const [story] = await db.select().from(stories).where(eq(stories.id, input.storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${input.storyId}`);

	const [eventRows, linkRows] = await Promise.all([
		db.select().from(storyEvents)
			.where(eq(storyEvents.storyId, input.storyId))
			.orderBy(asc(storyEvents.scheduledTurn), desc(storyEvents.occurredTurn), desc(storyEvents.createdAt)),
		db.select().from(npcEventLinks)
			.where(eq(npcEventLinks.storyId, input.storyId))
			.orderBy(asc(npcEventLinks.npcEntityId), asc(npcEventLinks.createdAt)),
	]);

	return buildGmTimelineBrief({
		...input,
		currentTurn: input.currentTurn ?? story.currentTurn,
		currentWorldTime: story.currentWorldTime,
		events: eventRows,
		npcLinks: linkRows,
	});
}

export async function scheduleTimelineEvent(input: Parameters<typeof buildScheduledTimelineEventInsert>[0] & {
	actorNpcEntityIds?: string[];
	targetNpcEntityIds?: string[];
}): Promise<StoryEventRow> {
	const db = getDb();
	const eventInsert = buildScheduledTimelineEventInsert(input);

	return db.transaction(async (tx) => {
		const [row] = await tx.insert(storyEvents).values(eventInsert).returning();
		if (!row) throw new Error('Failed to schedule timeline event');

		const links = buildNpcEventLinksForEvent({
			storyId: row.storyId,
			eventId: row.id,
			actorNpcEntityIds: input.actorNpcEntityIds,
			targetNpcEntityIds: input.targetNpcEntityIds,
			visibility: row.visibility,
			sourceEntryIds: row.sourceEntryIds ?? [],
			sourcePatchIds: row.sourcePatchIds ?? [],
			serverVersion: row.serverVersion,
			now: input.now,
		});
		if (links.length > 0) {
			await tx.insert(npcEventLinks).values(links).onConflictDoNothing();
		}

		return row;
	});
}

export async function promoteDueTimelineEvents(
	storyId: string,
	currentTurn: number,
	now = new Date().toISOString(),
): Promise<StoryEventRow[]> {
	return getDb()
		.update(storyEvents)
		.set(buildDueTimelineEventPromotionPatch(now))
		.where(and(
			eq(storyEvents.storyId, storyId),
			eq(storyEvents.status, 'scheduled'),
			sql`${storyEvents.scheduledTurn} <= ${currentTurn}`,
		))
		.returning();
}

export async function advanceStoryTurn(storyId: string, delta = 1): Promise<number> {
	const now = new Date().toISOString();
	const step = Math.max(0, Math.floor(Number.isFinite(delta) ? delta : 1));
	const [row] = await getDb()
		.update(stories)
		.set({
			currentTurn: sql`${stories.currentTurn} + ${step}`,
			updatedAt: now,
		})
		.where(eq(stories.id, storyId))
		.returning({ currentTurn: stories.currentTurn });

	if (!row) throw new Error(`Story not found: ${storyId}`);
	return row.currentTurn;
}

function toBriefEvent(
	event: StoryEventRow,
	currentTurn: number,
	statusOverride: StoryEventStatus | undefined,
	linkRows: NpcEventLinkRow[],
): GmTimelineBriefEvent {
	return {
		id: event.id,
		type: event.type as GmTimelineBriefEvent['type'],
		status: statusOverride ?? (event.status as StoryEventStatus),
		title: event.title,
		body: event.body,
		turnsUntilDue: event.scheduledTurn === null ? null : event.scheduledTurn - currentTurn,
		worldTime: event.worldTime,
		npcEntityIds: eventNpcIds(event, linkRows),
		factionIds: event.factionIds ?? [],
		locationIds: unique([...(event.locationIds ?? []), ...(event.locationId ? [event.locationId] : [])]),
		visibility: event.visibility as MemoryVisibility,
	};
}

function buildNpcTimelineEvents(input: {
	eventRows: StoryEventRow[];
	linkRows: NpcEventLinkRow[];
	npcEntityIds: string[];
	limit: number;
}): GmTimelineNpcEvent[] {
	const eventsById = new Map(input.eventRows.map(event => [event.id, event]));

	return input.npcEntityIds
		.map((npcEntityId) => {
			const links = input.linkRows.filter(link => link.npcEntityId === npcEntityId && eventsById.has(link.eventId));
			const eventIds = unique(links.map(link => link.eventId));
			const linkedEvents = eventIds
				.map(eventId => eventsById.get(eventId))
				.filter((event): event is StoryEventRow => Boolean(event));

			if (linkedEvents.length === 0) return null;

			return {
				npcEntityId,
				eventIds,
				summary: linkedEvents.map(event => event.title).join('; '),
				visibility: mostRestrictiveVisibility([
					...linkedEvents.map(event => event.visibility),
					...links.map(link => link.visibility),
				]),
			} satisfies GmTimelineNpcEvent;
		})
		.filter((event): event is GmTimelineNpcEvent => Boolean(event))
		.slice(0, input.limit);
}

function eventNpcIds(event: StoryEventRow, linkRows: NpcEventLinkRow[]): string[] {
	return unique(linkRows.filter(link => link.eventId === event.id).map(link => link.npcEntityId));
}

function compareNullableTurn(left: number | null, right: number | null): number {
	const leftValue = left ?? Number.MAX_SAFE_INTEGER;
	const rightValue = right ?? Number.MAX_SAFE_INTEGER;
	return leftValue - rightValue;
}

function isVisible(visibility: string, includeSecret: boolean): boolean {
	return includeSecret || PUBLIC_VISIBILITIES.has(visibility);
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}

function mostRestrictiveVisibility(values: string[]): MemoryVisibility {
	if (values.includes('secret')) return 'secret';
	if (values.includes('player_known')) return 'player_known';
	return 'public';
}

function buildId(prefix: string): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}
