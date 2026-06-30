import { describe, it, expect } from 'vitest';
import { actionChoiceSchema, actionChoicesResultSchema } from '../actionchoices';
import { suggestionSchema, suggestionsResultSchema } from '../suggestions';
import { loreUpdateSchema, loreManagementResultSchema } from '../lorebook';
import { styleReviewSchema } from '../style';
import { chapterSummaryResultSchema, chapterAnalysisSchema, retrievalDecisionSchema } from '../memory';
import {
	plotInjectionSchema, factionActionSchema, rumorSchema,
	worldSimulationResultSchema, relationDeltaSchema, plotMomentumSchema,
} from '../worldsim';
import { arcSummarySchema } from '../arc';
import { entryRefinementResultSchema } from '../entryRefinement';
import { strategicWorldFrameSchema } from '../strategicWorldBrain';
import { wikiLintResultSchema, wikiTextFixSchema } from '../wikiLint';
import {
	applyPlotMomentumAgencyGuard,
	describesForcedPlayerAction,
} from '../../../context/plotMomentumAgency';

// ════════════════════════════════════════════════════════════════
// Action Choices
// ════════════════════════════════════════════════════════════════

describe('actionChoiceSchema', () => {
	it('accepts valid action choice', () => {
		const data = { text: 'Charge the gate', type: 'bold' };
		expect(actionChoiceSchema.parse(data)).toEqual(data);
	});

	it('accepts optional risk and brief', () => {
		const data = { text: 'Sneak past', type: 'cautious', risk: 'low', brief: 'Stealthy approach' };
		expect(actionChoiceSchema.parse(data)).toEqual(data);
	});

	it('rejects invalid type enum', () => {
		expect(() => actionChoiceSchema.parse({ text: 'x', type: 'invalid' })).toThrow();
	});

	it('rejects missing text', () => {
		expect(() => actionChoiceSchema.parse({ type: 'bold' })).toThrow();
	});
});

describe('actionChoicesResultSchema', () => {
	it('accepts 2-4 choices', () => {
		const result = {
			choices: [
				{ text: 'Fight', type: 'bold' },
				{ text: 'Flee', type: 'cautious' },
			],
		};
		expect(actionChoicesResultSchema.parse(result).choices).toHaveLength(2);
	});

	it('rejects fewer than 2 choices', () => {
		expect(() => actionChoicesResultSchema.parse({ choices: [{ text: 'x', type: 'bold' }] })).toThrow();
	});

	it('rejects more than 4 choices', () => {
		const choices = Array.from({ length: 5 }, (_, i) => ({ text: `Choice ${i}`, type: 'bold' }));
		expect(() => actionChoicesResultSchema.parse({ choices })).toThrow();
	});
});

// ════════════════════════════════════════════════════════════════
// Suggestions
// ════════════════════════════════════════════════════════════════

describe('suggestionSchema', () => {
	it('accepts valid suggestion', () => {
		const data = { text: 'Look around', type: 'action' };
		expect(suggestionSchema.parse(data)).toEqual(data);
	});

	it('accepts all type variants', () => {
		for (const type of ['action', 'dialogue', 'thought', 'direction']) {
			expect(suggestionSchema.parse({ text: 'x', type })).toBeTruthy();
		}
	});
});

describe('suggestionsResultSchema', () => {
	it('accepts 1-4 suggestions', () => {
		const result = { suggestions: [{ text: 'Go north', type: 'direction' }] };
		expect(suggestionsResultSchema.parse(result).suggestions).toHaveLength(1);
	});

	it('rejects empty suggestions', () => {
		expect(() => suggestionsResultSchema.parse({ suggestions: [] })).toThrow();
	});
});

// ════════════════════════════════════════════════════════════════
// Lorebook
// ════════════════════════════════════════════════════════════════

describe('loreUpdateSchema', () => {
	it('accepts valid lore update', () => {
		const data = {
			action: 'create', name: 'Dragon', type: 'concept',
			description: 'A mythical beast', keywords: ['dragon', 'fire'], reason: 'Mentioned in story',
		};
		expect(loreUpdateSchema.parse(data)).toBeTruthy();
	});

	it('accepts character enrichment fields', () => {
		const data = {
			action: 'update', entryId: '123', name: 'Jon', type: 'character',
			description: 'Brooding hero', keywords: ['stark'], reason: 'Bio revealed',
			bio: 'Raised in Winterfell', motivations: ['protect the realm'], personality: 'honorable',
		};
		const parsed = loreUpdateSchema.parse(data);
		expect(parsed.bio).toBe('Raised in Winterfell');
		expect(parsed.motivations).toEqual(['protect the realm']);
	});

	it('accepts null bio/motivations/personality', () => {
		const data = {
			action: 'create', name: 'X', type: 'item',
			description: 'Y', keywords: [], reason: 'Z',
			bio: null, motivations: null, personality: null,
		};
		expect(loreUpdateSchema.parse(data).bio).toBeNull();
	});
});

describe('loreManagementResultSchema', () => {
	it('accepts result with summary', () => {
		const data = {
			updates: [{ action: 'create', name: 'X', type: 'item', description: 'Y', keywords: [], reason: 'Z' }],
			summary: 'One new item',
		};
		expect(loreManagementResultSchema.parse(data).summary).toBe('One new item');
	});
});

// ════════════════════════════════════════════════════════════════
// Style Review
// ════════════════════════════════════════════════════════════════

describe('styleReviewSchema', () => {
	it('accepts approved review with no issues', () => {
		const data = { approved: true, issues: [] };
		expect(styleReviewSchema.parse(data).approved).toBe(true);
	});

	it('accepts review with issues and all fields', () => {
		const data = {
			approved: false,
			issues: [{
				type: 'pov_break', description: 'Switched to first person',
				severity: 'major', suggestion: 'Use second person',
			}],
			revisedText: 'You walk forward.',
			overallQuality: 'fair',
		};
		const parsed = styleReviewSchema.parse(data);
		expect(parsed.issues).toHaveLength(1);
		expect(parsed.overallQuality).toBe('fair');
	});

	it('accepts all issue types', () => {
		for (const type of ['pov_break', 'tense_shift', 'character_voice', 'repetition', 'pacing', 'tone_mismatch']) {
			expect(styleReviewSchema.parse({
				approved: false,
				issues: [{ type, description: 'x', severity: 'minor' }],
			})).toBeTruthy();
		}
	});
});

// ════════════════════════════════════════════════════════════════
// Memory
// ════════════════════════════════════════════════════════════════

describe('chapterSummaryResultSchema', () => {
	it('accepts valid chapter summary', () => {
		const data = {
			title: 'The Beginning', summary: 'Hero sets out',
			keywords: ['journey'], keyCharacters: ['Jon'], keyLocations: ['Winterfell'],
			emotionalTone: 'hopeful',
		};
		expect(chapterSummaryResultSchema.parse(data)).toEqual(data);
	});
});

describe('chapterAnalysisSchema', () => {
	it('accepts chapter boundary decision', () => {
		const data = { shouldCreateChapter: true, optimalEndIndex: 15, keywords: ['battle'], reason: 'Scene shift' };
		expect(chapterAnalysisSchema.parse(data).shouldCreateChapter).toBe(true);
	});

	it('accepts false decision', () => {
		const data = { shouldCreateChapter: false, optimalEndIndex: 0, keywords: [], reason: 'Continuing scene' };
		expect(chapterAnalysisSchema.parse(data).shouldCreateChapter).toBe(false);
	});
});

describe('retrievalDecisionSchema', () => {
	it('accepts retrieval decision', () => {
		const data = { shouldRetrieve: true, relevantChapterIds: ['ch1', 'ch2'], reason: 'Callback needed' };
		expect(retrievalDecisionSchema.parse(data)).toEqual(data);
	});

	it('accepts without optional reason', () => {
		const data = { shouldRetrieve: false, relevantChapterIds: [] };
		expect(retrievalDecisionSchema.parse(data).reason).toBeUndefined();
	});
});

// ════════════════════════════════════════════════════════════════
// World Simulation
// ════════════════════════════════════════════════════════════════

describe('plotInjectionSchema', () => {
	it('accepts valid plot injection', () => {
		const data = {
			prose: 'A raven arrives', urgency: 'emerging',
			involvedCharacters: ['Maester'], involvedLocations: ['Castle'],
			narratorDirective: 'Introduce letter scene',
		};
		expect(plotInjectionSchema.parse(data)).toEqual(data);
	});
});

describe('factionActionSchema', () => {
	it('accepts valid faction action', () => {
		const data = {
			factionName: 'Lannisters', action: 'Sent troops to the Riverlands',
			actionType: 'military', target: 'Riverlands',
			motivation: 'Consolidate power', consequences: ['Road blockades', 'Increased patrols'],
			urgency: 'emerging', affectedRegions: ['Riverlands', 'Westerlands'],
		};
		expect(factionActionSchema.parse(data)).toBeTruthy();
	});

	it('accepts null target for internal actions', () => {
		const data = {
			factionName: 'X', action: 'Internal reform', actionType: 'internal',
			target: null, motivation: 'Y', consequences: [], urgency: 'background', affectedRegions: [],
		};
		expect(factionActionSchema.parse(data).target).toBeNull();
	});
});

describe('rumorSchema', () => {
	it('accepts valid rumor', () => {
		const data = {
			content: 'Dragons seen in the east', truthfulness: 0.7,
			originRegion: 'Essos', spreadRadius: 'continental',
			sourceType: 'traveler', relatedFaction: null, staleAfterChapters: 5,
		};
		expect(rumorSchema.parse(data)).toBeTruthy();
	});

	it('rejects truthfulness outside 0-1', () => {
		const base = {
			content: 'x', originRegion: 'y', spreadRadius: 'local',
			sourceType: 'spy', relatedFaction: null, staleAfterChapters: 3,
		};
		expect(() => rumorSchema.parse({ ...base, truthfulness: 1.5 })).toThrow();
		expect(() => rumorSchema.parse({ ...base, truthfulness: -0.1 })).toThrow();
	});
});

describe('worldSimulationResultSchema', () => {
	it('accepts minimal result with defaults', () => {
		const parsed = worldSimulationResultSchema.parse({});
		expect(parsed.plotInjection).toBeNull();
		expect(parsed.worldNarrative).toBe('');
		expect(parsed.factionActions).toEqual([]);
		expect(parsed.rumors).toEqual([]);
		expect(parsed.worldTension).toBe(0);
		expect(parsed.plotSeeds).toEqual([]);
	});

	it('rejects worldTension outside 0-10', () => {
		expect(() => worldSimulationResultSchema.parse({ worldTension: 11 })).toThrow();
	});
});

describe('plotMomentumSchema', () => {
	const validNextBeat = {
		next_beat: {
			critical_path: {
				path_a: { type: 'political_overture', description: 'A raven arrives with a marriage offer.' },
				path_b: { type: 'social_slight', description: 'A lord refuses to rise when the player is announced.', friction: true },
				path_c: { type: 'action_small_scale', description: 'A horse screams in the stable.', action: true },
				path_d: { type: 'twist_from_secret', description: 'A maester reveals a hidden will.', twist_from_existing_secret: true },
			},
			next_turn_strategy: {
				recommended_path: 'path_b',
				rationale: 'The player has had two easy turns; friction raises temperature.',
			},
			revelation_budget: {
				major_reveals_stewing: ['The heir is a bastard'],
				notes: 'Hold the bastard reveal until the feast arc.',
			},
			faction_advisory: {
				house_stark: { disposition: 'cautiously allied', likely_next_move: 'Send a raven warning.', notes: 'Honorable but stretched thin.' },
			},
			thread_awareness: {
				existing_threads: ['Find the missing courier'],
				imminent_threads: ['The feast approaches'],
				branch_alignment: 'Path B advances the feast tension without forcing a reveal.',
			},
		},
	};

	it('accepts a valid plot momentum payload', () => {
		const parsed = plotMomentumSchema.parse(validNextBeat);
		expect(parsed.next_beat.critical_path.path_b.friction).toBe(true);
		expect(parsed.next_beat.next_turn_strategy.recommended_path).toBe('path_b');
		expect(parsed.next_beat.faction_advisory.house_stark.disposition).toBe('cautiously allied');
	});

	it('accepts conditional player-dependent payoff wording', () => {
		const parsed = plotMomentumSchema.parse({
			next_beat: {
				...validNextBeat.next_beat,
				critical_path: {
					...validNextBeat.next_beat.critical_path,
					path_a: {
						type: 'loyalty_payoff',
						description: 'If Aurion chooses to return to the Eastern Wing or summons Vessia, she may be available with the war-galley ledgers.',
					},
				},
			},
		});

		expect(parsed.next_beat.critical_path.path_a.description).toContain('If Aurion chooses');
		expect(describesForcedPlayerAction(parsed.next_beat.critical_path.path_a.description)).toBe(false);
	});

	it('accepts earned reward path types for plot momentum', () => {
		const parsed = plotMomentumSchema.parse({
			next_beat: {
				...validNextBeat.next_beat,
				critical_path: {
					...validNextBeat.next_beat.critical_path,
					path_a: {
						type: 'loyalty_payoff',
						description: 'A sworn ally quietly vouches for the player at the gate.',
					},
				},
				next_turn_strategy: {
					recommended_path: 'path_a',
					rationale: 'Prior loyalty can now return as a quiet advantage.',
				},
			},
		});

		expect(parsed.next_beat.critical_path.path_a.type).toBe('loyalty_payoff');
	});

	it('accepts minimal defaults for optional booleans', () => {
		const minimal = {
			next_beat: {
				critical_path: {
					path_a: { type: 'none', description: 'Nothing happens.' },
					path_b: { type: 'none', description: 'Nothing happens.' },
					path_c: { type: 'none', description: 'Nothing happens.' },
					path_d: { type: 'none', description: 'Nothing happens.' },
				},
				next_turn_strategy: { recommended_path: 'path_a', rationale: 'Default.' },
				revelation_budget: { major_reveals_stewing: [], notes: '' },
				faction_advisory: {},
				thread_awareness: { existing_threads: [], imminent_threads: [], branch_alignment: '' },
			},
		};
		const parsed = plotMomentumSchema.parse(minimal);
		expect(parsed.next_beat.critical_path.path_a.friction).toBe(false);
	});

	it('rejects invalid recommended_path', () => {
		const bad = {
			next_beat: {
				...validNextBeat.next_beat,
				next_turn_strategy: { recommended_path: 'path_e', rationale: 'bad' },
			},
		};
		expect(() => plotMomentumSchema.parse(bad)).toThrow();
	});

	it('detects forced player movement in momentum descriptions', () => {
		expect(describesForcedPlayerAction('Aurion returns to the Eastern Wing.')).toBe(true);
		expect(describesForcedPlayerAction('You leave the vault.')).toBe(true);
		expect(describesForcedPlayerAction('A messenger knocks at the vault door.')).toBe(false);
	});

	it('annotates forced player movement as conditional momentum', () => {
		const forced = plotMomentumSchema.parse({
			next_beat: {
				...validNextBeat.next_beat,
				critical_path: {
					...validNextBeat.next_beat.critical_path,
					path_a: {
						type: 'loyalty_payoff',
						description: 'Aurion returns to the Eastern Wing. Aurion writes the letter to Braavos.',
						action: true,
					},
				},
				next_turn_strategy: {
					recommended_path: 'path_a',
					rationale: 'The payoff is ready.',
				},
			},
		});

		const guarded = applyPlotMomentumAgencyGuard(forced);
		const path = guarded.next_beat.critical_path.path_a;
		expect(path.description).toContain('Conditional opportunity only');
		expect(path.description).toContain('Aurion may choose to return');
		expect(path.description).toContain('Aurion may choose to write');
		expect(path.description).toContain('Do not move Aurion');
		expect(path.action).toBe(false);
		expect(path.downgraded_to_friction).toBe(true);
		expect(guarded.next_beat.next_turn_strategy.rationale).toContain('Player-agency guard');
	});

	it('keeps direct NPC and environment momentum unchanged', () => {
		const direct = plotMomentumSchema.parse({
			next_beat: {
				...validNextBeat.next_beat,
				critical_path: {
					...validNextBeat.next_beat.critical_path,
					path_c: {
						type: 'action_small_scale',
						description: 'A messenger knocks at the vault door. A horse screams in the stable.',
						action: true,
					},
				},
				next_turn_strategy: {
					recommended_path: 'path_c',
					rationale: 'A small interruption preserves pressure.',
				},
			},
		});

		const guarded = applyPlotMomentumAgencyGuard(direct);
		expect(guarded.next_beat.critical_path.path_c.description).toBe('A messenger knocks at the vault door. A horse screams in the stable.');
		expect(guarded.next_beat.critical_path.path_c.action).toBe(true);
		expect(guarded.next_beat.next_turn_strategy.rationale).toBe('A small interruption preserves pressure.');
	});
});

describe('strategicWorldFrameSchema', () => {
	it('accepts a strategic frame with scheme directives and clocks', () => {
		const parsed = strategicWorldFrameSchema.parse({
			arcNumber: 4,
			trigger: 'arc_created',
			chapterRange: { from: 16, to: 20 },
			continuityAssessment: {
				summary: 'Border trade pressure is unresolved.',
				unresolvedContinuityRisks: ['Free Companies have not reacted.'],
				staleThreads: [],
				contradictionsToReview: [],
			},
			worldMood: {
				politicalTemperature: 'volatile',
				economicPressure: 'scarcity',
				socialPressure: 'anxious',
			},
			publicSummary: 'The western grain roads are politically decisive.',
			hiddenStrategicSummary: 'The Synod is engineering dependence on escorts.',
			mainPlots: [{
				title: 'Control of the Western Grain Roads',
				kind: 'faction_plot',
				pressure: 'high',
				summary: 'Several powers maneuver over food movement.',
				linkedSchemeIds: ['scheme_synod'],
				linkedFactionGoalIds: ['goal_synod'],
				linkedThreadIds: ['thread_grain'],
				expectedPayoff: 'this_arc',
				playerAgency: 'reactive',
			}],
			schemeDirectives: [{
				type: 'advance_scheme',
				schemeId: 'scheme_synod',
				progressDelta: 12,
				visibleEffects: ['Caravan prices rise.'],
				hiddenEffects: ['Bribed captains steer trade.'],
				nextMoves: ['Pressure merchants into escort contracts.'],
				linkedFactionGoalIds: ['goal_synod'],
				linkedThreadIds: ['thread_grain'],
				linkedWorldEventIds: [],
				evidenceRefs: [{ sourceType: 'arc', label: 'Arc 3 summary' }],
				confidence: 0.82,
				reason: 'No rival has disrupted the plan.',
			}],
			strategicClocks: [{
				id: 'clock_synod_grain',
				name: 'The Synod Secures the Grain Roads',
				ownerFactionName: 'Iron Synod',
				progress: 55,
				velocity: 'steady',
				goal: 'Control food movement before winter.',
				visibleToPlayer: false,
				tickTriggers: ['player ignores merchant disappearances'],
				stallTriggers: ['player exposes staged attacks'],
				completionConsequences: ['Food prices become politically controlled.'],
				currentPhase: 'Merchants begin accepting Synod escorts.',
			}],
			factionOperations: [{
				id: 'op_synod_escort_contracts',
				factionName: 'Iron Synod',
				operation: 'Pressure river merchants into accepting armed escort contracts.',
				objective: 'Control grain movement without announcing a blockade.',
				actionType: 'economic',
				target: 'Western grain roads',
				urgency: 'urgent',
				visibility: 'secret',
				timeHorizon: 'next_few_turns',
				triggerConditions: ['player ignores missing caravans'],
				stallConditions: ['player exposes staged attacks'],
				visibleSignals: ['Escort prices rise', 'Merchants complain about delays'],
				hiddenSteps: ['Bribe two caravan masters'],
				linkedClockIds: ['clock_synod_grain'],
				linkedSchemeIds: ['scheme_synod'],
				evidenceRefs: [{ sourceType: 'faction', label: 'Iron Synod goals' }],
				confidence: 0.86,
			}],
			warPressureCard: {
				phase: 'mobilization',
				mainFactions: ['Iron Synod', 'River League'],
				warAims: ['Control the grain roads'],
				frontsOrTheaters: ['Western grain roads'],
				importantSchemes: ['The Synod Secures the Grain Roads'],
				visibleSigns: ['Escort prices rise'],
				hiddenFacts: ['Bribed captains are steering trade'],
				nextEscalationIfIgnored: 'Merchants accept Synod escorts as permanent protection.',
				playerInterventionPoints: ['Expose staged attacks'],
			},
			narratorPromptCard: 'Merchants are frightened and food prices are rising.',
			fastWorldSimInstructions: 'Advance road pressure through prices and missing caravans.',
		});

		expect(parsed.schemeDirectives).toHaveLength(1);
		expect(parsed.strategicClocks[0].progress).toBe(55);
		expect(parsed.warPressureCard?.phase).toBe('mobilization');
		expect(parsed.factionOperations[0]).toMatchObject({
			factionName: 'Iron Synod',
			actionType: 'economic',
			urgency: 'urgent',
			timeHorizon: 'next_few_turns',
		});
	});

	it('normalizes compact strategic brain output from loose JSON mode', () => {
		const parsed = strategicWorldFrameSchema.parse({
			arcNumber: 1,
			globalPressureLevel: 85,
			narratorPromptCard: 'CURRENT FOCUS: Aurion and Vaelar are preparing military enforcement.',
			fastWorldSimInstructions: 'HOUSE BALAERYS: Transitioning to a war footing.',
			mainPlots: [{
				name: 'The Iron Leash',
				pressure: 85,
				summary: 'The debt trap is springing shut.',
			}],
			subplots: [{
				name: 'Elephant Obstruction',
				pressure: 'urgent',
				summary: 'Guild regulations are slowing Balaerys logistics.',
			}],
			schemeDirectives: [{
				id: 'sch_westeros_blockade',
				type: 'create',
				name: 'The Crimson Blockade',
				factionId: '6448b5b4',
				targetId: 'c55edf86',
				description: 'Deploy the Volantene fleet to blockade Lannisport and Blackwater Bay.',
				priority: 10,
				progress: 10,
				visibleEffects: 'Harbor crews begin counting hulls.',
				hiddenEffects: 'Tiger captains receive sealed blockade orders.',
				confidence: 85,
			}],
			plotUpdates: [{
				id: 'plt_iron_throne_debt',
				name: 'The Iron Leash',
				status: 'active',
				pressure: 85,
				summary: 'The financial trap is springing shut.',
			}],
			backgroundFactionMoves: [{
				faction: 'House Balaerys',
				move: 'Send sealed fleet orders to allied captains.',
				goal: 'Prepare a blockade without public commitment.',
				type: 'fleet logistics',
				priority: 75,
				horizon: 'next_tick',
				visibleEffects: 'Dock scribes start counting hulls.',
				hiddenEffects: ['Captains receive coded harbor routes.'],
				confidence: 80,
			}],
			warPressure: {
				phase: 'fleet mobilization',
				mainFactions: ['House Balaerys', 'Iron Throne'],
				warAims: ['Force debt compliance'],
				frontsOrTheaters: ['Blackwater Bay'],
				importantSchemes: ['The Crimson Blockade'],
				visibleSigns: ['Dock scribes count hulls'],
				hiddenFacts: ['Sealed routes are already drafted'],
				nextEscalationIfIgnored: 'The fleet closes the bay.',
				playerInterventionPoints: ['Intercept sealed orders'],
			},
			canonPatchSuggestions: [{
				entityId: 'Aurion_Balaerys',
				field: 'assets',
				newValue: 'Three live dragons roosting in a remote mountain cavern.',
				reason: 'Player explicitly narrated the dragons roosting.',
				confidence: 90,
				evidenceRefs: ['Raw entry: dragons make deep caverns.'],
			}],
		});

		expect(parsed.worldMood.politicalTemperature).toBe('war');
		expect(parsed.warPressureCard?.phase).toBe('fleet mobilization');
		expect(parsed.mainPlots[0].title).toBe('The Iron Leash');
		expect(parsed.mainPlots[0].pressure).toBe('critical');
		expect(parsed.subplots[0].pressure).toBe('high');
		expect(parsed.schemeDirectives[0]).toMatchObject({
			type: 'create_scheme',
			title: 'The Crimson Blockade',
			ownerName: '6448b5b4',
			goal: 'Deploy the Volantene fleet to blockade Lannisport and Blackwater Bay.',
			progressDelta: 10,
			visibleEffects: ['Harbor crews begin counting hulls.'],
			hiddenEffects: ['Tiger captains receive sealed blockade orders.'],
			confidence: 0.85,
		});
		expect(parsed.factionOperations[0]).toMatchObject({
			factionName: 'House Balaerys',
			operation: 'Send sealed fleet orders to allied captains.',
			actionType: 'military',
			urgency: 'urgent',
			timeHorizon: 'next_tick',
			visibleSignals: ['Dock scribes start counting hulls.'],
		});
		expect(parsed.canonPatchSuggestions[0].type).toBe('custom');
		expect(parsed.canonPatchSuggestions[0].confidence).toBe(0.9);
		expect(parsed.canonPatchSuggestions[0].evidenceRefs[0].label).toBe('Raw entry: dragons make deep caverns.');
	});
});

describe('wikiLintResultSchema', () => {
	it('requires coverage, evidence, confidence, and entry ids', () => {
		const parsed = wikiLintResultSchema.parse({
			coverage: {
				entryCount: 2,
				relationshipCount: 1,
				chapterCount: 3,
				allEntriesIncluded: true,
				notes: 'All active entries were included.',
			},
			contradictions: [{
				entryId: 'entry_house',
				entryName: 'House Veyr',
				issue: 'The description says the house is extinct, but state lists active members.',
				conflictingEntryId: null,
				conflictsWith: 'House Veyr state.knownMembers',
				severity: 'major',
				evidence: ['entry_house desc/state'],
				confidence: 0.91,
			}],
			staleClaims: [],
			orphans: [],
			missingEntries: [],
			gapSuggestions: [],
			textFixes: [{
				entryId: 'entry_house',
				entryName: 'House Veyr',
				field: 'description',
				originalText: 'extict',
				correctedText: 'extinct',
				reason: 'Spelling fix.',
				evidence: ['entry_house description'],
				confidence: 1,
				safeToAutoApply: true,
			}],
			summary: 'One contradiction and one safe text fix.',
		});

		expect(parsed.coverage.allEntriesIncluded).toBe(true);
		expect(parsed.contradictions[0].entryId).toBe('entry_house');
	});

	it('rejects no-op text fixes', () => {
		expect(() => wikiTextFixSchema.parse({
			entryId: 'entry_house',
			entryName: 'House Veyr',
			field: 'description',
			originalText: 'unchanged',
			correctedText: 'unchanged',
			reason: 'No change.',
			evidence: ['entry_house description'],
			confidence: 0.5,
			safeToAutoApply: true,
		})).toThrow();
	});
});

describe('relationDeltaSchema', () => {
	it('accepts a normal delta', () => {
		const parsed = relationDeltaSchema.parse({
			targetFaction: 'House Stark', delta: -25, reason: 'sacked Sherrer',
		});
		expect(parsed).toEqual({ targetFaction: 'House Stark', delta: -25, reason: 'sacked Sherrer' });
	});

	it('clamps delta to ±50 instead of failing', () => {
		const overshoot = relationDeltaSchema.parse({ targetFaction: 'X', delta: 80, reason: 'r' });
		expect(overshoot.delta).toBe(50);
		const undershoot = relationDeltaSchema.parse({ targetFaction: 'X', delta: -200, reason: 'r' });
		expect(undershoot.delta).toBe(-50);
	});

	it('truncates over-long reason instead of failing', () => {
		const longReason = 'a'.repeat(300);
		const parsed = relationDeltaSchema.parse({ targetFaction: 'X', delta: 0, reason: longReason });
		expect(parsed.reason.length).toBeLessThanOrEqual(140);
	});
});

describe('factionActionSchema relationDeltas', () => {
	const base = {
		factionName: 'X', action: 'a', actionType: 'military' as const,
		target: null, motivation: 'm', consequences: [], urgency: 'background' as const,
		affectedRegions: [],
	};

	it('defaults relationDeltas to empty array when omitted', () => {
		const parsed = factionActionSchema.parse(base);
		expect(parsed.relationDeltas).toEqual([]);
	});

	it('caps relationDeltas at 4 silently (no throw)', () => {
		const five = Array.from({ length: 5 }, (_, i) => ({
			targetFaction: `T${i}`, delta: 5, reason: 'r',
		}));
		const parsed = factionActionSchema.parse({ ...base, relationDeltas: five });
		expect(parsed.relationDeltas).toHaveLength(4);
	});
});

// ════════════════════════════════════════════════════════════════
// Arc
// ════════════════════════════════════════════════════════════════

describe('arcSummarySchema', () => {
	it('accepts valid arc summary', () => {
		const data = {
			title: 'The Fall', summary: 'Everything collapses',
			keyPlotPoints: ['Betrayal', 'Siege'],
			characterArcs: [{ name: 'Jon', development: 'Grew disillusioned' }],
			unresolvedThreads: ['Missing sword'], emotionalProgression: 'hope to despair',
		};
		expect(arcSummarySchema.parse(data)).toEqual(data);
	});

	it('accepts empty arrays', () => {
		const data = {
			title: 'X', summary: 'Y', keyPlotPoints: [],
			characterArcs: [], unresolvedThreads: [], emotionalProgression: 'flat',
		};
		expect(arcSummarySchema.parse(data).keyPlotPoints).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// Entry Refinement
// ════════════════════════════════════════════════════════════════

describe('entryRefinementResultSchema', () => {
	it('accepts a description-only refinement', () => {
		const data = {
			description: 'Updated description with new facts appended.',
			reasoning: 'Added the siege detail.',
		};
		expect(entryRefinementResultSchema.parse(data).description).toBeTruthy();
	});

	it('accepts character enrichment fields', () => {
		const data = {
			description: 'Old text + new text.',
			bio: 'Born in Pyke, raised at sea.',
			appearance: 'Salt-stiff cloak.',
			personality: 'Steely and quiet.',
			rank: 'princess',
			currentDisposition: 'wary but loyal',
			affinity: 35,
			motivations: ['Reclaim her birthright', 'Avenge her father'],
			factionTags: ['House Greyjoy'],
			knownFacts: ['The player spared her brother.'],
			reasoning: 'Character context expanded.',
		};
		const parsed = entryRefinementResultSchema.parse(data);
		expect(parsed.bio).toBe('Born in Pyke, raised at sea.');
		expect(parsed.motivations).toHaveLength(2);
		expect(parsed.affinity).toBe(35);
	});

	it('accepts faction operational state fields', () => {
		const data = {
			description: 'Old text plus the port blockade.',
			playerStanding: -45,
			factionStatus: 'hostile',
			knownMembers: ['Lord Harlaw', 'Asha'],
			goals: [{
				description: 'Break the river blockade',
				priority: 8,
				progress: 25,
				type: 'military',
				deadline: 'before winter',
			}],
			resources: { military: 70, wealth: 45, influence: 55, information: 35, morale: 60 },
			disposition: 'aggressive',
			territory: ['Pyke', 'Lordsport'],
			reasoning: 'Faction state expanded.',
		};
		const parsed = entryRefinementResultSchema.parse(data);
		expect(parsed.goals?.[0].description).toBe('Break the river blockade');
		expect(parsed.resources?.military).toBe(70);
	});

	it('accepts all optional fields omitted except reasoning', () => {
		const data = { reasoning: 'Nothing to change.' };
		expect(entryRefinementResultSchema.parse(data).reasoning).toBe('Nothing to change.');
	});

	it('accepts nullable description (no change)', () => {
		const data = { description: null, reasoning: 'Unchanged.' };
		expect(entryRefinementResultSchema.parse(data).description).toBeNull();
	});

	it('rejects missing reasoning', () => {
		expect(() => entryRefinementResultSchema.parse({ description: 'x' })).toThrow();
	});

	it('rejects keywords with non-string entries', () => {
		expect(() => entryRefinementResultSchema.parse({
			keywords: [123, 'ok'],
			reasoning: 'test',
		})).toThrow();
	});
});

