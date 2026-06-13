import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
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
export const DEFAULT_NPC_EVENT_LIMIT = 4;

const NPC_EVENT_QUERY_MULTIPLIER = 4;
const NPC_EVENT_SUMMARY_CHAR_LIMIT = 280;

const PUBLIC_VISIBILITY_VALUES = ['public', 'player_known'] as const;
const PUBLIC_VISIBILITIES = new Set<string>(PUBLIC_VISIBILITY_VALUES);
const NPC_EVENT_LINK_SELECT = {
	id: npcEventLinks.id,
	storyId: npcEventLinks.storyId,
	eventId: npcEventLinks.eventId,
	npcEntityId: npcEventLinks.npcEntityId,
	role: npcEventLinks.role,
	visibility: npcEventLinks.visibility,
	evidenceStrength: npcEventLinks.evidenceStrength,
	sourceEntryIds: npcEventLinks.sourceEntryIds,
	sourcePatchIds: npcEventLinks.sourcePatchIds,
	serverVersion: npcEventLinks.serverVersion,
	createdAt: npcEventLinks.createdAt,
	updatedAt: npcEventLinks.updatedAt,
};

function looksLikeNpcEntityId(entityId: string): boolean {
	const clean = entityId.trim().toLowerCase();
	return clean.startsWith('npc_') || clean.startsWith('character_') || clean.startsWith('char_');
}

export function selectDueTimelineEvents(events: StoryEventRow[], currentTurn: number): StoryEventRow[] {
	return events
		.filter((event) => {
			if (event.status === 'due') return true;
			return event.status === 'scheduled'
				&& event.scheduledTurn !== null
				&& event.scheduledTurn <= currentTurn;
		})
		.sort(compareDueTimelineEvents);
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
	const actorNpcEntityIds = unique([
		...(input.actorNpcEntityIds ?? []),
		...(input.actorEntityIds ?? []).filter(looksLikeNpcEntityId),
	]);
	const targetNpcEntityIds = unique([
		...(input.targetNpcEntityIds ?? []),
		...(input.targetEntityIds ?? []).filter(looksLikeNpcEntityId),
	]);

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

interface DueTimelineEventPromotionOptions {
	now?: string;
	serverVersion?: number;
}

function normalizeDueTimelineEventPromotionOptions(
	options?: string | DueTimelineEventPromotionOptions,
): Required<Pick<DueTimelineEventPromotionOptions, 'now'>> & Pick<DueTimelineEventPromotionOptions, 'serverVersion'> {
	if (typeof options === 'string') return { now: options };
	return {
		now: options?.now ?? new Date().toISOString(),
		serverVersion: options?.serverVersion,
	};
}

export function buildDueTimelineEventPromotionPatch(now: string, options: Pick<DueTimelineEventPromotionOptions, 'serverVersion'> = {}): {
	status: 'due';
	updatedAt: string;
	serverVersion?: number;
} {
	const patch: {
		status: 'due';
		updatedAt: string;
		serverVersion?: number;
	} = {
		status: 'due',
		updatedAt: now,
	};
	if (typeof options.serverVersion === 'number' && Number.isFinite(options.serverVersion)) {
		patch.serverVersion = options.serverVersion;
	}
	return patch;
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
	npcEventLimit?: number;
}): GmTimelineBrief {
	const includeSecret = input.includeSecret ?? false;
	const dueLimit = normalizeLimit(input.dueLimit, DEFAULT_DUE_LIMIT);
	const recentLimit = normalizeLimit(input.recentLimit, DEFAULT_RECENT_LIMIT);
	const scheduledLimit = normalizeLimit(input.scheduledLimit, DEFAULT_SCHEDULED_LIMIT);
	const npcLimit = normalizeLimit(input.npcLimit, DEFAULT_NPC_LIMIT);
	const npcEventLimit = normalizeLimit(input.npcEventLimit, DEFAULT_NPC_EVENT_LIMIT);
	const visibleEvents = input.events.filter(event => isVisible(event.visibility, includeSecret));
	const visibleEventIds = new Set(visibleEvents.map(event => event.id));
	const visibleLinks = input.npcLinks.filter(link =>
		visibleEventIds.has(link.eventId) && isVisible(link.visibility, includeSecret));

	const dueRows = selectDueTimelineEvents(visibleEvents, input.currentTurn)
		.slice(0, dueLimit);
	const dueIds = new Set(dueRows.map(event => event.id));

	const recentRows = visibleEvents
		.filter(event => !dueIds.has(event.id) && event.status === 'committed')
		.sort(compareRecentTimelineEvents)
		.slice(0, recentLimit);

	const scheduledRows = visibleEvents
		.filter(event =>
			!dueIds.has(event.id)
			&& event.status === 'scheduled'
			&& event.scheduledTurn !== null
			&& event.scheduledTurn > input.currentTurn)
		.sort(compareScheduledTimelineEvents)
		.slice(0, scheduledLimit);

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
			currentTurn: input.currentTurn,
			limit: npcLimit,
			eventLimit: npcEventLimit,
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
	npcEventLimit?: number;
}): Promise<GmTimelineBrief> {
	const db = getDb();
	const [story] = await db.select().from(stories).where(eq(stories.id, input.storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${input.storyId}`);

	const currentTurn = input.currentTurn ?? story.currentTurn;
	const dueLimit = normalizeLimit(input.dueLimit, DEFAULT_DUE_LIMIT);
	const recentLimit = normalizeLimit(input.recentLimit, DEFAULT_RECENT_LIMIT);
	const scheduledLimit = normalizeLimit(input.scheduledLimit, DEFAULT_SCHEDULED_LIMIT);
	const npcLimit = normalizeLimit(input.npcLimit, DEFAULT_NPC_LIMIT);
	const npcEventLimit = normalizeLimit(input.npcEventLimit, DEFAULT_NPC_EVENT_LIMIT);
	const npcEntityIds = unique([...(input.presentNpcIds ?? []), ...(input.sceneEntityIds ?? [])])
		.slice(0, npcLimit);
	const npcLinkLimit = npcEventLimit * NPC_EVENT_QUERY_MULTIPLIER;
	const includeSecret = input.includeSecret ?? false;
	const eventVisibilityCondition = storyEventVisibilityCondition(includeSecret);
	const linkVisibilityCondition = npcEventLinkVisibilityCondition(includeSecret);
	const recentTurnExpression = storyEventRecentTurnExpression();

	const [dueRows, recentRows, scheduledRows, linkRowsByNpc] = await Promise.all([
		db.select().from(storyEvents)
			.where(and(
				eq(storyEvents.storyId, input.storyId),
				eventVisibilityCondition,
				sql`(${storyEvents.status} = 'due' OR (${storyEvents.status} = 'scheduled' AND ${storyEvents.scheduledTurn} <= ${currentTurn}))`,
			))
			.orderBy(
				sql`CASE WHEN ${storyEvents.status} = 'due' AND ${storyEvents.scheduledTurn} IS NULL THEN 0 ELSE 1 END`,
				asc(storyEvents.scheduledTurn),
				desc(recentTurnExpression),
				desc(storyEvents.updatedAt),
				asc(storyEvents.id),
			)
			.limit(dueLimit),
		db.select().from(storyEvents)
			.where(and(
				eq(storyEvents.storyId, input.storyId),
				eventVisibilityCondition,
				eq(storyEvents.status, 'committed'),
			))
			.orderBy(
				desc(recentTurnExpression),
				desc(storyEvents.updatedAt),
				desc(storyEvents.createdAt),
				asc(storyEvents.id),
			)
			.limit(recentLimit),
		db.select().from(storyEvents)
			.where(and(
				eq(storyEvents.storyId, input.storyId),
				eventVisibilityCondition,
				eq(storyEvents.status, 'scheduled'),
				sql`${storyEvents.scheduledTurn} > ${currentTurn}`,
			))
			.orderBy(
				asc(storyEvents.scheduledTurn),
				desc(recentTurnExpression),
				desc(storyEvents.updatedAt),
				desc(storyEvents.createdAt),
				asc(storyEvents.id),
			)
			.limit(scheduledLimit),
		npcLinkLimit > 0
			? Promise.all(npcEntityIds.map(npcEntityId => db.select(NPC_EVENT_LINK_SELECT)
				.from(npcEventLinks)
				.innerJoin(storyEvents, and(
					eq(storyEvents.storyId, npcEventLinks.storyId),
					eq(storyEvents.id, npcEventLinks.eventId),
				))
				.where(and(
					eq(npcEventLinks.storyId, input.storyId),
					eq(npcEventLinks.npcEntityId, npcEntityId),
					linkVisibilityCondition,
					eventVisibilityCondition,
				))
				.orderBy(
					npcLinkedEventUrgencyRankExpression(currentTurn),
					sql`CASE WHEN ${storyEvents.status} = 'due' AND ${storyEvents.scheduledTurn} IS NULL THEN 0 ELSE 1 END`,
					asc(storyEvents.scheduledTurn),
					desc(npcEventLinks.evidenceStrength),
					desc(recentTurnExpression),
					desc(npcEventLinks.updatedAt),
					desc(npcEventLinks.createdAt),
					asc(npcEventLinks.eventId),
				)
				.limit(npcLinkLimit)))
			: Promise.resolve([]),
	]);
	const linkRows = linkRowsByNpc.flat();
	const linkedEventIds = unique(linkRows.map(link => link.eventId));
	const linkedEventRows = linkedEventIds.length > 0
		? await db.select().from(storyEvents)
			.where(and(
				eq(storyEvents.storyId, input.storyId),
				eventVisibilityCondition,
				inArray(storyEvents.id, linkedEventIds),
			))
			.orderBy(
				desc(recentTurnExpression),
				desc(storyEvents.updatedAt),
				desc(storyEvents.createdAt),
				asc(storyEvents.id),
			)
			.limit(linkedEventIds.length)
		: [];

	return buildGmTimelineBrief({
		...input,
		currentTurn,
		currentWorldTime: story.currentWorldTime,
		events: uniqueStoryEventRows([...dueRows, ...recentRows, ...scheduledRows, ...linkedEventRows]),
		npcLinks: linkRows,
		dueLimit,
		recentLimit,
		scheduledLimit,
		npcLimit,
		npcEventLimit,
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
			actorEntityIds: input.actorEntityIds,
			targetEntityIds: input.targetEntityIds,
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
	options?: string | DueTimelineEventPromotionOptions,
): Promise<StoryEventRow[]> {
	const promotion = normalizeDueTimelineEventPromotionOptions(options);
	return getDb()
		.update(storyEvents)
		.set(buildDueTimelineEventPromotionPatch(promotion.now, { serverVersion: promotion.serverVersion }))
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
	currentTurn: number;
	limit: number;
	eventLimit: number;
}): GmTimelineNpcEvent[] {
	const eventsById = new Map(input.eventRows.map(event => [event.id, event]));

	return input.npcEntityIds
		.map((npcEntityId) => {
			const links = input.linkRows.filter(link => link.npcEntityId === npcEntityId && eventsById.has(link.eventId));
			const evidenceByEventId = maxEvidenceByEventId(links);
			const eventIds = unique(links.map(link => link.eventId))
				.sort((leftId, rightId) => compareNpcLinkedTimelineEvents(
					eventsById.get(leftId),
					eventsById.get(rightId),
					input.currentTurn,
					evidenceByEventId.get(leftId) ?? 0,
					evidenceByEventId.get(rightId) ?? 0,
				))
				.slice(0, input.eventLimit);
			const linkedEvents = eventIds
				.map(eventId => eventsById.get(eventId))
				.filter((event): event is StoryEventRow => Boolean(event));

			if (linkedEvents.length === 0) return null;
			const selectedEventIds = new Set(eventIds);
			const selectedLinks = links.filter(link => selectedEventIds.has(link.eventId));

			return {
				npcEntityId,
				eventIds,
				summary: truncateText(linkedEvents.map(event => compactText(event.title)).join('; '), NPC_EVENT_SUMMARY_CHAR_LIMIT),
				visibility: mostRestrictiveVisibility([
					...linkedEvents.map(event => event.visibility),
					...selectedLinks.map(link => link.visibility),
				]),
			} satisfies GmTimelineNpcEvent;
		})
		.filter((event): event is GmTimelineNpcEvent => Boolean(event))
		.slice(0, input.limit);
}

function eventNpcIds(event: StoryEventRow, linkRows: NpcEventLinkRow[]): string[] {
	return unique(linkRows.filter(link => link.eventId === event.id).map(link => link.npcEntityId));
}

function compareDueTimelineEvents(left: StoryEventRow, right: StoryEventRow): number {
	const leftNullDue = left.status === 'due' && left.scheduledTurn === null;
	const rightNullDue = right.status === 'due' && right.scheduledTurn === null;
	if (leftNullDue !== rightNullDue) return leftNullDue ? -1 : 1;

	return compareNullableTurn(left.scheduledTurn, right.scheduledTurn)
		|| compareRecentTimelineEvents(left, right);
}

function compareRecentTimelineEvents(left: StoryEventRow, right: StoryEventRow): number {
	return compareNullableTurn(right.occurredTurn ?? right.createdTurn, left.occurredTurn ?? left.createdTurn)
		|| compareDescendingText(left.updatedAt, right.updatedAt)
		|| compareDescendingText(left.createdAt, right.createdAt)
		|| left.id.localeCompare(right.id);
}

function compareScheduledTimelineEvents(left: StoryEventRow, right: StoryEventRow): number {
	return compareNullableTurn(left.scheduledTurn, right.scheduledTurn)
		|| compareRecentTimelineEvents(left, right);
}

function compareNpcLinkedTimelineEvents(
	left: StoryEventRow | undefined,
	right: StoryEventRow | undefined,
	currentTurn: number,
	leftEvidence: number,
	rightEvidence: number,
): number {
	if (!left && !right) return 0;
	if (!left) return 1;
	if (!right) return -1;

	return compareNpcTimelineUrgency(left, right, currentTurn)
		|| compareDescendingNumber(leftEvidence, rightEvidence)
		|| compareRecentTimelineEvents(left, right);
}

function compareNpcTimelineUrgency(left: StoryEventRow, right: StoryEventRow, currentTurn: number): number {
	const leftRank = npcTimelineUrgencyRank(left, currentTurn);
	const rightRank = npcTimelineUrgencyRank(right, currentTurn);
	if (leftRank !== rightRank) return leftRank - rightRank;

	if (leftRank === 0) {
		const leftNullDue = left.status === 'due' && left.scheduledTurn === null;
		const rightNullDue = right.status === 'due' && right.scheduledTurn === null;
		if (leftNullDue !== rightNullDue) return leftNullDue ? -1 : 1;
	}

	if (leftRank <= 1) {
		return compareNullableTurn(left.scheduledTurn, right.scheduledTurn);
	}

	return 0;
}

function npcTimelineUrgencyRank(event: StoryEventRow, currentTurn: number): number {
	if (event.status === 'due') return 0;
	if (event.status === 'scheduled' && event.scheduledTurn !== null && event.scheduledTurn <= currentTurn) return 0;
	if (event.status === 'scheduled' && event.scheduledTurn !== null) return 1;
	return 2;
}

function compareNullableTurn(left: number | null, right: number | null): number {
	const leftValue = left ?? Number.MAX_SAFE_INTEGER;
	const rightValue = right ?? Number.MAX_SAFE_INTEGER;
	return leftValue - rightValue;
}

function compareDescendingNumber(left: number, right: number): number {
	return right - left;
}

function compareDescendingText(left: string | null, right: string | null): number {
	return (right ?? '').localeCompare(left ?? '');
}

function maxEvidenceByEventId(links: NpcEventLinkRow[]): Map<string, number> {
	const evidenceByEventId = new Map<string, number>();
	for (const link of links) {
		evidenceByEventId.set(
			link.eventId,
			Math.max(evidenceByEventId.get(link.eventId) ?? Number.NEGATIVE_INFINITY, link.evidenceStrength ?? 0),
		);
	}
	return evidenceByEventId;
}

function compactText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, limit: number): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
	const candidate = value ?? fallback;
	return Math.max(0, Math.floor(Number.isFinite(candidate) ? candidate : fallback));
}

function storyEventVisibilityCondition(includeSecret: boolean) {
	return includeSecret ? undefined : inArray(storyEvents.visibility, PUBLIC_VISIBILITY_VALUES);
}

function npcEventLinkVisibilityCondition(includeSecret: boolean) {
	return includeSecret ? undefined : inArray(npcEventLinks.visibility, PUBLIC_VISIBILITY_VALUES);
}

function storyEventRecentTurnExpression() {
	return sql`coalesce(${storyEvents.occurredTurn}, ${storyEvents.createdTurn})`;
}

function npcLinkedEventUrgencyRankExpression(currentTurn: number) {
	return sql`CASE
		WHEN ${storyEvents.status} = 'due' THEN 0
		WHEN ${storyEvents.status} = 'scheduled' AND ${storyEvents.scheduledTurn} IS NOT NULL AND ${storyEvents.scheduledTurn} <= ${currentTurn} THEN 0
		WHEN ${storyEvents.status} = 'scheduled' AND ${storyEvents.scheduledTurn} IS NOT NULL THEN 1
		ELSE 2
	END`;
}

function uniqueStoryEventRows(rows: StoryEventRow[]): StoryEventRow[] {
	const byId = new Map<string, StoryEventRow>();
	for (const row of rows) {
		if (!byId.has(row.id)) byId.set(row.id, row);
	}
	return Array.from(byId.values());
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
