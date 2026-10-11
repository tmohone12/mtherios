import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/story.svelte', () => ({ story: { currentStory: null, schemes: [], lorebookEntries: [], entries: [] } }));
vi.mock('$lib/stores/settings.svelte', () => ({ settings: { getServiceConfig: () => ({ model: '', temperature: 0, maxTokens: 0, enabled: true, profileId: '', systemPromptOverride: '' }) } }));
vi.mock('$lib/services/ai/sdk/generate', () => ({ generateStructuredWithTools: vi.fn() }));
vi.mock('$lib/services/database', () => ({ getChapters: vi.fn() }));
vi.mock('$lib/services/canonicalWrites', () => ({ saveCanonicalScheme: vi.fn() }));

import { declarePlayerScheme } from './SchemeService';
import { story } from '$lib/stores/story.svelte';
import { generateStructuredWithTools } from '$lib/services/ai/sdk/generate';
import { getChapters } from '$lib/services/database';
import { saveCanonicalScheme } from '$lib/services/canonicalWrites';

describe('SchemeService safety gates', () => {
	it('keeps explicit player plan authoring after automatic scheme removal', async () => {
		const localStory = story as any;
		localStory.currentStory = { id: 'story-1', currentBranchId: null, timeTracker: null, serverVersion: 1 };
		localStory.protagonist = { name: 'Mara' };
		localStory.entries = [{ id: 'entry-1' }];
		localStory.schemes = [];
		vi.mocked(getChapters).mockResolvedValue([]);
		vi.mocked(saveCanonicalScheme).mockResolvedValue(2);
		vi.mocked(generateStructuredWithTools).mockResolvedValue({ toolCalls: [{ name: 'declare_player_scheme',
			arguments: { goal: 'Book passage', stages: [{ label: 'Ask clerk', hook: 'Buy a ticket' },
				{ label: 'Board ship', hook: 'Present the ticket' }] } }] } as never);
		const result = await declarePlayerScheme('Book passage');
		expect(result.error).toBeNull();
		expect(result.scheme).toMatchObject({ ownerType: 'player', ownerName: 'Mara', triggerEntryId: 'entry-1' });
		expect(saveCanonicalScheme).toHaveBeenCalledOnce();
		expect(localStory.schemes).toHaveLength(1);
	});

});
