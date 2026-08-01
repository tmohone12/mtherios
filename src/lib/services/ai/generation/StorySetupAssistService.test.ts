import { describe, expect, it } from 'vitest';
import { buildStorySetupAssistPrompt, storySetupAssistResultSchema } from './StorySetupAssistService';

describe('buildStorySetupAssistPrompt', () => {
	it('builds a writing-focused prompt that never asks the user to choose providers again', () => {
		const prompt = buildStorySetupAssistPrompt({
			mode: 'creative-writing',
			genre: 'mystery',
			title: '',
			worldDescription: 'A fogbound canal city with missing saints.',
			protagonistName: '',
			protagonistDescription: '',
			notes: 'Make it political and occult.',
			promptPack: 'GM PROMPT PACK: keep the mystery political, occult, and consequence-driven.',
		});

		expect(prompt.system).toContain('story setup writing assistant');
		expect(prompt.system).toContain('Do not discuss provider selection');
		expect(prompt.user).toContain('creative-writing');
		expect(prompt.user).toContain('A fogbound canal city');
		expect(prompt.user).toContain('Make it political and occult.');
		expect(prompt.user).toContain('GM PROMPT PACK: keep the mystery political');
		expect(prompt.user).not.toContain('API key');
	});
});

describe('storySetupAssistResultSchema', () => {
	it('normalizes common lorebook entry shapes returned by models', () => {
		const parsed = storySetupAssistResultSchema.parse({
			title: 'The Shattered Court',
			worldDescription: 'A court of rival heirs and ash-stained banners.',
			lorebookEntries: [
				{
					title: 'House Veyr',
					description: 'A proud border house with a starving army.',
					keywords: ['Veyr', 'border house'],
				},
				{
					label: 'The Red Granary',
					summary: 'A sealed winter storehouse every claimant needs.',
					keyTerms: 'granary, winter, succession',
				},
			],
		});

		expect(parsed.lorebookEntries).toEqual([
			{
				name: 'House Veyr',
				content: 'A proud border house with a starving army.',
				keywords: 'Veyr, border house',
			},
			{
				name: 'The Red Granary',
				content: 'A sealed winter storehouse every claimant needs.',
				keywords: 'granary, winter, succession',
			},
		]);
	});
});
