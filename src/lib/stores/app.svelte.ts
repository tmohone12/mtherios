/**
 * App Store — Mtherios
 * Global application state: current story, onboarding, navigation.
 */

import { deleteSetting, getSetting, setSetting } from '$lib/services/database';

class AppStore {
	onboardingComplete = $state(false);
	currentStoryId = $state<string | null>(null);
	showWizard = $state(false);
	loading = $state(true);

	async init() {
		try {
			const onboarded = await getSetting('onboardingComplete');
			this.onboardingComplete = onboarded === 'true';

			const lastStory = await getSetting('lastStoryId');
			this.currentStoryId = lastStory ?? null;

			if (!this.onboardingComplete) {
				this.showWizard = true;
			}
		} catch (e) {
			console.error('DB init failed:', e);
			// Degrade gracefully — show wizard so user can still set up
			this.showWizard = true;
		} finally {
			this.loading = false;
		}
	}

	startNewStory() {
		this.showWizard = true;
	}

	completeOnboarding(storyId: string) {
		this.onboardingComplete = true;
		this.currentStoryId = storyId;
		this.showWizard = false;
		setSetting('lastStoryId', storyId).catch(e => console.warn('[App] Failed to persist last story:', e));
	}

	openStory(storyId: string) {
		this.currentStoryId = storyId;
		setSetting('lastStoryId', storyId).catch(e => console.warn('[App] Failed to persist last story:', e));
	}

	closeStory() {
		this.currentStoryId = null;
		deleteSetting('lastStoryId').catch(e => console.warn('[App] Failed to clear last story:', e));
	}
}

export const app = new AppStore();
