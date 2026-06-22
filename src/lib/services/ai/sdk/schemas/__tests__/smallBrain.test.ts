import { describe, expect, it } from 'vitest';
import {
	smallBrainCanonResultSchema,
	smallBrainContextResultSchema,
	smallBrainResultSchema,
	smallBrainWorldResultSchema,
} from '../smallBrain';
import { smallBrainRunRequestSchema, smallBrainRunResponseSchema } from '../../../../../contracts/engine';

describe('smallBrain schemas', () => {
	it('accepts valid output for each mode', () => {
		expect(smallBrainResultSchema.parse({
			mode: 'context',
			brief: 'Recent court pressure matters.',
			relevantEntryIds: ['entry_1'],
		}).mode).toBe('context');

		expect(smallBrainResultSchema.parse({
			mode: 'canon',
			proposals: [{
				kind: 'fact',
				summary: 'Aurion controls the western granaries.',
				confidence: 0.75,
			}],
		}).mode).toBe('canon');

		expect(smallBrainResultSchema.parse({
			mode: 'world',
			npcIntents: [{
				name: 'Vaelar',
				intent: 'Secure grain leverage.',
				pressure: 0.6,
			}],
			strategicPulse: [{
				label: 'Grain road tension',
				pressure: 0.7,
				recommendedAttention: 'Watch merchant movement.',
			}],
			wikiDrafts: [{
				title: 'Western Granaries',
				body: 'A contested food reserve.',
			}],
		}).mode).toBe('world');
	});

	it('rejects unknown mode', () => {
		expect(() => smallBrainResultSchema.parse({ mode: 'other' })).toThrow();
	});

	it('rejects unknown result keys', () => {
		expect(() => smallBrainResultSchema.parse({
			mode: 'context',
			brief: 'Useful context.',
			extra: true,
		})).toThrow();

		expect(() => smallBrainCanonResultSchema.parse({
			mode: 'canon',
			proposals: [{
				kind: 'fact',
				summary: 'Aurion controls the western granaries.',
				confidence: 0.75,
				extra: true,
			}],
		})).toThrow();
	});

	it('rejects confidence or pressure outside 0..1', () => {
		expect(() => smallBrainCanonResultSchema.parse({
			mode: 'canon',
			proposals: [{ kind: 'fact', summary: 'x', confidence: 1.1 }],
		})).toThrow();

		expect(() => smallBrainWorldResultSchema.parse({
			mode: 'world',
			npcIntents: [{ name: 'x', intent: 'y', pressure: -0.1 }],
		})).toThrow();
	});

	it('applies default arrays', () => {
		expect(smallBrainContextResultSchema.parse({
			mode: 'context',
			brief: 'Useful context.',
		})).toMatchObject({
			relevantEntryIds: [],
			relevantEntityIds: [],
			relevantFactionIds: [],
			promptNotes: [],
			uncertainties: [],
		});

		expect(smallBrainCanonResultSchema.parse({ mode: 'canon' })).toEqual({
			mode: 'canon',
			proposals: [],
			rejected: [],
		});

		expect(smallBrainWorldResultSchema.parse({ mode: 'world' })).toEqual({
			mode: 'world',
			npcIntents: [],
			strategicPulse: [],
			wikiDrafts: [],
		});
	});

	it('coerces request limit from string and rejects over 50', () => {
		expect(smallBrainRunRequestSchema.parse({
			storyId: 'story_1',
			mode: 'context',
			limit: '12',
		}).limit).toBe(12);

		expect(() => smallBrainRunRequestSchema.parse({
			storyId: 'story_1',
			mode: 'context',
			limit: 51,
		})).toThrow();
	});

	it('rejects unknown request keys', () => {
		expect(() => smallBrainRunRequestSchema.parse({
			storyId: 'story_1',
			mode: 'context',
			extra: true,
		})).toThrow();
	});

	it('rejects ok responses without a result', () => {
		expect(() => smallBrainRunResponseSchema.parse({
			ok: true,
			storyId: 'story_1',
			mode: 'context',
			model: 'test-model',
			result: null,
			warnings: [],
		})).toThrow();
	});

	it('rejects responses where mode disagrees with result mode', () => {
		expect(() => smallBrainRunResponseSchema.parse({
			ok: false,
			storyId: 'story_1',
			mode: 'canon',
			model: 'test-model',
			result: {
				mode: 'context',
				brief: 'Useful context.',
			},
			warnings: [],
		})).toThrow();
	});
});
