import { describe, expect, it } from 'vitest';
import type { MemoryNode, RetrievedMemoryPacket } from '$lib/contracts/memory';
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
});
