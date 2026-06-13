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
			systemIncludes: [
				'server-side GM narrator',
				'hybrid POV',
				'Time HH:MM',
				'Do not append ending choices',
				'not a writing assistant',
				'1 Volantene honor = 1 gold dragon',
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
				'Old Blood Etiquette',
				'Volantene Household Hierarchy',
			],
			maxOccurrences: {
				'Balaerys Heir': 3,
			},
			maxMessageCount: 24,
			maxTotalBeforeGenerationTokens: 2600,
		});

		expect(failedLabels(findings)).toEqual([]);
		expect(report.system).not.toContain('skilled fiction writer');
		expect(report.system).not.toContain("author's directions");
		expect(report.retrievedMemoryIds).toEqual(['mem_old_blood', 'mem_household']);
	});

	it('keeps long-campaign continuity visible with saga arc chapter memory and 60 recent messages', () => {
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
		expect(report.prompt).toContain('Chapter memory');
		expect(report.prompt).toContain(longChapterOutcome);
		expect(report.prompt).toContain('do not rediscover this as if new');
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
						relationship: { status: 'self', level: 100 },
					}),
				],
			}),
			retrieved: packet('Aurion identity envoy balcony', []),
			options: {
				sceneEntityIds: ['pc_aurion'],
			},
		});

		expect(report.prompt).toContain('The long-description sentinel');
		expect(report.prompt).toContain('Second Cradle');
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

	it('renders continuity ledger facts, proposals, and warnings into the prompt', () => {
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

		expect(report.prompt).toContain('Continuity ledger');
		expect(report.prompt).toContain('Mara now carries the black key.');
		expect(report.prompt).toContain('fact_upsert -> facts/fact_mara_key');
		expect(report.prompt).toContain('Missing witness');
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
