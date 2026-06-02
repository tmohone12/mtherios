import { describe, expect, it } from 'vitest';
import {
	gmTimelineBriefSchema,
	npcEventLinkSchema,
	storyEventSchema,
} from './memory';

describe('timeline contracts', () => {
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
			recentEvents: [],
			scheduledEvents: [],
			npcEvents: [],
		});

		expect(brief.dueEvents[0].turnsUntilDue).toBe(0);
	});
});
