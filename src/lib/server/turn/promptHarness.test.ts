import { describe, expect, it } from 'vitest';
import type { GmTimelineBrief, MemoryNode, RetrievedMemoryPacket } from '$lib/contracts/memory';
import type { TurnContext } from './context';
import { buildPromptHarnessReport, evaluatePromptHarness } from './promptHarness';

const now = '2026-05-23T12:00:00.000Z';

function row<T extends Record<string, unknown>>(value: T): T & { serverVersion: number; createdAt: string; updatedAt: string } {
	return {
		serverVersion: 1,
		createdAt: now,
		updatedAt: now,
		...value,
	} as T & { serverVersion: number; createdAt: string; updatedAt: string };
}

function entity(id: string, type: string, name: string, description: string, state: Record<string, unknown> = {}) {
	return row({
		id,
		storyId: 'story_balaerys',
		type,
		name,
		description,
		status: 'active',
		visibility: 'player_known',
		state,
		metadata: {},
		sourceEntryIds: [],
		sourceEventIds: [],
		sourcePatchIds: [],
	});
}

function faction(id: string, name: string, overrides: Record<string, unknown> = {}) {
	return row({
		id,
		storyId: 'story_balaerys',
		entityId: `entity_${id}`,
		name,
		goals: ['protect current influence'],
		resources: { wealth: 50, influence: 50 },
		memberEntityIds: [],
		territoryIds: [],
		allies: [],
		enemies: [],
		pressure: 0,
		metadata: {},
		sourceEntryIds: [],
		sourceEventIds: [],
		sourcePatchIds: [],
		...overrides,
	});
}

function memoryNode(id: string, title: string, content: string): MemoryNode {
	return {
		id,
		storyId: 'story_balaerys',
		type: 'canonical',
		title,
		content,
		summary: content,
		keywords: [],
		entityIds: [],
		factionIds: [],
		threadIds: [],
		locationId: null,
		visibility: 'player_known',
		importance: 0.8,
		sourceEntryIds: [],
		sourceEventIds: [],
		sourcePatchIds: [],
		createdAt: now,
		updatedAt: now,
	};
}

function packet(query: string, nodes: MemoryNode[]): RetrievedMemoryPacket {
	return {
		storyId: 'story_balaerys',
		query,
		packet: nodes.length
			? [
				'## Retrieved Memory Packet',
				'Use these as durable evidence-linked facts for this turn.',
				...nodes.map((node) => `- (${node.type}) ${node.title}: ${node.summary}`),
			].join('\n')
			: '',
		nodes,
		tokenEstimate: 120,
		retrievalDebug: ['harness=test'],
	};
}

function baseContext(overrides: Partial<TurnContext> = {}): TurnContext {
	return {
		story: row({
			id: 'story_balaerys',
			clientStoryId: null,
			title: 'Rise of the Crimson Spire',
			description: 'A Volantene political fantasy rooted in House Balaerys.',
			genre: 'political fantasy',
			mode: 'adventure',
			settings: null,
			headerPrompt: 'The story starts in 296 AC on the protagonist nameday, the 15th day of the 8th moon. The protagonist is the young heir of House Balaerys.',
			currentLocationId: 'loc_crimson_spire',
			metadata: { playerReputation: 'The Balaerys heir is valuable, watched, and newly visible to rival Old Blood houses.' },
		}),
		recentEntries: [
			row({
				id: 'entry_old_1',
				storyId: 'story_balaerys',
				type: 'user_action',
				content: 'I step into the gallery before the nameday guests arrive.',
				position: 0,
				parentId: null,
				branchId: null,
				metadata: {},
			}),
			row({
				id: 'narration_old_1',
				storyId: 'story_balaerys',
				type: 'narration',
				content: 'The Crimson Spire stirs awake around you.',
				position: 1,
				parentId: 'entry_old_1',
				branchId: null,
				metadata: {},
			}),
		],
		entities: [
			entity('loc_crimson_spire', 'location', 'The Crimson Spire', 'The Balaerys manse inside the Black Walls.', { current: true }),
			entity('pc_balaerys', 'character', 'Balaerys Heir', 'The watched young heir of House Balaerys.', { present: true }),
			entity('npc_vaelar', 'character', 'Triarch Vaelar Balaerys', 'The senior public face of House Balaerys.', { present: true }),
		],
		factions: [
			faction('faction_triarchy', 'The Triarchy of Volantis', { pressure: 45 }),
			faction('faction_balaerys', 'House Balaerys', {
				pressure: 70,
				goals: ['keep House Balaerys first among the Old Blood'],
				resources: { wealth: 100, influence: 95, military: 60 },
				memberEntityIds: ['pc_balaerys', 'npc_vaelar'],
			}),
		],
		factionMemberships: [
			row({
				id: 'membership_pc_balaerys',
				storyId: 'story_balaerys',
				factionId: 'faction_balaerys',
				entityId: 'pc_balaerys',
				role: 'heir',
				rank: 'family',
				status: 'active',
				visibility: 'player_known',
				metadata: {},
				sourceEntryIds: [],
				sourceEventIds: [],
				sourcePatchIds: [],
			}),
		],
		factionResources: [],
		factionGoals: [],
		agreements: [],
		threads: [],
		events: [],
		beliefs: [],
		gmBrief: null,
		...overrides,
	} as unknown as TurnContext;
}

function failedLabels(findings: ReturnType<typeof evaluatePromptHarness>): string[] {
	return findings.filter((finding) => !finding.passed).map((finding) => `${finding.label}: ${finding.detail}`);
}

describe('turn prompt harness', () => {
	it('builds a Balaerys nameday prompt with Volantene context', () => {
		const oldBlood = memoryNode('mem_old_blood', 'Old Blood Etiquette', 'Invitations, seating, and marriage memory are weapons inside the Black Walls.');
		const household = memoryNode('mem_household', 'Volantene Household Hierarchy', 'Family elders, slave scribes, guards, and informants shape every great manse.');
		const report = buildPromptHarnessReport({
			name: 'balaerys-nameday-opening',
			playerText: 'I watch who arrives first for my nameday.',
			ctx: baseContext(),
			retrieved: packet('nameday arrivals House Balaerys Black Walls etiquette', [oldBlood, household]),
			options: {
				currentFactionId: 'faction_balaerys',
				sceneEntityIds: ['pc_balaerys', 'npc_vaelar'],
			},
		});

		const findings = evaluatePromptHarness(report, {
			systemIncludes: ['server-side narrator', '1 Volantene honor = 1 gold dragon', 'Bayesian social prior', '296 AC', '15th day of the 8th moon'],
			promptIncludes: [
				'The Crimson Spire',
				'Balaerys Heir',
				'House Balaerys',
				'Old Blood Etiquette',
				'Volantene Household Hierarchy',
			],
			maxOccurrences: {
				'Balaerys Heir': 3,
			},
			maxMessageCount: 24,
			maxTotalBeforeGenerationTokens: 2400,
		});

		expect(failedLabels(findings)).toEqual([]);
		expect(report.retrievedMemoryIds).toEqual(['mem_old_blood', 'mem_household']);
	});

	it('keeps actor belief limits visible for secret-knowledge scenarios', () => {
		const report = buildPromptHarnessReport({
			name: 'secret-knowledge-boundary',
			playerText: 'I ask Lady Saera whether anyone has spoken against me.',
			ctx: baseContext({
				entities: [
					entity('loc_crimson_spire', 'location', 'The Crimson Spire', 'The Balaerys manse inside the Black Walls.', { current: true }),
					entity('pc_balaerys', 'character', 'Balaerys Heir', 'The watched young heir of House Balaerys.', { present: true }),
					entity('npc_saera', 'character', 'Lady Saera Balaerys', 'A senior Balaerys matchmaker and court watcher.', { present: true }),
				],
				beliefs: [
					row({
						id: 'belief_saera_1',
						storyId: 'story_balaerys',
						believerEntityId: 'npc_saera',
						subjectEntityId: 'pc_balaerys',
						belief: 'Lady Saera believes kitchen servants saw the heir meet Drazen Vhassar before dawn.',
						confidence: 0.72,
						visibility: 'secret',
						evidenceEventIds: ['event_servant_gossip'],
						sourceEntryIds: [],
						sourceEventIds: ['event_servant_gossip'],
						sourcePatchIds: [],
					}),
				],
			}),
			retrieved: packet('Saera asks about rumor source', []),
			options: {
				sceneEntityIds: ['pc_balaerys', 'npc_saera'],
			},
		});

		const findings = evaluatePromptHarness(report, {
			systemIncludes: ['never make a present NPC act on secret canon unless their belief packet'],
			promptIncludes: [
				'Actor belief limits',
				'Lady Saera believes kitchen servants saw the heir meet Drazen Vhassar before dawn.',
				'72% confidence',
			],
			maxTotalBeforeGenerationTokens: 2400,
		});

		expect(failedLabels(findings)).toEqual([]);
	});

	it('ranks scene-relevant factions instead of keeping arbitrary insertion order', () => {
		const unrelated = Array.from({ length: 8 }, (_, index) =>
			faction(`faction_irrelevant_${index + 1}`, `House Irrelevant ${index + 1}`, {
				goals: [`hold an unrelated border claim ${index + 1}`],
			})
		);
		const ctx = baseContext({
			factions: [
				...unrelated,
				faction('faction_redwyne', 'House Redwyne', { pressure: 5 }),
				faction('faction_balaerys', 'House Balaerys', {
					pressure: 70,
					goals: ['keep House Balaerys first among the Old Blood'],
					resources: { wealth: 100, influence: 95, military: 60 },
					memberEntityIds: ['pc_balaerys'],
				}),
			],
		});
		const report = buildPromptHarnessReport({
			name: 'faction-ranking',
			playerText: 'I summon the Balaerys factor and ask how the rivals are moving.',
			ctx,
			retrieved: packet('Balaerys rivals Volantis Old Blood', []),
			options: {
				currentFactionId: 'faction_balaerys',
				sceneEntityIds: ['pc_balaerys'],
				maxFactions: 4,
			},
		});

		const findings = evaluatePromptHarness(report, {
			promptIncludes: ['House Balaerys', 'members: Balaerys Heir'],
			promptExcludes: ['House Irrelevant 5'],
			maxTotalBeforeGenerationTokens: 2200,
		});

		expect(failedLabels(findings)).toEqual([]);
	});

	it('includes compact GM timeline and text-RPG NPC portrayal details', () => {
		const gmBrief: GmTimelineBrief = {
			storyId: 'story_balaerys',
			currentTurn: 17,
			currentWorldTime: '296 AC, 15th day of the 8th moon, sunset',
			dueEvents: [
				{
					id: 'event_harbor_pact_due',
					type: 'marriage',
					status: 'due',
					title: 'Harbor marriage pact matures',
					body: 'The harbor faction expects House Balaerys to answer the marriage offer before the envoy leaves the quay.',
					turnsUntilDue: 0,
					worldTime: '296 AC, 15th day of the 8th moon, sunset',
					npcEntityIds: ['npc_saera'],
					factionIds: ['faction_balaerys', 'faction_harbor'],
					locationIds: ['loc_crimson_spire'],
					visibility: 'player_known',
				},
			],
			recentEvents: [
				{
					id: 'event_ring_terms',
					type: 'scheme',
					status: 'committed',
					title: 'Ring-gift terms whispered',
					body: 'A scribe carried the price of the proposed match from the harbor countinghouse.',
					turnsUntilDue: null,
					worldTime: '296 AC, 15th day of the 8th moon, afternoon',
					npcEntityIds: ['npc_saera'],
					factionIds: ['faction_balaerys'],
					locationIds: ['loc_crimson_spire'],
					visibility: 'player_known',
				},
			],
			scheduledEvents: [
				{
					id: 'event_harbor_envoy_waits',
					type: 'faction_move',
					status: 'scheduled',
					title: 'Harbor envoy demands answer',
					body: 'The envoy will seek a public yes or insult at the nameday tables.',
					turnsUntilDue: 2,
					worldTime: '296 AC, 16th day of the 8th moon, morning',
					npcEntityIds: ['npc_saera'],
					factionIds: ['faction_harbor'],
					locationIds: ['loc_crimson_spire'],
					visibility: 'player_known',
				},
			],
			npcEvents: [
				{
					npcEntityId: 'npc_saera',
					eventIds: ['event_harbor_pact_due', 'event_ring_terms'],
					summary: 'Saera has tracked the harbor pact, its ring-gift price, and who benefits if House Balaerys accepts.',
					visibility: 'player_known',
				},
			],
		};
		const report = buildPromptHarnessReport({
			name: 'gm-timeline-portrayal',
			playerText: 'I ask Lady Saera what price the harbor pact truly carries.',
			ctx: baseContext({
				entities: [
					entity('loc_crimson_spire', 'location', 'The Crimson Spire', 'The Balaerys manse inside the Black Walls.', { current: true }),
					entity('pc_balaerys', 'character', 'Balaerys Heir', 'The watched young heir of House Balaerys.', { present: true }),
					entity(
						'npc_saera',
						'character',
						'Lady Saera Balaerys',
						'A senior Balaerys matchmaker and court watcher.',
						{
							present: true,
							appearance: 'silver-streaked black hair, severe jade gown, ringed hands, sharp violet eyes',
							personalityDescriptors: ['controlled', 'cutting', 'protective when House Balaerys benefits'],
							voice: 'low, precise, and dryly amused',
							mannerisms: ['taps one ring against the table before naming a cost'],
						},
					),
				],
				gmBrief,
			}),
			retrieved: packet('Saera harbor marriage pact Balaerys cost', []),
			options: {
				currentFactionId: 'faction_balaerys',
				sceneEntityIds: ['pc_balaerys', 'npc_saera'],
			},
		});

		const findings = evaluatePromptHarness(report, {
			promptIncludes: [
				'GM timeline brief:',
				'Current turn',
				'Due events',
				'Harbor marriage pact matures',
				'Recent events',
				'Scheduled future events',
				'NPC event memory',
				'Appearance: silver-streaked black hair',
				'Personality: controlled; cutting; protective when House Balaerys benefits',
				'Voice: low, precise, and dryly amused',
				'Mannerisms: taps one ring against the table before naming a cost',
			],
			maxTotalBeforeGenerationTokens: 2500,
		});

		expect(failedLabels(findings)).toEqual([]);
	});

	it('labels secret GM timeline context as narrator-only', () => {
		const gmBrief: GmTimelineBrief = {
			storyId: 'story_balaerys',
			currentTurn: 18,
			currentWorldTime: '296 AC, 15th day of the 8th moon, night',
			dueEvents: [
				{
					id: 'event_poison_due',
					type: 'scheme',
					status: 'due',
					title: 'Cupbearer poison attempt ripens',
					body: 'A hidden servant has been paid to poison the rival envoy during the nameday feast.',
					turnsUntilDue: 0,
					worldTime: '296 AC, 15th day of the 8th moon, night',
					npcEntityIds: ['npc_saera'],
					factionIds: ['faction_balaerys'],
					locationIds: ['loc_crimson_spire'],
					visibility: 'secret',
				},
			],
			recentEvents: [
				{
					id: 'event_public_toast',
					type: 'reveal',
					status: 'committed',
					title: 'Public feast toast',
					body: 'The rival envoy praised House Balaerys loudly enough for the room to hear.',
					turnsUntilDue: null,
					worldTime: '296 AC, 15th day of the 8th moon, evening',
					npcEntityIds: ['npc_saera'],
					factionIds: ['faction_balaerys'],
					locationIds: ['loc_crimson_spire'],
					visibility: 'player_known',
				},
			],
			scheduledEvents: [
				{
					id: 'event_secret_ship',
					type: 'faction_move',
					status: 'scheduled',
					title: 'Hidden harbor ship departs',
					body: 'A ship carrying sealed Balaerys letters will leave before sunrise if the pact holds.',
					turnsUntilDue: 3,
					worldTime: '296 AC, 16th day of the 8th moon, dawn',
					npcEntityIds: ['npc_saera'],
					factionIds: ['faction_balaerys'],
					locationIds: ['loc_harbor'],
					visibility: 'secret',
				},
			],
			npcEvents: [
				{
					npcEntityId: 'npc_saera',
					eventIds: ['event_poison_due'],
					summary: 'Saera is tied to the cupbearer plot in narrator-only canon, not public scene knowledge.',
					visibility: 'secret',
				},
			],
		};
		const report = buildPromptHarnessReport({
			name: 'secret-gm-brief-labels',
			playerText: 'I ask Lady Saera why the cupbearer looks afraid.',
			ctx: baseContext({
				entities: [
					entity('loc_crimson_spire', 'location', 'The Crimson Spire', 'The Balaerys manse inside the Black Walls.', { current: true }),
					entity('pc_balaerys', 'character', 'Balaerys Heir', 'The watched young heir of House Balaerys.', { present: true }),
					entity('npc_saera', 'character', 'Lady Saera Balaerys', 'A senior Balaerys matchmaker and court watcher.', { present: true }),
				],
				gmBrief,
			}),
			retrieved: packet('Saera cupbearer poison fear', []),
			options: {
				sceneEntityIds: ['pc_balaerys', 'npc_saera'],
			},
		});

		const findings = evaluatePromptHarness(report, {
			promptIncludes: [
				'Secret timeline items are narrator-only context; present NPCs must not speak or act on them unless actor beliefs or scene evidence supports it.',
				'[secret narrator-only] scheme/due; due now: Cupbearer poison attempt ripens',
				'[secret narrator-only] faction_move/scheduled; due +3t: Hidden harbor ship departs',
				'[secret narrator-only] npc_saera: Saera is tied to the cupbearer plot',
				'reveal/committed; due n/a: Public feast toast',
			],
			maxTotalBeforeGenerationTokens: 2600,
		});

		expect(failedLabels(findings)).toEqual([]);
	});

	it('keeps crowded-scene portrayal detail inside a strict prompt budget', () => {
		const portrayedNpcs = Array.from({ length: 12 }, (_, index) => {
			const ordinal = index + 1;
			return entity(
				`npc_crowded_${ordinal}`,
				'character',
				`Old Blood Guest ${ordinal}`,
				`Guest ${ordinal} watches the room for leverage.`,
				{
					present: true,
					appearance: `NPC ${ordinal} wears layered ceremonial silk, jeweled pins, house-colored cuffs, old scars, scented oil, and a public mask of expensive boredom`,
					personalityDescriptors: [
						`calculating court survivor ${ordinal} with a habit of measuring every silence before answering`,
						`eager to find weakness in House Balaerys without showing open hostility ${ordinal}`,
						`polite when watched and venomous when protected by rank ${ordinal}`,
					],
					voice: `smoothly formal voice ${ordinal}, soft enough to force listeners closer while hiding the insult inside courtesy`,
					mannerisms: [
						`touches a signet before speaking ${ordinal}`,
						`counts allies with a glance before smiling ${ordinal}`,
						`lets the final word hang until the room shifts ${ordinal}`,
					],
				},
			);
		});
		const report = buildPromptHarnessReport({
			name: 'crowded-portrayal-budget',
			playerText: 'I enter the feast and study the crowded Old Blood table.',
			ctx: baseContext({
				entities: [
					entity('loc_crimson_spire', 'location', 'The Crimson Spire', 'The Balaerys manse inside the Black Walls.', { current: true }),
					entity('pc_balaerys', 'character', 'Balaerys Heir', 'The watched young heir of House Balaerys.', { present: true }),
					...portrayedNpcs,
				],
			}),
			retrieved: packet('Old Blood crowded feast portrayal', []),
			options: {
				sceneEntityIds: ['pc_balaerys', ...portrayedNpcs.map((npc) => npc.id)],
				maxFactions: 2,
			},
		});

		const findings = evaluatePromptHarness(report, {
			promptIncludes: [
				'Old Blood Guest 1',
				'Appearance: NPC 1 wears layered ceremonial silk',
				'Personality: calculating court survivor 1',
				'Voice:',
			],
			maxTotalBeforeGenerationTokens: 2200,
		});

		expect(failedLabels(findings)).toEqual([]);
	});

	it('uses old recent source-linked event fallback when no GM brief is loaded', () => {
		const report = buildPromptHarnessReport({
			name: 'recent-event-fallback-without-gm-brief',
			playerText: 'I ask what changed after the harbor envoy arrived.',
			ctx: baseContext({
				events: [
					row({
						id: 'event_harbor_arrival',
						storyId: 'story_balaerys',
						type: 'arrival',
						status: 'committed',
						title: 'Harbor envoy arrives',
						body: 'A harbor envoy entered the Crimson Spire with witnesses and a public marriage offer.',
						actorEntityIds: ['npc_harbor_envoy'],
						targetEntityIds: ['pc_balaerys'],
						locationId: 'loc_crimson_spire',
						locationIds: ['loc_crimson_spire'],
						factionIds: ['faction_harbor'],
						threadIds: [],
						visibility: 'player_known',
						createdTurn: 16,
						occurredTurn: 16,
						scheduledTurn: null,
						worldTime: '296 AC, 15th day of the 8th moon, afternoon',
						memoryImpact: {},
						sourceEntryIds: ['entry_harbor_arrival'],
						sourcePatchIds: [],
						metadata: {},
					}),
				],
				gmBrief: null,
			}),
			retrieved: packet('harbor envoy public offer', []),
		});

		const findings = evaluatePromptHarness(report, {
			promptIncludes: [
				'Recent source-linked events:',
				'Harbor envoy arrives',
				'A harbor envoy entered the Crimson Spire with witnesses and a public marriage offer.',
			],
			promptExcludes: ['GM timeline brief:'],
			maxTotalBeforeGenerationTokens: 2400,
		});

		expect(failedLabels(findings)).toEqual([]);
	});
});
