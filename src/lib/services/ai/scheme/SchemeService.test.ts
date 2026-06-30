import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/story.svelte', () => ({ story: { currentStory: null, schemes: [], lorebookEntries: [], entries: [] } }));
vi.mock('$lib/stores/settings.svelte', () => ({ settings: { getServiceConfig: () => ({ model: '', temperature: 0, maxTokens: 0, enabled: true, profileId: '', systemPromptOverride: '' }) } }));
vi.mock('$lib/services/ai/sdk/generate', () => ({ generateStructuredWithTools: vi.fn() }));
vi.mock('$lib/services/database', () => ({ getChapters: vi.fn() }));
vi.mock('$lib/services/canonicalWrites', () => ({ saveCanonicalScheme: vi.fn(), saveCanonicalSchemes: vi.fn() }));

import { findUniqueSchemeByIdOrPrefix, shouldEvaluate } from './SchemeService';
import type { Scheme } from '$lib/types';

function scheme(id: string): Scheme {
	return {
		id,
		storyId: 'story-1',
		ownerType: 'faction',
		ownerEntryId: 'faction-1',
		ownerName: 'House A',
		goal: 'secure leverage',
		trigger: 'insult',
		triggerChapter: 1,
		triggerEntryId: null,
		stages: [],
		currentStageIndex: 0,
		pressure: 20,
		status: 'active',
		secrecy: 'secret',
		nextTickAtDay: null,
		branchId: null,
		createdAt: 0,
		updatedAt: 0,
	};
}

describe('SchemeService safety gates', () => {
	it('evaluates schemes for faction-relevant timeline events', () => {
		expect(shouldEvaluate({
			timeline_events: [{
				title: 'A public marriage pact is announced',
				description: '',
				type: 'marriage',
				status: 'committed',
			}],
		} as any)).toBe(true);
	});

	it('rejects ambiguous scheme ID prefixes', () => {
		const schemes = [
			scheme('abcdef12-first-scheme'),
			scheme('abcdef12-second-scheme'),
			scheme('12345678-third-scheme'),
		];

		expect(findUniqueSchemeByIdOrPrefix(schemes, 'abcdef12')).toBeNull();
		expect(findUniqueSchemeByIdOrPrefix(schemes, '12345678')?.id).toBe('12345678-third-scheme');
		expect(findUniqueSchemeByIdOrPrefix(schemes, 'abc')).toBeNull();
	});
});
