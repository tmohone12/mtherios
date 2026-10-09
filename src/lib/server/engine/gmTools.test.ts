import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
import {
	buildActorBrief,
	buildActorDecisionView,
	buildAffinityRead,
	buildRelationshipWeb,
	buildSceneCheck,
	buildThreadBoard,
	loadGmToolData,
	type GmToolData,
} from './gmTools';

it('returns private NPC intent in the actor brief alongside beliefs and historical events', () => {
	const data = fixture();
	const actor = data.entities.find(entity => entity.id === 'npc_mira')!;
	const agency = { currentGoal: 'Protect her brother.', currentPlan: 'Secure an apprenticeship.', lastIndependentAction: 'Asked a cousin for a berth.', nextOpportunity: 'Meet the returning cousin tomorrow.', constraint: 'No public accusations.' };
	actor.state = { ...actor.state, ...agency };
	const result = buildActorBrief(data, { actorId: actor.id, eventLimit: 8 });
	const briefActor = result.data.actor as Record<string, unknown>;
		expect(briefActor.state).toMatchObject(agency);
		expect(result.data).toHaveProperty('beliefs');
});

it('keeps unrelated secrets out of the actor-decision evidence view', () => {
	const data = fixture();
	data.events.push({
		...data.events[0], id: 'event_unwitnessed', title: 'The Lord sells Mira out', body: 'The Lord privately instructs a spy to betray Mira.',
		actorEntityIds: ['npc_lord'], targetEntityIds: [], sourceEntryIds: ['entry_secret'],
	} as any);
	data.goals.push({ ...data.goals[0], id: 'goal_secret', goal: 'Mira must not learn the secret route.', secrecy: 'secret' } as any);
	const result = buildActorDecisionView(data, { actorId: 'npc_mira', eventLimit: 6 });
	const packet = JSON.stringify(result.data);

	expect(packet).toContain('forged the seal');
	expect(packet).toContain('Deliver the ledger before dawn');
	expect(packet).not.toContain('privately instructs a spy');
	expect(packet).not.toContain('must not learn the secret route');
	expect(result.sourceIds).not.toContain('entry_secret');
});

it('does not let actor decisions choose the player character\'s behavior', () => {
	expect(() => buildActorDecisionView(fixture(), { actorId: 'pc_aurion', eventLimit: 6 }))
		.toThrow('Player character cannot be an actor-decision subject.');
});

function fixture(): GmToolData {
	return {
		story: {
			id: 'story_alpha',
			currentTurn: 14,
			currentWorldTime: 'Night of the Flood Moon',
			currentLocationId: 'loc_docks',
			settings: { playerEntityId: 'pc_aurion' },
			metadata: {
				plotBrain: {
					active: true,
					lastFrameId: 'frame_plot',
					lastFrameTurn: 13,
					lastFrame: {
						id: 'frame_plot',
						storyId: 'story_alpha',
						publicSummary: 'The marriage bargain and the missing ledger are converging.',
						mainPlots: [{ title: 'The Missing Ledger', summary: 'The harbor ledger remains missing.' }],
						plotCards: [{ id: 'thread_ledger', title: 'The Missing Ledger', logline: 'The archive is exposed.' }],
						activationPlan: { activateNow: ['thread_ledger'] },
					},
				},
			},
		} as any,
		entities: [
			{ id: 'pc_aurion', storyId: 'story_alpha', type: 'character', name: 'Aurion', description: 'The protagonist.', status: 'active', visibility: 'player_known', state: { relationship: { level: 100, status: 'self', history: [] }, isProtagonist: true }, metadata: {}, sourceEntryIds: ['entry_aurion'] },
			{ id: 'npc_mira', storyId: 'story_alpha', type: 'character', name: 'Mira', description: 'A harbor envoy.', status: 'active', visibility: 'gm', state: { currentLocationId: 'loc_docks', currentDisposition: 'wary ally', goals: ['Protect her brother.'], relationship: { level: 42, status: 'trusted broker', history: [{ description: 'She kept the bargain.', delta: 2, entryId: 'entry_old' }, { description: 'The player exposed the seal.', delta: -4, entryId: 'entry_seal' }] } }, metadata: {}, sourceEntryIds: ['entry_mira'] },
			{ id: 'npc_lord', storyId: 'story_alpha', type: 'character', name: 'Harbor Lord', description: 'The guild patron.', status: 'active', visibility: 'gm', state: { currentLocationId: 'loc_court' }, metadata: {} },
			{ id: 'npc_ghost', storyId: 'story_alpha', type: 'character', name: 'Old Captain', description: null, status: 'active', visibility: 'gm', state: { status: 'deceased', currentLocationId: 'loc_docks' }, metadata: {} },
			{ id: 'loc_docks', storyId: 'story_alpha', type: 'location', name: 'Tide Docks', description: 'Black pilings above cold water.', status: 'active', visibility: 'public', state: { connections: [{ targetLocationId: 'loc_court', travelTime: 45 }] }, metadata: {} },
			{ id: 'loc_court', storyId: 'story_alpha', type: 'location', name: 'Harbor Court', description: 'A salt-stained audience hall.', status: 'active', visibility: 'public', state: { connections: [] }, metadata: {} },
		] as any,
		aliases: [{ id: 'alias_mira', storyId: 'story_alpha', entityId: 'npc_mira', alias: 'Lady Mira' }] as any,
		relationships: [{ id: 'rel_mira_lord', storyId: 'story_alpha', sourceEntityId: 'npc_mira', targetEntityId: 'npc_lord', type: 'rivalry', label: 'mutual leverage', strength: 0.8, bidirectional: true, sourceEventIds: ['event_ledger'] }] as any,
		factions: [{ id: 'faction_harbor', storyId: 'story_alpha', entityId: null, name: 'Harbor Guild', pressure: 7, metadata: {} }] as any,
		memberships: [{ id: 'membership_mira', storyId: 'story_alpha', factionId: 'faction_harbor', entityId: 'npc_mira', role: 'envoy', rank: 'captain', status: 'active', visibility: 'public' }] as any,
		resources: [{ id: 'resource_fleet', storyId: 'story_alpha', factionId: 'faction_harbor', kind: 'asset', name: 'Night Fleet', amount: 3, locationId: 'loc_docks', status: 'available' }] as any,
		goals: [{ id: 'goal_marriage', storyId: 'story_alpha', factionId: 'faction_harbor', goal: 'Secure the marriage alliance.', priority: 8, secrecy: 'secret', status: 'active' }] as any,
		projects: [{ id: 'project_ledger', storyId: 'story_alpha', factionId: 'faction_harbor', project: 'Recover the missing ledger.', status: 'active', progress: 0.5, dueTurn: 16, risks: ['Exposure'] }] as any,
		beliefs: [{ id: 'belief_mira', storyId: 'story_alpha', believerEntityId: 'npc_mira', subjectEntityId: 'npc_lord', belief: 'The Harbor Lord forged the seal.', confidence: 0.7, status: 'active', sourceEventIds: ['event_ledger'] }] as any,
		agreements: [{ id: 'agreement_marriage', storyId: 'story_alpha', category: 'alliance', parties: ['Mira', 'faction_harbor'], terms: 'Deliver the ledger before dawn.', status: 'active', secrecy: 'secret', consequences: ['War'], sourceEventIds: ['event_ledger'] }] as any,
		threads: [
			{ id: 'thread_ledger', storyId: 'story_alpha', description: 'The missing harbor ledger', status: 'open', significance: 'critical', relatedEntityIds: ['npc_mira'], relatedFactionIds: ['faction_harbor'], sourceEntryIds: ['entry_ledger'] },
			{ id: 'thread_marriage', storyId: 'story_alpha', description: 'The forced marriage alliance', status: 'active', significance: 'major', relatedEntityIds: ['npc_mira', 'npc_lord'], relatedFactionIds: ['faction_harbor'], sourceEntryIds: ['entry_marriage'] },
		] as any,
		events: [{ id: 'event_ledger', storyId: 'story_alpha', type: 'clue_discovery', status: 'committed', title: 'The ledger vanished', body: 'Someone emptied the archive.', occurredTurn: 13, scheduledTurn: null, createdTurn: 13, visibility: 'gm', actorEntityIds: ['npc_mira'], targetEntityIds: ['npc_lord'], factionIds: ['faction_harbor'], threadIds: ['thread_ledger'], locationId: 'loc_docks', locationIds: ['loc_docks'], sourceEntryIds: ['entry_ledger'], metadata: {} }] as any,
	};
}

describe('deterministic GM tools', () => {
	it('includes player capabilities in actor briefs and honors canonical clears over imported values', () => {
		const data = fixture();
		const player = data.entities[0];
		player.metadata = { originalMetadata: { playerCapabilities: { abilities: ['Old ability'], buffs: ['Old ward'] } } };
		player.state = { ...player.state, playerCapabilities: { abilities: ['Keen senses'], buffs: [] } };
		const brief = buildActorBrief(data, { actorId: player.id, eventLimit: 4 }).data as any;
		expect(brief.actor.state.playerCapabilities).toEqual({ abilities: ['Keen senses'], buffs: [] });
	});

	it('loads complete actor and resource sets instead of silently clipping resolvable canon', async () => {
		const allEntities = Array.from({ length: 501 }, (_, index) => ({
			id: `npc_${index}`,
			storyId: 'story_alpha',
			type: 'character',
			name: `Actor ${index}`,
		}));
		let queryIndex = 0;
		mocks.getDb.mockReturnValue({
			select: vi.fn(() => {
				const current = queryIndex++;
				return {
					from: () => ({
						where: () => {
							if (current === 0) return { limit: vi.fn().mockResolvedValue([{ id: 'story_alpha' }]) };
							if (current === 12) return { orderBy: vi.fn().mockResolvedValue([]) };
							return Promise.resolve(current === 1
								? allEntities
								: current === 6 ? [{ id: 'resource_after_old_cap' }] : []);
						},
					}),
				};
			}),
		});

		const loaded = await loadGmToolData('story_alpha');

		expect(loaded.entities).toHaveLength(501);
		expect(loaded.entities.at(-1)?.name).toBe('Actor 500');
		expect(loaded.resources).toEqual([{ id: 'resource_after_old_cap' }]);
	});

	it('keeps actor beliefs separate from narrator truth and exposes faction pressure with evidence', () => {
		const result = buildActorBrief(fixture(), { name: 'Lady Mira', eventLimit: 4 });
		const data = result.data as any;

		expect(data.actor.name).toBe('Mira');
		expect(data.beliefs[0].belief).toContain('forged the seal');
		expect(data.knowledgeBoundary).toContain('Beliefs are actor knowledge');
		expect(data.goals[0].goal).toContain('marriage alliance');
		expect(data.availableLevers).toContain('Night Fleet');
		expect(result.sourceIds).toEqual(expect.arrayContaining(['entry_mira', 'event_ledger', 'entry_ledger']));
	});

	it('keeps retired agreements and non-canon events out of GM explorer receipts', () => {
		const data = fixture();
		data.agreements.push({
			...data.agreements[0],
			id: 'agreement_fulfilled',
			status: 'fulfilled',
			terms: 'Armor polishing before dawn.',
		} as any);
		data.events.push(
			{ ...data.events[0], id: 'event_cancelled', title: 'The Azure Throne maps vulnerabilities', status: 'cancelled', occurredTurn: 30 } as any,
			{ ...data.events[0], id: 'event_superseded', title: 'Truth-stone rite tomorrow', status: 'due', scheduledTurn: 4, metadata: { superseded: true } } as any,
		);

		const actor = buildActorBrief(data, { name: 'Mira', eventLimit: 8 }).data as any;
		const board = buildThreadBoard(data, { actorIds: [], factionIds: [], limit: 12 }).data as any;

		expect(actor.agreements.map((row: any) => row.id)).toEqual(['agreement_marriage']);
		expect(actor.recentEvents.map((row: any) => row.id)).toEqual(['event_ledger']);
		expect(board.threads.find((row: any) => row.id === 'thread_ledger').lastMovement.id).toBe('event_ledger');
		expect(JSON.stringify({ actor, board })).not.toContain('Armor polishing before dawn');
		expect(JSON.stringify({ actor, board })).not.toContain('maps vulnerabilities');
		expect(JSON.stringify({ actor, board })).not.toContain('Truth-stone rite tomorrow');
	});

	it('checks known travel time, scene windows, and hard actor availability', () => {
		const result = buildSceneCheck(fixture(), {
			locationName: 'Harbor Court',
			actorIds: [],
			actorNames: ['Mira', 'Old Captain'],
			availableMinutes: 30,
		});
		const actors = (result.data as any).actors;

		expect(actors.find((actor: any) => actor.name === 'Mira')).toEqual(expect.objectContaining({
			reachability: 'no',
			travelTime: 45,
			reason: 'Known travel time exceeds the available scene window.',
		}));
		expect(actors.find((actor: any) => actor.name === 'Old Captain')).toEqual(expect.objectContaining({
			reachability: 'no',
			reason: 'Actor status is deceased.',
		}));
	});

	it('builds a bounded relationship web with faction membership edges', () => {
		const result = buildRelationshipWeb(fixture(), { actorNames: ['Mira'], actorIds: [], depth: 2 });
		const data = result.data as any;

		expect(data.nodes.map((node: any) => node.id)).toEqual(expect.arrayContaining(['npc_mira', 'npc_lord', 'faction_harbor']));
		expect(data.edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ sourceId: 'npc_mira', targetId: 'faction_harbor', type: 'faction_membership' }),
		]));
		expect(data.nodes.length).toBeLessThanOrEqual(30);
	});

	it('reads bounded NPC affinity as evidence without treating missing as neutral', () => {
		const result = buildAffinityRead(fixture(), { actorIds: [], actorNames: ['Lady Mira', 'Harbor Lord'], historyLimit: 1 });
		const data = result.data as any;

		expect(data.player).toEqual({ id: 'pc_aurion', name: 'Aurion' });
		expect(data.affinities[0]).toMatchObject({ actorId: 'npc_mira', level: 42, status: 'trusted broker', currentDisposition: 'wary ally' });
		expect(data.affinities[0].history).toEqual([expect.objectContaining({ delta: -4, entryId: 'entry_seal' })]);
		expect(data.affinities[1].level).toBeNull();
		expect(result.warnings).toEqual(expect.arrayContaining([
			expect.stringContaining('relationship status and current disposition disagree'),
			expect.stringContaining('no established numeric affinity'),
		]));
		expect(result.sourceIds).toEqual(expect.arrayContaining(['entry_aurion', 'entry_mira']));
	});

	it('returns no affinity history when historyLimit is zero and warns on malformed canon', () => {
		const data = fixture();
		(data.entities.find((row) => row.id === 'npc_mira')!.state as any).relationship.history = 'corrupt';
		const result = buildAffinityRead(data, { actorIds: ['npc_mira'], actorNames: [], historyLimit: 0 });
		const affinity = (result.data as any).affinities[0];

		expect(affinity.history).toEqual([]);
		expect(result.warnings).toContain('Mira has malformed affinity history entries.');
	});

	it('keeps affinity provenance bounded to the most recent source entries', () => {
		const data = fixture();
		data.entities.find((row) => row.id === 'npc_mira')!.sourceEntryIds = Array.from(
			{ length: 30 },
			(_, index) => `entry_${index}`,
		);

		const result = buildAffinityRead(data, { actorIds: ['npc_mira'], actorNames: [], historyLimit: 1 });
		const sourceEntryIds = (result.data as any).affinities[0].sourceEntryIds;

		expect(sourceEntryIds).toHaveLength(20);
		expect(sourceEntryIds[0]).toBe('entry_10');
		expect(sourceEntryIds.at(-1)).toBe('entry_29');
	});

	it('includes incoming one-way relationships while preserving their direction', () => {
		const data = fixture();
		data.relationships = [{
			id: 'rel_lord_mira',
			storyId: 'story_alpha',
			sourceEntityId: 'npc_lord',
			targetEntityId: 'npc_mira',
			type: 'suspicion',
			label: 'quietly watches',
			strength: 0.5,
			bidirectional: false,
			sourceEventIds: ['event_ledger'],
		} as any];

		const result = buildRelationshipWeb(data, { actorNames: ['Mira'], actorIds: [], depth: 1 });
		const web = result.data as any;

		expect(web.nodes.map((node: any) => node.id)).toContain('npc_lord');
		expect(web.edges).toContainEqual(expect.objectContaining({
			sourceId: 'npc_lord',
			targetId: 'npc_mira',
			bidirectional: false,
		}));
	});

	it('does not expose completed, cancelled, or closed faction projects as active pressure', () => {
		const data = fixture();
		data.projects.push(
			{ ...data.projects[0], id: 'project_done', project: 'Completed bargain', status: 'completed' } as any,
			{ ...data.projects[0], id: 'project_cancelled', project: 'Cancelled raid', status: 'cancelled' } as any,
			{ ...data.projects[0], id: 'project_closed', project: 'Closed inquiry', status: 'closed' } as any,
		);

		const actorProjects = ((buildActorBrief(data, { name: 'Mira', eventLimit: 4 }).data as any).projects as any[])
			.map((project) => project.id);
		const threadProjects = ((buildThreadBoard(data, { actorIds: [], factionIds: [], limit: 12 }).data as any).threads as any[])
			.flatMap((thread) => thread.projects.map((project: any) => project.id));

		expect(actorProjects).toContain('project_ledger');
		expect(threadProjects).toContain('project_ledger');
		expect(actorProjects).not.toEqual(expect.arrayContaining(['project_done', 'project_cancelled', 'project_closed']));
		expect(threadProjects).not.toEqual(expect.arrayContaining(['project_done', 'project_cancelled', 'project_closed']));
	});

	it('surfaces existing plot threads, collisions, projects, and Plot Director pressure without writing canon', () => {
		const result = buildThreadBoard(fixture(), { query: 'marriage ledger', actorIds: [], factionIds: [], limit: 12 });
		const data = result.data as any;

		expect(data.threads.map((thread: any) => thread.id)).toEqual(expect.arrayContaining(['thread_ledger', 'thread_marriage']));
		expect(data.collisions[0]).toEqual(expect.objectContaining({ sharedActors: ['npc_mira'], sharedFactions: ['faction_harbor'] }));
		expect(data.threads.find((thread: any) => thread.id === 'thread_ledger').projects[0].project).toContain('ledger');
		expect(data.plotDirector.publicSummary).toContain('converging');
	});

	it.each([
		['inactive', { active: false, lastFrameTurn: 13 }],
		['stale', { active: true, lastFrameTurn: 1 }],
	])('does not expose an %s Plot Director frame', (_label, plotBrainPatch) => {
		const data = fixture();
		data.story.metadata = {
			...data.story.metadata,
			plotBrain: {
				...(data.story.metadata as any).plotBrain,
				...plotBrainPatch,
			},
		};

		const result = buildThreadBoard(data, { actorIds: [], factionIds: [], limit: 12 });

		expect((result.data as any).plotDirector).toBeNull();
	});

	it.each([
		['stored frame id', (plotBrain: any) => { plotBrain.lastFrameId = 'frame_other'; }],
		['frame story id', (plotBrain: any) => { plotBrain.lastFrame.storyId = 'story_other'; }],
	])('does not expose a Plot Director frame with a mismatched %s', (_label, mutate) => {
		const data = fixture();
		mutate((data.story.metadata as any).plotBrain);

		const result = buildThreadBoard(data, { actorIds: [], factionIds: [], limit: 12 });

		expect((result.data as any).plotDirector).toBeNull();
	});

	it('keeps the last usable Plot Director frame while a refresh is pending', () => {
		const data = fixture();
		data.story.currentTurn = 22;
		data.story.metadata = {
			...data.story.metadata,
			plotBrain: {
				...(data.story.metadata as any).plotBrain,
				lastFrameTurn: 13,
				needsDevelopment: true,
			},
		};

		const result = buildThreadBoard(data, { actorIds: [], factionIds: [], limit: 12 });

		expect((result.data as any).plotDirector?.publicSummary).toContain('converging');
	});
});
