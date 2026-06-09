import { describe, expect, it } from 'vitest';
import {
	chooseEntityResolution,
	normalizeEntityName,
	scoreEntityNameSimilarity,
	type EntityResolutionCandidate,
} from './entityResolver';

function candidate(overrides: Partial<EntityResolutionCandidate>): EntityResolutionCandidate {
	return {
		entityId: 'entity_1',
		type: 'character',
		name: 'Mira Vey',
		aliases: ['Mira'],
		score: 0.9,
		signals: ['fuzzy:name', 'same:type'],
		sourceEntryIds: [],
		sourceEventIds: [],
		sourcePatchIds: [],
		...overrides,
	};
}

describe('entity resolver identity scoring', () => {
	it('normalizes names for stable lookup across casing, punctuation, and articles', () => {
		expect(normalizeEntityName('The Glass-Market Smuggler')).toBe('glass market smuggler');
		expect(normalizeEntityName('Mira Vey')).toBe('mira vey');
	});

	it('treats a short alias as a strong possible match for a canonical name', () => {
		expect(scoreEntityNameSimilarity('Mira', 'Mira Vey')).toBeGreaterThanOrEqual(0.82);
	});

	it('updates strong matches instead of creating duplicate entities', () => {
		const resolution = chooseEntityResolution({
			candidates: [
				candidate({ entityId: 'char_mira', score: 0.9 }),
			],
		});

		expect(resolution.decision).toBe('update');
		expect(resolution.entityId).toBe('char_mira');
	});

	it('asks instead of auto-merging when candidates are too close', () => {
		const resolution = chooseEntityResolution({
			candidates: [
				candidate({ entityId: 'char_mira_vey', name: 'Mira Vey', score: 0.79 }),
				candidate({ entityId: 'char_mira_ves', name: 'Mira Ves', score: 0.75 }),
			],
		});

		expect(resolution.decision).toBe('ask');
		expect(resolution.candidates.map((item) => item.entityId)).toEqual(['char_mira_vey', 'char_mira_ves']);
	});

	it('marks requested-id drift as a merge when an existing entity is a strong match', () => {
		const resolution = chooseEntityResolution({
			requestedId: 'char_new_mira',
			candidates: [
				candidate({ entityId: 'char_mira', score: 0.94, signals: ['exact:alias', 'same:type'] }),
			],
		});

		expect(resolution.decision).toBe('merge');
		expect(resolution.entityId).toBe('char_mira');
	});
});
