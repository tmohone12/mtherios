import { beforeEach, describe, expect, it, vi } from 'vitest';
import { npcEventLinks, stories, storyEvents } from '$lib/server/db/schema';
import {
	buildDueTimelineEventPromotionPatch,
	buildGmTimelineBrief,
	buildNpcEventLinksForEvent,
	buildScheduledTimelineEventInsert,
	loadGmTimelineBrief,
	promoteDueTimelineEvents,
	scheduleTimelineEvent,
	selectDueTimelineEvents,
} from './timeline';

const dbMocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	and: vi.fn((...conditions: unknown[]) => ({ kind: 'and', conditions })),
	eq: vi.fn((left: unknown, right: unknown) => ({ kind: 'eq', left, right })),
}));

vi.mock('$lib/server/db/client', () => ({
	getDb: dbMocks.getDb,
}));

vi.mock('drizzle-orm', async (importActual) => {
	const actual = await importActual<typeof import('drizzle-orm')>();
	return {
		...actual,
		and: dbMocks.and,
		eq: dbMocks.eq,
	};
});

const now = '2026-06-02T12:00:00.000Z';

type TestStoryEvent = Parameters<typeof selectDueTimelineEvents>[0][number];
type TestNpcLink = Parameters<typeof buildGmTimelineBrief>[0]['npcLinks'][number];

function event(overrides: Partial<TestStoryEvent>): TestStoryEvent {
	return {
		id: overrides.id ?? 'event_1',
		storyId: 'story_1',
		type: overrides.type ?? 'scheme',
		status: overrides.status ?? 'committed',
		title: overrides.title ?? 'A quiet scheme',
		body: overrides.body ?? 'Someone makes a move off-screen.',
		actorEntityIds: overrides.actorEntityIds ?? [],
		targetEntityIds: overrides.targetEntityIds ?? [],
		locationId: overrides.locationId ?? null,
		locationIds: overrides.locationIds ?? [],
		factionIds: overrides.factionIds ?? [],
		threadIds: overrides.threadIds ?? [],
		visibility: overrides.visibility ?? 'player_known',
		createdTurn: overrides.createdTurn ?? 1,
		occurredTurn: overrides.occurredTurn ?? null,
		scheduledTurn: overrides.scheduledTurn ?? null,
		worldTime: overrides.worldTime ?? null,
		memoryImpact: overrides.memoryImpact ?? {},
		sourceEntryIds: overrides.sourceEntryIds ?? [],
		sourcePatchIds: overrides.sourcePatchIds ?? [],
		metadata: overrides.metadata ?? {},
		serverVersion: overrides.serverVersion ?? 1,
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
	};
}

function link(overrides: Partial<TestNpcLink>): TestNpcLink {
	return {
		id: overrides.id ?? `link_${overrides.eventId ?? 'event_1'}_${overrides.npcEntityId ?? 'npc_1'}`,
		storyId: 'story_1',
		eventId: overrides.eventId ?? 'event_1',
		npcEntityId: overrides.npcEntityId ?? 'npc_1',
		role: overrides.role ?? 'affected',
		visibility: overrides.visibility ?? 'player_known',
		evidenceStrength: overrides.evidenceStrength ?? 0.75,
		sourceEntryIds: overrides.sourceEntryIds ?? [],
		sourcePatchIds: overrides.sourcePatchIds ?? [],
		serverVersion: overrides.serverVersion ?? 1,
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
	};
}

function sqlExpressionIncludes(value: unknown, expected: unknown, seen = new WeakSet<object>()): boolean {
	if (value === expected) return true;
	if (Array.isArray(value)) return value.some(item => sqlExpressionIncludes(item, expected, seen));
	if (typeof value === 'string' && typeof expected === 'string') return value.includes(expected);
	if (!value || typeof value !== 'object') return false;
	if (seen.has(value)) return false;
	seen.add(value);

	const record = value as { queryChunks?: unknown[]; value?: unknown; conditions?: unknown[] };
	if (record.value === expected) return true;
	if (Array.isArray(record.value) && record.value.includes(expected)) return true;
	if (Array.isArray(record.queryChunks) && record.queryChunks.some(chunk => sqlExpressionIncludes(chunk, expected, seen))) {
		return true;
	}
	if (Array.isArray(record.conditions) && record.conditions.some(condition => sqlExpressionIncludes(condition, expected, seen))) {
		return true;
	}

	return Object.values(record).some(child => sqlExpressionIncludes(child, expected, seen));
}

function conditionIncludesEq(value: unknown, left: unknown, right: unknown): boolean {
	if (!value || typeof value !== 'object') return false;

	const record = value as { kind?: unknown; left?: unknown; right?: unknown; conditions?: unknown[]; queryChunks?: unknown[] };
	if (record.kind === 'eq' && record.left === left && record.right === right) return true;
	if (Array.isArray(record.conditions) && record.conditions.some(condition => conditionIncludesEq(condition, left, right))) {
		return true;
	}
	if (Array.isArray(record.queryChunks) && record.queryChunks.some(chunk => conditionIncludesEq(chunk, left, right))) {
		return true;
	}
	return false;
}

function createSelectChain(rows: unknown[]) {
	const chain = {
		from: vi.fn(() => chain),
		innerJoin: vi.fn(() => chain),
		where: vi.fn((_condition: unknown) => chain),
		orderBy: vi.fn((..._expressions: unknown[]) => chain),
		limit: vi.fn(() => Promise.resolve(rows)),
	};
	return chain;
}

beforeEach(() => {
	dbMocks.getDb.mockReset();
	dbMocks.and.mockClear();
	dbMocks.eq.mockClear();
});

describe('timeline selection helpers', () => {
	it('selects scheduled events due on or before the current turn and excludes future or committed rows', () => {
		const selected = selectDueTimelineEvents([
			event({ id: 'future', status: 'scheduled', scheduledTurn: 7 }),
			event({ id: 'already_due', status: 'scheduled', scheduledTurn: 3 }),
			event({ id: 'current', status: 'scheduled', scheduledTurn: 5 }),
			event({ id: 'committed_due_turn', status: 'committed', scheduledTurn: 2 }),
		], 5);

		expect(selected.map(item => item.id)).toEqual(['already_due', 'current']);
	});

	it('keeps rows already marked due selected', () => {
		const selected = selectDueTimelineEvents([
			event({ id: 'due_without_turn', status: 'due', scheduledTurn: null }),
			event({ id: 'future', status: 'scheduled', scheduledTurn: 9 }),
		], 4);

		expect(selected.map(item => item.id)).toEqual(['due_without_turn']);
	});

	it('keeps null-turn due rows in the brief under tight due limits', () => {
		const brief = buildGmTimelineBrief({
			storyId: 'story_1',
			currentTurn: 8,
			currentWorldTime: null,
			events: [
				event({ id: 'dated_due', status: 'scheduled', scheduledTurn: 3 }),
				event({ id: 'null_due', status: 'due', scheduledTurn: null, createdTurn: 2 }),
			],
			npcLinks: [],
			dueLimit: 1,
			recentLimit: 0,
			scheduledLimit: 0,
		});

		expect(brief.dueEvents.map(item => item.id)).toEqual(['null_due']);
	});

	it('does not create npc links from generic actor and target entity ids by default', () => {
		const links = buildNpcEventLinksForEvent({
			storyId: 'story_1',
			eventId: 'event_scheme',
			actorEntityIds: ['faction_river_guard', 'thread_border_war'],
			targetEntityIds: ['location_gatehouse', 'faction_marsh_court'],
			visibility: 'player_known',
			sourceEntryIds: [],
			sourcePatchIds: [],
			serverVersion: 1,
			now,
		});

		expect(links).toEqual([]);
	});

	it('creates explicit actor and target npc links without duplicates and lets actor role win', () => {
		const links = buildNpcEventLinksForEvent({
			storyId: 'story_1',
			eventId: 'event_scheme',
			actorNpcEntityIds: ['npc_anya', 'npc_borin'],
			targetNpcEntityIds: ['npc_borin', 'npc_cass'],
			visibility: 'secret',
			sourceEntryIds: ['entry_1'],
			sourcePatchIds: ['patch_1'],
			serverVersion: 4,
			now,
		});

		expect(links[0]).toMatchObject({
			id: 'npc_event_event_scheme_npc_anya',
			storyId: 'story_1',
			eventId: 'event_scheme',
			npcEntityId: 'npc_anya',
			visibility: 'secret',
			sourceEntryIds: ['entry_1'],
			sourcePatchIds: ['patch_1'],
			serverVersion: 4,
		});
		expect(links).toMatchObject([
			{
				id: 'npc_event_event_scheme_npc_anya',
				npcEntityId: 'npc_anya',
				role: 'actor',
				evidenceStrength: 0.9,
			},
			{
				id: 'npc_event_event_scheme_npc_borin',
				npcEntityId: 'npc_borin',
				role: 'actor',
				evidenceStrength: 0.9,
			},
			{
				id: 'npc_event_event_scheme_npc_cass',
				npcEntityId: 'npc_cass',
				role: 'target',
				evidenceStrength: 0.75,
			},
		]);
	});

	it('uses explicit NPC ids for links and ignores generic actor and target entity ids', () => {
		const links = buildNpcEventLinksForEvent({
			storyId: 'story_1',
			eventId: 'event_scheme',
			actorEntityIds: ['faction_a', 'thread_border_war'],
			targetEntityIds: ['location_gatehouse', 'faction_b'],
			actorNpcEntityIds: ['npc_anya', 'npc_borin'],
			targetNpcEntityIds: ['npc_borin', 'npc_cass'],
			visibility: 'player_known',
			sourceEntryIds: [],
			sourcePatchIds: [],
			serverVersion: 1,
			now,
		});

		expect(links.map(item => [item.npcEntityId, item.role])).toEqual([
			['npc_anya', 'actor'],
			['npc_borin', 'actor'],
			['npc_cass', 'target'],
		]);
		expect(links.map(item => item.npcEntityId)).not.toContain('faction_a');
		expect(links.map(item => item.npcEntityId)).not.toContain('faction_b');
		expect(links.map(item => item.npcEntityId)).not.toContain('location_gatehouse');
		expect(links.map(item => item.npcEntityId)).not.toContain('thread_border_war');
	});

	it('creates a scheduled insert from current turn plus floored nonnegative delay metadata', () => {
		const insert = buildScheduledTimelineEventInsert({
			storyId: 'story_1',
			type: 'rumor',
			title: 'Rumor arrives',
			body: 'A rumor reaches court after a delay.',
			currentTurn: 10,
			delayTurns: 2.9,
			now,
			metadata: { source: 'world_tick' },
		});

		expect(insert).toMatchObject({
			storyId: 'story_1',
			type: 'rumor',
			title: 'Rumor arrives',
			body: 'A rumor reaches court after a delay.',
			status: 'scheduled',
			createdTurn: 10,
			occurredTurn: null,
			scheduledTurn: 12,
			metadata: { source: 'world_tick', inWorldDelayTurns: 2 },
		});
	});

	it('uses current world time when scheduled insert world time is omitted', () => {
		const insert = buildScheduledTimelineEventInsert({
			storyId: 'story_1',
			type: 'rumor',
			title: 'Rumor arrives',
			body: 'A rumor reaches court after a delay.',
			currentTurn: 10,
			currentWorldTime: '17th day of the 9th moon',
			delayTurns: 1,
			now,
		});

		expect(insert.worldTime).toBe('17th day of the 9th moon');
	});

	it('accepts plan-compatible loader and promotion signatures at compile time', () => {
		const loadInput = {
			storyId: 'story_1',
			sceneEntityIds: ['npc_cass'],
			currentTurn: 7,
			npcEventLimit: 2,
		} satisfies Parameters<typeof loadGmTimelineBrief>[0];
		const promoteInput = ['story_1', 5] satisfies Parameters<typeof promoteDueTimelineEvents>;
		const promoteWithVersionInput = ['story_1', 5, { now, serverVersion: 42 }] satisfies Parameters<typeof promoteDueTimelineEvents>;

		expect(loadInput.sceneEntityIds).toEqual(['npc_cass']);
		expect(loadInput.currentTurn).toBe(7);
		expect(promoteInput).toEqual(['story_1', 5]);
		expect(promoteWithVersionInput[2]).toEqual({ now, serverVersion: 42 });
	});

	it('accepts scheduled timeline input with explicit npc ids at compile time', () => {
		const scheduleInput = {
			storyId: 'story_1',
			type: 'scheme',
			title: 'Gatehouse pressure',
			body: 'A faction tests the gatehouse through named agents.',
			currentTurn: 5,
			delayTurns: 2,
			now,
			actorEntityIds: ['faction_river_guard'],
			targetEntityIds: ['location_gatehouse'],
			actorNpcEntityIds: ['npc_anya'],
			targetNpcEntityIds: ['npc_borin'],
		} satisfies Parameters<typeof scheduleTimelineEvent>[0];

		expect(scheduleInput.actorNpcEntityIds).toEqual(['npc_anya']);
		expect(scheduleInput.targetNpcEntityIds).toEqual(['npc_borin']);
	});

	it('inserts scheduled events and npc links inside a transaction', async () => {
		const row = event({
			id: 'event_tx',
			status: 'scheduled',
			title: 'Gatehouse pressure',
			body: 'A faction tests the gatehouse through named agents.',
			scheduledTurn: 7,
			sourceEntryIds: ['entry_1'],
			sourcePatchIds: ['patch_1'],
			serverVersion: 3,
		});
		const eventReturning = vi.fn().mockResolvedValue([row]);
		const eventValues = vi.fn(() => ({ returning: eventReturning }));
		const linkOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
		const linkValues = vi.fn(() => ({ onConflictDoNothing: linkOnConflictDoNothing }));
		const txInsert = vi.fn()
			.mockReturnValueOnce({ values: eventValues })
			.mockReturnValueOnce({ values: linkValues });
		const transaction = vi.fn(async (callback: (tx: { insert: typeof txInsert }) => Promise<TestStoryEvent>) =>
			callback({ insert: txInsert }));
		const dbInsert = vi.fn();
		dbMocks.getDb.mockReturnValue({ transaction, insert: dbInsert });

		const result = await scheduleTimelineEvent({
			storyId: 'story_1',
			type: 'scheme',
			title: 'Gatehouse pressure',
			body: 'A faction tests the gatehouse through named agents.',
			currentTurn: 5,
			delayTurns: 2,
			now,
			actorNpcEntityIds: ['npc_anya'],
		});

		expect(result).toBe(row);
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(dbInsert).not.toHaveBeenCalled();
		expect(txInsert).toHaveBeenCalledTimes(2);
		expect(eventValues).toHaveBeenCalledWith(expect.objectContaining({
			storyId: 'story_1',
			status: 'scheduled',
			title: 'Gatehouse pressure',
			scheduledTurn: 7,
		}));
		expect(linkValues).toHaveBeenCalledWith([
			expect.objectContaining({
				storyId: 'story_1',
				eventId: 'event_tx',
				npcEntityId: 'npc_anya',
				role: 'actor',
				visibility: 'player_known',
				sourceEntryIds: ['entry_1'],
				sourcePatchIds: ['patch_1'],
				serverVersion: 3,
			}),
		]);
		expect(linkOnConflictDoNothing).toHaveBeenCalledTimes(1);
	});

	it('builds a due promotion patch without mutating occurred turn', () => {
		expect(buildDueTimelineEventPromotionPatch(now)).toEqual({
			status: 'due',
			updatedAt: now,
		});
	});

	it('builds a versioned due promotion patch without mutating occurred turn', () => {
		const patch = buildDueTimelineEventPromotionPatch(now, { serverVersion: 42 });

		expect(patch).toEqual({
			status: 'due',
			updatedAt: now,
			serverVersion: 42,
		});
		expect(patch).not.toHaveProperty('occurredTurn');
	});

	it('promotes only scheduled due rows and leaves occurred turn out of the update payload', async () => {
		const rows = [event({ id: 'due_scheduled', status: 'due', scheduledTurn: 5 })];
		const returning = vi.fn().mockResolvedValue(rows);
		const where = vi.fn(() => ({ returning }));
		const set = vi.fn((payload: Record<string, unknown>) => {
			void payload;
			return { where };
		});
		const update = vi.fn(() => ({ set }));
		dbMocks.getDb.mockReturnValue({ update });

		const result = await promoteDueTimelineEvents('story_1', 5, now);
		const setPayload = set.mock.calls[0]?.[0];
		const dueTurnCondition = dbMocks.and.mock.calls[0]?.[2];

		expect(result).toBe(rows);
		expect(update).toHaveBeenCalledWith(storyEvents);
		expect(setPayload).toEqual({
			status: 'due',
			updatedAt: now,
		});
		expect(setPayload).not.toHaveProperty('occurredTurn');
		expect(where).toHaveBeenCalledWith(expect.objectContaining({ kind: 'and' }));
		expect(returning).toHaveBeenCalledTimes(1);
		expect(dbMocks.eq).toHaveBeenCalledWith(storyEvents.storyId, 'story_1');
		expect(dbMocks.eq).toHaveBeenCalledWith(storyEvents.status, 'scheduled');
		expect(sqlExpressionIncludes(dueTurnCondition, storyEvents.scheduledTurn)).toBe(true);
		expect(sqlExpressionIncludes(dueTurnCondition, 5)).toBe(true);
	});

	it('promotes scheduled due rows with server version when provided', async () => {
		const rows = [event({ id: 'due_scheduled', status: 'due', scheduledTurn: 5, serverVersion: 42 })];
		const returning = vi.fn().mockResolvedValue(rows);
		const where = vi.fn(() => ({ returning }));
		const set = vi.fn((payload: Record<string, unknown>) => {
			void payload;
			return { where };
		});
		const update = vi.fn(() => ({ set }));
		dbMocks.getDb.mockReturnValue({ update });

		const result = await promoteDueTimelineEvents('story_1', 5, { now, serverVersion: 42 });
		const setPayload = set.mock.calls[0]?.[0];

		expect(result).toBe(rows);
		expect(setPayload).toEqual({
			status: 'due',
			updatedAt: now,
			serverVersion: 42,
		});
		expect(setPayload).not.toHaveProperty('occurredTurn');
	});

	it('loads a timeline brief from bounded due, recent, scheduled, npc-link, and linked-event queries', async () => {
		const storyRow = {
			id: 'story_1',
			currentTurn: 8,
			currentWorldTime: 'Dawn court',
		};
		const dueRows = [
			event({
				id: 'null_due',
				status: 'due',
				title: 'Undated danger arrives',
				scheduledTurn: null,
				createdTurn: 2,
			}),
		];
		const recentRows = [
			event({
				id: 'recent_headline',
				status: 'committed',
				title: 'Fresh court rumor',
				occurredTurn: 7,
				createdTurn: 7,
			}),
		];
		const scheduledRows = [
			event({
				id: 'future_event',
				status: 'scheduled',
				title: 'Gatehouse pressure',
				scheduledTurn: 9,
			}),
		];
		const npcRows = [
			link({
				eventId: 'linked_old_memory',
				npcEntityId: 'npc_present',
				role: 'affected',
				evidenceStrength: 0.95,
			}),
		];
		const linkedRows = [
			event({
				id: 'linked_old_memory',
				status: 'committed',
				title: 'Old border debt',
				occurredTurn: 1,
				createdTurn: 1,
			}),
		];
		const chains = [storyRow ? [storyRow] : [], dueRows, recentRows, scheduledRows, npcRows, linkedRows]
			.map((rows) => {
				const chain = {
					from: vi.fn(() => chain),
					innerJoin: vi.fn(() => chain),
					where: vi.fn((_condition: unknown) => chain),
					orderBy: vi.fn((..._expressions: unknown[]) => chain),
					limit: vi.fn(() => Promise.resolve(rows)),
				};
				return chain;
			});
		const select = vi.fn()
			.mockReturnValueOnce(chains[0])
			.mockReturnValueOnce(chains[1])
			.mockReturnValueOnce(chains[2])
			.mockReturnValueOnce(chains[3])
			.mockReturnValueOnce(chains[4])
			.mockReturnValueOnce(chains[5]);
		dbMocks.getDb.mockReturnValue({ select });

		const brief = await loadGmTimelineBrief({
			storyId: 'story_1',
			presentNpcIds: ['npc_present'],
			currentTurn: undefined,
			dueLimit: 1,
			recentLimit: 1,
			scheduledLimit: 1,
			npcLimit: 1,
			npcEventLimit: 1,
		});

		expect(select).toHaveBeenCalledTimes(6);
		expect(chains[1].limit).toHaveBeenCalledWith(1);
		expect(chains[2].limit).toHaveBeenCalledWith(1);
		expect(chains[3].limit).toHaveBeenCalledWith(1);
		expect(chains[4].limit).toHaveBeenCalledWith(expect.any(Number));
		expect(chains[5].limit).toHaveBeenCalledWith(1);
		expect(brief.currentTurn).toBe(8);
		expect(brief.currentWorldTime).toBe('Dawn court');
		expect(brief.dueEvents.map(item => item.id)).toEqual(['null_due']);
		expect(brief.recentEvents.map(item => item.id)).toEqual(['recent_headline']);
		expect(brief.scheduledEvents.map(item => item.id)).toEqual(['future_event']);
		expect(brief.npcEvents).toEqual([
			{
				npcEntityId: 'npc_present',
				eventIds: ['linked_old_memory'],
				summary: 'Old border debt',
				visibility: 'player_known',
			},
		]);
	});

	it('applies public visibility filters before bounded timeline query limits', async () => {
		const storyRow = {
			id: 'story_1',
			currentTurn: 8,
			currentWorldTime: 'Dawn court',
		};
		const chains = [[storyRow], [], [], [], []].map(createSelectChain);
		const select = vi.fn()
			.mockReturnValueOnce(chains[0])
			.mockReturnValueOnce(chains[1])
			.mockReturnValueOnce(chains[2])
			.mockReturnValueOnce(chains[3])
			.mockReturnValueOnce(chains[4]);
		dbMocks.getDb.mockReturnValue({ select });

		await loadGmTimelineBrief({
			storyId: 'story_1',
			presentNpcIds: ['npc_visible'],
			includeSecret: false,
			dueLimit: 1,
			recentLimit: 1,
			scheduledLimit: 1,
			npcLimit: 1,
			npcEventLimit: 1,
		});

		const dueWhere = chains[1].where.mock.calls[0]?.[0];
		const recentWhere = chains[2].where.mock.calls[0]?.[0];
		const scheduledWhere = chains[3].where.mock.calls[0]?.[0];
		const linkWhere = chains[4].where.mock.calls[0]?.[0];

		for (const condition of [dueWhere, recentWhere, scheduledWhere]) {
			expect(sqlExpressionIncludes(condition, storyEvents.visibility)).toBe(true);
			expect(sqlExpressionIncludes(condition, 'public')).toBe(true);
			expect(sqlExpressionIncludes(condition, 'player_known')).toBe(true);
		}
		expect(sqlExpressionIncludes(linkWhere, npcEventLinks.visibility)).toBe(true);
		expect(sqlExpressionIncludes(linkWhere, storyEvents.visibility)).toBe(true);
		expect(sqlExpressionIncludes(linkWhere, 'public')).toBe(true);
		expect(sqlExpressionIncludes(linkWhere, 'player_known')).toBe(true);
	});

	it('orders recent bounded queries by occurred turn falling back to created turn', async () => {
		const storyRow = {
			id: 'story_1',
			currentTurn: 8,
			currentWorldTime: 'Dawn court',
		};
		const chains = [[storyRow], [], [], []].map(createSelectChain);
		const select = vi.fn()
			.mockReturnValueOnce(chains[0])
			.mockReturnValueOnce(chains[1])
			.mockReturnValueOnce(chains[2])
			.mockReturnValueOnce(chains[3]);
		dbMocks.getDb.mockReturnValue({ select });

		await loadGmTimelineBrief({
			storyId: 'story_1',
			includeSecret: false,
			dueLimit: 0,
			recentLimit: 1,
			scheduledLimit: 0,
			npcLimit: 0,
		});

		const recentOrderArgs = chains[2].orderBy.mock.calls[0] ?? [];

		expect(sqlExpressionIncludes(recentOrderArgs[0], 'coalesce')).toBe(true);
		expect(sqlExpressionIncludes(recentOrderArgs[0], storyEvents.occurredTurn)).toBe(true);
		expect(sqlExpressionIncludes(recentOrderArgs[0], storyEvents.createdTurn)).toBe(true);
	});

	it('loads npc links with a fair per-npc bound so later present npcs are not starved', async () => {
		const storyRow = {
			id: 'story_1',
			currentTurn: 12,
			currentWorldTime: 'Dawn court',
		};
		const firstNpcLinks = [
			link({
				id: 'link_first_high_1',
				eventId: 'first_old_high_1',
				npcEntityId: 'npc_first',
				evidenceStrength: 0.95,
			}),
			link({
				id: 'link_first_high_2',
				eventId: 'first_old_high_2',
				npcEntityId: 'npc_first',
				evidenceStrength: 0.94,
			}),
			link({
				id: 'link_first_high_3',
				eventId: 'first_old_high_3',
				npcEntityId: 'npc_first',
				evidenceStrength: 0.93,
			}),
			link({
				id: 'link_first_high_4',
				eventId: 'first_old_high_4',
				npcEntityId: 'npc_first',
				evidenceStrength: 0.92,
			}),
		];
		const laterNpcLinks = [
			link({
				id: 'link_later_due',
				eventId: 'later_due_visible',
				npcEntityId: 'npc_later',
				evidenceStrength: 0.1,
			}),
		];
		const linkedRows = [
			event({
				id: 'first_old_high_1',
				status: 'committed',
				title: 'First old memory',
				occurredTurn: 1,
				createdTurn: 1,
			}),
			event({
				id: 'first_old_high_2',
				status: 'committed',
				title: 'First older memory',
				occurredTurn: 2,
				createdTurn: 2,
			}),
			event({
				id: 'first_old_high_3',
				status: 'committed',
				title: 'First third memory',
				occurredTurn: 3,
				createdTurn: 3,
			}),
			event({
				id: 'first_old_high_4',
				status: 'committed',
				title: 'First fourth memory',
				occurredTurn: 4,
				createdTurn: 4,
			}),
			event({
				id: 'later_due_visible',
				status: 'due',
				title: 'Later NPC danger arrives',
				scheduledTurn: null,
				createdTurn: 11,
			}),
		];
		const select = vi.fn(() => {
			let selectedTable: unknown;
			let whereCondition: unknown;
			const chain = {
				from: vi.fn((table: unknown) => {
					selectedTable = table;
					return chain;
				}),
				innerJoin: vi.fn(() => chain),
				where: vi.fn((condition: unknown) => {
					whereCondition = condition;
					return chain;
				}),
				orderBy: vi.fn(() => chain),
				limit: vi.fn((limitValue: number) => {
					if (selectedTable === stories) return Promise.resolve([storyRow]);
					if (selectedTable === npcEventLinks) {
						if (conditionIncludesEq(whereCondition, npcEventLinks.npcEntityId, 'npc_later')) {
							return Promise.resolve(laterNpcLinks);
						}
						return Promise.resolve(firstNpcLinks.slice(0, limitValue));
					}
					if (selectedTable === storyEvents && sqlExpressionIncludes(whereCondition, storyEvents.id)) {
						return Promise.resolve(linkedRows);
					}
					return Promise.resolve([]);
				}),
			};
			return chain;
		});
		dbMocks.getDb.mockReturnValue({ select });

		const brief = await loadGmTimelineBrief({
			storyId: 'story_1',
			presentNpcIds: ['npc_first', 'npc_later'],
			includeSecret: false,
			dueLimit: 0,
			recentLimit: 0,
			scheduledLimit: 0,
			npcLimit: 2,
			npcEventLimit: 1,
		});

		expect(brief.npcEvents.map(item => item.npcEntityId)).toEqual(['npc_first', 'npc_later']);
		expect(brief.npcEvents.find(item => item.npcEntityId === 'npc_later')?.eventIds).toEqual(['later_due_visible']);
	});

	it('builds due, recent, scheduled, and npc event slices with due statuses overridden', () => {
		const brief = buildGmTimelineBrief({
			storyId: 'story_1',
			currentTurn: 5,
			currentWorldTime: 'Late spring',
			events: [
				event({ id: 'recent', status: 'committed', occurredTurn: 4, scheduledTurn: null, actorEntityIds: ['npc_anya'] }),
				event({ id: 'due_scheduled', status: 'scheduled', scheduledTurn: 5, actorEntityIds: ['npc_borin'] }),
				event({ id: 'future', status: 'scheduled', scheduledTurn: 8, targetEntityIds: ['npc_cass'] }),
			],
			npcLinks: [
				link({ eventId: 'recent', npcEntityId: 'npc_anya', role: 'actor' }),
				link({ eventId: 'due_scheduled', npcEntityId: 'npc_borin', role: 'actor' }),
				link({ eventId: 'future', npcEntityId: 'npc_cass', role: 'target' }),
			],
			presentNpcIds: ['npc_anya', 'npc_borin'],
			sceneEntityIds: ['npc_cass'],
			includeSecret: false,
		});

		expect(brief.storyId).toBe('story_1');
		expect(brief.currentTurn).toBe(5);
		expect(brief.currentWorldTime).toBe('Late spring');
		expect(brief.dueEvents).toMatchObject([{ id: 'due_scheduled', status: 'due', turnsUntilDue: 0 }]);
		expect(brief.recentEvents).toMatchObject([{ id: 'recent', status: 'committed', turnsUntilDue: null }]);
		expect(brief.scheduledEvents).toMatchObject([{ id: 'future', status: 'scheduled', turnsUntilDue: 3 }]);
		expect(brief.npcEvents).toEqual([
			{
				npcEntityId: 'npc_anya',
				eventIds: ['recent'],
				summary: 'A quiet scheme',
				visibility: 'player_known',
			},
			{
				npcEntityId: 'npc_borin',
				eventIds: ['due_scheduled'],
				summary: 'A quiet scheme',
				visibility: 'player_known',
			},
			{
				npcEntityId: 'npc_cass',
				eventIds: ['future'],
				summary: 'A quiet scheme',
				visibility: 'player_known',
			},
		]);
	});

	it('builds present npc memory from visible links even when linked events miss headline limits', () => {
		const brief = buildGmTimelineBrief({
			storyId: 'story_1',
			currentTurn: 20,
			currentWorldTime: null,
			events: [
				event({
					id: 'linked_old_memory',
					status: 'committed',
					title: 'Old border debt',
					occurredTurn: 1,
					createdTurn: 1,
				}),
				event({
					id: 'headline_recent',
					status: 'committed',
					title: 'Fresh court rumor',
					occurredTurn: 19,
					createdTurn: 19,
				}),
			],
			npcLinks: [
				link({ eventId: 'linked_old_memory', npcEntityId: 'npc_present', role: 'affected' }),
			],
			presentNpcIds: ['npc_present'],
			recentLimit: 1,
			scheduledLimit: 0,
			dueLimit: 0,
			includeSecret: false,
		});

		expect(brief.recentEvents.map(item => item.id)).toEqual(['headline_recent']);
		expect(brief.npcEvents).toEqual([
			{
				npcEntityId: 'npc_present',
				eventIds: ['linked_old_memory'],
				summary: 'Old border debt',
				visibility: 'player_known',
			},
		]);
	});

	it('caps present npc memory outside headline slices to the per-npc event limit', () => {
		const brief = buildGmTimelineBrief({
			storyId: 'story_1',
			currentTurn: 20,
			currentWorldTime: null,
			events: [
				event({
					id: 'headline_recent',
					status: 'committed',
					title: 'Fresh court rumor',
					occurredTurn: 19,
					createdTurn: 19,
				}),
				event({
					id: 'linked_due_memory',
					status: 'due',
					title: 'Old border debt comes due',
					scheduledTurn: null,
					createdTurn: 2,
				}),
				event({
					id: 'linked_quiet_memory',
					status: 'committed',
					title: 'Quiet remembered slight',
					occurredTurn: 3,
					createdTurn: 3,
				}),
			],
			npcLinks: [
				link({ eventId: 'linked_quiet_memory', npcEntityId: 'npc_present', role: 'affected' }),
				link({ eventId: 'linked_due_memory', npcEntityId: 'npc_present', role: 'affected' }),
			],
			presentNpcIds: ['npc_present'],
			recentLimit: 1,
			scheduledLimit: 0,
			dueLimit: 0,
			npcEventLimit: 1,
			includeSecret: false,
		});

		expect(brief.recentEvents.map(item => item.id)).toEqual(['headline_recent']);
		expect(brief.npcEvents).toEqual([
			{
				npcEntityId: 'npc_present',
				eventIds: ['linked_due_memory'],
				summary: 'Old border debt comes due',
				visibility: 'player_known',
			},
		]);
	});

	it('caps per-npc event ids and summary with deterministic relevance ordering', () => {
		const longTitle = (prefix: string) => `${prefix} ${'x'.repeat(120)}`;
		const brief = buildGmTimelineBrief({
			storyId: 'story_1',
			currentTurn: 10,
			currentWorldTime: null,
			events: [
				event({
					id: 'committed_newer',
					status: 'committed',
					title: longTitle('Newest committed memory'),
					occurredTurn: 9,
					createdTurn: 9,
				}),
				event({
					id: 'future_later',
					status: 'scheduled',
					title: longTitle('Later scheduled pressure'),
					scheduledTurn: 14,
					createdTurn: 4,
				}),
				event({
					id: 'due_null',
					status: 'due',
					title: longTitle('Undated due pressure'),
					scheduledTurn: null,
					createdTurn: 1,
				}),
				event({
					id: 'future_soon',
					status: 'scheduled',
					title: longTitle('Soon scheduled pressure'),
					scheduledTurn: 11,
					createdTurn: 3,
				}),
				event({
					id: 'committed_stronger',
					status: 'committed',
					title: longTitle('Stronger committed memory'),
					occurredTurn: 2,
					createdTurn: 2,
				}),
			],
			npcLinks: [
				link({ eventId: 'committed_newer', npcEntityId: 'npc_present', evidenceStrength: 0.1, createdAt: '2026-06-02T12:00:05.000Z' }),
				link({ eventId: 'future_later', npcEntityId: 'npc_present', evidenceStrength: 0.2, createdAt: '2026-06-02T12:00:04.000Z' }),
				link({ eventId: 'due_null', npcEntityId: 'npc_present', evidenceStrength: 0.1, createdAt: '2026-06-02T12:00:01.000Z' }),
				link({ eventId: 'future_soon', npcEntityId: 'npc_present', evidenceStrength: 0.9, createdAt: '2026-06-02T12:00:03.000Z' }),
				link({ eventId: 'committed_stronger', npcEntityId: 'npc_present', evidenceStrength: 0.95, createdAt: '2026-06-02T12:00:02.000Z' }),
			],
			presentNpcIds: ['npc_present'],
			recentLimit: 0,
			scheduledLimit: 0,
			dueLimit: 0,
			npcEventLimit: 4,
			includeSecret: false,
		});

		const npcEvent = brief.npcEvents[0];

		expect(npcEvent?.eventIds).toEqual([
			'due_null',
			'future_soon',
			'future_later',
			'committed_stronger',
		]);
		expect(npcEvent?.summary).toContain('Undated due pressure');
		expect(npcEvent?.summary).not.toContain('Newest committed memory');
		expect(npcEvent?.summary.length).toBeLessThanOrEqual(320);
	});

	it('derives brief npc ids from links only, not generic actor or target entity ids', () => {
		const brief = buildGmTimelineBrief({
			storyId: 'story_1',
			currentTurn: 5,
			currentWorldTime: null,
			events: [
				event({
					id: 'faction_move',
					status: 'committed',
					occurredTurn: 4,
					actorEntityIds: ['faction_a'],
					targetEntityIds: ['location_gatehouse'],
				}),
			],
			npcLinks: [
				link({ eventId: 'faction_move', npcEntityId: 'npc_a', role: 'actor' }),
			],
			presentNpcIds: ['npc_a'],
		});

		expect(brief.recentEvents).toMatchObject([
			{
				id: 'faction_move',
				npcEntityIds: ['npc_a'],
			},
		]);
	});

	it('does not build public npc memory from a secret linked event', () => {
		const brief = buildGmTimelineBrief({
			storyId: 'story_1',
			currentTurn: 20,
			currentWorldTime: null,
			events: [
				event({
					id: 'secret_memory',
					status: 'committed',
					title: 'Hidden pact',
					visibility: 'secret',
					occurredTurn: 1,
					createdTurn: 1,
				}),
			],
			npcLinks: [
				link({
					eventId: 'secret_memory',
					npcEntityId: 'npc_present',
					role: 'actor',
					visibility: 'player_known',
				}),
			],
			presentNpcIds: ['npc_present'],
			recentLimit: 0,
			includeSecret: false,
		});

		expect(brief.recentEvents).toEqual([]);
		expect(brief.npcEvents).toEqual([]);
	});

	it('excludes secret events and links unless includeSecret is true', () => {
		const hidden = event({ id: 'hidden', status: 'scheduled', scheduledTurn: 5, visibility: 'secret' });
		const visible = event({ id: 'visible', status: 'scheduled', scheduledTurn: 5, visibility: 'player_known' });

		const publicBrief = buildGmTimelineBrief({
			storyId: 'story_1',
			currentTurn: 5,
			currentWorldTime: null,
			events: [hidden, visible],
			npcLinks: [
				link({ eventId: 'hidden', npcEntityId: 'npc_secret', visibility: 'secret' }),
				link({ eventId: 'visible', npcEntityId: 'npc_visible', visibility: 'player_known' }),
			],
			presentNpcIds: ['npc_secret', 'npc_visible'],
			includeSecret: false,
		});

		const secretBrief = buildGmTimelineBrief({
			storyId: 'story_1',
			currentTurn: 5,
			currentWorldTime: null,
			events: [hidden, visible],
			npcLinks: [
				link({ eventId: 'hidden', npcEntityId: 'npc_secret', visibility: 'secret' }),
				link({ eventId: 'visible', npcEntityId: 'npc_visible', visibility: 'player_known' }),
			],
			presentNpcIds: ['npc_secret', 'npc_visible'],
			includeSecret: true,
		});

		expect(publicBrief.dueEvents.map(item => item.id)).toEqual(['visible']);
		expect(publicBrief.npcEvents.map(item => item.npcEntityId)).toEqual(['npc_visible']);
		expect(secretBrief.dueEvents.map(item => item.id)).toEqual(['hidden', 'visible']);
		expect(secretBrief.npcEvents.map(item => item.npcEntityId)).toEqual(['npc_secret', 'npc_visible']);
	});
});
