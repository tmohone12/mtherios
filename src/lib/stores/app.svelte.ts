/**
 * App Store — Mtherios
 * Global application state: current story, onboarding, navigation.
 */

import { getSetting } from '$lib/services/database';

class AppStore {
	onboardingComplete = $state(false);
	currentStoryId = $state<string | null>(null);
	showWizard = $state(false);
	loading = $state(true);

	async init() {
		const onboarded = await getSetting('onboardingComplete');
		this.onboardingComplete = onboarded === 'true';

		const lastStory = await getSetting('lastStoryId');
		this.currentStoryId = lastStory ?? null;

		this.loading = false;

		// Show wizard if not onboarded
		if (!this.onboardingComplete) {
			this.showWizard = true;
		}
	}

	startNewStory() {
		this.showWizard = true;
	}

	completeOnboarding(storyId: string) {
		this.onboardingComplete = true;
		this.currentStoryId = storyId;
		this.showWizard = false;
	}

	openStory(storyId: string) {
		this.currentStoryId = storyId;
	}

	closeStory() {
		this.currentStoryId = null;
	}
}

export const app = new AppStore();
