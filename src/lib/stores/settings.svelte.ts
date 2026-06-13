/**
 * Settings Store — Mtherios
 * Persists all settings to IndexedDB. Loads on init.
 */

import { getSetting, setSetting, getAllSettings } from '$lib/services/database';
import { PROVIDERS, type ProviderConfig } from '$lib/services/ai/sdk/providers/config';
import { DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET } from '$lib/services/memorySettings';
import type { UISettings, APIProfile, ProviderType, ReasoningEffort } from '$lib/types';

// ── Per-Service Configuration ──
export interface ServiceConfig {
	model: string;
	temperature: number;
	maxTokens: number;
	systemPromptOverride: string; // empty = use default
	enabled: boolean;
	profileId: string; // API profile to use — empty = active profile (default)
}

export const SERVICE_DEFINITIONS: Record<string, { label: string; description: string; profile: string; defaultTemp: number; defaultMaxTokens: number }> = {
	narrative: { label: 'Narrative', description: 'Main story generation', profile: 'narrative', defaultTemp: 1.0, defaultMaxTokens: 4096 },
	classifier: { label: 'Classifier', description: 'Extract world state from narrative', profile: 'worldState', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	suggestions: { label: 'Suggestions', description: 'Generate action suggestions', profile: 'guidance', defaultTemp: 0.8, defaultMaxTokens: 2048 },
	actionChoices: { label: 'Action Choices', description: 'Generate branching choices', profile: 'guidance', defaultTemp: 0.8, defaultMaxTokens: 2048 },
	memory: { label: 'Memory', description: 'Chapter summarization & retrieval', profile: 'memoryContext', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	styleReviewer: { label: 'Style Reviewer', description: 'Review narrative quality', profile: 'style', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	loreManagement: { label: 'Lore Management', description: 'Discover and curate lorebook entries automatically', profile: 'lorebook', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	entryRefinement: { label: 'Entry Refinement', description: 'Per-entry AI refinement from the lorebook entry modal', profile: 'lorebook', defaultTemp: 0.4, defaultMaxTokens: 4096 },
	imageGeneration: { label: 'Image Generation', description: 'Scene image generation', profile: 'image', defaultTemp: 0.7, defaultMaxTokens: 1024 },
	worldSimulation: { label: 'World Simulation', description: 'Living world DM — plot injection, faction movements, rumors, world tension', profile: 'worldState', defaultTemp: 0.6, defaultMaxTokens: 8192 },
	strategicWorldBrain: { label: 'Strategic World Brain', description: 'Deep arc-level simulation for factions, schemes, plots, subplots, and world pressure', profile: 'deepSimulation', defaultTemp: 0.45, defaultMaxTokens: 9000 },
	arcCondensation: { label: 'Arc Condensation', description: 'Condense chapters into arc summaries', profile: 'memoryContext', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	sagaCondensation: { label: 'Saga Condensation', description: 'Condense arcs into long-term saga summaries', profile: 'memoryContext', defaultTemp: 0.25, defaultMaxTokens: 4096 },
	proceduralMemory: { label: 'Procedural Memory', description: 'CASS-inspired narrative rule extraction and injection', profile: 'memoryContext', defaultTemp: 0.4, defaultMaxTokens: 4096 },
	wikiLint: { label: 'Wiki Lint', description: 'Health-check the lorebook for contradictions, stale claims, orphan entries, and missing entries.', profile: 'lorebook', defaultTemp: 0.2, defaultMaxTokens: 16384 },
};

// ── Service Profile Groups ──
// Services in the same profile share one LLM model setting.
export interface ServiceProfile {
	id: string;
	label: string;
	description: string;
	icon: string;
	serviceIds: string[];
}

export const SERVICE_PROFILES: ServiceProfile[] = [
	{ id: 'deepSimulation', label: 'Deep Simulation', description: 'Rare strategic planning for factions, schemes, plots, and arc pressure', icon: 'S', serviceIds: ['strategicWorldBrain'] },
	{ id: 'narrative', label: 'Narrative', description: 'Main story generation engine', icon: '✍️', serviceIds: ['narrative'] },
	{ id: 'worldState', label: 'World State', description: 'Extracts characters, locations, items, living world simulation, and plot momentum', icon: '🌍', serviceIds: ['classifier', 'worldSimulation'] },
	{ id: 'guidance', label: 'Player Guidance', description: 'Suggestions and branching action choices', icon: '🧭', serviceIds: ['suggestions', 'actionChoices'] },
	{ id: 'memoryContext', label: 'Memory & Context', description: 'Chapter, arc, saga, and procedural memory', icon: '🧠', serviceIds: ['memory', 'arcCondensation', 'sagaCondensation', 'proceduralMemory'] },
	{ id: 'lorebook', label: 'Lorebook', description: 'Discover, curate, query, and lint lore entries', icon: '📜', serviceIds: ['loreManagement', 'entryRefinement', 'wikiLint'] },
	{ id: 'style', label: 'Style Review', description: 'POV, tense, and prose quality checks', icon: '✨', serviceIds: ['styleReviewer'] },
	{ id: 'image', label: 'Image Generation', description: 'Scene and character image generation', icon: '🎨', serviceIds: ['imageGeneration'] },
];

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
	loreManagement: { maxIterations: number };
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
		imageGenerationMode: 'none',
		imageStyle: 'asoiaf',
		imageCustomStyle: '',
		imageSize: '1024x1024',
		imageModel: '',
		imageProfileId: '',
		imageCharacterPrompt: '',
		// Memory settings
		maxMessages: 250,
		maxHistoryEntries: 50,
		chapterThreshold: 20,
		postChapterBuffer: 10,
		maxPrevChaptersInSummary: 5,
		chaptersPerArc: 5,
		retrievedChapterLimit: 3,
		retrievedLoreEntryLimit: 8,
		conversationMemoryLimit: 6,
		proceduralMemoryLimit: 8,
		backendMemoryTokenBudget: DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET,
		snapshotTokenCap: 0,
		serverAuthoritativeTurns: true,
	});

	// ── Per-Service Configs ──
	serviceConfigs = $state<Record<string, ServiceConfig>>({});
	profileModels = $state<Record<string, string>>({});

	serviceSpecificSettings = $state<{
		contextWindow?: Record<string, number>;
		lorebookLimits?: Record<string, number>;
	}>({});

	systemServicesSettings = $state<SystemServicesSettings>({
		classifier: { model: '', temperature: 0.5, maxTokens: 8192, chatHistoryTruncation: 100 },
		loreManagement: { maxIterations: 5 },
	});

	translationSettings = $state({
		enabled: false,
		targetLanguage: 'en',
		sourceLanguage: 'en',
		translateUserInput: false,
		translateWorldState: false,
	});

	/** Context budget in tokens (0 = auto: 30% tiers + 60% history of model context) */
	contextBudget = $state(0);

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

	getProfile(profileId?: string | null): APIProfile | null {
		if (!profileId) return this.activeProfile;
		return this.profiles.find(p => p.id === profileId) ?? null;
	}

	getServiceProfile(serviceId: string): APIProfile | null {
		const config = this.getServiceConfig(serviceId);
		return this.getProfile(config.profileId);
	}

	getServiceProvider(serviceId: string): ProviderConfig | null {
		const profile = this.getServiceProfile(serviceId);
		if (!profile) return null;
		return PROVIDERS[profile.providerType as ProviderType] ?? null;
	}

	get needsApiKey(): boolean {
		const profile = this.activeProfile;
		if (!profile) return true;
		const provider = PROVIDERS[profile.providerType as ProviderType];
		return Boolean(provider?.requiresApiKey && !profile.apiKey);
	}

	// ── Init (load from IndexedDB) ──
	async init() {
		try {
			const all = await getAllSettings();

			// Profiles
			if (all.apiProfiles) {
				try { this.profiles = JSON.parse(all.apiProfiles); } catch (e) { console.warn('[Settings] Failed to parse apiProfiles:', e); }
			}
			this.activeProfileId = all.activeProfileId ?? null;

			// Narrative settings
			if (all.narrativeSettings) {
				try { Object.assign(this.narrativeSettings, JSON.parse(all.narrativeSettings)); } catch (e) { console.warn('[Settings] Failed to parse narrativeSettings:', e); }
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
				try { this.serviceConfigs = JSON.parse(all.serviceConfigs); } catch (e) { console.warn('[Settings] Failed to parse serviceConfigs:', e); }
			}

			// Profile models
			if (all.profileModels) {
				try { this.profileModels = JSON.parse(all.profileModels); } catch (e) { console.warn('[Settings] Failed to parse profileModels:', e); }
			}

			// UI settings
			const hadSavedUiSettings = Boolean(all.uiSettings);
			if (all.uiSettings) {
				try { Object.assign(this.uiSettings, JSON.parse(all.uiSettings)); } catch (e) { console.warn('[Settings] Failed to parse uiSettings:', e); }
			}
			this.normalizeUiSettings();

			// One-time flags kept for compatibility. Memory settings are now
			// user-authoritative, so migrations must not rewrite saved values.
			if (!all.uiSettingsMaxMessagesV2) {
				await setSetting('uiSettingsMaxMessagesV2', '1');
			}

			if (!all.uiSettingsMaxHistoryEntriesV3) {
				if (!hadSavedUiSettings) await this.saveUISettings();
				await setSetting('uiSettingsMaxHistoryEntriesV3', '1');
			}

			// System services
			if (all.systemServicesSettings) {
				try { Object.assign(this.systemServicesSettings, JSON.parse(all.systemServicesSettings)); } catch (e) { console.warn('[Settings] Failed to parse systemServicesSettings:', e); }
			}

			// Context budget
			if (all.contextBudget) {
				this.contextBudget = parseInt(all.contextBudget, 10) || 0;
			}
		} catch (e) {
			console.error('Settings init failed:', e);
		}
	}

	// ── Persistence ──
	private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
		const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
		return Math.min(max, Math.max(min, Math.round(number)));
	}

	private normalizeUiSettings() {
		this.uiSettings.maxMessages = this.clampNumber(this.uiSettings.maxMessages, 1, 1000, 250);
		this.uiSettings.maxHistoryEntries = this.clampNumber(this.uiSettings.maxHistoryEntries, 1, 1000, 50);
		this.uiSettings.chapterThreshold = this.clampNumber(this.uiSettings.chapterThreshold, 5, 200, 20);
		this.uiSettings.postChapterBuffer = this.clampNumber(this.uiSettings.postChapterBuffer, 0, 100, 10);
		this.uiSettings.maxPrevChaptersInSummary = this.clampNumber(this.uiSettings.maxPrevChaptersInSummary, 0, 50, 5);
		this.uiSettings.chaptersPerArc = this.clampNumber(this.uiSettings.chaptersPerArc, 2, 50, 5);
		this.uiSettings.retrievedChapterLimit = this.clampNumber(this.uiSettings.retrievedChapterLimit, 0, 12, 3);
		this.uiSettings.retrievedLoreEntryLimit = this.clampNumber(this.uiSettings.retrievedLoreEntryLimit, 0, 24, 8);
		this.uiSettings.conversationMemoryLimit = this.clampNumber(this.uiSettings.conversationMemoryLimit, 0, 24, 6);
		this.uiSettings.proceduralMemoryLimit = this.clampNumber(this.uiSettings.proceduralMemoryLimit, 0, 24, 8);
		this.uiSettings.backendMemoryTokenBudget = this.clampNumber(this.uiSettings.backendMemoryTokenBudget, 160, 2400, DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET);
		this.uiSettings.snapshotTokenCap = this.clampNumber(this.uiSettings.snapshotTokenCap, 0, 50000, 0);
	}

	async saveProfiles() {
		await setSetting('apiProfiles', JSON.stringify(this.profiles));
		if (this.activeProfileId) await setSetting('activeProfileId', this.activeProfileId);
	}

	async saveNarrativeSettings() {
		await setSetting('narrativeSettings', JSON.stringify(this.narrativeSettings));
		await setSetting('narrativeModel', this.narrativeSettings.model);
	}

	async saveUISettings() {
		this.normalizeUiSettings();
		await setSetting('uiSettings', JSON.stringify(this.uiSettings));
	}

	async saveServiceConfigs() {
		await setSetting('serviceConfigs', JSON.stringify(this.serviceConfigs));
	}

	async saveProfileModels() {
		await setSetting('profileModels', JSON.stringify(this.profileModels));
	}

	async saveContextBudget() {
		await setSetting('contextBudget', String(this.contextBudget));
	}

	getServiceConfig(serviceId: string): ServiceConfig {
		const existing = this.serviceConfigs[serviceId];
		const def = SERVICE_DEFINITIONS[serviceId];
		// Resolve model: per-service override → profile model → empty (provider default)
		const profileModel = def ? (this.profileModels[def.profile] ?? '') : '';
		const narrativeFallback = serviceId === 'narrative' && !existing?.profileId
			? this.narrativeSettings.model
			: '';
		const fallbackModel = profileModel || narrativeFallback || '';
		if (existing) {
			return { ...existing, model: existing.model || fallbackModel, profileId: existing.profileId ?? '' };
		}
		return {
			model: fallbackModel,
			temperature: serviceId === 'narrative' ? this.narrativeSettings.temperature : (def?.defaultTemp ?? 0.5),
			maxTokens: serviceId === 'narrative' ? this.narrativeSettings.maxTokens : (def?.defaultMaxTokens ?? 4096),
			systemPromptOverride: '',
			enabled: true,
			profileId: '',
		};
	}

	async setServiceConfig(serviceId: string, config: Partial<ServiceConfig>) {
		const current = this.serviceConfigs[serviceId] ?? {
			model: '',
			temperature: SERVICE_DEFINITIONS[serviceId]?.defaultTemp ?? 0.5,
			maxTokens: SERVICE_DEFINITIONS[serviceId]?.defaultMaxTokens ?? 4096,
			systemPromptOverride: '',
			enabled: true,
			profileId: '',
		};
		this.serviceConfigs = { ...this.serviceConfigs, [serviceId]: { ...current, ...config } };
		await this.saveServiceConfigs();
	}

	getProfileModel(profileId: string): string {
		return this.profileModels[profileId] ?? '';
	}

	async setProfileModel(profileId: string, model: string) {
		this.profileModels = { ...this.profileModels, [profileId]: model };
		await this.saveProfileModels();
	}

	async setActiveProfile(profileId: string) {
		this.activeProfileId = profileId;
		await setSetting('activeProfileId', profileId);

		// Only set narrative model to provider default if user hasn't set one
		if (!this.narrativeSettings.model) {
			const profile = this.profiles.find(p => p.id === profileId);
			if (profile) {
				const provider = PROVIDERS[profile.providerType as ProviderType];
				if (provider?.services?.narrative) {
					this.narrativeSettings.model = provider.services.narrative.model;
					await this.saveNarrativeSettings();
				}
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
