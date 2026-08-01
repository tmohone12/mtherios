/**
 * App Store — Mtherios
 * Global application state: current story, onboarding, navigation.
 */

import { deleteSetting, getSetting, setSetting } from '$lib/services/database';
import { refreshStoryCatalog } from '$lib/services/serverStories';

class AppStore {
	onboardingComplete = $state(false);
	currentStoryId = $state<string | null>(null);
	activeShelfId = $state<string | null>(null);
	showWizard = $state(false);
	loading = $state(true);

	async init() {
		try {
			const onboarded = await getSetting('onboardingComplete');
			const lastStory = await getSetting('lastStoryId');
			const lastShelf = await getSetting('lastShelfId');
			const catalog = await refreshStoryCatalog().catch((error) => {
				console.warn('[App] Backend story catalog unavailable during startup:', error);
				return null;
			});
			const catalogStoryIds = new Set((catalog ?? []).map((story) => story.id));
			const recoveredStoryId = lastStory && catalogStoryIds.has(lastStory)
				? lastStory
				: catalog?.length === 1
					? catalog[0]?.id ?? null
					: catalog === null ? lastStory ?? null : null;

			this.onboardingComplete = onboarded === 'true' || Boolean(recoveredStoryId);
			this.currentStoryId = recoveredStoryId;
			this.activeShelfId = lastShelf ?? catalog?.find((story) => story.id === recoveredStoryId)?.shelfId ?? null;

			if (recoveredStoryId) {
				await setSetting('onboardingComplete', 'true');
				await setSetting('lastStoryId', recoveredStoryId);
			} else if (lastStory && catalog !== null) {
				await deleteSetting('lastStoryId');
			}

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

	startNewStory(shelfId?: string | null) {
		this.activeShelfId = shelfId ?? this.activeShelfId;
		if (this.activeShelfId) setSetting('lastShelfId', this.activeShelfId).catch(e => console.warn('[App] Failed to persist last shelf:', e));
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

	openShelf(shelfId: string | null) {
		this.activeShelfId = shelfId;
		if (shelfId) setSetting('lastShelfId', shelfId).catch(e => console.warn('[App] Failed to persist last shelf:', e));
		else deleteSetting('lastShelfId').catch(e => console.warn('[App] Failed to clear last shelf:', e));
	}

	closeStory() {
		this.currentStoryId = null;
		deleteSetting('lastStoryId').catch(e => console.warn('[App] Failed to clear last story:', e));
	}
}

export const app = new AppStore();
