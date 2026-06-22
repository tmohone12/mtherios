<script lang="ts">
	import { X, Check, ExternalLink, Eye, EyeOff, Globe, Server, Sparkles, Cpu, Zap, SlidersHorizontal, Wrench, Palette, ScrollText, ChevronDown, ImageIcon, Brain, RefreshCw, Search, FileText } from 'lucide-svelte';
	import ServiceConfigPanel from './ServiceConfigPanel.svelte';
	import PromptsPanel from './PromptsPanel.svelte';
	import PromptInspector from './PromptInspector.svelte';
	import ContextWindow from '../story/ContextWindow.svelte';
	import { settings, SERVICE_DEFINITIONS, SERVICE_PROFILES } from '$lib/stores/settings.svelte';
	import { PROVIDERS, getProviderList } from '$lib/services/ai/sdk/providers/config';
	import { STYLE_PRESETS } from '$lib/services/ai/image/ImageGenerationService';
	import {
		CONTEXT_BUDGET_STEPS,
		contextBudgetSliderIndexToValue,
		contextBudgetValueToSliderIndex,
		formatTokenBudgetCompact,
	} from '$lib/services/memorySettings';
	import { defaultTerminalApiKeyRef, syncTerminalLlmSettingsFromBrowser } from '$lib/services/terminalSettings';
	import type { ProviderType, APIProfile, UISettings } from '$lib/types';
	import { uuid } from '$lib/utils/uuid';
	import { fade } from 'svelte/transition';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	// Tab navigation
	type Tab = 'providers' | 'services' | 'prompts' | 'memory' | 'images' | 'interface' | 'inspector';
	type NumericUiSettingKey = Extract<keyof UISettings,
		| 'maxMessages'
		| 'maxHistoryEntries'
		| 'chapterThreshold'
		| 'postChapterBuffer'
		| 'maxPrevChaptersInSummary'
		| 'chaptersPerArc'
		| 'retrievedChapterLimit'
		| 'retrievedLoreEntryLimit'
		| 'conversationMemoryLimit'
		| 'proceduralMemoryLimit'
		| 'backendMemoryTokenBudget'
		| 'snapshotTokenCap'>;

	interface MemoryDial {
		key: NumericUiSettingKey;
		label: string;
		description: string;
		min: number;
		max: number;
		step: number;
		suffix?: string;
		zeroLabel?: string;
	}

	let activeTab = $state<Tab>('providers');

	// Provider editing
	let editingProvider = $state<ProviderType | null>(null);
	let apiKey = $state('');
	let terminalApiKeyRef = $state('');
	let customUrl = $state('');
	let model = $state('');
	let showApiKey = $state(false);
	let testStatus = $state<'idle' | 'testing' | 'success' | 'error'>('idle');
	let testMessage = $state('');
	// Live model list fetched from /models for the provider being edited.
	// Populated by testConnection on success, persisted by saveProfile.
	let fetchedModelsForProfile = $state<string[]>([]);
	let modelSearch = $state('');
	let editModelSearch = $state('');
	let fetchingModels = $state(false);
	let modelFetchMessage = $state('');
	let contextBudgetSliderIndex = $state(0);

	$effect(() => {
		contextBudgetSliderIndex = contextBudgetValueToSliderIndex(settings.contextBudget);
	});

	/**
	 * Fetch the live model list from an OpenAI-compatible /models endpoint.
	 * Returns deduplicated, sorted model IDs. Handles the standard
	 * { data: [{ id }] } shape plus a couple of common variants.
	 */
	async function fetchOpenAIModels(baseUrl: string, key: string): Promise<string[]> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (key) headers['Authorization'] = `Bearer ${key}`;
		const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers });
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 150)}` : ''}`);
		}
		const data = await res.json();
		const list: unknown[] = Array.isArray(data?.data)
			? data.data
			: Array.isArray(data?.models)
				? data.models
				: Array.isArray(data)
					? data
					: [];
		const ids = list
			.map((m) => (typeof m === 'string' ? m : (m as any)?.id ?? (m as any)?.name))
			.filter((id): id is string => typeof id === 'string' && id.length > 0);
		return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
	}

	// Merged chip list: fetched (live, canonical) wins, fallback fills gaps.
	function modelOptionsFor(profile: APIProfile | null | undefined, fallback: string[]): string[] {
		const hidden = new Set(profile?.hiddenModels ?? []);
		const ordered = [
			...(profile?.favoriteModels ?? []),
			...(profile?.fetchedModels ?? []),
			...(profile?.customModels ?? []),
			...fallback,
		];
		return Array.from(new Set(ordered)).filter(id => id && !hidden.has(id));
	}

	function filterModels(models: string[], query: string): string[] {
		const q = query.trim().toLowerCase();
		if (!q) return models;
		return models.filter(id => id.toLowerCase().includes(q));
	}

	const modelChips = $derived.by(() =>
		modelOptionsFor(settings.activeProfile, settings.activeProvider?.fallbackModels ?? [])
	);

	const filteredModelChips = $derived.by(() => filterModels(modelChips, modelSearch));

	/** Merged list for the provider being edited — uses the locally-fetched list if present. */
	function editModelChips(fallback: string[]): string[] {
		const existing = editingProvider ? getProfileByProvider(editingProvider) : undefined;
		const profile = existing
			? { ...existing, fetchedModels: fetchedModelsForProfile }
			: {
				id: '',
				name: '',
				providerType: editingProvider ?? 'openai-compatible',
				apiKey: '',
				customModels: [],
				fetchedModels: fetchedModelsForProfile,
				reasoningModels: [],
				hiddenModels: [],
				favoriteModels: [],
				createdAt: 0,
			} satisfies APIProfile;
		return modelOptionsFor(profile, fallback);
	}

	function filteredEditModels(fallback: string[]): string[] {
		return filterModels(editModelChips(fallback), editModelSearch);
	}

	// Helpers
	function getProfileByProvider(providerType: ProviderType): APIProfile | undefined {
		return settings.profiles.find(p => p.providerType === providerType);
	}

	function isProviderConfigured(providerType: ProviderType): boolean {
		const profile = getProfileByProvider(providerType);
		const provider = PROVIDERS[providerType];
		if (!profile || !provider) return false;
		return !provider.requiresApiKey || !!profile.apiKey;
	}

	function keyLabelFor(profile: APIProfile): string {
		const provider = PROVIDERS[profile.providerType as ProviderType];
		if (provider && !provider.requiresApiKey) return 'Application Default Credentials';
		if (profile.apiKey.startsWith('sk-ant-oat-')) return 'Setup Token (OAuth)';
		return profile.apiKey ? '••••' + profile.apiKey.slice(-4) : 'Not stored';
	}

	function selectProvider(id: ProviderType) {
		editingProvider = id;
		const existing = getProfileByProvider(id);
		apiKey = existing?.apiKey ?? '';
		terminalApiKeyRef = existing?.terminalApiKeyRef ?? defaultTerminalApiKeyRef(id);
		model = existing ? (settings.narrativeSettings.model || '') : '';
		customUrl = existing?.baseUrl ?? '';
		showApiKey = false;
		testStatus = 'idle';
		testMessage = '';
		editModelSearch = '';
		// Preserve the profile's previously-fetched models so editing without
		// re-testing doesn't blow them away on save.
		fetchedModelsForProfile = existing?.fetchedModels ? [...existing.fetchedModels] : [];
	}

	async function fetchModelsForActiveProfile() {
		const profile = settings.activeProfile;
		const provider = settings.activeProvider;
		if (!profile || !provider) return;
		fetchingModels = true;
		modelFetchMessage = '';
		try {
			const baseUrl = profile.baseUrl || provider.baseUrl;
			if (!baseUrl) throw new Error('This provider does not expose an OpenAI-compatible /models endpoint.');
			const ids = await fetchOpenAIModels(baseUrl, profile.apiKey);
			profile.fetchedModels = ids;
			await settings.saveProfiles();
			modelFetchMessage = `Fetched ${ids.length} model${ids.length === 1 ? '' : 's'}.`;
		} catch (e) {
			modelFetchMessage = e instanceof Error ? e.message : 'Failed to fetch models.';
		} finally {
			fetchingModels = false;
		}
	}

	async function fetchModelsForEditing() {
		if (!editingProvider) return;
		fetchingModels = true;
		testStatus = 'testing';
		testMessage = '';
		try {
			const provider = PROVIDERS[editingProvider];
			const baseUrl = customUrl || provider.baseUrl;
			if (!baseUrl) throw new Error('This provider does not expose an OpenAI-compatible /models endpoint.');
			const ids = await fetchOpenAIModels(baseUrl, apiKey);
			fetchedModelsForProfile = ids;
			testStatus = 'success';
			testMessage = `Fetched ${ids.length} model${ids.length === 1 ? '' : 's'}.`;
		} catch (e) {
			testStatus = 'error';
			testMessage = e instanceof Error ? e.message : 'Failed to fetch models.';
		} finally {
			fetchingModels = false;
		}
	}

	async function saveProfile() {
		if (!editingProvider) return;
		const providerType = editingProvider;
		const providerConfig = PROVIDERS[providerType];
		const existing = getProfileByProvider(providerType);
		const normalizedKeyRef = terminalApiKeyRef.trim() || null;

		if (existing) {
			existing.apiKey = apiKey;
			existing.terminalApiKeyRef = normalizedKeyRef;
			if (customUrl) existing.baseUrl = customUrl;
			else delete existing.baseUrl;
			if (fetchedModelsForProfile.length > 0) existing.fetchedModels = [...fetchedModelsForProfile];
			await settings.saveProfiles();
			await settings.setActiveProfile(existing.id);
		} else {
			const profile: APIProfile = {
				id: uuid(),
				name: providerConfig?.name ?? providerType,
				providerType,
				apiKey,
				terminalApiKeyRef: normalizedKeyRef,
				...(customUrl ? { baseUrl: customUrl } : {}),
				customModels: [],
				fetchedModels: [...fetchedModelsForProfile],
				reasoningModels: [],
				hiddenModels: [],
				favoriteModels: [],
				createdAt: Date.now(),
			};
			await settings.addProfile(profile);
			await settings.setActiveProfile(profile.id);
		}

		if (model) {
			settings.narrativeSettings.model = model;
			await saveNarrativeSettingsAndSync();
		}
		try {
			await syncTerminalLlmSettingsFromBrowser(['narrative', 'classifier', 'smallBrain']);
			testStatus = 'success';
			testMessage = 'Saved provider and synced terminal runtime settings.';
		} catch (error) {
			testStatus = 'error';
			testMessage = `Saved locally, but terminal sync failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	async function testConnection() {
		if (!editingProvider) return;
		testStatus = 'testing';
		try {
			const provider = PROVIDERS[editingProvider];
			const testModel = model || provider.fallbackModels[0];
			const baseUrl = customUrl || provider.baseUrl;
			const isAnthropicShape = editingProvider === 'anthropic' || editingProvider === 'anthropic-proxy';
			const isOAuth = apiKey.startsWith('sk-ant-oat-');

			if (isAnthropicShape) {
				const anthropicUrl = baseUrl || '/api/anthropic';
				const headers: Record<string, string> = {
					'Content-Type': 'application/json',
					'anthropic-version': '2023-06-01',
				};
				if (apiKey) {
					if (isOAuth) {
						headers['Authorization'] = `Bearer ${apiKey}`;
						headers['anthropic-beta'] = 'oauth-2025-04-01';
					} else {
						headers['x-api-key'] = apiKey;
					}
				}
				const res = await fetch(`${anthropicUrl}/v1/messages`, {
					method: 'POST',
					headers,
					body: JSON.stringify({
						model: testModel,
						messages: [{ role: 'user', content: 'Hi' }],
						max_tokens: 1,
					}),
				});
				if (res.ok) { testStatus = 'success'; testMessage = 'Connected!'; }
				else { const err = await res.text(); testStatus = 'error'; testMessage = `HTTP ${res.status}: ${err.slice(0, 150)}`; }
			} else {
				// OpenAI-compatible: hit /models, parse the list, persist it.
				try {
					const ids = await fetchOpenAIModels(baseUrl, apiKey);
					fetchedModelsForProfile = ids;
					testStatus = 'success';
					testMessage = ids.length > 0
						? `Connected — fetched ${ids.length} model${ids.length === 1 ? '' : 's'}`
						: 'Connected, but no models returned';
				} catch (e) {
					testStatus = 'error';
					testMessage = e instanceof Error ? e.message : 'Connection failed';
				}
			}
		} catch (e) {
			testStatus = 'error';
			testMessage = e instanceof Error ? e.message : 'Connection failed';
		}
	}

	// Generation settings (bound and saved)
	async function syncNarrativeRuntimeSetting() {
		try {
			await syncTerminalLlmSettingsFromBrowser(['narrative']);
		} catch (error) {
			console.warn('[Settings] Terminal sync for narrative settings failed:', error);
		}
	}

	async function saveNarrativeSettingsAndSync() {
		await settings.saveNarrativeSettings();
		await syncNarrativeRuntimeSetting();
	}

	async function saveTemp(val: number) {
		settings.narrativeSettings.temperature = val;
		await saveNarrativeSettingsAndSync();
	}
	async function saveMaxTokens(val: number) {
		settings.narrativeSettings.maxTokens = val;
		await saveNarrativeSettingsAndSync();
	}

	function clampDial(value: number, min: number, max: number): number {
		if (!Number.isFinite(value)) return min;
		return Math.min(max, Math.max(min, Math.round(value)));
	}

	function settingValue(key: NumericUiSettingKey): number {
		return Number(settings.uiSettings[key] ?? 0);
	}

	function syncRangeValue(node: HTMLInputElement, value: number) {
		const apply = (next: number) => {
			queueMicrotask(() => {
				node.value = String(next);
			});
		};
		apply(value);
		return { update: apply };
	}

	function backendMemorySliderPosition(): number {
		const value = clampDial(settingValue('backendMemoryTokenBudget'), 160, 2400);
		return clampDial((value / 2400) * 100, 0, 100);
	}

	function backendMemoryTokensFromSlider(position: number): number {
		const scaled = (clampDial(position, 0, 100) / 100) * 2400;
		return clampDial(Math.round(scaled / 20) * 20, 160, 2400);
	}

	function formatDialValue(dial: MemoryDial): string {
		const value = settingValue(dial.key);
		if (value === 0 && dial.zeroLabel) return dial.zeroLabel;
		return `${value.toLocaleString()}${dial.suffix ? ` ${dial.suffix}` : ''}`;
	}

	async function saveUiNumber(key: NumericUiSettingKey, value: number, min: number, max: number) {
		settings.uiSettings[key] = clampDial(value, min, max);
		await settings.saveUISettings();
		if (key === 'backendMemoryTokenBudget') {
			await syncTerminalLlmSettingsFromBrowser(['narrative', 'classifier', 'smallBrain']).catch((error) => {
				console.warn('[Settings] Terminal memory setting sync failed:', error);
			});
		}
	}

	async function saveContextBudgetValue(value: number) {
		settings.contextBudget = clampDial(value, 0, 200000);
		await settings.saveContextBudget();
		await syncTerminalLlmSettingsFromBrowser(['narrative', 'classifier', 'smallBrain']).catch((error) => {
			console.warn('[Settings] Terminal context budget sync failed:', error);
		});
	}

	function saveContextBudgetFromSlider(index: number) {
		contextBudgetSliderIndex = clampDial(index, 0, CONTEXT_BUDGET_STEPS.length - 1);
		return saveContextBudgetValue(contextBudgetSliderIndexToValue(index));
	}

	const providerIcons: Record<string, typeof Zap> = {
		openrouter: Globe, nanogpt: Zap, anthropic: Sparkles, openai: Cpu,
	};
	const topProviders: ProviderType[] = ['anthropic', 'openrouter', 'nanogpt', 'openai'];
	const otherProviders = getProviderList().filter(p => !topProviders.includes(p.value));

	// ── Inline image-provider editor (Images tab) ──
	let imgEditorOpen = $state(false);
	let imgProviderType = $state<ProviderType>('google-ai-studio');
	let imgApiKey = $state('');
	let imgBaseUrl = $state('');
	let imgShowKey = $state(false);
	let imgSaving = $state(false);
	let imgSaveError = $state('');

	const imageCapableProviders = $derived(
		(Object.keys(PROVIDERS) as ProviderType[])
			.filter(k => PROVIDERS[k].capabilities.imageGeneration)
			.map(k => ({ value: k, label: PROVIDERS[k].name }))
	);

	function openImgEditorForExisting() {
		const id = settings.uiSettings.imageProfileId;
		const existing = id ? settings.profiles.find(p => p.id === id) : undefined;
		if (existing) {
			imgProviderType = existing.providerType as ProviderType;
			imgApiKey = existing.apiKey ?? '';
			imgBaseUrl = existing.baseUrl ?? '';
		} else {
			imgProviderType = 'google-ai-studio';
			imgApiKey = '';
			imgBaseUrl = '';
		}
		imgSaveError = '';
		imgEditorOpen = true;
	}

	async function saveImageProvider() {
		imgSaving = true;
		imgSaveError = '';
		try {
			const cfg = PROVIDERS[imgProviderType];
			if (!cfg) throw new Error('Unknown provider type');
			if (cfg.requiresApiKey && !imgApiKey) throw new Error('API key required');

			const currentId = settings.uiSettings.imageProfileId;
			const existing = currentId ? settings.profiles.find(p => p.id === currentId) : undefined;
			// Reuse existing profile only if it's the same provider type AND
			// is image-only (so we don't stomp the user's narrative profile).
			const reuse = existing && existing.providerType === imgProviderType
				&& settings.activeProfileId !== existing.id;

			if (reuse && existing) {
				existing.apiKey = imgApiKey;
				if (imgBaseUrl) existing.baseUrl = imgBaseUrl; else delete existing.baseUrl;
				await settings.saveProfiles();
			} else {
				const profile: APIProfile = {
					id: uuid(),
					name: `${cfg.name} (Image)`,
					providerType: imgProviderType,
					apiKey: imgApiKey,
					...(imgBaseUrl ? { baseUrl: imgBaseUrl } : {}),
					customModels: [],
					fetchedModels: [],
					reasoningModels: [],
					hiddenModels: [],
					favoriteModels: [],
					createdAt: Date.now(),
				};
				await settings.addProfile(profile);
				settings.uiSettings.imageProfileId = profile.id;
				await settings.saveUISettings();
			}
			imgEditorOpen = false;
		} catch (e) {
			imgSaveError = e instanceof Error ? e.message : 'Save failed';
		} finally {
			imgSaving = false;
		}
	}

	const tabs: Array<{ id: Tab; label: string; shortLabel: string; icon: typeof Globe }> = [
		{ id: 'providers', label: 'Providers & Models', shortLabel: 'Providers', icon: Globe },
		{ id: 'services', label: 'AI Services', shortLabel: 'Services', icon: Wrench },
		{ id: 'prompts', label: 'Prompts', shortLabel: 'Prompts', icon: FileText },
		{ id: 'memory', label: 'Memory', shortLabel: 'Memory', icon: Brain },
		{ id: 'images', label: 'Image Generation', shortLabel: 'Images', icon: ImageIcon },
		{ id: 'interface', label: 'Interface', shortLabel: 'UI', icon: Palette },
		{ id: 'inspector', label: 'Inspector', shortLabel: 'Inspector', icon: ScrollText },
	];

	const liveContextDials: MemoryDial[] = [
		{ key: 'snapshotTokenCap', label: 'Dynamic Prompt Cap', description: 'Caps arcs, chapters, lore, world state, retrieved memory, and final instructions before history is added.', min: 0, max: 50000, step: 500, suffix: 'tokens', zeroLabel: 'Auto' },
		{ key: 'maxMessages', label: 'Conversation Messages', description: 'Recent chat turns kept in the short-term prompt window.', min: 1, max: 1000, step: 1, suffix: 'messages' },
		{ key: 'maxHistoryEntries', label: 'Raw History Scan', description: 'Raw entries allowed into the local history scan before token budgeting cuts them down.', min: 1, max: 1000, step: 1, suffix: 'entries' },
	];

	const retrievalDials: MemoryDial[] = [
		{ key: 'backendMemoryTokenBudget', label: 'Terminal Memory Packet', description: 'Target size for terminal-retrieved memory when a story is bound to the terminal world database.', min: 160, max: 2400, step: 20, suffix: 'tokens' },
		{ key: 'retrievedChapterLimit', label: 'Chapter Memories', description: 'Searchable episodic chapters injected for the current action.', min: 0, max: 12, step: 1, suffix: 'chapters', zeroLabel: 'Off' },
		{ key: 'retrievedLoreEntryLimit', label: 'Lorebook Matches', description: 'Local lore entries pulled by current action when backend retrieval is unavailable.', min: 0, max: 24, step: 1, suffix: 'entries', zeroLabel: 'Off' },
		{ key: 'conversationMemoryLimit', label: 'NPC Conversation Memory', description: 'NPC-specific remembered exchanges eligible for the current scene.', min: 0, max: 24, step: 1, suffix: 'memories', zeroLabel: 'Off' },
		{ key: 'proceduralMemoryLimit', label: 'Procedural Rules', description: 'Learned narrative rules and style constraints retrieved for this turn.', min: 0, max: 24, step: 1, suffix: 'rules', zeroLabel: 'Off' },
	];

	const summaryDials: MemoryDial[] = [
		{ key: 'chapterThreshold', label: 'Chapter Threshold', description: 'Eligible entries needed before the chapter summarizer can run.', min: 5, max: 200, step: 5, suffix: 'entries' },
		{ key: 'postChapterBuffer', label: 'Post-Chapter Buffer', description: 'Fresh entries protected from summarization so the current scene stays hot.', min: 0, max: 100, step: 1, suffix: 'entries' },
		{ key: 'maxPrevChaptersInSummary', label: 'Prior Chapter Context', description: 'Older chapter summaries given to the chapter summarizer for continuity.', min: 0, max: 50, step: 1, suffix: 'chapters', zeroLabel: 'None' },
		{ key: 'chaptersPerArc', label: 'Chapters per Arc', description: 'Uncovered chapters condensed into one long-term arc at a time.', min: 2, max: 50, step: 1, suffix: 'chapters' },
	];
</script>

{#if open}
<div class="fixed inset-0 z-50 flex items-stretch justify-stretch overflow-hidden p-0 sm:items-center sm:justify-center sm:p-4" transition:fade={{ duration: 150 }}>
	<button class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick={onClose} aria-label="Close settings"></button>

	<!-- Modal: wider, taller -->
	<div class="settings-modal-shell relative flex min-h-0 w-full max-w-3xl flex-col overflow-hidden rounded-none border-0 border-[var(--border-primary)] bg-[var(--bg-secondary)] sm:flex-row sm:rounded-2xl sm:border">

		<!-- Sidebar -->
		<div class="hidden sm:flex w-48 shrink-0 flex-col border-r border-[var(--border-primary)] bg-[var(--bg-primary)]">
			<div class="px-4 py-5">
				<h2 class="font-display text-sm font-semibold tracking-wider uppercase text-[var(--text-accent)]">Settings</h2>
			</div>
			<nav class="flex-1 space-y-0.5 px-2">
				{#each tabs as tab}
					<button
						class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors
							{activeTab === tab.id
								? 'bg-[rgba(212,168,83,0.1)] text-[var(--text-accent)]'
								: 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'}"
						onclick={() => activeTab = tab.id}
					>
						<tab.icon class="h-4 w-4 shrink-0" />
						<span>{tab.label}</span>
					</button>
				{/each}
			</nav>
		</div>

		<!-- Mobile tab picker -->
		<div class="grid shrink-0 grid-cols-3 gap-1.5 border-b border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 sm:hidden">
			{#each tabs as tab}
				<button
					type="button"
					aria-label={tab.label}
					aria-pressed={activeTab === tab.id}
					class="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors
						{activeTab === tab.id
							? 'border-[var(--color-gold-600)]/50 bg-[rgba(212,168,83,0.12)] text-[var(--text-accent)]'
							: 'border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]'}"
					onclick={() => activeTab = tab.id}
				>
					<tab.icon class="h-3.5 w-3.5 shrink-0" />
					<span class="min-w-0 truncate">{tab.shortLabel}</span>
				</button>
			{/each}
		</div>

		<!-- Content area -->
		<div class="flex min-h-0 flex-1 flex-col min-w-0">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-4 py-3 sm:px-6 sm:py-3">
				<h3 class="font-display text-base tracking-wide text-[var(--text-primary)]">
					{tabs.find(t => t.id === activeTab)?.label ?? 'Settings'}
				</h3>
				<button class="text-[var(--text-muted)] hover:text-[var(--text-primary)]" onclick={onClose}>
					<X class="h-5 w-5" />
				</button>
			</div>

			<!-- Scrollable content -->
			<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pt-4 sm:p-6 sm:pt-6" style="margin-top: 0; -webkit-overflow-scrolling: touch;">

				<!-- ═══ TAB: PROVIDERS & MODELS ═══ -->
				{#if activeTab === 'providers'}
				<div class="space-y-6">

					<!-- Active provider + model display -->
					{#if settings.activeProfile}
						<div class="rounded-xl border border-[var(--color-gold-600)]/20 bg-[rgba(212,168,83,0.04)] p-4">
							<div class="flex items-center justify-between mb-3">
								<span class="font-display text-xs uppercase tracking-wider text-[var(--text-accent)]">Active Provider</span>
								<span class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">CONNECTED</span>
							</div>
							<div class="text-sm text-[var(--text-primary)] font-semibold">{settings.activeProfile.name}</div>
							<div class="mt-1 font-mono text-xs text-[var(--text-muted)]">
								Model: {settings.narrativeSettings.model || 'provider default'}
							</div>
							<div class="mt-1 font-mono text-xs text-[var(--text-muted)]">
								Key: {keyLabelFor(settings.activeProfile)}
							</div>
						</div>
					{/if}

					<!-- Narrative model override -->
					<div class="space-y-2">
						<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Narrative Model</label>
						<div class="flex gap-2">
							<input
								type="text"
								bind:value={settings.narrativeSettings.model}
								placeholder={settings.activeProvider?.fallbackModels?.[0] ?? 'model-name'}
								class="flex-1 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
							/>
							<button
								class="flex items-center gap-1.5 rounded-lg border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-primary)] hover:border-[var(--color-gold-600)] disabled:opacity-50"
								onclick={fetchModelsForActiveProfile}
								disabled={fetchingModels || !settings.activeProfile}
								title="Fetch models from the active provider"
							>
								<RefreshCw class="h-3.5 w-3.5 {fetchingModels ? 'animate-spin' : ''}" />
								Get Models
							</button>
							<button
								class="rounded-lg bg-[var(--color-gold-400)]/20 px-3 py-2 text-xs font-semibold text-[var(--text-accent)] hover:bg-[var(--color-gold-400)]/30"
								onclick={saveNarrativeSettingsAndSync}
							>Save</button>
						</div>
						{#if modelChips.length > 0}
							<div class="relative">
								<Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
								<input
									type="search"
									bind:value={modelSearch}
									placeholder={`Search ${modelChips.length} model${modelChips.length === 1 ? '' : 's'}`}
									class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] py-1.5 pl-8 pr-3 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
								/>
							</div>
							<div class="max-h-44 overflow-y-auto rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)]/40 p-2">
								{#if filteredModelChips.length > 0}
									<div class="flex flex-wrap gap-1">
										{#each filteredModelChips as fm}
											<button
												class="max-w-full truncate rounded border border-[var(--border-primary)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]
												{settings.narrativeSettings.model === fm ? 'border-[var(--color-gold-600)] text-[var(--text-accent)]' : ''}"
												onclick={() => { settings.narrativeSettings.model = fm; saveNarrativeSettingsAndSync(); }}
												title={fm}
											>{fm}</button>
										{/each}
									</div>
								{:else}
									<p class="px-1 py-2 text-xs text-[var(--text-muted)]">No models match that search.</p>
								{/if}
							</div>
						{/if}
						{#if modelFetchMessage}
							<p class="text-[10px] {modelFetchMessage.startsWith('Fetched') ? 'text-emerald-400' : 'text-rose-400'}">{modelFetchMessage}</p>
						{/if}
					</div>

					<!-- Generation params -->
					<div class="grid grid-cols-2 gap-4">
						<div class="space-y-1.5">
							<label class="text-xs text-[var(--text-muted)]">Temperature</label>
							<input type="range" min="0" max="2" step="0.1"
								bind:value={settings.narrativeSettings.temperature}
								onchange={() => saveNarrativeSettingsAndSync()}
								class="w-full accent-[var(--color-gold-400)]" />
							<div class="text-center font-mono text-xs text-[var(--text-primary)]">{settings.narrativeSettings.temperature?.toFixed(1) ?? '1.0'}</div>
						</div>
						<div class="space-y-1.5">
							<label class="text-xs text-[var(--text-muted)]">Max Tokens</label>
							<input type="number" min="256" max="65536" step="256"
								bind:value={settings.narrativeSettings.maxTokens}
								onchange={() => saveNarrativeSettingsAndSync()}
								class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-1.5 font-mono text-sm text-[var(--text-primary)] focus:outline-none" />
						</div>
					</div>

					<!-- Provider list -->
					<div>
						<div class="mb-3 font-display text-xs uppercase tracking-wider text-[var(--text-muted)]">Providers</div>
						<div class="grid grid-cols-2 gap-2">
							{#each topProviders as pid}
								{@const prov = PROVIDERS[pid]}
								{@const Icon = providerIcons[pid] ?? Server}
								{@const isConfigured = isProviderConfigured(pid)}
								{@const isActive = settings.activeProfile?.providerType === pid}
								<button class="relative flex items-center gap-3 rounded-xl border p-3 text-left transition-all
									{isActive
										? 'border-[var(--color-gold-600)]/40 bg-[rgba(212,168,83,0.08)]'
										: isConfigured
											? 'border-emerald-500/20 bg-emerald-500/5'
											: 'border-[var(--border-primary)] hover:border-[var(--color-gold-600)]'}"
									onclick={() => selectProvider(pid)}>
									<Icon class="h-5 w-5 shrink-0 {isActive ? 'text-[var(--text-accent)]' : 'text-[var(--text-muted)]'}" />
									<div class="flex-1 min-w-0">
										<div class="text-sm font-semibold text-[var(--text-primary)] truncate">{prov.name}</div>
										<div class="text-[10px] text-[var(--text-muted)]">{isConfigured ? (isActive ? 'Active' : 'Configured') : 'Not set up'}</div>
									</div>
									{#if isConfigured}<Check class="h-3.5 w-3.5 shrink-0 text-emerald-400" />{/if}
								</button>
							{/each}
						</div>

						{#if otherProviders.length > 0}
							<details class="mt-3">
								<summary class="cursor-pointer text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
									More providers ({otherProviders.length})
								</summary>
								<div class="mt-2 space-y-1">
									{#each otherProviders as prov}
										{@const isConfigured = isProviderConfigured(prov.value)}
										<button class="flex w-full items-center gap-2 rounded-lg border border-[var(--border-primary)] px-3 py-2 text-left text-sm hover:border-[var(--color-gold-600)]"
											onclick={() => selectProvider(prov.value)}>
											<Server class="h-3.5 w-3.5 text-[var(--text-muted)]" />
											<span class="flex-1 text-[var(--text-primary)]">{prov.label}</span>
											{#if isConfigured}<Check class="h-3 w-3 text-emerald-400" />{/if}
										</button>
									{/each}
								</div>
							</details>
						{/if}
					</div>

					<!-- Provider edit form (inline, expands below) -->
					{#if editingProvider}
						{@const prov = PROVIDERS[editingProvider]}
						{@const editOptions = editModelChips(prov.fallbackModels)}
						{@const visibleEditModels = filteredEditModels(prov.fallbackModels)}
						<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4 space-y-4">
							<div class="flex items-center justify-between">
								<h4 class="font-display text-sm font-semibold text-[var(--text-primary)]">{prov.name}</h4>
								<button class="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]" onclick={() => editingProvider = null}>Close</button>
							</div>

							<!-- API Key -->
							{#if prov.requiresApiKey}
								<div class="space-y-1.5">
									<div class="flex items-center justify-between">
										<label class="text-xs text-[var(--text-muted)]">
											{editingProvider === 'anthropic' ? 'API Key or Setup Token' : editingProvider === 'anthropic-proxy' ? 'Bridge Token' : 'API Key'}
										</label>
										{#if editingProvider === 'anthropic'}
											<span class="text-[9px] text-purple-400">Supports sk-ant-oat-* setup tokens</span>
										{:else if editingProvider === 'anthropic-proxy'}
											<span class="text-[9px] text-purple-400">cc-bridge BRIDGE_TOKEN</span>
										{/if}
									</div>
									<div class="relative">
										<input
											type={showApiKey ? 'text' : 'password'}
											bind:value={apiKey}
											placeholder={editingProvider === 'anthropic' ? 'sk-ant-... or sk-ant-oat-...' : editingProvider === 'anthropic-proxy' ? 'Bridge token from cc-bridge service' : 'sk-...'}
											class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 pr-8 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
										/>
										<button class="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
											onclick={() => showApiKey = !showApiKey}>
											{#if showApiKey}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}
										</button>
									</div>
								</div>
							{/if}

							<div class="space-y-1.5">
								<label for="terminal-key-ref-{editingProvider}" class="text-xs text-[var(--text-muted)]">Terminal key ref</label>
								<input
									id="terminal-key-ref-{editingProvider}"
									type="text"
									bind:value={terminalApiKeyRef}
									placeholder={defaultTerminalApiKeyRef(editingProvider)}
									class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
								/>
								<p class="text-[10px] leading-relaxed text-[var(--text-muted)]">
									Saved to terminal settings as an env/config reference. The raw key stays in browser settings or ignored local config, not Postgres.
								</p>
							</div>

							<!-- Custom URL -->
							{#if editingProvider === 'openai-compatible' || editingProvider === 'ollama' || editingProvider === 'lmstudio' || editingProvider === 'anthropic-proxy'}
								<div class="space-y-1.5">
									<label class="text-xs text-[var(--text-muted)]">Base URL</label>
									<input type="text" bind:value={customUrl}
										placeholder={prov.baseUrl || 'https://your-api.com/v1'}
										class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none" />
								</div>
							{/if}

							<!-- Model quick select -->
							<div class="space-y-1.5">
								<label class="text-xs text-[var(--text-muted)]">Default Model</label>
								<input type="text" bind:value={model}
									placeholder={editOptions[0] ?? 'model-name'}
									class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none" />
								<div class="flex gap-2">
									<div class="relative flex-1">
										<Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
										<input
											type="search"
											bind:value={editModelSearch}
											placeholder={`Search ${editOptions.length} model${editOptions.length === 1 ? '' : 's'}`}
											class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] py-1.5 pl-8 pr-3 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
										/>
									</div>
									<button
										class="flex items-center gap-1.5 rounded-lg border border-[var(--border-primary)] px-3 py-1.5 text-xs text-[var(--text-primary)] hover:border-[var(--color-gold-600)] disabled:opacity-50"
										onclick={fetchModelsForEditing}
										disabled={fetchingModels || (prov.requiresApiKey && !apiKey)}
										title="Fetch models from this provider"
									>
										<RefreshCw class="h-3.5 w-3.5 {fetchingModels ? 'animate-spin' : ''}" />
										Get
									</button>
								</div>
								{#if editOptions.length > 1}
									<div class="max-h-44 overflow-y-auto rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)]/60 p-2">
										{#if visibleEditModels.length > 0}
											<div class="flex flex-wrap gap-1">
												{#each visibleEditModels as fm}
													<button
														class="max-w-full truncate rounded border border-[var(--border-primary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]
															{model === fm ? 'border-[var(--color-gold-600)] text-[var(--text-accent)]' : ''}"
														onclick={() => model = fm}
														title={fm}
													>{fm}</button>
												{/each}
											</div>
										{:else}
											<p class="px-1 py-2 text-xs text-[var(--text-muted)]">No models match that search.</p>
										{/if}
									</div>
								{/if}
								{#if fetchedModelsForProfile.length > 0}
									<p class="text-[10px] text-[var(--text-muted)] italic">Live list — {fetchedModelsForProfile.length} models from {customUrl || prov.baseUrl}/models</p>
								{/if}
							</div>

							<!-- Actions -->
							<div class="flex gap-2">
								<button class="flex-1 rounded-lg border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-primary)] hover:border-[var(--color-gold-600)]"
									onclick={testConnection} disabled={testStatus === 'testing' || (prov.requiresApiKey && !apiKey)}>
									{#if testStatus === 'testing'}Testing...
									{:else if testStatus === 'success'}Connected
									{:else if testStatus === 'error'}Failed — Retry
									{:else}Test{/if}
								</button>
								<button class="flex-1 rounded-lg bg-[var(--color-gold-400)]/20 px-3 py-2 text-xs font-semibold text-[var(--text-accent)] hover:bg-[var(--color-gold-400)]/30"
									onclick={saveProfile} disabled={prov.requiresApiKey && !apiKey}>
									Save Provider
								</button>
							</div>

							{#if testMessage}
								<div class="rounded-lg p-2 text-xs {testStatus === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}">
									{testMessage}
								</div>
							{/if}
						</div>
					{/if}

					<!-- Context Window -->
					<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
						<ContextWindow />
					</div>
					<div class="space-y-3 border-t border-[var(--border-primary)] pt-4">
						<h4 class="font-display text-xs uppercase tracking-wider text-[var(--text-accent)]">Terminal Runtime</h4>
						<div class="flex items-start gap-3 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
							<span class="mt-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">On</span>
							<span class="min-w-0">
								<span class="block text-xs font-medium text-[var(--text-primary)]">Terminal-bound turns</span>
								<span class="mt-1 block text-[10px] leading-relaxed text-[var(--text-muted)]">Bound stories always route turns through the engine command gateway.</span>
							</span>
						</div>
					</div>
				</div>

				<!-- ═══ TAB: AI SERVICES ═══ -->
				{:else if activeTab === 'services'}
				<ServiceConfigPanel onBack={() => activeTab = 'providers'} />

				<!-- ═══ TAB: PROMPTS ═══ -->
				{:else if activeTab === 'prompts'}
				<PromptsPanel />

				<!-- ═══ TAB: MEMORY ═══ -->
				{:else if activeTab === 'memory'}
				<div class="space-y-4">
					<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
						<div class="mb-4 flex items-start justify-between gap-3">
							<div>
								<h4 class="font-display text-xs uppercase tracking-wider text-[var(--text-accent)]">Live Context</h4>
								<p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">Prompt size, recent turns, and raw history intake.</p>
							</div>
							<span class="rounded-full border border-[var(--border-primary)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
								{settings.contextBudget === 0 ? 'Auto' : `${settings.contextBudget.toLocaleString()} tokens`}
							</span>
						</div>

						<div class="space-y-5">
							<div class="space-y-2">
								<div class="flex items-center justify-between gap-3">
									<span class="text-xs font-medium text-[var(--text-primary)]">Context Budget</span>
									<span class="font-mono text-[11px] text-[var(--text-muted)]">{settings.contextBudget === 0 ? 'Auto' : settings.contextBudget.toLocaleString()}</span>
								</div>
								<div class="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3">
									<input
										type="range"
										bind:value={contextBudgetSliderIndex}
										use:syncRangeValue={contextBudgetSliderIndex}
										min="0"
										max={CONTEXT_BUDGET_STEPS.length - 1}
										step="1"
										oninput={(e) => saveContextBudgetFromSlider(Number((e.target as HTMLInputElement).value))}
										class="w-full accent-[var(--color-gold-400)]"
									/>
									<input
										type="number"
										value={settings.contextBudget}
										min="0"
										max="200000"
										step="1000"
										onchange={(e) => saveContextBudgetValue(Number((e.target as HTMLInputElement).value))}
										class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5 text-right font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"
									/>
								</div>
								<div class="grid grid-cols-4 text-[9px] text-[var(--text-muted)]">
									<span>{formatTokenBudgetCompact(CONTEXT_BUDGET_STEPS[0])}</span>
									<span class="text-center">{formatTokenBudgetCompact(CONTEXT_BUDGET_STEPS[5])}</span>
									<span class="text-center">{formatTokenBudgetCompact(CONTEXT_BUDGET_STEPS[8])}</span>
									<span class="text-right">{formatTokenBudgetCompact(CONTEXT_BUDGET_STEPS[CONTEXT_BUDGET_STEPS.length - 1])}</span>
								</div>
								<p class="text-[10px] leading-relaxed text-[var(--text-muted)]">0 keeps the model-aware automatic budget.</p>
							</div>

							{#each liveContextDials as dial (dial.key)}
								<div class="space-y-2">
									<div class="flex items-center justify-between gap-3">
										<span class="text-xs font-medium text-[var(--text-primary)]">{dial.label}</span>
										<span class="font-mono text-[11px] text-[var(--text-muted)]">{formatDialValue(dial)}</span>
									</div>
									<div class="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3">
										{#if dial.key === 'backendMemoryTokenBudget'}
											<input
												type="range"
												value={String(backendMemorySliderPosition())}
												use:syncRangeValue={backendMemorySliderPosition()}
												min="0"
												max="100"
												step="1"
												oninput={(e) => saveUiNumber(dial.key, backendMemoryTokensFromSlider(Number((e.target as HTMLInputElement).value)), dial.min, dial.max)}
												class="w-full accent-[var(--color-gold-400)]"
											/>
										{:else}
											<input
												type="range"
												value={String(settingValue(dial.key))}
												use:syncRangeValue={settingValue(dial.key)}
												min={dial.min}
												max={dial.max}
												step={dial.step}
												oninput={(e) => saveUiNumber(dial.key, Number((e.target as HTMLInputElement).value), dial.min, dial.max)}
												class="w-full accent-[var(--color-gold-400)]"
											/>
										{/if}
										<input
											type="number"
											bind:value={settings.uiSettings[dial.key]}
											min={dial.min}
											max={dial.max}
											step={dial.step}
											onchange={(e) => saveUiNumber(dial.key, Number((e.target as HTMLInputElement).value), dial.min, dial.max)}
											class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5 text-right font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"
										/>
									</div>
									<p class="text-[10px] leading-relaxed text-[var(--text-muted)]">{dial.description}</p>
								</div>
							{/each}
						</div>
					</section>

					<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
						<div class="mb-4 flex items-start justify-between gap-3">
							<div>
								<h4 class="font-display text-xs uppercase tracking-wider text-[var(--text-accent)]">Retrieval</h4>
								<p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">How much searchable memory is pulled for the current action.</p>
							</div>
							<span class="rounded-full border border-[var(--border-primary)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
								Terminal-bound
							</span>
						</div>

						<div class="space-y-5">
							{#each retrievalDials as dial (dial.key)}
								<div class="space-y-2">
									<div class="flex items-center justify-between gap-3">
										<span class="text-xs font-medium text-[var(--text-primary)]">{dial.label}</span>
										<span class="font-mono text-[11px] text-[var(--text-muted)]">{formatDialValue(dial)}</span>
									</div>
									<div class="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3">
										{#if dial.key === 'backendMemoryTokenBudget'}
											<input
												type="range"
												value={String(backendMemorySliderPosition())}
												use:syncRangeValue={backendMemorySliderPosition()}
												min="0"
												max="100"
												step="1"
												oninput={(e) => saveUiNumber(dial.key, backendMemoryTokensFromSlider(Number((e.target as HTMLInputElement).value)), dial.min, dial.max)}
												class="w-full accent-[var(--color-gold-400)]"
											/>
										{:else}
											<input
												type="range"
												value={String(settingValue(dial.key))}
												use:syncRangeValue={settingValue(dial.key)}
												min={dial.min}
												max={dial.max}
												step={dial.step}
												oninput={(e) => saveUiNumber(dial.key, Number((e.target as HTMLInputElement).value), dial.min, dial.max)}
												class="w-full accent-[var(--color-gold-400)]"
											/>
										{/if}
										<input
											type="number"
											value={settingValue(dial.key)}
											min={dial.min}
											max={dial.max}
											step={dial.step}
											onchange={(e) => saveUiNumber(dial.key, Number((e.target as HTMLInputElement).value), dial.min, dial.max)}
											class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5 text-right font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"
										/>
									</div>
									<p class="text-[10px] leading-relaxed text-[var(--text-muted)]">{dial.description}</p>
								</div>
							{/each}
						</div>
					</section>

					<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
						<div class="mb-4">
							<h4 class="font-display text-xs uppercase tracking-wider text-[var(--text-accent)]">Summary Jobs</h4>
							<p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">Chapter creation and arc condensation pacing.</p>
						</div>

						<div class="space-y-5">
							{#each summaryDials as dial (dial.key)}
								<div class="space-y-2">
									<div class="flex items-center justify-between gap-3">
										<span class="text-xs font-medium text-[var(--text-primary)]">{dial.label}</span>
										<span class="font-mono text-[11px] text-[var(--text-muted)]">{formatDialValue(dial)}</span>
									</div>
									<div class="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3">
										<input
											type="range"
											value={settingValue(dial.key)}
											min={dial.min}
											max={dial.max}
											step={dial.step}
											oninput={(e) => saveUiNumber(dial.key, Number((e.target as HTMLInputElement).value), dial.min, dial.max)}
											class="w-full accent-[var(--color-gold-400)]"
										/>
										<input
											type="number"
											value={settingValue(dial.key)}
											min={dial.min}
											max={dial.max}
											step={dial.step}
											onchange={(e) => saveUiNumber(dial.key, Number((e.target as HTMLInputElement).value), dial.min, dial.max)}
											class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 py-1.5 text-right font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"
										/>
									</div>
									<p class="text-[10px] leading-relaxed text-[var(--text-muted)]">{dial.description}</p>
								</div>
							{/each}
						</div>
					</section>
				</div>

				<!-- ═══ TAB: IMAGE GENERATION ═══ -->
				{:else if activeTab === 'images'}
				<div class="space-y-5">
					<!-- Image Provider (separate from narrative) -->
					<div class="space-y-2">
						<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Image Provider</label>
						<p class="text-xs text-[var(--text-muted)] leading-relaxed">
							The provider used for image generation. Independent from the narrative provider — pick a configured profile, configure a dedicated one below, or leave on default to follow the active narrative profile.
						</p>
						<div class="flex gap-2">
							<select
								class="flex-1 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"
								value={settings.uiSettings.imageProfileId ?? ''}
								onchange={(e) => { settings.uiSettings.imageProfileId = (e.target as HTMLSelectElement).value; settings.saveUISettings(); }}
							>
								<option value="">Use narrative provider (default)</option>
								{#each settings.profiles as p}
									{@const cfg = PROVIDERS[p.providerType as ProviderType]}
									{@const supportsImages = cfg?.capabilities.imageGeneration}
									<option value={p.id}>{p.name}{supportsImages ? '' : ' — no image support'}</option>
								{/each}
							</select>
							<button
								class="rounded-xl border border-[var(--border-primary)] px-4 py-3 text-xs text-[var(--text-primary)] hover:border-[var(--color-gold-600)]"
								onclick={openImgEditorForExisting}
							>
								{settings.uiSettings.imageProfileId ? 'Edit Key' : 'Add Image Provider'}
							</button>
						</div>
					</div>

					<!-- Inline image-provider editor -->
					{#if imgEditorOpen}
						<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4 space-y-3">
							<div class="flex items-center justify-between">
								<h4 class="font-display text-sm font-semibold text-[var(--text-primary)]">Image Provider Setup</h4>
								<button class="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]" onclick={() => imgEditorOpen = false}>Close</button>
							</div>

							<div class="space-y-1.5">
								<label class="text-xs text-[var(--text-muted)]">Provider</label>
								<select
									class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none"
									bind:value={imgProviderType}
								>
									{#each imageCapableProviders as p}
										<option value={p.value}>{p.label}</option>
									{/each}
								</select>
								<p class="text-[10px] text-[var(--text-muted)]">For Gemini image, pick <span class="font-mono">Google AI Studio</span>.</p>
							</div>

							{#if PROVIDERS[imgProviderType]?.requiresApiKey}
								<div class="space-y-1.5">
									<label class="text-xs text-[var(--text-muted)]">API Key</label>
									<div class="relative">
										<input
											type={imgShowKey ? 'text' : 'password'}
											bind:value={imgApiKey}
											placeholder="API key for the image provider"
											class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 pr-8 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
										/>
										<button class="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" onclick={() => imgShowKey = !imgShowKey}>
											{#if imgShowKey}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}
										</button>
									</div>
								</div>
							{/if}

							{#if imgProviderType === 'openai-compatible' || imgProviderType === 'ollama' || imgProviderType === 'lmstudio'}
								<div class="space-y-1.5">
									<label class="text-xs text-[var(--text-muted)]">Base URL</label>
									<input
										type="text"
										bind:value={imgBaseUrl}
										placeholder={PROVIDERS[imgProviderType]?.baseUrl || 'https://your-api.com/v1'}
										class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
									/>
								</div>
							{/if}

							{#if imgSaveError}
								<div class="rounded-lg bg-red-500/10 p-2 text-xs text-red-400">{imgSaveError}</div>
							{/if}

							<button
								class="w-full rounded-lg bg-[var(--color-gold-400)]/20 px-3 py-2 text-xs font-semibold text-[var(--text-accent)] hover:bg-[var(--color-gold-400)]/30 disabled:opacity-50"
								onclick={saveImageProvider}
								disabled={imgSaving || (PROVIDERS[imgProviderType]?.requiresApiKey && !imgApiKey)}
							>
								{imgSaving ? 'Saving...' : 'Save & Use for Images'}
							</button>
						</div>
					{/if}

					<!-- Character Consistency Prompt -->
					<div class="space-y-2 border-t border-[var(--border-primary)] pt-4">
						<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Character Prompt</label>
						<p class="text-xs text-[var(--text-muted)] leading-relaxed">
							Persistent description of your character (appearance, clothing, distinguishing features). Prepended to every image prompt to keep visuals consistent across scenes.
						</p>
						<textarea
							class="w-full rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
							rows="4"
							placeholder="e.g. A tall woman in her late twenties, dark auburn hair braided over one shoulder, emerald eyes, wearing a worn leather cuirass over a forest-green tunic, a silver crescent pendant at her throat"
							value={settings.uiSettings.imageCharacterPrompt ?? ''}
							oninput={(e) => { settings.uiSettings.imageCharacterPrompt = (e.target as HTMLTextAreaElement).value; settings.saveUISettings(); }}
						></textarea>
					</div>

					<!-- Image Generation Mode -->
					<div class="space-y-2 border-t border-[var(--border-primary)] pt-4">
						<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Generation Mode</label>
						<p class="text-xs text-[var(--text-muted)] leading-relaxed">
							Controls when images are generated. Inline generates automatically after each narrative. Agentic lets the AI decide.
						</p>
						<div class="grid grid-cols-3 gap-2">
							{#each [
								{ value: 'none', label: 'Off', desc: 'Disabled' },
								{ value: 'inline', label: 'Inline', desc: 'Auto-generate' },
								{ value: 'agentic', label: 'Agentic', desc: 'AI decides' },
							] as mode}
								<button class="rounded-lg border border-[var(--border-primary)] px-3 py-3 text-left transition-colors
									{settings.uiSettings.imageGenerationMode === mode.value
										? 'border-[var(--color-gold-600)] text-[var(--text-accent)] bg-[rgba(212,168,83,0.08)]'
										: 'text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]'}"
									onclick={() => { settings.uiSettings.imageGenerationMode = mode.value as any; settings.saveUISettings(); }}>
									<div class="font-display text-sm tracking-wide">{mode.label}</div>
									<div class="mt-0.5 text-[10px] opacity-70">{mode.desc}</div>
								</button>
							{/each}
						</div>
					</div>

					<!-- Style Preset -->
					<div class="space-y-2 border-t border-[var(--border-primary)] pt-4">
						<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Art Style</label>
						<div class="grid grid-cols-2 gap-2">
							{#each Object.entries(STYLE_PRESETS) as [key, preset]}
								<button class="rounded-lg border border-[var(--border-primary)] px-3 py-2.5 text-left transition-colors
									{settings.uiSettings.imageStyle === key
										? 'border-[var(--color-gold-600)] text-[var(--text-accent)] bg-[rgba(212,168,83,0.08)]'
										: 'text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]'}"
									onclick={() => { settings.uiSettings.imageStyle = key; settings.saveUISettings(); }}>
									<div class="text-sm">{preset.label}</div>
								</button>
							{/each}
							<button class="rounded-lg border border-[var(--border-primary)] px-3 py-2.5 text-left transition-colors
								{settings.uiSettings.imageStyle === 'custom'
									? 'border-[var(--color-gold-600)] text-[var(--text-accent)] bg-[rgba(212,168,83,0.08)]'
									: 'text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]'}"
								onclick={() => { settings.uiSettings.imageStyle = 'custom'; settings.saveUISettings(); }}>
								<div class="text-sm">Custom</div>
							</button>
						</div>
						{#if settings.uiSettings.imageStyle === 'custom'}
							<textarea
								class="w-full rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
								rows="3"
								placeholder="Describe the art style for generated images..."
								value={settings.uiSettings.imageCustomStyle ?? ''}
								oninput={(e) => { settings.uiSettings.imageCustomStyle = (e.target as HTMLTextAreaElement).value; settings.saveUISettings(); }}
							></textarea>
						{/if}
					</div>

					<!-- Image Size -->
					<div class="space-y-2 border-t border-[var(--border-primary)] pt-4">
						<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Image Size</label>
						<div class="grid grid-cols-3 gap-2">
							{#each ['512x512', '1024x1024', '1024x1792'] as size}
								<button class="rounded-lg border border-[var(--border-primary)] px-3 py-2.5 text-center transition-colors
									{settings.uiSettings.imageSize === size
										? 'border-[var(--color-gold-600)] text-[var(--text-accent)] bg-[rgba(212,168,83,0.08)]'
										: 'text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]'}"
									onclick={() => { settings.uiSettings.imageSize = size; settings.saveUISettings(); }}>
									<div class="text-sm">{size}</div>
								</button>
							{/each}
						</div>
					</div>

					<!-- Model Override -->
					<div class="space-y-2 border-t border-[var(--border-primary)] pt-4">
						<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Model Override</label>
						<p class="text-xs text-[var(--text-muted)] leading-relaxed">
							Leave empty to use the provider's default image model.
						</p>
						<input
							type="text"
							class="w-full rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
							placeholder={settings.activeProvider?.imageDefaults?.defaultModel ?? 'Provider default'}
							value={settings.uiSettings.imageModel ?? ''}
							oninput={(e) => { settings.uiSettings.imageModel = (e.target as HTMLInputElement).value; settings.saveUISettings(); }}
						/>
					</div>
				</div>

				<!-- ═══ TAB: INTERFACE ═══ -->
				{:else if activeTab === 'interface'}
				<div class="space-y-5">
					<div class="space-y-2">
						<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Font Size</label>
						<div class="grid grid-cols-3 gap-2">
							{#each ['small', 'medium', 'large'] as size}
								<button class="rounded-lg border border-[var(--border-primary)] px-4 py-3 font-display text-sm capitalize tracking-wide transition-colors
									{settings.uiSettings.fontSize === size
										? 'border-[var(--color-gold-600)] text-[var(--text-accent)] bg-[rgba(212,168,83,0.08)]'
										: 'text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]'}"
									onclick={() => settings.setFontSize(size as any)}>
									{size}
								</button>
							{/each}
						</div>
					</div>
					<div class="space-y-3">
						<label class="flex items-center justify-between">
							<span class="text-sm text-[var(--text-primary)]">Auto-scroll to new content</span>
							<input type="checkbox" class="h-4 w-4 accent-[var(--color-gold-400)]"
								checked={settings.uiSettings.autoScroll}
								onchange={(e) => { settings.uiSettings.autoScroll = (e.target as HTMLInputElement).checked; settings.saveUISettings(); }} />
						</label>
						<label class="flex items-center justify-between">
							<span class="text-sm text-[var(--text-primary)]">Show word count</span>
							<input type="checkbox" class="h-4 w-4 accent-[var(--color-gold-400)]"
								checked={settings.uiSettings.showWordCount}
								onchange={(e) => { settings.uiSettings.showWordCount = (e.target as HTMLInputElement).checked; settings.saveUISettings(); }} />
						</label>
						<label class="flex items-center justify-between">
							<span class="text-sm text-[var(--text-primary)]">Disable suggestions</span>
							<input type="checkbox" class="h-4 w-4 accent-[var(--color-gold-400)]"
								checked={settings.uiSettings.disableSuggestions}
								onchange={(e) => { settings.uiSettings.disableSuggestions = (e.target as HTMLInputElement).checked; settings.saveUISettings(); }} />
						</label>
					</div>

				</div>

				<!-- ═══ TAB: INSPECTOR ═══ -->
				{:else if activeTab === 'inspector'}
				<PromptInspector />
				{/if}

			</div>
		</div>
	</div>
</div>
{/if}

<style>
	.settings-modal-shell {
		height: 100dvh;
		max-height: 100dvh;
	}

	@media (min-width: 640px) {
		.settings-modal-shell {
			height: min(92dvh, 800px);
			max-height: min(92dvh, 800px);
		}
	}
</style>
