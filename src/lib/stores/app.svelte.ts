/**
 * App Store — Mtherios
 * Global application state: current story, onboarding, navigation.
 */

import { deleteSetting, getSetting, setSetting } from '$lib/services/database';
import { refreshStoryCatalog } from '$lib/services/serverStories';

export type WorkspacePanel = 'content' | 'library' | 'database' | 'engine' | 'terminal';
export type StoryTab = 'play' | 'lore' | 'chapters';
const historyKey = 'mythengineViewIndex';
const workspacePanels: WorkspacePanel[] = ['content', 'library', 'database', 'engine', 'terminal'];
const storyTabs: StoryTab[] = ['play', 'lore', 'chapters'];

class AppStore {
	onboardingComplete = $state(false);
	currentStoryId = $state<string | null>(null);
	pendingStoryEntryId = $state<string | null>(null);
	activeShelfId = $state<string | null>(null);
	showWizard = $state(false);
	loading = $state(true);
	workspacePanel = $state<WorkspacePanel>('library');
	storyTab = $state<StoryTab>('play');
	private navigationGuards = new Set<() => boolean>();
	private historyIndex = 0;
	private acceptedUrl = '';
	private restoringHistory = false;
	private navigationReady = false;
	private knownStoryIds = new Map<string, string>();

	registerNavigationGuard(guard: () => boolean) {
		this.navigationGuards.add(guard);
		return () => { this.navigationGuards.delete(guard); };
	}

	private canNavigate() {
		return !this.restoringHistory && [...this.navigationGuards].every(guard => guard());
	}

	private readLocation() {
		const params = new URL(window.location.href).searchParams;
		const panel = params.get('workspace') as WorkspacePanel;
		const tab = params.get('tab') as StoryTab;
		const storyId = params.get('story');
		return {
			storyId: storyId ? this.knownStoryIds.get(storyId) ?? null : null,
			panel: workspacePanels.includes(panel) ? panel : params.has('source') ? 'content' as const : 'library' as const,
			tab: storyTabs.includes(tab) ? tab : 'play' as const,
		};
	}

	private writeLocation(replace = false) {
		if (!this.navigationReady) return;
		const url = new URL(window.location.href);
		url.searchParams.set('workspace', this.workspacePanel);
		if (this.currentStoryId) {
			url.searchParams.set('story', this.currentStoryId);
			url.searchParams.set('tab', this.storyTab);
		} else {
			url.searchParams.delete('story');
			url.searchParams.delete('tab');
		}
		if (!replace && url.href === this.acceptedUrl) return;
		if (!replace) this.historyIndex += 1;
		// These are views within one route. Retain SvelteKit's route state so
		// its router does not reload data or unmount a guarded editor on popstate.
		const state = { ...window.history.state, [historyKey]: this.historyIndex };
		window.history[replace ? 'replaceState' : 'pushState'](state, '', url);
		this.acceptedUrl = url.href;
	}

	private persistStory() {
		const saving = this.currentStoryId
			? setSetting('lastStoryId', this.currentStoryId)
			: deleteSetting('lastStoryId');
		saving.catch(error => console.warn('[App] Failed to persist current story:', error));
	}

	private onPopState = (event: PopStateEvent) => {
		const nextIndex = event.state?.[historyKey];
		if (this.restoringHistory && nextIndex === this.historyIndex) {
			this.restoringHistory = false;
			return;
		}
		const next = this.readLocation();
		const changed = next.storyId !== this.currentStoryId || next.panel !== this.workspacePanel || next.tab !== this.storyTab || this.showWizard;
		if (changed && !this.canNavigate()) {
			if (Number.isSafeInteger(nextIndex) && nextIndex !== this.historyIndex) {
				this.restoringHistory = true;
				window.history.go(this.historyIndex - nextIndex);
			} else {
				// An untracked same-document entry (for example an old bookmark)
				// has no reliable traversal direction. Keep the editor and its URL.
				window.history.pushState({ ...window.history.state, [historyKey]: this.historyIndex }, '', this.acceptedUrl);
			}
			return;
		}
		this.historyIndex = Number.isSafeInteger(nextIndex) ? nextIndex : this.historyIndex;
		this.currentStoryId = next.storyId;
		this.workspacePanel = next.panel;
		this.storyTab = next.tab;
		this.pendingStoryEntryId = null;
		this.showWizard = !this.onboardingComplete;
		this.persistStory();
		this.writeLocation(true);
	};

	private onBeforeUnload = (event: BeforeUnloadEvent) => {
		if ([...this.navigationGuards].every(guard => guard())) return;
		event.preventDefault();
		event.returnValue = '';
	};

	disposeNavigation() {
		if (typeof window !== 'undefined') {
			window.removeEventListener('popstate', this.onPopState);
			window.removeEventListener('beforeunload', this.onBeforeUnload);
		}
		this.navigationReady = false;
		this.restoringHistory = false;
	}

	async init() {
		this.disposeNavigation();
		try {
			const onboarded = await getSetting('onboardingComplete');
			const lastStory = await getSetting('lastStoryId');
			const lastShelf = await getSetting('lastShelfId');
			const catalog = await refreshStoryCatalog().catch((error) => {
				console.warn('[App] Backend story catalog unavailable during startup:', error);
				return null;
			});
			const catalogStoryIds = new Set((catalog ?? []).map((story) => story.id));
			this.knownStoryIds = new Map();
			for (const story of catalog ?? []) {
				this.knownStoryIds.set(story.id, story.id);
				if (story.serverStoryId) this.knownStoryIds.set(story.serverStoryId, story.id);
			}
			const recoveredStoryId = lastStory && catalogStoryIds.has(lastStory)
				? lastStory
				: catalog?.length === 1
					? catalog[0]?.id ?? null
					: catalog === null ? lastStory ?? null : null;

			const params = typeof window !== 'undefined' ? new URL(window.location.href).searchParams : null;
			const explicitView = params?.has('story') || params?.has('workspace') || params?.has('source');
			const location = params ? this.readLocation() : null;
			this.currentStoryId = explicitView ? location?.storyId ?? null : recoveredStoryId;
			this.onboardingComplete = onboarded === 'true' || Boolean(this.currentStoryId || recoveredStoryId);
			if (this.currentStoryId) this.knownStoryIds.set(this.currentStoryId, this.currentStoryId);
			this.workspacePanel = location?.panel ?? 'library';
			this.storyTab = location?.tab ?? 'play';
			this.activeShelfId = catalog?.find((story) => story.id === this.currentStoryId)?.shelfId ?? lastShelf ?? null;

			if (this.currentStoryId) {
				await setSetting('onboardingComplete', 'true');
				await setSetting('lastStoryId', this.currentStoryId);
			} else if (lastStory && (explicitView || catalog !== null)) {
				await deleteSetting('lastStoryId');
			}

			this.showWizard = !this.onboardingComplete;
			if (typeof window !== 'undefined') {
				const index = window.history.state?.[historyKey];
				this.historyIndex = Number.isSafeInteger(index) ? index : 0;
				this.navigationReady = true;
				this.writeLocation(true);
				window.addEventListener('popstate', this.onPopState);
				window.addEventListener('beforeunload', this.onBeforeUnload);
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
		if (!this.canNavigate()) return false;
		this.activeShelfId = shelfId ?? this.activeShelfId;
		if (this.activeShelfId) setSetting('lastShelfId', this.activeShelfId).catch(e => console.warn('[App] Failed to persist last shelf:', e));
		this.showWizard = true;
		return true;
	}

	completeOnboarding(storyId: string) {
		this.onboardingComplete = true;
		this.showWizard = false;
		this.openStory(storyId);
	}

	openStory(storyId: string) {
		if (!this.canNavigate()) return false;
		storyId = this.knownStoryIds.get(storyId) ?? storyId;
		this.pendingStoryEntryId = null;
		this.currentStoryId = storyId;
		this.knownStoryIds.set(storyId, storyId);
		this.storyTab = 'play';
		this.showWizard = false;
		this.persistStory();
		this.writeLocation();
		return true;
	}

	openStorySource(storyId: string, entryId: string) {
		if (!this.openStory(storyId)) return false;
		this.pendingStoryEntryId = entryId;
		return true;
	}

	selectWorkspace(panel: WorkspacePanel) {
		if (!workspacePanels.includes(panel)) return false;
		if (!this.currentStoryId && panel === this.workspacePanel && !this.showWizard) return true;
		if (!this.canNavigate()) return false;
		this.workspacePanel = panel;
		this.currentStoryId = null;
		this.pendingStoryEntryId = null;
		this.storyTab = 'play';
		this.showWizard = false;
		this.persistStory();
		this.writeLocation();
		return true;
	}

	selectStoryTab(tab: StoryTab) {
		if (!storyTabs.includes(tab)) return false;
		if (tab === this.storyTab) return true;
		if (!this.canNavigate()) return false;
		this.storyTab = tab;
		this.writeLocation();
		return true;
	}

	openShelf(shelfId: string | null) {
		this.activeShelfId = shelfId;
		if (shelfId) setSetting('lastShelfId', shelfId).catch(e => console.warn('[App] Failed to persist last shelf:', e));
		else deleteSetting('lastShelfId').catch(e => console.warn('[App] Failed to clear last shelf:', e));
	}

	closeStory(options: { replace?: boolean } = {}) {
		if (!this.canNavigate()) return false;
		this.pendingStoryEntryId = null;
		this.currentStoryId = null;
		this.storyTab = 'play';
		this.persistStory();
		this.writeLocation(options.replace);
		return true;
	}
}

export const app = new AppStore();
