<script lang="ts">
	import { X, Check, ExternalLink, Eye, EyeOff, Globe, Server, Sparkles, Cpu, Zap, SlidersHorizontal, Wrench, Palette, ScrollText, ChevronDown, ImageIcon, Brain, RefreshCw, Search, FileText } from 'lucide-svelte';
	import JevProviderPanel from './JevProviderPanel.svelte';
	import AgentSettingsPanel from './AgentSettingsPanel.svelte';
	import ServiceConfigPanel from './ServiceConfigPanel.svelte';
	import ModelRolesPanel from './ModelRolesPanel.svelte';
	import PromptsPanel from './PromptsPanel.svelte';
	import PromptInspector from './PromptInspector.svelte';
	import ContextWindow from '../story/ContextWindow.svelte';
	import MemoryProcessingStatus from '../story/MemoryProcessingStatus.svelte';
	import { story } from '$lib/stores/story.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { settings, SERVICE_DEFINITIONS, SERVICE_PROFILES } from '$lib/stores/settings.svelte';
	import { PROVIDERS, getProviderList } from '$lib/services/ai/sdk/providers/config';
	import {
		CONTEXT_BUDGET_STEPS,
		contextBudgetSliderIndexToValue,
		contextBudgetValueToSliderIndex,
		formatTokenBudgetCompact,
	} from '$lib/services/memorySettings';
	import { defaultTerminalApiKeyRef, refreshTerminalLlmSettings, patchTerminalLlmSettings } from '$lib/services/terminalSettings';
	import type { ProviderType, APIProfile, UISettings } from '$lib/types';
	import { uuid } from '$lib/utils/uuid';
	import { fade } from 'svelte/transition';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();
	let terminalSettingsError = $state('');
	$effect(() => {
		if (open) void refreshTerminalLlmSettings().then(() => terminalSettingsError = '').catch(error => terminalSettingsError = String(error));
	});

	// Tab navigation
	type Tab = 'agents' | 'providers' | 'services' | 'prompts' | 'memory' | 'images' | 'interface' | 'inspector';
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
		| 'backendMemoryTokenBudget'
		| 'recentDialogueTokens'
		| 'recentDialogueTurns'
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
	let settingsBody = $state<HTMLDivElement>();

	// Provider editing
	let editingProvider = $state<ProviderType | null>(null);
	$effect(() => {
		if (open && editingProvider) return app.registerNavigationGuard(() => {
			testStatus = 'error';
			testMessage = 'Save or close this provider editor before leaving settings.';
			return false;
		});
	});
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
	let fetchingEditorModels = $state(false);
	let modelRequest = 0;
	let activeModelRequest = 0;
	let modelFetchMessage = $state('');
	let contextBudgetSliderIndex = $state(0);

	$effect(() => {
		if (!open) {
			modelRequest += 1;
			activeModelRequest += 1;
			fetchingModels = false;
			fetchingEditorModels = false;
			testStatus = 'idle';
		}
	});
	$effect(() => {
		void settings.activeProfile?.id;
		modelFetchMessage = '';
	});

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
		return !provider.requiresApiKey || !!profile.apiKey || profile.id.startsWith('terminal:');
	}

	function keyLabelFor(profile: APIProfile): string {
		const provider = PROVIDERS[profile.providerType as ProviderType];
		if (provider && !provider.requiresApiKey) return 'Application Default Credentials';
		if (profile.apiKey.startsWith('sk-ant-oat-')) return 'Setup Token (OAuth)';
		return profile.id.startsWith('terminal:') && !profile.apiKey ? 'Managed on server' : profile.apiKey ? '••••' + profile.apiKey.slice(-4) : 'Not stored';
	}

	function selectProvider(id: ProviderType) {
		modelRequest += 1;
		fetchingEditorModels = false;
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
		const request = ++activeModelRequest;
		const key = profile.apiKey;
		const baseUrl = profile.baseUrl || provider.baseUrl;
		const isCurrent = () => request === activeModelRequest && settings.activeProfile?.id === profile.id && settings.activeProfile?.apiKey === key && (settings.activeProfile?.baseUrl || settings.activeProvider?.baseUrl) === baseUrl;
		fetchingModels = true;
		modelFetchMessage = '';
		try {
			if (!baseUrl) throw new Error('This provider does not expose an OpenAI-compatible /models endpoint.');
			const ids = await fetchOpenAIModels(baseUrl, key);
			if (!isCurrent()) return;
			profile.fetchedModels = ids;
			await settings.saveProfiles();
			if (isCurrent()) modelFetchMessage = `Fetched ${ids.length} model${ids.length === 1 ? '' : 's'}.`;
		} catch (e) {
			if (isCurrent()) modelFetchMessage = e instanceof Error ? e.message : 'Failed to fetch models.';
		} finally {
			if (request === activeModelRequest) fetchingModels = false;
		}
	}

	async function fetchModelsForEditing() {
		if (!editingProvider) return;
		const request = ++modelRequest;
		const providerId = editingProvider, key = apiKey, url = customUrl;
		const isCurrent = () => request === modelRequest && editingProvider === providerId && apiKey === key && customUrl === url;
		fetchingEditorModels = true;
		testStatus = 'testing';
		testMessage = '';
		try {
			const provider = PROVIDERS[editingProvider];
			const baseUrl = customUrl || provider.baseUrl;
			if (!baseUrl) throw new Error('This provider does not expose an OpenAI-compatible /models endpoint.');
			const ids = await fetchOpenAIModels(baseUrl, apiKey);
			if (!isCurrent()) return;
			fetchedModelsForProfile = ids;
			testStatus = 'success';
			testMessage = `Fetched ${ids.length} model${ids.length === 1 ? '' : 's'}.`;
		} catch (e) {
			if (!isCurrent()) return;
			testStatus = 'error';
			testMessage = e instanceof Error ? e.message : 'Failed to fetch models.';
		} finally {
			if (request === modelRequest) {
				fetchingEditorModels = false;
				if (!isCurrent()) testStatus = 'idle';
			}
		}
	}

	async function saveProfile() {
		if (!editingProvider) return;
		const providerType = editingProvider;
		const providerConfig = PROVIDERS[providerType];
		const existing = getProfileByProvider(providerType);
		const normalizedKeyRef = terminalApiKeyRef.trim() || null;
		if (normalizedKeyRef?.replace(/^env:/, '').startsWith('sk-')) {
			testStatus = 'error'; testMessage = 'Put the secret in API Key. Terminal key ref must be a name such as env:NANOGPT_API_KEY.'; return;
		}

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
			await settings.saveNarrativeSettings();
		}
		try {
			await settings.setServiceConfig('narrative', { profileId: settings.activeProfileId ?? '', model: settings.narrativeSettings.model });
			await patchTerminalLlmSettings([{ serviceId: 'narrative', providerType, baseUrl: customUrl || providerConfig?.baseUrl || null, model: settings.narrativeSettings.model || null, apiKeyRef: normalizedKeyRef || defaultTerminalApiKeyRef(providerType) }], apiKey.trim() ? [{ ref: normalizedKeyRef || defaultTerminalApiKeyRef(providerType), value: apiKey.trim() }] : []);
			await refreshTerminalLlmSettings();
			testStatus = 'success';
			testMessage = 'Saved provider and synced terminal runtime settings.';
		} catch (error) {
			testStatus = 'error';
			testMessage = `Saved locally, but terminal sync failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	async function testConnection() {
		if (!editingProvider) return;
		const request = ++modelRequest;
		const providerId = editingProvider, key = apiKey, url = customUrl, selectedModel = model;
		const isCurrent = () => request === modelRequest && editingProvider === providerId && apiKey === key && customUrl === url && model === selectedModel;
		testStatus = 'testing';
		testMessage = '';
		try {
			const provider = PROVIDERS[editingProvider];
			const testModel = model || provider.fallbackModels[0];
			const baseUrl = customUrl || provider.baseUrl;
			const isAnthropicShape = editingProvider === 'anthropic' || editingProvider === 'anthropic-proxy';
			const isZaiShape = editingProvider === 'z-ai';
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
				if (res.ok) { if (!isCurrent()) return; testStatus = 'success'; testMessage = 'Connected!'; }
				else { const err = await res.text(); if (!isCurrent()) return; testStatus = 'error'; testMessage = `HTTP ${res.status}: ${err.slice(0, 150)}`; }
			} else if (isZaiShape) {
				// Z.AI's public OpenAPI surface exposes chat completions, not /models.
				const headers: Record<string, string> = { 'Content-Type': 'application/json' };
				if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
				const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
					method: 'POST',
					headers,
					body: JSON.stringify({
						model: testModel,
						messages: [{ role: 'user', content: 'Hi' }],
						max_tokens: 1,
						stream: false,
					}),
				});
				if (res.ok) { if (!isCurrent()) return; testStatus = 'success'; testMessage = 'Connected!'; }
				else { const err = await res.text(); if (!isCurrent()) return; testStatus = 'error'; testMessage = `HTTP ${res.status}: ${err.slice(0, 150)}`; }
			} else {
				// OpenAI-compatible: hit /models, parse the list, persist it.
				try {
					const ids = await fetchOpenAIModels(baseUrl, apiKey);
					if (!isCurrent()) return;
					fetchedModelsForProfile = ids;
					testStatus = 'success';
					testMessage = ids.length > 0
						? `Connected — fetched ${ids.length} model${ids.length === 1 ? '' : 's'}`
						: 'Connected, but no models returned';
				} catch (e) {
					if (!isCurrent()) return;
					testStatus = 'error';
					testMessage = e instanceof Error ? e.message : 'Connection failed';
				}
			}
		} catch (e) {
			if (!isCurrent()) return;
			testStatus = 'error';
			testMessage = e instanceof Error ? e.message : 'Connection failed';
		} finally {
			if (request === modelRequest && !isCurrent()) testStatus = 'idle';
		}
	}

	// Generation settings (bound and saved)
	async function syncNarrativeRuntimeSetting(field: 'model' | 'temperature' | 'maxTokens' | 'reasoningEffort') {
		try {
			await patchTerminalLlmSettings([{ serviceId: 'narrative', [field]: settings.narrativeSettings[field] }]);
			await refreshTerminalLlmSettings();
		} catch (error) {
			console.warn('[Settings] Terminal sync for narrative settings failed:', error);
		}
	}

	async function saveNarrativeSettingsAndSync(field: 'model' | 'temperature' | 'maxTokens' | 'reasoningEffort' = 'model') {
		await settings.saveNarrativeSettings();
		await syncNarrativeRuntimeSetting(field);
	}

	async function saveTemp(val: number) {
		settings.narrativeSettings.temperature = val;
		await saveNarrativeSettingsAndSync('temperature');
	}
	async function saveMaxTokens(val: number) {
		settings.narrativeSettings.maxTokens = val;
		await saveNarrativeSettingsAndSync('maxTokens');
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
	}

	async function saveContextBudgetValue(value: number) {
		settings.contextBudget = clampDial(value, 0, 200000);
		await settings.saveContextBudget();
		await patchTerminalLlmSettings(['narrative', 'classifier'].map(serviceId => ({ serviceId, contextBudget: settings.contextBudget || null }))).catch((error) => {
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

	const tabs: Array<{ id: Tab; group: string; label: string; shortLabel: string; description: string; icon: typeof Globe }> = [
		{ id: 'providers', group: 'AI & tools', label: 'Providers & Models', shortLabel: 'Providers', description: 'Connect your providers and choose the voice behind your stories.', icon: Globe },
		{ id: 'agents', group: 'AI & tools', label: 'Agent Tools', shortLabel: 'Tools', description: 'Choose how the GM and Assistant work, with separate project defaults and game overrides.', icon: Wrench },
		{ id: 'services', group: 'AI & tools', label: 'AI Services', shortLabel: 'Services', description: 'Choose the models that help write, remember, and build your world.', icon: Cpu },
		{ id: 'prompts', group: 'Story experience', label: 'Prompts', shortLabel: 'Prompts', description: 'Shape the instructions behind your narrator and creative tools.', icon: FileText },
		{ id: 'memory', group: 'Story experience', label: 'Memory', shortLabel: 'Memory', description: 'Give each scene the right balance of recent events and lasting history.', icon: Brain },
		{ id: 'images', group: 'Story experience', label: 'Image Generation', shortLabel: 'Images', description: 'Set an art direction for the people and places in your story.', icon: ImageIcon },
		{ id: 'interface', group: 'Story experience', label: 'Interface', shortLabel: 'Interface', description: 'Make room for the way you like to read and write.', icon: Palette },
		{ id: 'inspector', group: 'Advanced', label: 'Inspector', shortLabel: 'Inspector', description: 'Look inside the context and instructions sent to your narrator.', icon: ScrollText },
	];

	function focusDialog(node: HTMLElement) {
		const previousFocus = document.activeElement;
		const frame = requestAnimationFrame(() => node.querySelector<HTMLButtonElement>('[data-settings-close]')?.focus());
		function handleKeydown(event: KeyboardEvent) {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				onClose();
			} else if (event.key === 'Tab') {
				const controls = [...node.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter(control => control.offsetParent !== null);
				const target = event.shiftKey ? controls.at(-1) : controls[0];
				if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
					event.preventDefault();
					target?.focus();
				}
			}
		}
		node.addEventListener('keydown', handleKeydown);
		return { destroy() {
			cancelAnimationFrame(frame);
			node.removeEventListener('keydown', handleKeydown);
			if (previousFocus instanceof HTMLElement) previousFocus.focus();
		} };
	}

	const serverMemoryControls = $derived(Boolean(story.currentStory?.serverStoryId) || settings.uiSettings.serverAuthoritativeTurns);
	const liveContextDials: MemoryDial[] = $derived(serverMemoryControls ? [
		{ key: 'recentDialogueTurns', label: 'Recent Dialogue', description: 'Keep up to this many complete player-and-GM turns from the current chapter. A scene checkpoint may shorten this to 10 turns; a 24,000-token safety cap prevents oversized requests.', min: 1, max: 40, step: 1, suffix: 'turns' },
	] : [
		{ key: 'snapshotTokenCap', label: 'Dynamic Prompt Cap', description: 'Caps arcs, chapters, lore, world state, retrieved memory, and final instructions before history is added.', min: 0, max: 50000, step: 500, suffix: 'tokens', zeroLabel: 'Auto' },
		{ key: 'maxMessages', label: 'Conversation Messages', description: 'Recent chat turns kept in the short-term prompt window.', min: 1, max: 1000, step: 1, suffix: 'messages' },
		{ key: 'maxHistoryEntries', label: 'Raw History Scan', description: 'Raw entries allowed into the local history scan before token budgeting cuts them down.', min: 1, max: 1000, step: 1, suffix: 'entries' },
	]);

	const retrievalDials: MemoryDial[] = [
		{ key: 'backendMemoryTokenBudget', label: 'Terminal Memory Packet', description: 'Target size for terminal-retrieved memory when a story is bound to the terminal world database.', min: 160, max: 2400, step: 20, suffix: 'tokens' },
		{ key: 'retrievedChapterLimit', label: 'Chapter Memories', description: 'Searchable episodic chapters injected for the current action.', min: 0, max: 12, step: 1, suffix: 'chapters', zeroLabel: 'Off' },
		{ key: 'retrievedLoreEntryLimit', label: 'Lorebook Matches', description: 'Local lore entries pulled by current action when backend retrieval is unavailable.', min: 0, max: 24, step: 1, suffix: 'entries', zeroLabel: 'Off' },
		{ key: 'conversationMemoryLimit', label: 'NPC Conversation Memory', description: 'NPC-specific remembered exchanges eligible for the current scene.', min: 0, max: 24, step: 1, suffix: 'memories', zeroLabel: 'Off' },
	];

	const summaryDials: MemoryDial[] = [
		{ key: 'maxPrevChaptersInSummary', label: 'Prior Chapter Context', description: 'Older chapter summaries given to the chapter summarizer for continuity.', min: 0, max: 50, step: 1, suffix: 'chapters', zeroLabel: 'None' },
	];
</script>

{#if open}
<div class="settings-overlay" transition:fade={{ duration: 150 }}>
	<button class="settings-backdrop" onclick={onClose} aria-label="Close settings" tabindex="-1"></button>

	<!-- Modal: wider, taller -->
	<div class="settings-modal-shell" class:settings-wide={activeTab === 'prompts'} role="dialog" aria-modal="true" aria-label="Settings" tabindex="-1" use:focusDialog>

		<!-- Sidebar -->
		<aside class="settings-sidebar">
			<div class="settings-brand">
				<span class="settings-eyebrow">Your workspace</span>
				<h2>Settings</h2>
			</div>
			<nav class="settings-navigation" aria-label="Settings sections">
				{#each tabs as tab, index}
					{#if index === 0 || tabs[index - 1].group !== tab.group}<span class="settings-nav-group">{tab.group}</span>{/if}
					<button
						class="settings-nav-item"
						class:active={activeTab === tab.id}
						aria-current={activeTab === tab.id ? 'page' : undefined}
						aria-label={tab.label}
						title={tab.label}
						onclick={() => { activeTab = tab.id; settingsBody?.scrollTo({ top: 0 }); }}
					>
						<tab.icon class="h-4 w-4 shrink-0" />
						<span class="settings-nav-label">{tab.label}</span>
						<span class="settings-nav-short">{tab.shortLabel}</span>
					</button>
				{/each}
			</nav>
			<div class="settings-sidebar-note"><span></span> Make it your own.</div>
		</aside>

		<!-- Content area -->
		<div class="settings-main">
			<!-- Header -->
			<header class="settings-header">
				<div>
					<span class="settings-eyebrow">Settings / {tabs.find(t => t.id === activeTab)?.group}</span>
					<h3 id="settings-section-title">{tabs.find(t => t.id === activeTab)?.label ?? 'Settings'}</h3>
					<p>{tabs.find(t => t.id === activeTab)?.description}</p>
				</div>
				<button class="settings-close" data-settings-close onclick={onClose} aria-label="Close settings">
					<X class="h-5 w-5" />
				</button>
			</header>

			<!-- Scrollable content -->
			<div class="settings-body" bind:this={settingsBody} aria-labelledby="settings-section-title">
				{#if terminalSettingsError}<p role="alert" class="settings-error">Server settings could not refresh: {terminalSettingsError}</p>{/if}

				<!-- ═══ TAB: PROVIDERS & MODELS ═══ -->
				{#if activeTab === 'providers'}
				<div class="space-y-6">

					<!-- Active provider + model display -->
					{#if settings.activeProfile}
						<div class="active-provider rounded-xl border border-[var(--color-gold-600)]/20 bg-[rgba(212,168,83,0.04)] p-4">
							<div class="flex items-center justify-between mb-3">
								<span class="font-display text-xs uppercase tracking-wider text-[var(--text-accent)]">Active Provider</span>
								<span class="provider-status">Active profile</span>
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
						<label for="narrative-model-input" class="font-display text-sm tracking-wide text-[var(--text-primary)]">GameMaster Model</label>
						<div class="model-actions flex gap-2">
							<input
								id="narrative-model-input"
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
								onclick={() => saveNarrativeSettingsAndSync()}
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
					<p class="text-xs text-[var(--text-muted)]">These settings mirror the terminal. API keys stay on the server unless you explicitly replace one.</p>
					<button class="min-h-11 text-xs text-[var(--text-accent)]" onclick={() => refreshTerminalLlmSettings().then(() => terminalSettingsError = '').catch(error => terminalSettingsError = String(error))}>Refresh from server</button>
					<div class="space-y-1.5">
						<label for="narrative-reasoning" class="text-xs text-[var(--text-muted)]">Reasoning (server setting)</label>
						<select id="narrative-reasoning" bind:value={settings.narrativeSettings.reasoningEffort} onchange={() => saveNarrativeSettingsAndSync('reasoningEffort')} class="w-full rounded-lg bg-[var(--bg-tertiary)] p-2 text-sm">
							{#each ['off', 'low', 'medium', 'high'] as effort}<option value={effort}>{effort}</option>{/each}
						</select>
					</div>
					<div class="grid grid-cols-2 gap-4">
						<div class="space-y-1.5">
							<label for="narrative-temperature" class="text-xs text-[var(--text-muted)]">Temperature</label>
							<input id="narrative-temperature" type="range" min="0" max="2" step="0.1"
								bind:value={settings.narrativeSettings.temperature}
								onchange={() => saveNarrativeSettingsAndSync('temperature')}
								class="w-full accent-[var(--color-gold-400)]" />
							<div class="text-center font-mono text-xs text-[var(--text-primary)]">{settings.narrativeSettings.temperature?.toFixed(1) ?? '1.0'}</div>
						</div>
						<div class="space-y-1.5">
							<label for="narrative-max-tokens" class="text-xs text-[var(--text-muted)]">Max Tokens</label>
							<input id="narrative-max-tokens" type="number" min="256" max="65536" step="256"
								bind:value={settings.narrativeSettings.maxTokens}
								onchange={() => saveNarrativeSettingsAndSync('maxTokens')}
								class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-1.5 font-mono text-sm text-[var(--text-primary)] focus:outline-none" />
						</div>
					</div>

					<JevProviderPanel />

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
										<label for="provider-api-key-{editingProvider}" class="text-xs text-[var(--text-muted)]">
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
											id="provider-api-key-{editingProvider}"
											type={showApiKey ? 'text' : 'password'}
											bind:value={apiKey}
											placeholder={editingProvider === 'anthropic' ? 'sk-ant-... or sk-ant-oat-...' : editingProvider === 'anthropic-proxy' ? 'Bridge token from cc-bridge service' : 'sk-...'}
											class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 pr-8 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
										/>
										<button class="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
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
									<label for="provider-base-url-{editingProvider}" class="text-xs text-[var(--text-muted)]">Base URL</label>
									<input id="provider-base-url-{editingProvider}" type="text" bind:value={customUrl}
										placeholder={prov.baseUrl || 'https://your-api.com/v1'}
										class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none" />
								</div>
							{/if}

							<!-- Model quick select -->
							<div class="space-y-1.5">
								<label for="provider-default-model-{editingProvider}" class="text-xs text-[var(--text-muted)]">Default Model</label>
								<input id="provider-default-model-{editingProvider}" type="text" bind:value={model}
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
										disabled={testStatus === 'testing' || (prov.requiresApiKey && !apiKey)}
										title="Fetch models from this provider"
									>
										<RefreshCw class="h-3.5 w-3.5 {fetchingEditorModels ? 'animate-spin' : ''}" />
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
								onclick={saveProfile} disabled={prov.requiresApiKey && !apiKey && !getProfileByProvider(editingProvider)?.id.startsWith('terminal:')}>
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
				{:else if activeTab === 'agents'}
				<AgentSettingsPanel />
			{:else if activeTab === 'services'}
				<ModelRolesPanel />
				<p class="text-xs text-[var(--text-muted)]">Advanced per-task settings below edit the same server settings; a task left on its role keeps inheriting it.</p>
				<ServiceConfigPanel onBack={() => activeTab = 'providers'} />

				<!-- ═══ TAB: PROMPTS ═══ -->
				{:else if activeTab === 'prompts'}
				<PromptsPanel />

				<!-- ═══ TAB: MEMORY ═══ -->
				{:else if activeTab === 'memory'}
				<div class="space-y-4">
					{#if story.currentStory?.serverStoryId}
						<MemoryProcessingStatus storyId={story.currentStory.serverStoryId} />
					{/if}
					<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
						<div class="mb-4 flex items-start justify-between gap-3">
							<div>
								<h4 class="font-display text-xs uppercase tracking-wider text-[var(--text-accent)]">Live Context</h4>
								<p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">Separate allowances for scene memory and recent dialogue. The server checks the whole request and reserves room for the reply.</p>
							</div>
							<span class="rounded-full border border-[var(--border-primary)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
								{settings.contextBudget === 0 ? 'Auto' : `${settings.contextBudget.toLocaleString()} tokens`}
							</span>
						</div>

						<div class="space-y-5">
							<div class="space-y-2">
								<div class="flex items-center justify-between gap-3">
									<span class="text-xs font-medium text-[var(--text-primary)]">Scene and Memory Budget</span>
									<span class="font-mono text-[11px] text-[var(--text-muted)]">{settings.contextBudget === 0 ? 'Auto' : settings.contextBudget.toLocaleString()}</span>
								</div>
								<div class="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3">
									<input
										type="range"
										bind:value={contextBudgetSliderIndex}
										aria-label="Scene and memory budget slider"
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
										aria-label="Scene and memory budget in tokens"
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
								<p class="text-[10px] leading-relaxed text-[var(--text-muted)]">0 uses the compiler's built-in section limits. Recent dialogue has its own allowance below; this is not the total model context size.</p>
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
												aria-label={`${dial.label} slider`} value={String(backendMemorySliderPosition())}
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
												aria-label={`${dial.label} slider`} value={String(settingValue(dial.key))}
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
											aria-label={dial.label} bind:value={settings.uiSettings[dial.key]}
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
							{#each retrievalDials.filter(dial => !serverMemoryControls || dial.key === 'backendMemoryTokenBudget') as dial (dial.key)}
								<div class="space-y-2">
									<div class="flex items-center justify-between gap-3">
										<span class="text-xs font-medium text-[var(--text-primary)]">{dial.label}</span>
										<span class="font-mono text-[11px] text-[var(--text-muted)]">{formatDialValue(dial)}</span>
									</div>
									<div class="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3">
										{#if dial.key === 'backendMemoryTokenBudget'}
											<input
												type="range"
												aria-label={`${dial.label} slider`} value={String(backendMemorySliderPosition())}
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
												aria-label={`${dial.label} slider`} value={String(settingValue(dial.key))}
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
											aria-label={dial.label} value={settingValue(dial.key)}
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
							<p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">Each chapter summarizes 20 completed story turns, keeping your action and its narration together. Each arc summarizes 10 consecutive chapters. Summarization starts as soon as the window is complete.</p>
						</div>

						<div class="space-y-5">
							{#each summaryDials.filter(dial => !serverMemoryControls || dial.key !== 'maxPrevChaptersInSummary') as dial (dial.key)}
								<div class="space-y-2">
									<div class="flex items-center justify-between gap-3">
										<span class="text-xs font-medium text-[var(--text-primary)]">{dial.label}</span>
										<span class="font-mono text-[11px] text-[var(--text-muted)]">{formatDialValue(dial)}</span>
									</div>
									<div class="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3">
										<input
											type="range"
											aria-label={dial.label} value={settingValue(dial.key)}
											min={dial.min}
											max={dial.max}
											step={dial.step}
											oninput={(e) => saveUiNumber(dial.key, Number((e.target as HTMLInputElement).value), dial.min, dial.max)}
											class="w-full accent-[var(--color-gold-400)]"
										/>
										<input
											type="number"
											aria-label={dial.label} value={settingValue(dial.key)}
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
					<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4 text-sm text-[var(--text-secondary)]">
						Scene images and character portraits use the Image Generation service configured under
						<button class="font-semibold text-[var(--text-accent)] underline" onclick={() => activeTab = 'services'}>AI Services</button>.
						Character appearance and scene details come from the saved game.
					</div>
					<!-- Image Generation Mode -->
					<div class="space-y-2 border-t border-[var(--border-primary)] pt-4">
						<span class="font-display text-sm tracking-wide text-[var(--text-primary)]">Generation Mode</span>
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

				</div>

				<!-- ═══ TAB: INTERFACE ═══ -->
				{:else if activeTab === 'interface'}
				<div class="space-y-5">
					<div class="space-y-2">
						<span class="font-display text-sm tracking-wide text-[var(--text-primary)]">Font Size</span>
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
	.settings-overlay {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 28px;
	}
	.settings-backdrop { position: absolute; inset: 0; background: rgb(6 9 7 / 76%); backdrop-filter: blur(10px); }
	.settings-modal-shell {
		position: relative;
		display: grid;
		grid-template-columns: 232px minmax(0, 1fr);
		width: 100%;
		max-width: 1120px;
		height: min(90dvh, 880px);
		max-height: calc(100dvh - 56px);
		min-height: 0;
		overflow: hidden;
		border: 1px solid var(--border-primary);
		border-radius: 20px;
		background: var(--bg-secondary);
		box-shadow: 0 32px 100px rgb(0 0 0 / 45%);
	}
	.settings-modal-shell.settings-wide { max-width: 1440px; }
	.settings-sidebar { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow-y: auto; background: var(--bg-primary); border-right: 1px solid var(--border-primary); }
	.settings-brand { padding: 34px 26px 26px; }
	.settings-eyebrow { display: block; color: var(--text-muted); font: 10px/1.5 var(--font-ui); font-weight: 600; text-transform: uppercase; letter-spacing: .17em; }
	.settings-brand h2 { margin-top: 7px; font: 30px/1.2 var(--font-display); color: var(--text-primary); }
	.settings-navigation { display: flex; flex-direction: column; gap: 5px; padding: 0 13px; }
	.settings-nav-group { padding: 18px 12px 6px; color: var(--text-muted); font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; }
	.settings-nav-group:first-child { padding-top: 0; }
	.settings-nav-item { display: flex; align-items: center; gap: 11px; min-height: 46px; padding: 12px; border: 1px solid transparent; border-radius: 9px; color: var(--text-muted); text-align: left; font-size: 12px; transition: color 150ms, background 150ms, border-color 150ms; }
	.settings-nav-item:hover { background: var(--bg-tertiary); color: var(--text-primary); }
	.settings-nav-item.active { border-color: color-mix(in srgb, var(--text-accent) 20%, transparent); color: var(--text-accent); background: color-mix(in srgb, var(--text-accent) 9%, transparent); }
	.settings-nav-short { display: none; }
	.settings-sidebar-note { display: flex; align-items: center; gap: 8px; margin-top: auto; padding: 28px 26px; font-size: 11px; color: var(--text-muted); }
	.settings-sidebar-note span { height: 5px; width: 5px; border-radius: 50%; background: #96ab91; }
	.settings-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
	.settings-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; padding: 30px 36px 25px; border-bottom: 1px solid var(--border-primary); }
	.settings-header h3 { margin-top: 9px; font: 30px/1.15 var(--font-display); color: var(--text-primary); letter-spacing: -.025em; }
	.settings-header p { max-width: 550px; margin-top: 10px; color: var(--text-muted); font-size: 12px; line-height: 1.7; }
	.settings-close { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 38px; height: 38px; border: 1px solid var(--border-primary); border-radius: 10px; color: var(--text-muted); }
	.settings-close:hover { background: var(--bg-tertiary); color: var(--text-primary); }
	.settings-close:focus-visible, .settings-nav-item:focus-visible { outline: 2px solid var(--text-accent); outline-offset: 2px; }
	.settings-error { margin-bottom: 20px; padding: 14px 16px; border: 1px solid color-mix(in srgb, var(--text-accent) 40%, transparent); border-radius: 8px; color: var(--text-primary); background: var(--bg-primary); font-size: 12px; overflow-wrap: anywhere; }
	.settings-body { min-height: 0; min-width: 0; flex: 1; overflow: auto; overscroll-behavior: contain; padding: 30px 36px 42px; scrollbar-gutter: stable; }
	.settings-body > :global(div) { max-width: 900px; margin-inline: auto; }
	.settings-wide .settings-body > :global(div) { max-width: none; }
	.settings-body :global(input:not([type='checkbox']):not([type='range'])),
	.settings-body :global(select),
	.settings-body :global(textarea) { min-width: 0; min-height: 42px; border-radius: 8px; font-size: 12px; line-height: 1.65; transition: border-color 150ms, box-shadow 150ms; }
	.settings-body :global(textarea) { resize: vertical; }
	.settings-body :global(input:focus-visible),
	.settings-body :global(select:focus-visible),
	.settings-body :global(textarea:focus-visible) { outline: 2px solid color-mix(in srgb, var(--text-accent) 45%, transparent); outline-offset: 2px; }
	.settings-body :global(button.font-display), .settings-body :global(label.font-display) { font-family: var(--font-ui); letter-spacing: .01em; }
	.settings-body :global(label) { line-height: 1.65; }
	.settings-body :global(section) { padding: 24px; border-radius: 12px; }
	.settings-body :global(section h4) { font: 21px/1.3 var(--font-display); text-transform: none; letter-spacing: 0; color: var(--text-primary); }
	.settings-body :global(section p) { font-size: 11px; line-height: 1.7; }
	.settings-body :global(input[type='range']) { min-height: 24px; }
	.settings-body :global(label:has(> input[type='checkbox'])) { gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--border-primary); }
	.active-provider { padding: 22px; background: linear-gradient(115deg, color-mix(in srgb, var(--text-accent) 8%, transparent), transparent); }
	.provider-status { border: 1px solid rgb(150 171 145 / 25%); border-radius: 20px; padding: 3px 9px; background: rgb(150 171 145 / 9%); color: #a9bea4; font-size: 10px; }
	.model-actions { flex-wrap: wrap; }
	.model-actions input { flex-basis: 200px; }
	@media (max-width: 900px) {
		.settings-overlay { padding: 18px; }
		.settings-modal-shell { grid-template-columns: 195px minmax(0, 1fr); max-height: calc(100dvh - 36px); }
		.settings-header, .settings-body { padding: 24px; }
		.settings-brand { padding-inline: 23px; }
		.settings-nav-item { font-size: 11px; gap: 8px; }
	}
	@media (max-width: 700px) {
		.settings-overlay { padding: 0; }
		.settings-modal-shell { display: flex; flex-direction: column; height: 100dvh; max-height: 100dvh; border: 0; border-radius: 0; }
		.settings-sidebar { flex-shrink: 0; border-right: 0; border-bottom: 1px solid var(--border-primary); }
		.settings-brand, .settings-sidebar-note, .settings-nav-label, .settings-nav-group { display: none; }
		.settings-navigation { flex-direction: row; gap: 5px; padding: 12px 16px; overflow-x: auto; }
		.settings-nav-item { flex-shrink: 0; min-height: 42px; font-size: 11px; padding: 10px 12px; }
		.settings-nav-short { display: inline; }
		.settings-main { flex: 1; }
		.settings-header { padding: 23px 20px 20px; }
		.settings-header h3 { font-size: 26px; }
		.settings-header p { font-size: 11px; margin-top: 8px; }
		.settings-header .settings-eyebrow { font-size: 9px; }
		.settings-body { padding: 22px 18px 32px; }
		.settings-body :global(section) { padding: 18px; }
		.settings-body :global(input:not([type='checkbox']):not([type='range'])),
		.settings-body :global(select), .settings-body :global(textarea) { font-size: 16px; }
		.settings-close { width: 42px; height: 42px; }
	}
</style>
