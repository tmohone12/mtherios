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
import { extractedRuleSchema, reflectionResultSchema, ruleRelevanceSchema } from '../procedural';
import { entryRefinementResultSchema } from '../entryRefinement';

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
				path_b: { type: 'social_slight', description: 'A lord refuses to rise when the player enters.', friction: true },
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
// Procedural Memory
// ════════════════════════════════════════════════════════════════

describe('extractedRuleSchema', () => {
	it('accepts valid rule', () => {
		const data = {
			content: 'NPCs flee when outnumbered', category: 'world_rule',
			type: 'rule', confidence: 0.8,
			relatedEntities: ['Guard', 'Barracks'], tags: ['combat', 'npc'],
		};
		expect(extractedRuleSchema.parse(data)).toBeTruthy();
	});

	it('accepts anti_pattern type', () => {
		const data = {
			content: 'Avoid repeated tavern scenes', category: 'anti_pattern',
			type: 'anti_pattern', confidence: 0.6,
			relatedEntities: [], tags: ['pacing'],
		};
		expect(extractedRuleSchema.parse(data).type).toBe('anti_pattern');
	});

	it('rejects confidence outside 0-1', () => {
		const base = { content: 'x', category: 'world_rule', type: 'rule', relatedEntities: [], tags: [] };
		expect(() => extractedRuleSchema.parse({ ...base, confidence: 1.1 })).toThrow();
	});

	it('accepts all categories', () => {
		const categories = ['character_behavior', 'world_rule', 'narrative_pattern', 'player_preference', 'anti_pattern', 'lore_connection'];
		for (const category of categories) {
			expect(extractedRuleSchema.parse({
				content: 'x', category, type: 'rule', confidence: 0.5, relatedEntities: [], tags: [],
			})).toBeTruthy();
		}
	});
});

describe('reflectionResultSchema', () => {
	it('accepts valid reflection result', () => {
		const data = {
			rules: [{ content: 'x', category: 'world_rule', type: 'rule', confidence: 0.5, relatedEntities: [], tags: [] }],
			summary: 'One pattern found',
		};
		expect(reflectionResultSchema.parse(data)).toBeTruthy();
	});
});

describe('ruleRelevanceSchema', () => {
	it('accepts valid relevance result', () => {
		const data = { ruleIds: ['r1', 'r2'], reason: 'Combat context' };
		expect(ruleRelevanceSchema.parse(data)).toEqual(data);
	});
});

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
			motivations: ['Reclaim her birthright', 'Avenge her father'],
			personality: 'Steely and quiet.',
			reasoning: 'Character context expanded.',
		};
		const parsed = entryRefinementResultSchema.parse(data);
		expect(parsed.bio).toBe('Born in Pyke, raised at sea.');
		expect(parsed.motivations).toHaveLength(2);
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

