import { describe, expect, it } from 'vitest';
import {
	gmTimelineBriefSchema,
	npcEventLinkSchema,
	storyEventSchema,
} from './memory';

describe('timeline contracts', () => {
	it('parses legacy story events with Task 2 defaults', () => {
		const event = storyEventSchema.parse({
			id: 'event_legacy_raven',
			storyId: 'story_1',
			type: 'rumor',
			title: 'A raven arrives from the coast',
			body: 'A late raven warns that the coastal watch has gone quiet.',
			actorEntityIds: ['npc_watch_captain'],
			targetEntityIds: [],
			locationId: 'loc_coastal_watch',
			threadIds: ['thread_border_alarms'],
			visibility: 'player_known',
			sourceEntryIds: ['entry_1'],
			sourcePatchIds: [],
			metadata: {},
			serverVersion: 3,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(event.status).toBe('committed');
		expect(event.locationIds).toEqual([]);
		expect(event.factionIds).toEqual([]);
		expect(event.createdTurn).toBe(0);
		expect(event.occurredTurn).toBeNull();
		expect(event.scheduledTurn).toBeNull();
		expect(event.worldTime).toBeNull();
		expect(event.memoryImpact).toEqual({});
	});

	it('parses scheduled story events with world time and NPC-visible metadata', () => {
		const event = storyEventSchema.parse({
			id: 'event_marriage_alliance',
			storyId: 'story_1',
			type: 'alliance',
			status: 'scheduled',
			title: 'House Vhalor marriage pact',
			body: 'House Vhalor and House Maeris will bind their fleets by marriage.',
			actorEntityIds: ['npc_vhalor_heir'],
			targetEntityIds: ['npc_maeris_heir'],
			locationId: 'loc_harbor_keep',
			locationIds: ['loc_harbor_keep'],
			factionIds: ['faction_vhalor', 'faction_maeris'],
			threadIds: ['thread_trade_war'],
			visibility: 'secret',
			createdTurn: 4,
			occurredTurn: null,
			scheduledTurn: 6,
			worldTime: '17th day of the 9th moon, 296 AC',
			memoryImpact: { relationship: 'alliance' },
			sourceEntryIds: ['entry_4'],
			sourcePatchIds: ['patch_4'],
			metadata: { inWorldDelayTurns: 2 },
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(event.status).toBe('scheduled');
		expect(event.scheduledTurn).toBe(6);
		expect(event.factionIds).toEqual(['faction_vhalor', 'faction_maeris']);
	});

	it('parses NPC-event links used as character memory evidence', () => {
		const link = npcEventLinkSchema.parse({
			id: 'npc_event_link_1',
			storyId: 'story_1',
			eventId: 'event_marriage_alliance',
			npcEntityId: 'npc_vhalor_heir',
			role: 'actor',
			visibility: 'secret',
			evidenceStrength: 0.9,
			sourceEntryIds: ['entry_4'],
			sourcePatchIds: ['patch_4'],
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(link.role).toBe('actor');
		expect(link.evidenceStrength).toBe(0.9);
	});

	it('defaults optional NPC-event link evidence fields', () => {
		const link = npcEventLinkSchema.parse({
			id: 'npc_event_link_defaults',
			storyId: 'story_1',
			eventId: 'event_marriage_alliance',
			npcEntityId: 'npc_vhalor_heir',
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(link.role).toBe('affected');
		expect(link.visibility).toBe('player_known');
		expect(link.evidenceStrength).toBe(0.75);
		expect(link.sourceEntryIds).toEqual([]);
		expect(link.sourcePatchIds).toEqual([]);
	});

	it('parses knowledge-oriented NPC-event links', () => {
		const link = npcEventLinkSchema.parse({
			id: 'npc_event_link_knower',
			storyId: 'story_1',
			eventId: 'event_secret_alliance',
			npcEntityId: 'npc_spymaster',
			role: 'knower',
			visibility: 'secret',
			evidenceStrength: 0.8,
			sourceEntryIds: ['entry_7'],
			sourcePatchIds: ['patch_7'],
			serverVersion: 13,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(link.role).toBe('knower');
	});

	it('parses compact GM timeline briefs', () => {
		const brief = gmTimelineBriefSchema.parse({
			storyId: 'story_1',
			currentTurn: 6,
			currentWorldTime: '17th day of the 9th moon, 296 AC',
			dueEvents: [{
				id: 'event_marriage_alliance',
				type: 'alliance',
				status: 'due',
				title: 'House Vhalor marriage pact',
				body: 'House Vhalor and House Maeris will bind their fleets by marriage.',
				turnsUntilDue: 0,
				worldTime: '17th day of the 9th moon, 296 AC',
				npcEntityIds: ['npc_vhalor_heir', 'npc_maeris_heir'],
				factionIds: ['faction_vhalor', 'faction_maeris'],
				locationIds: ['loc_harbor_keep'],
				visibility: 'secret',
			}],
			recentEvents: [{
				id: 'event_raven_warning',
				type: 'rumor',
				status: 'committed',
				title: 'Raven warning received',
				body: 'A raven warning reached the harbor keep earlier today.',
				worldTime: '17th day of the 9th moon, 296 AC',
				npcEntityIds: ['npc_watch_captain'],
				factionIds: ['faction_vhalor'],
				locationIds: ['loc_harbor_keep'],
				visibility: 'player_known',
			}],
			scheduledEvents: [],
			npcEvents: [],
		});

		expect(brief.dueEvents[0].turnsUntilDue).toBe(0);
		expect(brief.recentEvents[0].turnsUntilDue).toBeNull();
	});

	it('rejects invalid story event statuses', () => {
		expect(() => storyEventSchema.parse({
			id: 'event_bad_status',
			storyId: 'story_1',
			type: 'rumor',
			status: 'archived',
			title: 'Bad status',
			body: 'This event should not parse.',
			actorEntityIds: [],
			targetEntityIds: [],
			locationId: null,
			threadIds: [],
			visibility: 'player_known',
			sourceEntryIds: [],
			sourcePatchIds: [],
			metadata: {},
			serverVersion: 1,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		})).toThrow();
	});

	it('rejects invalid NPC-event link roles', () => {
		expect(() => npcEventLinkSchema.parse({
			id: 'npc_event_link_bad_role',
			storyId: 'story_1',
			eventId: 'event_marriage_alliance',
			npcEntityId: 'npc_vhalor_heir',
			role: 'instigator',
			visibility: 'secret',
			evidenceStrength: 0.9,
			sourceEntryIds: ['entry_4'],
			sourcePatchIds: ['patch_4'],
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		})).toThrow();
	});

	it.each([-0.1, 1.1])('rejects out-of-range NPC-event evidence strength %s', (evidenceStrength) => {
		expect(() => npcEventLinkSchema.parse({
			id: `npc_event_link_bad_evidence_${evidenceStrength}`,
			storyId: 'story_1',
			eventId: 'event_marriage_alliance',
			npcEntityId: 'npc_vhalor_heir',
			role: 'witness',
			visibility: 'secret',
			evidenceStrength,
			sourceEntryIds: ['entry_4'],
			sourcePatchIds: ['patch_4'],
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		})).toThrow();
	});
});
