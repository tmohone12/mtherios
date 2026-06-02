import { describe, expect, it } from 'vitest';
import {
	buildDueTimelineEventPromotionPatch,
	buildGmTimelineBrief,
	buildNpcEventLinksForEvent,
	buildScheduledTimelineEventInsert,
	loadGmTimelineBrief,
	promoteDueTimelineEvents,
	selectDueTimelineEvents,
} from './timeline';

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

	it('creates actor and target links without duplicates and lets actor role win', () => {
		const links = buildNpcEventLinksForEvent({
			storyId: 'story_1',
			eventId: 'event_scheme',
			actorEntityIds: ['npc_anya', 'npc_borin'],
			targetEntityIds: ['npc_borin', 'npc_cass'],
			visibility: 'player_known',
			sourceEntryIds: [],
			sourcePatchIds: [],
			serverVersion: 1,
			now,
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

	it('accepts plan-compatible loader and promotion signatures at compile time', () => {
		const loadInput = {
			storyId: 'story_1',
			sceneEntityIds: ['npc_cass'],
		} satisfies Parameters<typeof loadGmTimelineBrief>[0];
		const promoteInput = ['story_1', 5] satisfies Parameters<typeof promoteDueTimelineEvents>;

		expect(loadInput.sceneEntityIds).toEqual(['npc_cass']);
		expect(promoteInput).toEqual(['story_1', 5]);
	});

	it('builds a due promotion patch without mutating occurred turn', () => {
		expect(buildDueTimelineEventPromotionPatch(now)).toEqual({
			status: 'due',
			updatedAt: now,
		});
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
