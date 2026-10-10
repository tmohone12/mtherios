/**
 * Settings Store — Mtherios
 * Persists all settings to IndexedDB. Loads on init.
 */

import { getSetting, setSetting, getAllSettings } from '$lib/services/database';
import { PROVIDERS, type ProviderConfig } from '$lib/services/ai/sdk/providers/config';
import { DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET, DEFAULT_RECENT_DIALOGUE_TOKENS, DEFAULT_RECENT_DIALOGUE_TURNS, normalizeRecentDialogueTokens, normalizeRecentDialogueTurns } from '$lib/services/memorySettings';
import { FIXED_CHAPTER_SETTINGS } from '$lib/services/chapterCadence';
import type { UISettings, APIProfile, ProviderType, ReasoningEffort } from '$lib/types';
import { modelTaskDefinition } from '$lib/contracts/modelTasks';

// ── Per-Service Configuration ──
export interface ServiceConfig {
	model: string;
	temperature: number;
	maxTokens: number;
	systemPromptOverride: string; // empty = use default
	enabled: boolean;
	profileId: string; // API profile to use — empty = active profile (default)
	/** Server-resolved model when this task inherits its role; never saved as an override. */
	effectiveModel?: string;
	inherited?: boolean;
	dialogueMode?: 'all' | 'important';
	batchMaxCostUsd?: number | null;
	batchInputUsdPerMillion?: number | null;
	batchOutputUsdPerMillion?: number | null;
}

export const SERVICE_DEFINITIONS: Record<string, { label: string; description: string; profile: string; defaultTemp: number; defaultMaxTokens: number; defaultEnabled?: boolean }> = {
	assistant: { label: 'Authoring Assistant', description: 'Separate model for project and game authoring conversations', profile: 'assistant', defaultTemp: 0.5, defaultMaxTokens: 4096, defaultEnabled: false },
	batchAuthoring: { label: 'Batch Authoring', description: 'Separate model and spend ceiling for bounded authoring helpers', profile: 'batchAuthoring', defaultTemp: 0.3, defaultMaxTokens: 4096, defaultEnabled: false },
	narrative: { label: 'GameMaster', description: 'Main story generation and turn authority', profile: 'narrative', defaultTemp: 1.0, defaultMaxTokens: 4096 },
	dialogue: { label: 'NPC Dialogue', description: 'Optional second model that revises NPC speech after the GameMaster sets the scene', profile: 'dialogue', defaultTemp: 0.7, defaultMaxTokens: 2048, defaultEnabled: false },
	storySetupAssist: { label: 'Story Setup Assist', description: 'Helps draft new-story titles, worlds, protagonists, and lore seeds', profile: 'narrative', defaultTemp: 0.8, defaultMaxTokens: 2048 },
	classifier: { label: 'Turn Memory Extraction', description: 'Extract world state from completed turns for Memory & Context', profile: 'memoryContext', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	smallBrain: { label: 'Lore Master', description: 'Read-only cited context synthesis and canon review', profile: 'narrative', defaultTemp: 0.3, defaultMaxTokens: 1200 },
	actorDecision: { label: 'Actor Decisions', description: 'Propose evidence-bound NPC responses for pivotal interactions', profile: 'narrative', defaultTemp: 0.2, defaultMaxTokens: 700, defaultEnabled: false },
	continuityReview: { label: 'Continuity Review', description: 'Shadow-review completed narration for source-linked continuity risks', profile: 'narrative', defaultTemp: 0.1, defaultMaxTokens: 900, defaultEnabled: false },
	characterUpdate: { label: 'Character Update', description: 'Refresh known character continuity from completed chapters', profile: 'narrative', defaultTemp: 0.2, defaultMaxTokens: 4096 },
	suggestions: { label: 'Suggestions', description: 'Generate action suggestions', profile: 'guidance', defaultTemp: 0.8, defaultMaxTokens: 2048 },
	memory: { label: 'Memory', description: 'Chapter summarization & retrieval', profile: 'memoryContext', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	loreManagement: { label: 'Lore Management', description: 'Discover and curate lorebook entries automatically', profile: 'memoryContext', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	entryRefinement: { label: 'Entry Refinement', description: 'Refine an entry with the memory and lore context', profile: 'memoryContext', defaultTemp: 0.4, defaultMaxTokens: 4096 },
	imageGeneration: { label: 'Image Generation', description: 'Scene image generation', profile: 'image', defaultTemp: 0.7, defaultMaxTokens: 1024 },
	strategicWorldBrain: { label: 'Strategic World Brain', description: 'Deep arc-level simulation for factions, schemes, plots, subplots, and world pressure', profile: 'narrative', defaultTemp: 0.45, defaultMaxTokens: 8192 },
	arcCondensation: { label: 'Arc Condensation', description: 'Condense chapters into arc summaries', profile: 'memoryContext', defaultTemp: 0.3, defaultMaxTokens: 4096 },
	sagaCondensation: { label: 'Saga Condensation', description: 'Condense arcs into long-term saga summaries', profile: 'memoryContext', defaultTemp: 0.25, defaultMaxTokens: 4096 },
};

// The UI and server share one set of enablement defaults.
for (const [id, definition] of Object.entries(SERVICE_DEFINITIONS)) {
	const task = modelTaskDefinition(id);
	if (task) definition.defaultEnabled = task.defaultEnabled;
}

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
	{ id: 'narrative', label: 'GameMaster', description: 'Story model; expand services for World State and other tools', icon: '✍️', serviceIds: ['narrative', 'storySetupAssist', 'smallBrain', 'actorDecision', 'continuityReview', 'characterUpdate', 'strategicWorldBrain'] },
	{ id: 'dialogue', label: 'NPC Dialogue', description: 'Optional model for spoken lines after the GameMaster draft', icon: '💬', serviceIds: ['dialogue'] },
	{ id: 'memoryContext', label: 'Memory & Context subagent', description: 'Turn memory, chapter/arc/saga history, lore management, and entry refinement', icon: '🧠', serviceIds: ['classifier', 'memory', 'arcCondensation', 'sagaCondensation', 'loreManagement', 'entryRefinement'] },
	{ id: 'guidance', label: 'Player Guidance subagent', description: 'Optional player-visible suggestions', icon: '🧭', serviceIds: ['suggestions'] },
	{ id: 'assistant', label: 'Authoring Assistant', description: 'Authoring model and bounded batch helpers', icon: 'A', serviceIds: ['assistant', 'batchAuthoring'] },
	{ id: 'image', label: 'Image Generation', description: 'Scene and character image generation', icon: '🎨', serviceIds: ['imageGeneration'] },
];

/** Preserve old profile selections as explicit task overrides before changing group ownership. */
export function migrateConsolidatedProfiles(configs: Record<string, ServiceConfig>, models: Record<string, string>) {
	const nextConfigs = { ...configs };
	const nextModels = { ...models };
	for (const [oldGroup, services] of Object.entries({
		worldState: ['classifier', 'smallBrain', 'actorDecision', 'continuityReview', 'characterUpdate'],
		deepSimulation: ['strategicWorldBrain'],
		batchAuthoring: ['batchAuthoring'],
		lorebook: ['loreManagement', 'entryRefinement'],
	})) {
		const model = models[oldGroup];
		if (!model) continue;
		for (const serviceId of services) {
			const existing = nextConfigs[serviceId];
			if (existing?.model) continue;
			const def = SERVICE_DEFINITIONS[serviceId];
			nextConfigs[serviceId] = existing ? { ...existing, model } : {
				model, temperature: def.defaultTemp, maxTokens: def.defaultMaxTokens,
				systemPromptOverride: '', enabled: def.defaultEnabled ?? true, profileId: '',
			};
		}
	}
	if (!nextModels.memoryContext && models.lorebook) nextModels.memoryContext = models.lorebook;
	return { configs: nextConfigs, models: nextModels };
}

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
		...FIXED_CHAPTER_SETTINGS,
		maxPrevChaptersInSummary: 5,
		retrievedChapterLimit: 3,
		retrievedLoreEntryLimit: 8,
		conversationMemoryLimit: 6,
		backendMemoryTokenBudget: DEFAULT_BACKEND_MEMORY_TOKEN_BUDGET,
		recentDialogueTokens: DEFAULT_RECENT_DIALOGUE_TOKENS,
		recentDialogueTurns: DEFAULT_RECENT_DIALOGUE_TURNS,
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
			if (!all.consolidatedProfilesV1) {
				const migrated = migrateConsolidatedProfiles(this.serviceConfigs, this.profileModels);
				this.serviceConfigs = migrated.configs;
				this.profileModels = migrated.models;
				await this.saveServiceConfigs();
				await this.saveProfileModels();
				await setSetting('consolidatedProfilesV1', '1');
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
		this.uiSettings.recentDialogueTokens = normalizeRecentDialogueTokens(this.uiSettings.recentDialogueTokens);
		this.uiSettings.recentDialogueTurns = normalizeRecentDialogueTurns(this.uiSettings.recentDialogueTurns);
		this.uiSettings.maxMessages = this.clampNumber(this.uiSettings.maxMessages, 1, 1000, 250);
		this.uiSettings.maxHistoryEntries = this.clampNumber(this.uiSettings.maxHistoryEntries, 1, 1000, 50);
		Object.assign(this.uiSettings, FIXED_CHAPTER_SETTINGS);
		this.uiSettings.maxPrevChaptersInSummary = this.clampNumber(this.uiSettings.maxPrevChaptersInSummary, 0, 50, 5);
		this.uiSettings.retrievedChapterLimit = this.clampNumber(this.uiSettings.retrievedChapterLimit, 0, 12, 3);
		this.uiSettings.retrievedLoreEntryLimit = this.clampNumber(this.uiSettings.retrievedLoreEntryLimit, 0, 24, 8);
		this.uiSettings.conversationMemoryLimit = this.clampNumber(this.uiSettings.conversationMemoryLimit, 0, 24, 6);
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
		const narrativeFallback = def && ['narrative', 'memoryContext', 'guidance'].includes(def.profile) && !existing?.profileId
			? this.narrativeSettings.model
			: '';
		const fallbackModel = profileModel || narrativeFallback || '';
		if (existing) {
			return { ...existing, model: existing.model || existing.effectiveModel || fallbackModel, profileId: existing.profileId ?? '' };
		}
		return {
			model: fallbackModel,
			temperature: serviceId === 'narrative' ? this.narrativeSettings.temperature : (def?.defaultTemp ?? 0.5),
			maxTokens: serviceId === 'narrative' ? this.narrativeSettings.maxTokens : (def?.defaultMaxTokens ?? 4096),
			systemPromptOverride: '',
			enabled: def?.defaultEnabled ?? true,
			profileId: '',
		};
	}

	async setServiceConfig(serviceId: string, config: Partial<ServiceConfig>) {
		const current = this.serviceConfigs[serviceId] ?? {
			model: '',
			temperature: SERVICE_DEFINITIONS[serviceId]?.defaultTemp ?? 0.5,
			maxTokens: SERVICE_DEFINITIONS[serviceId]?.defaultMaxTokens ?? 4096,
			systemPromptOverride: '',
			enabled: SERVICE_DEFINITIONS[serviceId]?.defaultEnabled ?? true,
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
