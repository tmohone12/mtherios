import { afterEach, describe, expect, it } from 'vitest';
import { settings } from './settings.svelte';
import { story } from './story.svelte';

describe('browser narrator prompt authority', () => {
	const originalNarrativeConfig = settings.serviceConfigs.narrative;

	afterEach(() => {
		story.clear();
		const serviceConfigs = { ...settings.serviceConfigs };
		if (originalNarrativeConfig) serviceConfigs.narrative = originalNarrativeConfig;
		else delete serviceConfigs.narrative;
		settings.serviceConfigs = serviceConfigs;
	});

	it('treats player commands as attempts and permits unresolved NPC initiative', () => {
		story.currentStory = {
			id: 'story_prompt_test',
			title: 'Prompt Test',
			description: null,
			genre: null,
			templateId: null,
			mode: 'adventure',
			createdAt: 1,
			updatedAt: 1,
			settings: null,
			memoryConfig: null,
			retryState: null,
			styleReviewState: null,
			timeTracker: null,
			currentBranchId: null,
			currentBgImage: null,
			headerPrompt: null,
			lastWorldSimDay: null,
			compactedLore: null,
			compactedLoreHistory: null,
			meters: null,
		};

		const prompt = story.buildSystemPrompt();

		expect(prompt).toContain('In-world input states attempted intent');
		expect(prompt).toContain('scripted NPC text is non-canon');
		expect(prompt).toContain('no question is needed after NPC answers, actions, or pauses');
		expect(prompt).toContain('Avoid pointed question endings and repeated choices');
		expect(prompt).toContain('Agreement follows evidence and incentives; refusal follows boundaries and cost. Neither is automatic.');
		expect(prompt).toContain('INNER THOUGHT IS NARRATOR-ONLY');
		expect(prompt).toContain('NPCs cannot hear or directly react unless the player also speaks or acts, or they independently infer it from observable evidence.');
		expect(prompt).toContain('A continuation after a roll result is part of the same turn');
		expect(prompt).toContain('{{roll:1d20:15:DEX:Cross the collapsing bridge}}');
		expect(prompt).not.toContain('first-person POV (I/me/my)');
		expect(prompt).toContain('The app rolls automatically and immediately asks you to resume the same turn');
		expect(prompt).not.toContain('Wait for {{user}} to supply the result');
		expect(prompt).toContain('EVERY COMPLETE TURN BEGINS WITH EXACTLY ONE HEADER LINE');
		expect(prompt).not.toContain('interpret and narrate the result');
		expect(prompt).not.toContain('Do NOT end with an NPC speaking new dialogue');
		expect(prompt).not.toContain('THREE-LINE HEADER');
		expect(prompt).not.toContain('Dream Team');
		expect(prompt).not.toContain('### Chronicler Doctrine');
		expect(prompt).not.toContain('WEAVE THIS INTO THE NEXT RESPONSE');
	});

	it('applies a local narrative override without dropping core GM authority', () => {
		settings.serviceConfigs = {
			...settings.serviceConfigs,
			narrative: {
				...settings.getServiceConfig('narrative'),
				systemPromptOverride: 'Narrate in clipped noir prose.',
			},
		};
		story.currentStory = {
			id: 'story_override_test', title: 'Override Test', description: null, genre: null,
			templateId: null, mode: 'adventure', createdAt: 1, updatedAt: 1, settings: null,
			memoryConfig: null, retryState: null, styleReviewState: null, timeTracker: null,
			currentBranchId: null, currentBgImage: null, headerPrompt: null,
			lastWorldSimDay: null, compactedLore: null, compactedLoreHistory: null, meters: null,
		};

		const prompt = story.buildSystemPrompt();

		expect(prompt).toContain('Narrate in clipped noir prose.');
		expect(prompt).toContain('IMMUTABLE CORE GM AUTHORITY');
		expect(prompt).toContain('In-world input states attempted intent');
		expect(prompt).toContain('NPCs act from independent motives, knowledge, boundaries, emotions, and costs');
		expect(prompt).toContain('never cause automatic praise, trust, forgiveness, attraction, or compliance');
		expect(prompt).toContain('NPCs may act, refuse, or ask when warranted');
		expect(prompt).toContain('INNER THOUGHT IS NARRATOR-ONLY');
		expect(prompt).not.toContain('### Chronicler Doctrine');
	});
});
