import { describe, it, expect } from 'vitest';
import { actionChoiceSchema, actionChoicesResultSchema } from '../actionchoices';
import { suggestionSchema, suggestionsResultSchema } from '../suggestions';
import {
	characterUpdateSchema, locationUpdateSchema, itemUpdateSchema,
	relationshipExtractionSchema, conversationDetectionSchema,
	classificationResultSchema, locationConnectionSchema,
} from '../classifier';
import { timelineFillEntrySchema, timelineFillResultSchema } from '../timeline';
import { loreUpdateSchema, loreManagementResultSchema } from '../lorebook';
import { styleReviewSchema } from '../style';
import { chapterSummaryResultSchema, chapterAnalysisSchema, retrievalDecisionSchema } from '../memory';
import {
	plotInjectionSchema, factionActionSchema, rumorSchema,
	worldSimulationResultSchema,
} from '../worldsim';
import { arcSummarySchema } from '../arc';
import { extractedRuleSchema, reflectionResultSchema, ruleRelevanceSchema } from '../procedural';
import { vaultQuerySchema, vaultActionSchema, vaultResultSchema } from '../vault';
import { factionSignalSchema } from '../classifier';
import { microFactionReactionSchema, microFactionResultSchema } from '../microfaction';

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
// Classifier
// ════════════════════════════════════════════════════════════════

describe('characterUpdateSchema', () => {
	it('accepts valid character update', () => {
		const data = { name: 'Arya', description: 'A girl', relationship: 'ally', status: 'active' };
		expect(characterUpdateSchema.parse(data)).toEqual(data);
	});

	it('accepts nullable description and relationship', () => {
		const data = { name: 'Guard', description: null, relationship: null, status: 'unknown' };
		expect(characterUpdateSchema.parse(data)).toEqual(data);
	});

	it('accepts all status enum values', () => {
		for (const status of ['active', 'inactive', 'departed', 'deceased', 'unknown']) {
			expect(characterUpdateSchema.parse({ name: 'X', description: null, relationship: null, status })).toBeTruthy();
		}
	});

	it('accepts optional traits array', () => {
		const data = { name: 'Jon', description: null, relationship: null, status: 'active', traits: ['brave', 'honorable'] };
		expect(characterUpdateSchema.parse(data).traits).toEqual(['brave', 'honorable']);
	});
});

describe('locationConnectionSchema', () => {
	it('accepts valid connection', () => {
		const data = { targetName: 'Winterfell', direction: 'north', travelTimeMinutes: 120, description: null };
		expect(locationConnectionSchema.parse(data)).toEqual(data);
	});
});

describe('locationUpdateSchema', () => {
	it('accepts valid location with defaults', () => {
		const data = { name: 'Tavern', description: 'A warm inn', current: true };
		const parsed = locationUpdateSchema.parse(data);
		expect(parsed.connections).toEqual([]);
	});

	it('accepts optional region and terrain', () => {
		const data = { name: 'Forest', description: null, current: false, region: 'The North', terrain: 'woodland' };
		expect(locationUpdateSchema.parse(data).region).toBe('The North');
	});
});

describe('itemUpdateSchema', () => {
	it('accepts minimal item', () => {
		const data = { name: 'Sword', description: 'Sharp' };
		expect(itemUpdateSchema.parse(data)).toBeTruthy();
	});

	it('accepts optional fields', () => {
		const data = { name: 'Potion', description: null, quantity: 3, equipped: false, location: 'backpack' };
		expect(itemUpdateSchema.parse(data).quantity).toBe(3);
	});
});

describe('relationshipExtractionSchema', () => {
	it('accepts valid relationship', () => {
		const data = {
			sourceName: 'Jon', targetName: 'Arya', type: 'allied-with',
			label: 'siblings', strength: 90, bidirectional: true,
		};
		expect(relationshipExtractionSchema.parse(data)).toEqual(data);
	});

	it('rejects strength outside 0-100', () => {
		const base = { sourceName: 'A', targetName: 'B', type: 'allied-with', label: null, bidirectional: false };
		expect(() => relationshipExtractionSchema.parse({ ...base, strength: 101 })).toThrow();
		expect(() => relationshipExtractionSchema.parse({ ...base, strength: -1 })).toThrow();
	});

	it('accepts all 12 relationship types', () => {
		const types = [
			'member-of', 'leader-of', 'allied-with', 'enemy-of',
			'located-in', 'part-of', 'created-by', 'triggered-by',
			'knows-about', 'owns', 'serves', 'related-to',
		];
		for (const type of types) {
			expect(relationshipExtractionSchema.parse({
				sourceName: 'A', targetName: 'B', type, label: null, strength: 50, bidirectional: false,
			})).toBeTruthy();
		}
	});
});

describe('conversationDetectionSchema', () => {
	it('accepts valid conversation', () => {
		const data = {
			npcName: 'Merchant', topicSummary: 'Prices', playerRevealed: ['has gold'],
			npcLearned: ['player is wealthy'], emotionalShift: 'greedy', importance: 'minor',
		};
		expect(conversationDetectionSchema.parse(data)).toEqual(data);
	});

	it('accepts null emotionalShift', () => {
		const data = {
			npcName: 'Guard', topicSummary: 'Directions', playerRevealed: [],
			npcLearned: [], emotionalShift: null, importance: 'trivial',
		};
		expect(conversationDetectionSchema.parse(data).emotionalShift).toBeNull();
	});
});

describe('classificationResultSchema', () => {
	it('accepts full classification result', () => {
		const data = {
			characters: [{ name: 'A', description: null, relationship: null, status: 'active' }],
			locations: [{ name: 'Inn', description: 'Cozy', current: true }],
			items: [{ name: 'Key', description: 'Rusty' }],
			storyBeats: [{ title: 'Arrival', description: 'Hero arrives', significance: 'moderate' }],
		};
		const parsed = classificationResultSchema.parse(data);
		expect(parsed.relationships).toEqual([]);
		expect(parsed.conversations).toEqual([]);
	});

	it('accepts optional mood and timeProgression', () => {
		const data = {
			characters: [], locations: [], items: [], storyBeats: [],
			mood: 'tense', timeProgression: '2 hours later',
		};
		expect(classificationResultSchema.parse(data).mood).toBe('tense');
	});

	it('defaults factionSignals to empty array', () => {
		const data = { characters: [], locations: [], items: [], storyBeats: [] };
		expect(classificationResultSchema.parse(data).factionSignals).toEqual([]);
	});

	it('accepts factionSignals', () => {
		const data = {
			characters: [], locations: [], items: [], storyBeats: [],
			factionSignals: [{
				factionName: 'Lannisters', trigger: 'provoked',
				context: 'Player killed a Lannister guard', urgency: 'high',
			}],
		};
		const parsed = classificationResultSchema.parse(data);
		expect(parsed.factionSignals).toHaveLength(1);
		expect(parsed.factionSignals[0].trigger).toBe('provoked');
	});
});

// ════════════════════════════════════════════════════════════════
// Faction Signals
// ════════════════════════════════════════════════════════════════

describe('factionSignalSchema', () => {
	it('accepts valid faction signal', () => {
		const data = {
			factionName: 'Boltons', trigger: 'threatened',
			context: 'Northern lords are gathering', urgency: 'medium',
		};
		expect(factionSignalSchema.parse(data)).toEqual(data);
	});

	it('defaults urgency to low', () => {
		const data = {
			factionName: 'Freys', trigger: 'informed',
			context: 'A raven arrived',
		};
		expect(factionSignalSchema.parse(data).urgency).toBe('low');
	});

	it('accepts all trigger types', () => {
		for (const trigger of ['threatened', 'opportunity', 'informed', 'provoked', 'weakened']) {
			expect(factionSignalSchema.parse({
				factionName: 'X', trigger, context: 'Y',
			})).toBeTruthy();
		}
	});

	it('rejects invalid trigger type', () => {
		expect(() => factionSignalSchema.parse({
			factionName: 'X', trigger: 'bored', context: 'Y',
		})).toThrow();
	});
});

// ════════════════════════════════════════════════════════════════
// Timeline
// ════════════════════════════════════════════════════════════════

describe('timelineFillEntrySchema', () => {
	it('accepts valid timeline entry', () => {
		const data = { type: 'event', name: 'Battle', description: 'A great battle', keywords: ['war'] };
		expect(timelineFillEntrySchema.parse(data)).toBeTruthy();
	});

	it('accepts all entity types', () => {
		for (const type of ['character', 'location', 'item', 'faction', 'concept', 'event']) {
			expect(timelineFillEntrySchema.parse({ type, name: 'X', description: 'Y', keywords: [] })).toBeTruthy();
		}
	});
});

describe('timelineFillResultSchema', () => {
	it('accepts empty entries array', () => {
		expect(timelineFillResultSchema.parse({ entries: [] }).entries).toEqual([]);
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
// Vault
// ════════════════════════════════════════════════════════════════

describe('vaultQuerySchema', () => {
	it('accepts minimal query', () => {
		const data = { query: 'find warrior' };
		expect(vaultQuerySchema.parse(data)).toBeTruthy();
	});

	it('accepts optional fields', () => {
		const data = { query: 'dragon', entryTypes: ['character'], limit: 10 };
		expect(vaultQuerySchema.parse(data).limit).toBe(10);
	});
});

describe('vaultActionSchema', () => {
	it('accepts valid action', () => {
		const data = { action: 'create', name: 'Dragon', type: 'character', reason: 'Save for reuse' };
		expect(vaultActionSchema.parse(data)).toBeTruthy();
	});

	it('accepts all action types', () => {
		for (const action of ['create', 'update', 'delete', 'link', 'unlink']) {
			expect(vaultActionSchema.parse({ action, reason: 'test' })).toBeTruthy();
		}
	});
});

describe('vaultResultSchema', () => {
	it('accepts valid vault result', () => {
		const data = {
			actions: [{ action: 'create', name: 'X', reason: 'Y' }],
			reasoning: 'Created one entry',
		};
		expect(vaultResultSchema.parse(data)).toBeTruthy();
	});
});

// ════════════════════════════════════════════════════════════════
// Micro-Faction Simulation
// ════════════════════════════════════════════════════════════════

describe('microFactionReactionSchema', () => {
	it('accepts valid reaction', () => {
		const data = {
			action: 'Sent a spy to the northern camp',
			actionType: 'intelligence',
			visible: false,
			rumor: null,
			consequence: 'Boltons now know about the gathering',
		};
		expect(microFactionReactionSchema.parse(data)).toEqual(data);
	});

	it('accepts "none" action type', () => {
		const data = {
			action: 'The faction takes no action',
			actionType: 'none',
			visible: false,
			rumor: null,
			consequence: null,
		};
		expect(microFactionReactionSchema.parse(data).actionType).toBe('none');
	});

	it('accepts visible reaction with rumor', () => {
		const data = {
			action: 'Mobilized troops at the border',
			actionType: 'military',
			visible: true,
			rumor: 'Soldiers were seen marching south from the Dreadfort',
			consequence: 'Road to Winterfell is now patrolled',
		};
		const parsed = microFactionReactionSchema.parse(data);
		expect(parsed.visible).toBe(true);
		expect(parsed.rumor).toBeTruthy();
	});

	it('accepts all action types', () => {
		for (const actionType of ['military', 'diplomatic', 'economic', 'intelligence', 'internal', 'none']) {
			expect(microFactionReactionSchema.parse({
				action: 'x', actionType, visible: false, rumor: null, consequence: null,
			})).toBeTruthy();
		}
	});
});

describe('microFactionResultSchema', () => {
	it('accepts valid result', () => {
		const data = {
			factionName: 'Lannisters',
			reaction: {
				action: 'Recalled their envoy', actionType: 'diplomatic',
				visible: true, rumor: 'The Lannister envoy left in haste',
				consequence: 'Diplomatic relations severed',
			},
		};
		const parsed = microFactionResultSchema.parse(data);
		expect(parsed.factionName).toBe('Lannisters');
		expect(parsed.reaction.actionType).toBe('diplomatic');
	});
});
