import { describe, expect, it } from 'vitest';
import {
	buildGmTimelineBrief,
	buildNpcEventLinksForEvent,
	buildScheduledTimelineEventInsert,
	selectDueTimelineEvents,
} from './timeline';

const now = '2026-06-02T12:00:00.000Z';

type TestStoryEvent = Parameters<typeof selectDueTimelineEvents>[0][number];
type TestNpcLink = Parameters<typeof buildGmTimelineBrief>[0]['linkRows'][number];

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
			event: event({
				id: 'event_scheme',
				actorEntityIds: ['npc_anya', 'npc_borin'],
				targetEntityIds: ['npc_borin', 'npc_cass'],
			}),
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

	it('builds due, recent, scheduled, and npc event slices with due statuses overridden', () => {
		const brief = buildGmTimelineBrief({
			storyId: 'story_1',
			currentTurn: 5,
			currentWorldTime: 'Late spring',
			eventRows: [
				event({ id: 'recent', status: 'committed', occurredTurn: 4, scheduledTurn: null, actorEntityIds: ['npc_anya'] }),
				event({ id: 'due_scheduled', status: 'scheduled', scheduledTurn: 5, actorEntityIds: ['npc_borin'] }),
				event({ id: 'future', status: 'scheduled', scheduledTurn: 8, targetEntityIds: ['npc_cass'] }),
			],
			linkRows: [
				link({ eventId: 'recent', npcEntityId: 'npc_anya', role: 'actor' }),
				link({ eventId: 'due_scheduled', npcEntityId: 'npc_borin', role: 'actor' }),
				link({ eventId: 'future', npcEntityId: 'npc_cass', role: 'target' }),
			],
			presentNpcIds: ['npc_anya', 'npc_borin'],
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
		]);
	});

	it('excludes secret events and links unless includeSecret is true', () => {
		const hidden = event({ id: 'hidden', status: 'scheduled', scheduledTurn: 5, visibility: 'secret' });
		const visible = event({ id: 'visible', status: 'scheduled', scheduledTurn: 5, visibility: 'player_known' });

		const publicBrief = buildGmTimelineBrief({
			storyId: 'story_1',
			currentTurn: 5,
			currentWorldTime: null,
			eventRows: [hidden, visible],
			linkRows: [
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
			eventRows: [hidden, visible],
			linkRows: [
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
