import { describe, expect, it } from 'vitest';
import {
	DEFAULT_ONBOARDING_GENRE_PROMPT_PACK_ID,
	NEUTRAL_PROMPT_PACK_ID,
	buildGenrePromptPack,
	getOnboardingGenreOption,
	getOnboardingGenreOptions,
	resolveStoryPromptPack,
} from './storyPromptPacks';

describe('onboarding story prompt packs', () => {
	it('replaces generic fantasy with a feudal dark gritty ASOIAF-inspired GM pack', () => {
		const options = getOnboardingGenreOptions();

		expect(options.map((option) => option.id)).not.toContain('fantasy');
		expect(options).toContainEqual(expect.objectContaining({
			id: 'feudal-dark-gritty-asoiaf',
			label: 'Feudal Dark Gritty',
		}));

		const pack = buildGenrePromptPack('feudal-dark-gritty-asoiaf');
		expect(pack).toContain('GM PROMPT PACK');
		expect(pack).toContain('feudal');
		expect(pack).toContain('dark');
		expect(pack).toContain('gritty');
		expect(pack).toContain('ASOIAF-inspired');
	});

	it('keeps the anime power-fantasy doctrine compact, agency-first, and continuity-aware', () => {
		const options = getOnboardingGenreOptions();
		expect(options).toContainEqual(expect.objectContaining({
			id: 'anime-power-fantasy',
			label: 'Anime Power Fantasy',
		}));

		const pack = buildGenrePromptPack('anime-power-fantasy');
		const wordCount = pack.split(/\s+/).length;
		expect(wordCount).toBeGreaterThanOrEqual(200);
		expect(wordCount).toBeLessThanOrEqual(400);
		expect(pack).toContain('Player agency is absolute');
		expect(pack).toContain('Never reset them into an underdog');
		expect(pack).toContain('current anime setting');
		expect(pack).not.toContain('High School DxD');
		expect(pack).toContain('Focus on the 2-4 NPCs');
		expect(pack).toContain('Advance one existing plot pressure');
		expect(pack).toContain('Do not force a cliffhanger');
		expect(pack).toContain('without canned shock lines');
		expect(pack).not.toMatch(/Vael Anot|internal monologue|\bsession\b/i);
	});

	it('defaults missing prompt-pack ids to neutral instead of a genre style', () => {
		expect(DEFAULT_ONBOARDING_GENRE_PROMPT_PACK_ID).toBe('anime-power-fantasy');

		const fallback = getOnboardingGenreOption('missing-pack-id');
		expect(fallback.id).toBe(NEUTRAL_PROMPT_PACK_ID);
		expect(buildGenrePromptPack('missing-pack-id')).toContain('Neutral Narrator');
		expect(buildGenrePromptPack('missing-pack-id')).not.toContain('ASOIAF-inspired court');
	});

	it('resolves prompt packs from explicit ids before genre inference', () => {
		expect(resolveStoryPromptPack({
			promptPackId: 'anime-power-fantasy',
			genre: 'dark fantasy political intrigue',
		}).id).toBe('anime-power-fantasy');
		expect(resolveStoryPromptPack({ genre: 'dark fantasy political intrigue' }).id).toBe('feudal-dark-gritty-asoiaf');
		expect(resolveStoryPromptPack({ genre: 'fantasy' }).id).toBe(NEUTRAL_PROMPT_PACK_ID);
	});
});
