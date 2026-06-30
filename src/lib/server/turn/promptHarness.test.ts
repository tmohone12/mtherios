import { describe, expect, it } from 'vitest';
import type { GmTimelineBrief, MemoryNode, RetrievedMemoryPacket } from '$lib/contracts/memory';
import type { TurnContext } from './context';
import { buildPromptHarnessReport, evaluatePromptHarness } from './promptHarness';
import { buildStateExtractionPrompt } from './promptPacket';

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
		retrievalTrace: [],
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
		factionProjects: [],
		agreements: [],
		threads: [],
		events: [],
		beliefs: [],
		facts: [],
		patchProposals: [],
		continuityWarnings: [],
		chapters: [],
		arcs: [],
		sagas: [],
		gmBrief: null,
		...overrides,
	} as unknown as TurnContext;
}

function failedLabels(findings: ReturnType<typeof evaluatePromptHarness>): string[] {
	return findings.filter((finding) => !finding.passed).map((finding) => `${finding.label}: ${finding.detail}`);
}

describe('turn prompt harness', () => {
	it('tells state extraction to preserve unknown characters as reviewable references', () => {
		const prompt = buildStateExtractionPrompt(
			'I listen for the name whispered in the crowd.',
			'Someone mutters Ser Olyvar, but no one by that name is present or identified.',
		);

		expect(prompt).toContain('Do not create new character canon from narration extraction.');
		expect(prompt).toContain('Use characters only for established canonical characters already present in context');
		expect(prompt).toContain('appearance, background, currentLocation, currentAction, emotionalState, goals, speechStyle, eventMemory.did/saw/knew/knows');
		expect(prompt).toContain('leave new names as reviewable references');
		expect(prompt).toContain('timeline_events, agreements, faction known_members, conversations, or relationships');
	});

	it('builds a Balaerys nameday prompt with retrieved temporal memory', () => {
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
			systemIncludes: [
				'server-side GM narrator',
				'hybrid POV',
				'Time HH:MM',
				'Do not append ending choices',
				'not a writing assistant',
				'1 Volantene honor = 1 gold dragon',
				'great houses count wealth in millions of gold dragons',
				'Iron Bank lending scale reaches roughly 83 million honors',
				'200+ ships',
				'D&D-style d20 checks',
				'Bayesian social prior',
				'ROLEPLAY AUTHORITY',
				'LIVING FEUDAL GM DOCTRINE',
				'three consequence clocks',
				'War is logistics before glory',
				'Aegon/Aurion Targaryen-Belaerys is a dynastic weapon',
				'296 AC',
				'15th day of the 8th moon',
			],
			promptIncludes: [
				'The Crimson Spire',
				'Balaerys Heir',
				'House Balaerys',
				'Retrieved temporal/canonical memory:',
				'Old Blood Etiquette',
				'Volantene Household Hierarchy',
			],
			maxOccurrences: {
				'Balaerys Heir': 3,
			},
			maxMessageCount: 24,
			maxTotalBeforeGenerationTokens: 3600,
		});

		expect(failedLabels(findings)).toEqual([]);
		expect(report.system).not.toContain('skilled fiction writer');
		expect(report.system).not.toContain("author's directions");
		expect(report.prompt).toContain('Retrieved temporal/canonical memory:');
		expect(report.prompt).toContain('Old Blood Etiquette');
		expect(report.prompt).toContain('Volantene Household Hierarchy');
		expect(report.retrievedMemoryIds).toEqual(['mem_old_blood', 'mem_household']);
		});

	it('teaches the narrator the parallel write secondary-arc command', () => {
		const report = buildPromptHarnessReport({
			name: 'parallel-write-secondary-arc-command',
			playerText: 'Parallel write for this character: Xanda',
			ctx: baseContext({
				recentEntries: [
					row({
						id: 'entry_turn_one',
						storyId: 'story_balaerys',
						type: 'user_action',
						content: 'I refuse the envoy until the house ledgers are opened.',
						position: 20,
						parentId: null,
						branchId: null,
						metadata: {},
					}),
					row({
						id: 'narration_turn_one',
						storyId: 'story_balaerys',
						type: 'narration',
						content: 'The envoy stiffens while the ledgers are brought into the hall.',
						position: 21,
						parentId: 'entry_turn_one',
						branchId: null,
						metadata: {},
					}),
					row({
						id: 'entry_turn_two',
						storyId: 'story_balaerys',
						type: 'user_action',
						content: 'I send a quiet servant to watch the east arcade.',
						position: 22,
						parentId: null,
						branchId: null,
						metadata: {},
					}),
					row({
						id: 'narration_turn_two',
						storyId: 'story_balaerys',
						type: 'narration',
						content: 'The servant vanishes into red shadow as footsteps gather beyond the lattice.',
						position: 23,
						parentId: 'entry_turn_two',
						branchId: null,
						metadata: {},
					}),
				],
				entities: [
					entity('loc_yin', 'location', 'Yin', 'The imperial city of Yi Ti.', { current: true }),
					entity('pc_aurion', 'character', 'Aurion Balaerys', 'The player-centered primary arc character.', {
						present: true,
						relationship: { status: 'self', level: 100 },
					}),
					entity('npc_xanda', 'character', 'Xanda', 'A courtier moving through a parallel web of private tests.', {
						present: false,
						currentLocation: 'east arcade',
						goals: ['learn who controls the ledgers before Aurion does'],
					}),
				],
			}),
			retrieved: packet('Parallel write for this character: Xanda', []),
			options: {
				sceneEntityIds: ['pc_aurion'],
			},
		});

		expect(report.prompt).toContain('PARALLEL WRITE COMMAND');
		expect(report.prompt).toContain('secondary arc');
		expect(report.prompt).toContain('primary arc');
		expect(report.prompt).toContain('last two primary turns');
		expect(report.prompt).toContain('possible connecting point');
		expect(report.prompt).toContain('Character npc_xanda / Xanda');
		expect(report.prompt).toContain('learn who controls the ledgers before Aurion does');
		expect(report.messages.map((message) => message.content).join('\n')).toContain('The servant vanishes into red shadow');
	});

	it('exposes stable and dynamic prompt sections for cache inspection', () => {
		const oldBlood = memoryNode('mem_old_blood', 'Old Blood Etiquette', 'Invitations and seating are political weapons.');
		const report = buildPromptHarnessReport({
			name: 'prompt-section-manifest',
			playerText: 'I watch who arrives first for my nameday.',
			ctx: baseContext(),
			retrieved: packet('nameday arrivals House Balaerys Black Walls etiquette', [oldBlood]),
			options: {
				currentFactionId: 'faction_balaerys',
				sceneEntityIds: ['pc_balaerys', 'npc_vaelar'],
			},
		});

		expect(report.compiledPrompt.stablePrefix.map((section) => section.id)).toEqual(['prompt_system']);
		expect(report.compiledPrompt.dynamicTail.map((section) => section.id)).toEqual([
			'turn_context',
			'recent_dialogue',
		]);
		expect(report.compiledPrompt.manifest.included).toContain('prompt_system');
		expect(report.compiledPrompt.manifest.stableTokens).toBeGreaterThan(0);
		expect(report.compiledPrompt.manifest.dynamicTokens).toBeGreaterThan(0);
		expect(report.promptSectionTrace.map(({ id, lane, priority }) => ({ id, lane, priority }))).toEqual([
			{ id: 'prompt_system', lane: 'engine_static', priority: 100 },
			{ id: 'turn_context', lane: 'turn_dynamic', priority: 90 },
			{ id: 'recent_dialogue', lane: 'turn_dynamic', priority: 80 },
		]);
		for (const section of report.promptSectionTrace) {
			expect(section.contentHash).toMatch(/^[a-f0-9]{64}$/);
			expect(section.charCount).toBeGreaterThan(0);
			expect(section.tokenEstimate).toBeGreaterThan(0);
			expect(section.sourceIdCount).toBe(section.sourceIds.length);
			expect(section).not.toHaveProperty('content');
		}
		expect(report.promptSectionTrace.find((section) => section.id === 'prompt_system')?.sourceIds).toEqual(['story_balaerys']);
		expect(report.promptSectionTrace.find((section) => section.id === 'turn_context')?.sourceIds).toEqual(['story_balaerys', 'mem_old_blood']);
		expect(report.promptSectionTrace.find((section) => section.id === 'recent_dialogue')?.sourceIds).toEqual(['recent_message_0', 'recent_message_1']);
	});

	it('injects terminal wiki context into the narration prompt', () => {
		const report = buildPromptHarnessReport({
			name: 'wiki-context-not-injected',
			playerText: 'I ask what the old vault says.',
			ctx: baseContext(),
			options: {
				sceneEntityIds: ['pc_balaerys'],
				wikiContextMarkdown: 'Vault-only wiki detail that should stay in search/debug surfaces.',
			},
		});

		expect(report.prompt).toContain('Terminal wiki context');
		expect(report.prompt).toContain('Vault-only wiki detail');
		expect(report.promptSectionTrace.find((section) => section.id === 'turn_context')?.sourceIds).toContain('terminal_wiki_context');
	});

	it('recognizes relationship.status player_character as the protagonist', () => {
		const report = buildPromptHarnessReport({
			name: 'player-character-relationship-status',
			playerText: 'I study the tavern before speaking.',
			ctx: baseContext({
				recentEntries: [
					row({
						id: 'entry_walano',
						storyId: 'story_balaerys',
						type: 'user_action',
						content: 'I study the tavern before speaking.',
						position: 10,
						parentId: null,
						branchId: null,
						metadata: {},
					}),
					row({
						id: 'narration_walano',
						storyId: 'story_balaerys',
						type: 'narration',
						content: '[ Time 10:44 | Day 3, Second Moon, 299 AC | Location - Summer Isles, Walano, the Golden Parrot tavern | Weather hot ]',
						position: 11,
						parentId: 'entry_walano',
						branchId: null,
						metadata: {},
					}),
				],
				entities: [
					entity('pc_aurion', 'character', 'Aurion Balaerys', 'The dragon-blooded player character.', {
						present: true,
						relationship: { status: 'player_character', level: 100 },
						currentDisposition: 'self',
					}),
					entity('npc_zhen', 'character', 'Vermillion Zhen Lian', 'The Empress of Yi Ti.', {
						present: true,
						currentLocation: 'Yi Ti, Yin',
					}),
				],
			}),
			retrieved: packet('Walano Golden Parrot', []),
			options: {},
		});

		expect(report.prompt).toContain('Player character:');
		expect(report.prompt).toContain('- Name: Aurion Balaerys');
		expect(report.prompt).toContain('- character: Aurion Balaerys');
		expect(report.prompt).not.toContain('- character: Vermillion Zhen Lian');
	});

	it('spends detailed character block slots on NPCs when the protagonist already has a player card', () => {
		const report = buildPromptHarnessReport({
			name: 'npc-character-block-slots',
			playerText: 'I watch both courtiers before speaking.',
			ctx: baseContext({
				entities: [
					entity('loc_crimson_spire', 'location', 'The Crimson Spire', 'The Balaerys manse inside the Black Walls.', { current: true }),
					entity('pc_balaerys', 'character', 'Balaerys Heir', 'The watched young heir of House Balaerys.', {
						present: true,
						relationship: { status: 'self', level: 100 },
					}),
					entity('npc_saera', 'character', 'Lady Saera Balaerys', 'A senior Balaerys matchmaker.', {
						present: true,
						currentAction: 'testing the harbor terms',
					}),
					entity('npc_vaelar', 'character', 'Triarch Vaelar Balaerys', 'The senior public face of House Balaerys.', {
						present: true,
						currentAction: 'watching the family benches for weakness',
					}),
				],
			}),
			retrieved: packet('Saera Vaelar Balaerys court', []),
			options: {
				sceneEntityIds: ['pc_balaerys', 'npc_saera', 'npc_vaelar'],
			},
		});

		const findings = evaluatePromptHarness(report, {
			promptIncludes: [
				'Player character:',
				'Character npc_saera / Lady Saera Balaerys',
				'Character npc_vaelar / Triarch Vaelar Balaerys',
				'action: testing the harbor terms',
				'action: watching the family benches for weakness',
			],
			promptExcludes: ['Character pc_balaerys / Balaerys Heir'],
			maxTotalBeforeGenerationTokens: 2600,
		});

		expect(failedLabels(findings)).toEqual([]);
	});

	it('keeps long-campaign continuity visible without duplicating chapters already covered by arcs', () => {
		const longChapterOutcome = 'Chapter 3 outcome: Vaelar exposed the same purple-sealed letter once and only once, proving the harbor bribe came from House Vhassar before the nameday feast.';
		const report = buildPromptHarnessReport({
			name: 'long-campaign-continuity',
			playerText: 'I ask Vaelar why everyone keeps circling back to the letter.',
			ctx: baseContext({
				recentEntries: Array.from({ length: 70 }, (_, index) => row({
					id: `entry_${index}`,
					storyId: 'story_balaerys',
					type: index % 2 === 0 ? 'user_action' : 'narration',
					content: `Conversation beat ${index}: the letter was discussed without repeating the discovery scene.`,
					position: index,
					parentId: index > 0 ? `entry_${index - 1}` : null,
					branchId: null,
					metadata: {},
				})),
				chapters: [
					row({
						id: 'chapter_3',
						storyId: 'story_balaerys',
						number: 3,
						title: 'The Purple Seal',
						sceneOutcome: longChapterOutcome,
						irreversibleChanges: ['The purple-sealed letter is known to Vaelar and the heir.'],
						npcKnowledgeChanges: [{ npc: 'Vaelar', learned: 'Vhassar funded the harbor bribe.' }],
						promisesDebtsOaths: ['Vaelar promised not to repeat the discovery scene unless new evidence appears.'],
						discoveredClues: ['Purple wax from House Vhassar.'],
						relationshipChanges: [],
						factionChanges: ['House Vhassar is implicated in harbor bribery.'],
						openThreads: ['Who delivered the letter?'],
						sourceEntryIds: [],
						sourceEventIds: [],
						metadata: {},
					}),
				],
				arcs: [
					row({
						id: 'arc_1',
						storyId: 'story_balaerys',
						number: 1,
						title: 'Harbor Bribe',
						summary: 'The harbor bribe arc already established House Vhassar as the likely patron; do not rediscover this as if new.',
						chapterIds: ['chapter_3'],
						sourceEventIds: [],
						openThreadIds: ['thread_letter_courier'],
						metadata: {},
					}),
				],
				sagas: [
					row({
						id: 'saga_1',
						storyId: 'story_balaerys',
						number: 1,
						title: 'Old Blood Pressure',
						summary: 'The first saga is about Old Blood houses using documents, debt, and marriage pressure rather than repeating first discoveries.',
						arcIds: ['arc_1'],
						keyFactionShifts: ['House Vhassar became a covert antagonist.'],
						majorPowerChanges: ['Balaerys gained leverage over harbor accounts.'],
						lingeringThreads: ['The courier remains unidentified.'],
						overallTone: 'paranoid court politics',
						sourceEventIds: [],
						openThreadIds: ['thread_letter_courier'],
						metadata: {},
					}),
				],
			}),
			retrieved: packet('letter Vaelar Vhassar harbor bribe', []),
			options: {
				currentFactionId: 'faction_balaerys',
				sceneEntityIds: ['pc_balaerys', 'npc_vaelar'],
			},
		});

		expect(report.messages).toHaveLength(60);
		expect(report.prompt).toContain('Saga memory');
		expect(report.prompt).toContain('Arc memory');
		expect(report.prompt).toContain('do not rediscover this as if new');
		expect(report.prompt).not.toContain('Chapter memory');
		expect(report.prompt).not.toContain(longChapterOutcome);
	});

	it('budgets uncovered chapter memory by size instead of always sending eight chapters', () => {
		const report = buildPromptHarnessReport({
			name: 'chapter-memory-budget',
			playerText: 'I ask what the latest chapter changed.',
			ctx: baseContext({
				chapters: Array.from({ length: 12 }, (_, index) => row({
					id: `chapter_${index + 1}`,
					storyId: 'story_balaerys',
					number: index + 1,
					title: `Budget Chapter ${index + 1}`,
					sceneOutcome: `Chapter ${index + 1} sentinel. ${'large continuity detail '.repeat(120)}`,
					irreversibleChanges: [],
					npcKnowledgeChanges: [],
					promisesDebtsOaths: [],
					discoveredClues: [],
					relationshipChanges: [],
					factionChanges: [],
					openThreads: [],
					sourceEntryIds: [],
					sourceEventIds: [],
					metadata: {},
				})),
				arcs: [],
				sagas: [],
			}),
			retrieved: packet('latest chapter', []),
		});

		expect(report.prompt).toContain('Chapter 12 sentinel');
		expect(report.prompt).not.toContain('Chapter 5 sentinel');
	});

	it('renders uncovered checkpoint chapters as readable chapter memory', () => {
		const report = buildPromptHarnessReport({
			name: 'checkpoint-chapter-memory-cleanup',
			playerText: 'I ask what Arlan remembers about the gate.',
			ctx: baseContext({
				chapters: [
					row({
						id: 'chapter_checkpoint',
						storyId: 'story_balaerys',
						number: 9,
						title: 'The Gate Promise',
						sceneOutcome: [
							'[CHECKPOINT = Chapter checkpoint covering transcript positions 1-40.]',
							'[SOURCE COVERAGE =',
							'- 40 entries covered.',
							']',
							'[RECENT STORY STATE =',
							'- Arlan admits he promised to open the postern gate before dawn.',
							']',
							'[CHARACTER STATE =',
							'Arlan [npc_arlan]:',
							'- Frightened, cornered, and still bound by the gate promise.',
							']',
							'[ACTIVE THREADS =',
							'- Whether Arlan keeps the gate promise.',
							']',
						].join('\n'),
						irreversibleChanges: [],
						npcKnowledgeChanges: [],
						promisesDebtsOaths: [],
						discoveredClues: [],
						relationshipChanges: [],
						factionChanges: [],
						openThreads: [],
						sourceEntryIds: [],
						sourceEventIds: [],
						metadata: {},
					}),
				],
				arcs: [],
				sagas: [],
			}),
			retrieved: packet('Arlan gate promise', []),
		});

		expect(report.prompt).toContain('Chapter memory');
		expect(report.prompt).toContain('Arlan admits he promised to open the postern gate before dawn.');
		expect(report.prompt).toContain('Characters: Arlan [npc_arlan]:');
		expect(report.prompt).not.toContain('[CHECKPOINT');
		expect(report.prompt).not.toContain('SOURCE COVERAGE');
	});

	it('uses arc summaries without expanding covered chapter summaries', () => {
		const longOutcome = [
			'Aurion reached Yin under heat, incense, trade-gold, and foreign perfume.',
			'Ser Davos and Malyrio stayed watchful while the Copper Court pressed around them.',
			'Xanda sent a lapis-sealed dinner invitation and turned the evening into a test of courtly danger.',
			'Prompt arc sentinel: Aurion joked about poison, ate the honeyed locusts anyway, and left the dinner balanced between attraction, manipulation, and politics.',
		].join(' ');
		const report = buildPromptHarnessReport({
			name: 'arc-chapter-expansion',
			playerText: 'I ask what the Eastern Rise arc already covered.',
			ctx: baseContext({
				chapters: [
					row({
						id: 'chapter_yin_arrival',
						storyId: 'story_balaerys',
						number: 7,
						title: 'Arrival in Yin',
						sceneOutcome: longOutcome,
						irreversibleChanges: [],
						npcKnowledgeChanges: [],
						promisesDebtsOaths: [],
						discoveredClues: [],
						relationshipChanges: [],
						factionChanges: [],
						openThreads: [],
						sourceEntryIds: [],
						sourceEventIds: [],
						metadata: {},
					}),
					row({
						id: 'chapter_xanda_dinner',
						storyId: 'story_balaerys',
						number: 8,
						title: 'Xanda at Dinner',
						sceneOutcome: 'Aurion met Xanda, joked about poison, and ate the honeyed locusts anyway.',
						irreversibleChanges: [],
						npcKnowledgeChanges: [],
						promisesDebtsOaths: [],
						discoveredClues: [],
						relationshipChanges: [],
						factionChanges: [],
						openThreads: [],
						sourceEntryIds: [],
						sourceEventIds: [],
						metadata: {},
					}),
				],
				arcs: [
					row({
						id: 'arc_eastern_rise',
						storyId: 'story_balaerys',
						number: 2,
						title: 'Eastern Rise',
						summary: 'Aurion begins making a name in Yi Ti.',
						chapterIds: ['chapter_yin_arrival', 'chapter_xanda_dinner'],
						sourceEventIds: [],
						openThreadIds: [],
						metadata: {},
					}),
				],
			}),
			retrieved: packet('Eastern Rise Aurion Xanda', []),
		});

		expect(report.prompt).toContain('Arc memory');
		expect(report.prompt).toContain('summary: Aurion begins making a name in Yi Ti.');
		expect(report.prompt).not.toContain('chapters:');
		expect(report.prompt).not.toContain('Chapter 7: Arrival in Yin - Aurion reached Yin');
		expect(report.prompt).not.toContain('Prompt arc sentinel: Aurion joked about poison');
		expect(report.prompt).not.toContain('Chapter 8: Xanda at Dinner - Aurion met Xanda');
	});

	it('caps oversized arc summaries before adding them to the narration prompt', () => {
		const report = buildPromptHarnessReport({
			name: 'oversized-arc-summary',
			playerText: 'Continue from the arc.',
			ctx: baseContext({
				arcs: [
					row({
						id: 'arc_oversized',
						storyId: 'story_balaerys',
						number: 3,
						title: 'Oversized Arc',
						summary: `Arc opening fact survives. ${'raw chapter wall '.repeat(5000)} Arc prompt tail sentinel.`,
						chapterIds: [],
						sourceEventIds: [],
						openThreadIds: [`thread start ${'thread filler '.repeat(2000)} thread tail sentinel`],
						metadata: {},
					}),
				],
			}),
			retrieved: packet('oversized arc', []),
		});

		expect(report.prompt).toContain('Arc memory');
		expect(report.prompt).toContain('Arc opening fact survives.');
		expect(report.prompt).not.toContain('Arc prompt tail sentinel');
		expect(report.prompt).not.toContain('thread tail sentinel');
	});

	it('budgets rendered arc memory while still hiding chapters covered by older arcs', () => {
		const arcs = Array.from({ length: 9 }, (_, index) => row({
			id: `arc_${index + 1}`,
			storyId: 'story_balaerys',
			number: index + 1,
			title: `Arc ${index + 1}`,
			summary: `Arc ${index + 1} summary sentinel. ${'large arc detail '.repeat(180)}`,
			chapterIds: index === 0 ? ['chapter_1'] : [],
			sourceEventIds: [],
			openThreadIds: [],
			metadata: {},
		}));
		const report = buildPromptHarnessReport({
			name: 'arc-count-cap-covered-chapters',
			playerText: 'Continue with compact memory.',
			ctx: baseContext({
				chapters: [
					row({
						id: 'chapter_1',
						storyId: 'story_balaerys',
						number: 1,
						title: 'Covered Old Chapter',
						sceneOutcome: 'Covered chapter sentinel should not render.',
						irreversibleChanges: [],
						npcKnowledgeChanges: [],
						promisesDebtsOaths: [],
						discoveredClues: [],
						relationshipChanges: [],
						factionChanges: [],
						openThreads: [],
						sourceEntryIds: [],
						sourceEventIds: [],
						metadata: {},
					}),
				],
				arcs,
			}),
			retrieved: packet('compact memory', []),
		});

		expect(report.prompt).not.toContain('Arc 1 summary sentinel.');
		expect(report.prompt).not.toContain('Arc 5 summary sentinel.');
		expect(report.prompt).toContain('Arc 9 summary sentinel.');
		expect(report.prompt).not.toContain('Covered chapter sentinel should not render.');
	});

	it('keeps the tail of long narration messages so continue prompts do not restart', () => {
		const longNarration = [
			'Opening sentinel: Arianne begins in the Tower of the Sun.',
			'Arianne reads reports about Volantis and the rumor grows across Dorne. '.repeat(150),
			'Ending sentinel: Doran reaches for the old dragon-sealed letter and the scene must continue from here.',
		].join('\n\n');
		const report = buildPromptHarnessReport({
			name: 'long-narration-tail',
			playerText: 'Continue from where you left off.',
			ctx: baseContext({
				recentEntries: [
					row({
						id: 'entry_arianne_intro',
						storyId: 'story_balaerys',
						type: 'user_action',
						content: 'Introduce Arianne and leave a hook.',
						position: 10,
						parentId: null,
						branchId: null,
						metadata: {},
					}),
					row({
						id: 'narration_arianne_intro',
						storyId: 'story_balaerys',
						type: 'narration',
						content: longNarration,
						position: 11,
						parentId: 'entry_arianne_intro',
						branchId: null,
						metadata: {},
					}),
				],
			}),
			retrieved: packet('continue Arianne Doran letter', []),
		});

		const previousNarration = report.messages.find((message) => message.role === 'assistant')?.content ?? '';
		expect(previousNarration).toContain('Opening sentinel');
		expect(previousNarration).toContain('Ending sentinel');
		expect(previousNarration.length).toBeLessThanOrEqual(6000);
	});

	it('keeps long player character descriptions visible in the server prompt', () => {
		const longDescription = [
			'Aegon Targaryen, hidden as Aurion Balaerys, was not merely fostered by House Balaerys.',
			'After the death of their trueborn infant heir, the surviving elders performed a forbidden cradle rite that made his public identity both a shield and a trap.',
			'He carries the cadence of Volantene tutors, the training scars of courtyard masters, and the private terror of a boy taught that his name could burn cities before he understood crowns.',
			'His court mask is controlled, bright, and dangerous; underneath it sits a survivor who has learned to count every favor as a future blade.',
			'The long-description sentinel: remembers Elia, Tywin, blood magic, Volantene debt, and the lie of the Second Cradle.',
		].join(' ');
		const report = buildPromptHarnessReport({
			name: 'long-player-character-description',
			playerText: 'I listen from the balcony before answering the envoy.',
			ctx: baseContext({
				entities: [
					entity('loc_crimson_spire', 'location', 'The Crimson Spire', 'The Balaerys manse inside the Black Walls.', { current: true }),
					entity('pc_aurion', 'character', 'Aurion Balaerys', longDescription, {
						present: true,
						aliases: ['Aegon Targaryen', 'Golden Dragon'],
						appearance: 'silver-gold hair and a controlled court mask',
						background: 'raised as Aurion Balaerys while hidden Targaryen blood made him a dynastic weapon',
						currentAction: 'weighing the envoy from the balcony',
						goals: ['survive the nameday politics without revealing his bloodline'],
						speechStyle: 'bright, careful, and dangerous when pressed',
						factionTags: ['Hidden Dragon Claim'],
						eventMemory: {
							did: ['accepted exile to Yi Ti rather than fracture House Balaerys'],
							knows: ['his public name and true bloodline are both political weapons'],
						},
						relationship: { status: 'self', level: 100 },
					}),
				],
				factionMemberships: [
					row({
						id: 'membership_pc_aurion_balaerys',
						storyId: 'story_balaerys',
						factionId: 'faction_balaerys',
						entityId: 'pc_aurion',
						role: 'hidden heir',
						rank: 'family',
						status: 'active',
						visibility: 'player_known',
						metadata: {},
						sourceEntryIds: [],
						sourceEventIds: [],
						sourcePatchIds: [],
					}),
				],
			}),
			retrieved: packet('Aurion identity envoy balcony', []),
			options: {
				sceneEntityIds: ['pc_aurion'],
			},
		});

		expect(report.prompt).toContain('The long-description sentinel');
		expect(report.prompt).toContain('Player character:');
		expect(report.prompt).toContain('[Appearance]: silver-gold hair and a controlled court mask');
		expect(report.prompt).toContain('[Personality]: .');
		expect(report.prompt).toContain('[Key History]: present in the current scene; action: weighing the envoy from the balcony');
		expect(report.prompt).toContain('did: accepted exile to Yi Ti rather than fracture House Balaerys');
		expect(report.prompt).toContain('[Affiliations]: House Balaerys (role=hidden heir; rank=family; status=active); Hidden Dragon Claim');
		expect(report.prompt).toContain('[bio]: Aegon Targaryen, hidden as Aurion Balaerys');
		expect(report.prompt).not.toContain('Aliases:');
		expect(report.prompt).not.toContain('Background:');
		expect(report.prompt).not.toContain('Current state:');
		expect(report.prompt).not.toContain('Goals:');
		expect(report.prompt).not.toContain('Speech style:');
		expect(report.prompt).not.toContain('NPC event memory:');
	});

	it('renders editable character templates with factions and event memory', () => {
		const report = buildPromptHarnessReport({
			name: 'character-canon-template-block',
			playerText: 'I watch Xanda across the table and choose my words carefully.',
			ctx: baseContext({
				entities: [
					entity('loc_yin', 'location', 'Yin', 'The imperial city of Yi Ti.', { current: true }),
					entity('npc_aurion', 'character', 'Aurion Balaerys', 'A young exile trying to rise in Yi Ti.', {
						present: true,
						appearance: 'silver-gold hair tied back from a heat-flushed face',
						background: 'sent east by House Balaerys to earn a name',
						aliases: ['Golden Dragon'],
						goals: ['survive courtly YiTish politics', 'win influence without losing himself'],
						speechStyle: 'blunt, youthful, honest under pressure',
						factionTags: ['Balaerys Trading Post'],
						eventMemory: {
							did: ['ate the honeyed locusts after joking they might be poisoned'],
							saw: ['Xanda laughed instead of taking offense'],
							knew: ['his family sent him away and the wound still bites'],
						},
						promptTemplate: [
							'Character {{id}} / {{name}}',
							'Appearance: {{appearance}}',
							'Background: {{background}}',
							'Goals:',
							'{{goals}}',
							'Speech style: {{speechStyle}}',
							'Factions:',
							'{{factions}}',
							'NPC event memory:',
							'{{eventMemory}}',
						].join('\n'),
					}),
				],
				factions: [
					faction('faction_vermillion_court', 'Vermillion Court'),
				],
				factionMemberships: [
					row({
						id: 'membership_aurion_court',
						storyId: 'story_balaerys',
						factionId: 'faction_vermillion_court',
						entityId: 'npc_aurion',
						role: 'consort',
						rank: 'imperial household',
						status: 'active',
						visibility: 'player_known',
						metadata: {},
						sourceEntryIds: [],
						sourceEventIds: [],
						sourcePatchIds: [],
					}),
				],
			}),
			retrieved: packet('Aurion Xanda Yi Ti locusts consort', []),
			options: {
				sceneEntityIds: ['npc_aurion'],
			},
		});

		expect(report.prompt).toContain('Character canon blocks:');
		expect(report.prompt).toContain('Character npc_aurion / Aurion Balaerys');
		expect(report.prompt).toContain('- Golden Dragon');
		expect(report.prompt).toContain('Appearance: silver-gold hair tied back');
		expect(report.prompt).toContain('- survive courtly YiTish politics');
		expect(report.prompt).toContain('Speech style: blunt, youthful, honest under pressure');
		expect(report.prompt).toContain('- Vermillion Court (role=consort; rank=imperial household; status=active)');
		expect(report.prompt).toContain('- Balaerys Trading Post');
		expect(report.prompt).toContain('- did: ate the honeyed locusts');
		expect(report.prompt).not.toContain('{{appearance}}');
	});

	it('uses newest character event memory in prompt cards', () => {
		const report = buildPromptHarnessReport({
			name: 'newest-character-event-memory',
			playerText: 'I watch Xanda for what she remembers from the dinner.',
			ctx: baseContext({
				entities: [
					entity('loc_yin', 'location', 'Yin', 'The imperial city of Yi Ti.', { current: true }),
					entity('npc_xanda', 'character', 'Xanda', 'A pureborn YiTish courtier testing Aurion.', {
						present: true,
						eventMemory: {
							did: [
								'old checkpoint 1',
								'old checkpoint 2',
								'old checkpoint 3',
								'old checkpoint 4',
								'old checkpoint 5',
								'freshly challenged Aurion over the honeyed locusts',
							],
							saw: ['freshly saw Aurion eat despite the warning'],
							knows: ['freshly knows his exile wound still bites'],
						},
					}),
				],
			}),
			retrieved: packet('Xanda dinner memory', []),
			options: {
				sceneEntityIds: ['npc_xanda'],
			},
		});

		expect(report.prompt).toContain('did: freshly challenged Aurion over the honeyed locusts');
		expect(report.prompt).toContain('saw: freshly saw Aurion eat despite the warning');
		expect(report.prompt).toContain('knows: freshly knows his exile wound still bites');
		expect(report.prompt).not.toContain('old checkpoint 1');
		expect(report.prompt).not.toContain('old checkpoint 2');
	});

	it('uses metadata character event memory in prompt cards', () => {
		const report = buildPromptHarnessReport({
			name: 'metadata-character-event-memory',
			playerText: 'I ask Mira what the ledger proved.',
			ctx: baseContext({
				entities: [
					entity('loc_yin', 'location', 'Yin', 'The imperial city of Yi Ti.', { current: true }),
					row({
						id: 'npc_mira',
						storyId: 'story_balaerys',
						type: 'character',
						name: 'Mira of the Harbor',
						description: 'A broker who survived the harbor coup.',
						status: 'active',
						visibility: 'player_known',
						state: { present: true },
						metadata: {
							eventMemory: {
								knows: ['Mira knows the ledger names Zhen.'],
							},
						},
						sourceEntryIds: [],
						sourceEventIds: [],
						sourcePatchIds: [],
					}),
				],
			}),
			retrieved: packet('Mira ledger memory', []),
			options: {
				sceneEntityIds: ['npc_mira'],
			},
		});

		expect(report.prompt).toContain('knows: Mira knows the ledger names Zhen.');
	});

	it('uses metadata character current state in prompt cards', () => {
		const report = buildPromptHarnessReport({
			name: 'metadata-character-current-state',
			playerText: 'I look to Mira before the guards arrive.',
			ctx: baseContext({
				entities: [
					entity('loc_yin', 'location', 'Yin', 'The imperial city of Yi Ti.', { current: true }),
					row({
						id: 'npc_mira',
						storyId: 'story_balaerys',
						type: 'character',
						name: 'Mira of the Harbor',
						description: 'A broker who survived the harbor coup.',
						status: 'active',
						visibility: 'player_known',
						state: { present: true, goals: ['protect Aurion'] },
						metadata: {
							status: 'wanted by the guard captain',
							currentAction: 'guarding the ledger room',
							emotionalState: 'controlled fear under court composure',
							relationship: { status: 'reluctant ally', level: 62 },
							goals: ['expose the harbor witness'],
							pressures: ['the guard captain is searching for the ledger'],
						},
						sourceEntryIds: [],
						sourceEventIds: [],
						sourcePatchIds: [],
					}),
				],
			}),
			retrieved: packet('Mira ledger room current state', []),
			options: {
				sceneEntityIds: ['npc_mira'],
			},
		});

		expect(report.prompt).toContain('status: wanted by the guard captain');
		expect(report.prompt).toContain('action: guarding the ledger room');
		expect(report.prompt).toContain('emotional state: controlled fear under court composure');
		expect(report.prompt).toContain('relationship: reluctant ally, level 62');
		expect(report.prompt).toContain('protect Aurion');
		expect(report.prompt).toContain('expose the harbor witness');
		expect(report.prompt).toContain('pressure: the guard captain is searching for the ledger');
	});

	it('keeps default character cards to the compact lore fields without alias clutter', () => {
		const report = buildPromptHarnessReport({
			name: 'character-card-aliases',
			playerText: 'I ask whether the Golden Dragon is the same man as Aurion.',
			ctx: baseContext({
				entities: [
					entity('loc_yin', 'location', 'Yin', 'The imperial city of Yi Ti.', { current: true }),
					entity('npc_aurion', 'character', 'Aurion Balaerys', 'A young exile trying to rise in Yi Ti.', {
						present: true,
						aliases: ['Golden Dragon', 'Aegon Targaryen'],
					}),
				],
			}),
			retrieved: packet('Golden Dragon Aurion identity', []),
			options: {
				sceneEntityIds: ['npc_aurion'],
			},
		});

		expect(report.prompt).toContain('[bio]: A young exile trying to rise in Yi Ti.');
		expect(report.prompt).not.toContain('Aliases:');
		expect(report.prompt).not.toContain('- Golden Dragon');
		expect(report.prompt).not.toContain('- Aegon Targaryen');
	});

	it('includes exact query-named character cards even when the character is not present', () => {
		const report = buildPromptHarnessReport({
			name: 'query-named-non-present-character-card',
			playerText: 'I ask what Xanda would remember from the dinner.',
			ctx: baseContext({
				entities: [
					entity('loc_yin', 'location', 'Yin', 'The imperial city of Yi Ti.', { current: true }),
					entity('pc_aurion', 'character', 'Aurion Balaerys', 'The exiled young dragon.', {
						present: true,
						relationship: { status: 'self', level: 100 },
					}),
					entity('npc_attendant', 'character', 'Court Attendant', 'A present servant arranging tea.', { present: true }),
					entity('npc_xanda', 'character', 'Xanda', 'A pureborn YiTish courtier testing Aurion.', {
						present: false,
						currentLocation: 'Copper Court apartments',
						eventMemory: {
							knows: ['Aurion ate the honeyed locusts despite the warning'],
						},
					}),
				],
			}),
			retrieved: packet('Xanda dinner memory', []),
			options: {
				sceneEntityIds: ['pc_aurion'],
			},
		});

		expect(report.prompt).toContain('Character npc_xanda / Xanda');
		expect(report.prompt).toContain('not currently visible');
		expect(report.prompt).toContain('knows: Aurion ate the honeyed locusts despite the warning');
	});

	it('keeps inactive merged character rows out of prompt entity surfaces', () => {
		const mergedConsort = entity('entity_consort', 'character', 'Consort', 'A mistaken title-only character row.', { present: true });
		mergedConsort.status = 'inactive';
		mergedConsort.metadata = { mergedInto: 'npc_aurion' };
		const report = buildPromptHarnessReport({
			name: 'inactive-merged-character-filter',
			playerText: 'I continue with Zhen beside me.',
			ctx: baseContext({
				entities: [
					entity('loc_yin', 'location', 'Yin', 'The imperial city of Yi Ti.', { current: true }),
					entity('npc_aurion', 'character', 'Aurion Balaerys', 'A young exile trying to rise in Yi Ti.', { present: true }),
					mergedConsort,
				],
			}),
			retrieved: packet('Aurion Consort', []),
			options: {
				sceneEntityIds: ['npc_aurion', 'entity_consort'],
			},
		});

		expect(report.prompt).toContain('Character npc_aurion / Aurion Balaerys');
		expect(report.prompt).toContain('- character: Aurion Balaerys');
		expect(report.prompt).not.toContain('Character entity_consort / Consort');
		expect(report.prompt).not.toContain('- character: Consort');
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
			maxTotalBeforeGenerationTokens: 2550,
		});

		expect(failedLabels(findings)).toEqual([]);
	});

	it('keeps continuity repair artifacts out of the narration prompt', () => {
		const report = buildPromptHarnessReport({
			name: 'continuity-ledger-rendering',
			playerText: 'I ask what changed in the ledger.',
			ctx: baseContext({
				facts: [
					row({
						id: 'fact_mara_key',
						storyId: 'story_balaerys',
						type: 'observation',
						subjectEntityId: 'entity_mara',
						targetEntityId: null,
						title: 'Mara and the black key',
						statement: 'Mara now carries the black key.',
						confidence: 0.9,
						status: 'active',
						visibility: 'player_known',
						firstSeenEntryId: 'entry_ledger',
						sourceEntryIds: ['entry_ledger'],
						sourceEventIds: ['event_ledger'],
						sourcePatchIds: ['patch_ledger'],
						metadata: {},
					}),
				],
				patchProposals: [
					row({
						id: 'proposal_mara_key',
						storyId: 'story_balaerys',
						proposalType: 'fact_upsert',
						targetTable: 'facts',
						targetRecordId: 'fact_mara_key',
						proposedBy: 'narration',
						operations: [{ op: 'upsert', path: '/facts/fact_mara_key', value: { statement: 'Mara now carries the black key.' } }],
						reason: 'Narration stated Mara now carries the black key.',
						suggestion: 'Merge after review.',
						status: 'pending',
						decision: null,
						validatedBy: null,
						affectedEntityIds: ['entity_mara'],
						confidence: 0.9,
						sourceEntryIds: ['entry_ledger'],
						sourceEventIds: ['event_ledger'],
						sourcePatchIds: ['patch_ledger'],
						metadata: {},
					}),
				],
				continuityWarnings: [
					row({
						id: 'warning_ledger',
						storyId: 'story_balaerys',
						warningType: 'turn_extraction',
						level: 'warning',
						title: 'Missing witness',
						status: 'open',
						details: 'Skipped relationship because the witness entity was missing.',
						entityIds: ['entity_mara'],
						factionIds: [],
						threadIds: [],
						actorIds: [],
						sourceEntryIds: ['entry_ledger'],
						sourceEventIds: ['event_ledger'],
						sourcePatchIds: ['patch_ledger'],
						resolutionNotes: null,
						resolvedBy: null,
						resolvedAt: null,
						metadata: {},
					}),
				],
			}),
			retrieved: packet('ledger continuity review', []),
			options: {
				sceneEntityIds: ['pc_balaerys'],
			},
		});

		expect(report.prompt).not.toContain('Continuity ledger');
		expect(report.prompt).not.toContain('Mara now carries the black key.');
		expect(report.prompt).not.toContain('fact_upsert -> facts/fact_mara_key');
		expect(report.prompt).not.toContain('Missing witness');
	});

	it('keeps unresolved character repair proposals out of prompt context', () => {
		const report = buildPromptHarnessReport({
			name: 'unresolved-character-reference',
			playerText: 'I ask whether anyone knows the knight whose name was whispered.',
			ctx: baseContext({
				patchProposals: [
					row({
						id: 'proposal_ser_olyvar',
						storyId: 'story_balaerys',
						proposalType: 'character_reference_review',
						targetTable: 'entities',
						targetRecordId: 'unresolved_character_ser_olyvar',
						proposedBy: 'llm',
						operations: [{
							op: 'review',
							path: '/entities/character',
							value: {
								name: 'Ser Olyvar',
								description: 'A knight mentioned only in passing by the crowd.',
								status: 'active',
							},
						}],
						reason: 'Turn referenced unresolved character Ser Olyvar.',
						suggestion: 'Review this character reference before creating a new canonical record.',
						status: 'needs_review',
						decision: null,
						validatedBy: null,
						affectedEntityIds: [],
						confidence: 0.52,
						sourceEntryIds: ['entry_whisper'],
						sourceEventIds: [],
						sourcePatchIds: ['patch_whisper'],
						metadata: {
							sourceType: 'unresolved_character_reference',
							sourceName: 'Ser Olyvar',
						},
					}),
				],
			}),
			retrieved: packet('Ser Olyvar whispered name', []),
			options: {
				sceneEntityIds: ['pc_balaerys'],
			},
		});

		expect(report.prompt).not.toContain('Unresolved character references');
		expect(report.prompt).not.toContain('Ser Olyvar');
		expect(report.prompt).not.toContain('not yet canon');
		expect(report.prompt).not.toContain('- character: Ser Olyvar');
	});

	it('shows unresolved character reference source context for agreement faction and timeline names', () => {
		const report = buildPromptHarnessReport({
			name: 'unresolved-character-reference-source-context',
			playerText: 'I ask which unverified names are tied to the oath, faction roster, and delayed move.',
			ctx: baseContext({
				patchProposals: [
					row({
						id: 'proposal_unknown_envoy',
						storyId: 'story_balaerys',
						proposalType: 'character_reference_review',
						targetTable: 'entities',
						targetRecordId: 'unresolved_character_unknown_envoy',
						proposedBy: 'narration',
						operations: [{
							op: 'review',
							path: '/entities/character',
							value: {
								name: 'Unknown Envoy',
								description: 'Agreement party in oath: Hold the ash road until dawn.',
							},
						}],
						reason: 'Turn referenced unresolved character Unknown Envoy.',
						suggestion: 'Review this character reference before creating a new canonical record.',
						status: 'needs_review',
						decision: null,
						validatedBy: null,
						affectedEntityIds: [],
						confidence: 0.52,
						sourceEntryIds: ['entry_oath'],
						sourceEventIds: [],
						sourcePatchIds: ['patch_oath'],
						metadata: {
							sourceType: 'unresolved_character_reference',
							sourceName: 'Unknown Envoy',
							referenceContext: 'agreement_party',
							agreementCategory: 'oath',
						},
					}),
					row({
						id: 'proposal_oath_witness',
						storyId: 'story_balaerys',
						proposalType: 'character_reference_review',
						targetTable: 'entities',
						targetRecordId: 'unresolved_character_oath_witness',
						proposedBy: 'narration',
						operations: [{
							op: 'review',
							path: '/entities/character',
							value: {
								name: 'Oath Witness',
								description: 'Faction member named in "The Watch".',
							},
						}],
						reason: 'Turn referenced unresolved character Oath Witness.',
						suggestion: 'Review this character reference before creating a new canonical record.',
						status: 'needs_review',
						decision: null,
						validatedBy: null,
						affectedEntityIds: [],
						confidence: 0.52,
						sourceEntryIds: ['entry_watch'],
						sourceEventIds: [],
						sourcePatchIds: ['patch_watch'],
						metadata: {
							sourceType: 'unresolved_character_reference',
							sourceName: 'Oath Witness',
							referenceContext: 'faction_member',
							factionName: 'The Watch',
						},
					}),
					row({
						id: 'proposal_hooded_envoy',
						storyId: 'story_balaerys',
						proposalType: 'character_reference_review',
						targetTable: 'entities',
						targetRecordId: 'unresolved_character_hooded_envoy',
						proposedBy: 'narration',
						operations: [{
							op: 'review',
							path: '/entities/character',
							value: {
								name: 'Hooded Envoy',
								description: 'Timeline event actor in "Oath witness hunted".',
							},
						}],
						reason: 'Turn referenced unresolved character Hooded Envoy.',
						suggestion: 'Review this character reference before creating a new canonical record.',
						status: 'needs_review',
						decision: null,
						validatedBy: null,
						affectedEntityIds: [],
						confidence: 0.52,
						sourceEntryIds: ['entry_timeline'],
						sourceEventIds: [],
						sourcePatchIds: ['patch_timeline'],
						metadata: {
							sourceType: 'unresolved_character_reference',
							sourceName: 'Hooded Envoy',
							referenceContext: 'timeline_actor',
							timelineTitle: 'Oath witness hunted',
						},
					}),
				],
			}),
			retrieved: packet('unresolved agreement faction timeline names', []),
			options: {
				sceneEntityIds: ['pc_balaerys'],
			},
		});

		expect(report.prompt).not.toContain('Unknown Envoy');
		expect(report.prompt).not.toContain('Oath Witness');
		expect(report.prompt).not.toContain('Hooded Envoy');
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
			maxTotalBeforeGenerationTokens: 2600,
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
							currentLocation: 'The Crimson Spire nameday hall',
							currentAction: 'measuring the harbor pact before giving advice',
							emotionalState: 'watchful and dryly amused',
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
				'location: The Crimson Spire nameday hall',
				'action: measuring the harbor pact before giving advice',
				'emotional state: watchful and dryly amused',
				'linked: Saera has tracked the harbor pact, its ring-gift price, and who benefits if House Balaerys accepts.',
				'Appearance: silver-streaked black hair',
				'Personality: controlled; cutting; protective when House Balaerys benefits',
				'Voice: low, precise, and dryly amused',
				'Mannerisms: taps one ring against the table before naming a cost',
			],
			maxTotalBeforeGenerationTokens: 2900,
		});

		expect(failedLabels(findings)).toEqual([]);
	});

	it('includes scene-selected NPC portrayal even when the entity is not marked present', () => {
		const report = buildPromptHarnessReport({
			name: 'scene-entity-portrayal-without-present-flag',
			playerText: 'I study Lady Zarela before answering her terms.',
			ctx: baseContext({
				entities: [
					entity('loc_crimson_spire', 'location', 'The Crimson Spire', 'The Balaerys manse inside the Black Walls.', { current: true }),
					entity('pc_balaerys', 'character', 'Balaerys Heir', 'The watched young heir of House Balaerys.', { present: true }),
					entity(
						'npc_zarela',
						'character',
						'Lady Zarela Qhaedar',
						'A rival Old Blood negotiator testing House Balaerys.',
						{
							appearance: 'ivory braid pins, a red lacquered fan, and watchful amber eyes',
							personalityDescriptors: ['ceremonial', 'needle-sharp', 'patient enough to let a silence bleed'],
							voice: 'soft, formal, and edged with ritual courtesy',
							mannerisms: ['folds her fan once before naming a debt'],
						},
					),
				],
			}),
			retrieved: packet('Old Blood negotiation posture', []),
			options: {
				sceneEntityIds: ['pc_balaerys', 'npc_zarela'],
				maxFactions: 2,
			},
		});

		const findings = evaluatePromptHarness(report, {
			promptIncludes: [
				'Lady Zarela Qhaedar',
				'Appearance: ivory braid pins',
				'Personality: ceremonial; needle-sharp; patient enough to let a silence bleed',
				'Voice: soft, formal, and edged with ritual courtesy',
				'Mannerisms: folds her fan once before naming a debt',
			],
			maxTotalBeforeGenerationTokens: 2600,
		});

		expect(failedLabels(findings)).toEqual([]);
	});

	it('prioritizes scene-selected NPC portrayal over incidental crowded entities', () => {
		const incidentalGuests = Array.from({ length: 16 }, (_, index) => {
			const ordinal = index + 1;
			return entity(
				`npc_incidental_${ordinal}`,
				'character',
				`Incidental Guest ${ordinal}`,
				`Guest ${ordinal} fills the feast table.`,
				{
					present: true,
					appearance: `ceremonial silk guest ${ordinal}`,
					personalityDescriptors: [`watchful courtier ${ordinal}`],
					voice: `formal guest voice ${ordinal}`,
					mannerisms: [`adjusts a jeweled cuff ${ordinal}`],
				},
			);
		});
		const report = buildPromptHarnessReport({
			name: 'scene-entity-priority-in-crowd',
			playerText: 'I ignore the crowd and ask Zarela what alliance she really wants.',
			ctx: baseContext({
				entities: [
					entity('loc_crimson_spire', 'location', 'The Crimson Spire', 'The Balaerys manse inside the Black Walls.', { current: true }),
					entity('pc_balaerys', 'character', 'Balaerys Heir', 'The watched young heir of House Balaerys.', { present: true }),
					...incidentalGuests,
					entity(
						'npc_zarela',
						'character',
						'Lady Zarela Qhaedar',
						'A rival Old Blood negotiator testing House Balaerys.',
						{
							appearance: 'ivory braid pins, a red lacquered fan, and watchful amber eyes',
							personalityDescriptors: ['ceremonial', 'needle-sharp', 'patient enough to let a silence bleed'],
							voice: 'soft, formal, and edged with ritual courtesy',
							mannerisms: ['folds her fan once before naming a debt'],
						},
					),
				],
			}),
			retrieved: packet('Old Blood negotiation posture', []),
			options: {
				sceneEntityIds: ['pc_balaerys', 'npc_zarela'],
				maxFactions: 2,
			},
		});

		const findings = evaluatePromptHarness(report, {
			promptIncludes: [
				'Lady Zarela Qhaedar',
				'Appearance: ivory braid pins',
				'Personality: ceremonial; needle-sharp; patient enough to let a silence bleed',
				'Voice: soft, formal, and edged with ritual courtesy',
				'Mannerisms: folds her fan once before naming a debt',
			],
			maxTotalBeforeGenerationTokens: 3100,
		});

		expect(failedLabels(findings)).toEqual([]);
	});

	it('does not send stale present NPCs when the latest narration has moved scenes', () => {
		const report = buildPromptHarnessReport({
			name: 'stale-present-entities-outside-current-scene',
			playerText: 'I read the letters again from the Golden Parrot table.',
			ctx: baseContext({
				story: row({
					id: 'story_balaerys',
					clientStoryId: null,
					title: 'Rise of the Crimson Spire',
					description: 'A Volantene political fantasy rooted in House Balaerys.',
					genre: 'political fantasy',
					mode: 'adventure',
					settings: null,
					headerPrompt: 'The story starts in 296 AC on the protagonist nameday, the 15th day of the 8th moon.',
					currentTurn: 1065,
					currentWorldTime: 'old stale Crimson Spire clock',
					currentLocationId: 'loc_crimson_spire',
					metadata: {},
				}),
				recentEntries: [
					row({
						id: 'entry_walano',
						storyId: 'story_balaerys',
						type: 'user_action',
						content: 'I sit in the Golden Parrot and read the letters.',
						position: 100,
						parentId: null,
						branchId: null,
						metadata: {},
					}),
					row({
						id: 'narration_walano',
						storyId: 'story_balaerys',
						type: 'narration',
						content: '[ Time 14:56 | Day 3, Second Moon, 299 AC | Location - Summer Isles, Walano, the Golden Parrot tavern | Weather humid and bright ]\n\nMoira watches the tavern door while the letters from Volantis and Yi Ti wait on the table.',
						position: 101,
						parentId: 'entry_walano',
						branchId: null,
						metadata: {},
					}),
				],
				entities: [
					entity('loc_crimson_spire', 'location', 'The Crimson Spire', 'The Balaerys manse inside the Black Walls.', { current: true }),
					entity('pc_aurion', 'character', 'Aurion Balaerys', 'The dragon-blooded exile now traveling through the Summer Isles.', {
						present: true,
						isProtagonist: true,
						currentLocation: 'Summer Isles, Walano, the Golden Parrot tavern',
					}),
					entity('npc_zhen', 'character', 'Vermillion Zhen Lian', 'The Empress of Yi Ti.', {
						present: true,
						currentLocation: 'Yi Ti, Yin, the Vermilion Phoenix Apartments',
					}),
					entity('npc_daemon', 'character', 'Daemon Sand', 'A Dornish political actor far from Walano.', {
						present: true,
						currentLocation: 'Dorne, Sunspear',
					}),
					entity('npc_xanda', 'character', 'Xanda of Qarth', 'A high-status eastern noblewoman from an older scene.', {
						present: true,
						currentLocation: 'Qarth',
					}),
				],
				chapters: [
					row({
						id: 'chapter_offstage_memory',
						storyId: 'story_balaerys',
						number: 50,
						title: 'Letters From Elsewhere',
						sceneOutcome: 'Daemon Sand remained in Volantis while Vermillion Zhen Lian ruled Yi Ti and Xanda handled older trade matters outside the tavern.',
						irreversibleChanges: [],
						npcKnowledgeChanges: [],
						promisesDebtsOaths: [],
						discoveredClues: [],
						relationshipChanges: [],
						factionChanges: [],
						openThreads: [],
						sourceEntryIds: [],
						sourceEventIds: [],
						metadata: {},
					}),
				],
				patchProposals: [
					row({
						id: 'proposal_moira',
						storyId: 'story_balaerys',
						proposalType: 'character_reference_review',
						targetTable: 'entities',
						targetRecordId: 'unresolved_character_moira',
						proposedBy: 'llm',
						operations: [{
							op: 'review',
							path: '/entities/character',
							value: {
								name: 'Moira of the Sweet Lotus Vale',
								description: 'A Summer Islander woman present near Aurion at the Golden Parrot.',
								status: 'active',
							},
						}],
						reason: 'Turn referenced unresolved character Moira at the Golden Parrot.',
						suggestion: 'Review this character reference before creating canon.',
						status: 'needs_review',
						decision: null,
						validatedBy: null,
						affectedEntityIds: [],
						confidence: 0.62,
						sourceEntryIds: ['narration_walano'],
						sourceEventIds: [],
						sourcePatchIds: [],
						metadata: {
							sourceType: 'unresolved_character_reference',
							sourceName: 'Moira of the Sweet Lotus Vale',
							referenceContext: 'current_scene',
						},
					}),
				],
			}),
			retrieved: packet('Walano Golden Parrot Moira letters Volantis Yi Ti', []),
			options: {
				sceneEntityIds: ['pc_aurion'],
			},
		});

		expect(report.prompt).toContain('Current scene from latest narration');
		expect(report.prompt).toContain('Golden Parrot tavern');
		expect(report.prompt).toContain('Aurion Balaerys');
		expect(report.prompt).toContain('Moira watches the tavern door');
		expect(report.prompt).not.toContain('Moira of the Sweet Lotus Vale');
		expect(report.prompt).not.toContain('- character: Vermillion Zhen Lian');
		expect(report.prompt).not.toContain('- character: Daemon Sand');
		expect(report.prompt).not.toContain('- character: Xanda of Qarth');
		expect(report.prompt).not.toContain('Current location:\nThe Crimson Spire');
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
			maxTotalBeforeGenerationTokens: 2850,
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
			maxTotalBeforeGenerationTokens: 3650,
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
			maxTotalBeforeGenerationTokens: 2600,
		});

		expect(failedLabels(findings)).toEqual([]);
	});
});
