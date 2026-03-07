/**
 * Settings Store — Mtherios
 * Persists all settings to IndexedDB. Loads on init.
 */

import { getSetting, setSetting, getAllSettings } from '$lib/services/database';
import { PROVIDERS, type ProviderConfig } from '$lib/services/ai/sdk/providers/config';
import type { UISettings, APIProfile, ProviderType, ReasoningEffort } from '$lib/types';

// ── Service Settings ──
export interface NarrativeSettings {
	model: string;
	temperature: number;
	maxTokens: number;
	reasoningEffort: ReasoningEffort;
}

export interface ClassifierSettings {
	model: string;
	temperature: number;
	maxTokens: number;
	chatHistoryTruncation: number;
}

export interface SystemServicesSettings {
	classifier: ClassifierSettings;
	timelineFill: { enabled: boolean; mode: 'static' | 'agentic'; maxQueries: number };
	loreManagement: { maxIterations: number };
	agenticRetrieval: { maxIterations: number };
}

class SettingsStore {
	// ── API Profiles ──
	profiles = $state<APIProfile[]>([]);
	activeProfileId = $state<string | null>(null);

	// ── Narrative Generation Settings ──
	narrativeSettings = $state<NarrativeSettings>({
		model: '',
		temperature: 1.0,
		maxTokens: 4096,
		reasoningEffort: 'off',
	});

	// ── UI Settings ──
	uiSettings = $state<UISettings>({
		theme: 'mtherios',
		fontSize: 'medium',
		fontFamily: 'Cormorant Garamond',
		fontSource: 'google',
		showWordCount: true,
		autoSave: true,
		spellcheckEnabled: false,
		debugMode: false,
		disableSuggestions: false,
		disableActionPrefixes: false,
		showReasoning: false,
		sidebarWidth: 380,
		autoScroll: true,
		showScrollToTop: true,
		showScrollToBottom: true,
	});

	serviceSpecificSettings = $state<{
		contextWindow?: Record<string, number>;
		lorebookLimits?: Record<string, number>;
		agenticRetrieval?: Record<string, number>;
	}>({});

	systemServicesSettings = $state<SystemServicesSettings>({
		classifier: { model: '', temperature: 0.5, maxTokens: 8192, chatHistoryTruncation: 100 },
		timelineFill: { enabled: false, mode: 'static', maxQueries: 5 },
		loreManagement: { maxIterations: 5 },
		agenticRetrieval: { maxIterations: 10 },
	});

	translationSettings = $state({
		enabled: false,
		targetLanguage: 'en',
		sourceLanguage: 'en',
		translateUserInput: false,
		translateWorldState: false,
	});

	// ── Derived ──
	get activeProfile(): APIProfile | null {
		if (!this.activeProfileId) return this.profiles[0] ?? null;
		return this.profiles.find(p => p.id === this.activeProfileId) ?? this.profiles[0] ?? null;
	}

	get activeProvider(): ProviderConfig | null {
		const profile = this.activeProfile;
		if (!profile) return null;
		return PROVIDERS[profile.providerType as ProviderType] ?? null;
	}

	get needsApiKey(): boolean {
		return !this.activeProfile?.apiKey;
	}

	// ── Init (load from IndexedDB) ──
	async init() {
		try {
			const all = await getAllSettings();

			// Profiles
			if (all.apiProfiles) {
				try { this.profiles = JSON.parse(all.apiProfiles); } catch { /* keep default */ }
			}
			this.activeProfileId = all.activeProfileId ?? null;

			// Narrative settings
			if (all.narrativeSettings) {
				try { Object.assign(this.narrativeSettings, JSON.parse(all.narrativeSettings)); } catch { /* keep default */ }
			} else if (this.activeProvider?.services?.narrative) {
				// Initialize from provider defaults
				const defaults = this.activeProvider.services.narrative;
				this.narrativeSettings.model = defaults.model;
				this.narrativeSettings.temperature = defaults.temperature;
				this.narrativeSettings.maxTokens = defaults.maxTokens;
				this.narrativeSettings.reasoningEffort = defaults.reasoningEffort;
			}

			// Narrative model override
			if (all.narrativeModel) {
				this.narrativeSettings.model = all.narrativeModel;
			}

			// UI settings
			if (all.uiSettings) {
				try { Object.assign(this.uiSettings, JSON.parse(all.uiSettings)); } catch { /* keep default */ }
			}

			// System services
			if (all.systemServicesSettings) {
				try { Object.assign(this.systemServicesSettings, JSON.parse(all.systemServicesSettings)); } catch { /* keep default */ }
			}
		} catch (e) {
			console.error('Settings init failed:', e);
		}
	}

	// ── Persistence ──
	async saveProfiles() {
		await setSetting('apiProfiles', JSON.stringify(this.profiles));
		if (this.activeProfileId) await setSetting('activeProfileId', this.activeProfileId);
	}

	async saveNarrativeSettings() {
		await setSetting('narrativeSettings', JSON.stringify(this.narrativeSettings));
		await setSetting('narrativeModel', this.narrativeSettings.model);
	}

	async saveUISettings() {
		await setSetting('uiSettings', JSON.stringify(this.uiSettings));
	}

	async setActiveProfile(profileId: string) {
		this.activeProfileId = profileId;
		await setSetting('activeProfileId', profileId);

		// Reset narrative model to provider default
		const profile = this.profiles.find(p => p.id === profileId);
		if (profile) {
			const provider = PROVIDERS[profile.providerType as ProviderType];
			if (provider?.services?.narrative) {
				this.narrativeSettings.model = provider.services.narrative.model;
				await this.saveNarrativeSettings();
			}
		}
	}

	async addProfile(profile: APIProfile) {
		this.profiles = [...this.profiles, profile];
		if (!this.activeProfileId) this.activeProfileId = profile.id;
		await this.saveProfiles();
	}

	async removeProfile(profileId: string) {
		this.profiles = this.profiles.filter(p => p.id !== profileId);
		if (this.activeProfileId === profileId) {
			this.activeProfileId = this.profiles[0]?.id ?? null;
		}
		await this.saveProfiles();
	}

	// Convenience
	setTheme(theme: string) { this.uiSettings.theme = theme as any; }
	setFontSize(size: 'small' | 'medium' | 'large') { this.uiSettings.fontSize = size; }
	setSidebarWidth(width: number) { this.uiSettings.sidebarWidth = width; }

	getServicePresetId(_serviceId: string): string | undefined { return undefined; }
	getImageProfile(_profileId: string): { model: string } | undefined { return undefined; }
}

export const settings = new SettingsStore();
