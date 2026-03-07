/**
 * Settings Store — Mtherios
 * Persists all settings to IndexedDB. Loads on init.
 */

import { getSetting, setSetting, getAllSettings } from '$lib/services/database';
import { PROVIDERS, type ProviderConfig } from '$lib/services/ai/sdk/providers/config';
import type { UISettings, APIProfile, ProviderType, ReasoningEffort } from '$lib/types';

// ── Per-Service Configuration ──
export interface ServiceConfig {
	model: string;
	temperature: number;
	maxTokens: number;
	systemPromptOverride: string; // empty = use default
	enabled: boolean;
}

export const SERVICE_DEFINITIONS: Record<string, { label: string; description: string; category: string; defaultTemp: number; defaultMaxTokens: number }> = {
	narrative: { label: 'Narrative', description: 'Main story generation', category: 'Generation', defaultTemp: 1.0, defaultMaxTokens: 4096 },
	classifier: { label: 'Classifier', description: 'Extract world state from narrative', category: 'Generation', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	suggestions: { label: 'Suggestions', description: 'Generate action suggestions', category: 'Generation', defaultTemp: 0.8, defaultMaxTokens: 2048 },
	actionChoices: { label: 'Action Choices', description: 'Generate branching choices', category: 'Generation', defaultTemp: 0.8, defaultMaxTokens: 2048 },
	memory: { label: 'Memory', description: 'Chapter summarization & retrieval', category: 'Memory', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	styleReviewer: { label: 'Style Reviewer', description: 'Review narrative quality', category: 'Quality', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	timelineFill: { label: 'Timeline Fill', description: 'Auto-generate lorebook entries', category: 'Lorebook', defaultTemp: 0.5, defaultMaxTokens: 4096 },
	loreManagement: { label: 'Lore Management', description: 'Curate lorebook automatically', category: 'Lorebook', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	agenticRetrieval: { label: 'Agentic Retrieval', description: 'Multi-step context retrieval', category: 'Retrieval', defaultTemp: 0.3, defaultMaxTokens: 2048 },
	interactiveVault: { label: 'Interactive Vault', description: 'Natural language lorebook management', category: 'Lorebook', defaultTemp: 0.5, defaultMaxTokens: 4096 },
	imageGeneration: { label: 'Image Generation', description: 'Scene image generation', category: 'Image', defaultTemp: 0.7, defaultMaxTokens: 1024 },
};

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

	// ── Per-Service Configs ──
	serviceConfigs = $state<Record<string, ServiceConfig>>({});

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

			// Service configs
			if (all.serviceConfigs) {
				try { this.serviceConfigs = JSON.parse(all.serviceConfigs); } catch { /* keep default */ }
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

	async saveServiceConfigs() {
		await setSetting('serviceConfigs', JSON.stringify(this.serviceConfigs));
	}

	getServiceConfig(serviceId: string): ServiceConfig {
		const existing = this.serviceConfigs[serviceId];
		if (existing) return existing;
		const def = SERVICE_DEFINITIONS[serviceId];
		return {
			model: '',
			temperature: def?.defaultTemp ?? 0.5,
			maxTokens: def?.defaultMaxTokens ?? 4096,
			systemPromptOverride: '',
			enabled: true,
		};
	}

	async setServiceConfig(serviceId: string, config: Partial<ServiceConfig>) {
		const current = this.getServiceConfig(serviceId);
		this.serviceConfigs = { ...this.serviceConfigs, [serviceId]: { ...current, ...config } };
		await this.saveServiceConfigs();
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
