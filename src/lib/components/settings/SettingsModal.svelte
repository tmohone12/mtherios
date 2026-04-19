<script lang="ts">
	import { X, Check, ExternalLink, Eye, EyeOff, Globe, Server, Sparkles, Cpu, Zap, SlidersHorizontal, Wrench, Palette, ScrollText, ChevronDown, ImageIcon, Brain } from 'lucide-svelte';
	import ServiceConfigPanel from './ServiceConfigPanel.svelte';
	import PromptInspector from './PromptInspector.svelte';
	import ContextWindow from '../story/ContextWindow.svelte';
	import { settings, SERVICE_DEFINITIONS, SERVICE_PROFILES } from '$lib/stores/settings.svelte';
	import { PROVIDERS, getProviderList } from '$lib/services/ai/sdk/providers/config';
	import { STYLE_PRESETS } from '$lib/services/ai/image/ImageGenerationService';
	import type { ProviderType, APIProfile } from '$lib/types';
	import { uuid } from '$lib/utils/uuid';
	import { fade } from 'svelte/transition';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	// Tab navigation
	type Tab = 'providers' | 'services' | 'memory' | 'images' | 'interface' | 'inspector';
	let activeTab = $state<Tab>('providers');

	// Provider editing
	let editingProvider = $state<ProviderType | null>(null);
	let apiKey = $state('');
	let customUrl = $state('');
	let model = $state('');
	let showApiKey = $state(false);
	let testStatus = $state<'idle' | 'testing' | 'success' | 'error'>('idle');
	let testMessage = $state('');

	// Helpers
	function getProfileByProvider(providerType: ProviderType): APIProfile | undefined {
		return settings.profiles.find(p => p.providerType === providerType);
	}

	function selectProvider(id: ProviderType) {
		editingProvider = id;
		const existing = getProfileByProvider(id);
		apiKey = existing?.apiKey ?? '';
		model = existing ? (settings.narrativeSettings.model || '') : '';
		customUrl = existing?.baseUrl ?? '';
		showApiKey = false;
		testStatus = 'idle';
		testMessage = '';
	}

	async function saveProfile() {
		if (!editingProvider) return;
		const providerType = editingProvider;
		const providerConfig = PROVIDERS[providerType];
		const existing = getProfileByProvider(providerType);

		if (existing) {
			existing.apiKey = apiKey;
			if (customUrl) existing.baseUrl = customUrl;
			else delete existing.baseUrl;
			await settings.saveProfiles();
			await settings.setActiveProfile(existing.id);
		} else {
			const profile: APIProfile = {
				id: uuid(),
				name: providerConfig?.name ?? providerType,
				providerType,
				apiKey,
				...(customUrl ? { baseUrl: customUrl } : {}),
				customModels: [],
				fetchedModels: [],
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
	}

	async function testConnection() {
		if (!editingProvider) return;
		testStatus = 'testing';
		try {
			const provider = PROVIDERS[editingProvider];
			const testModel = model || provider.fallbackModels[0];
			const baseUrl = customUrl || provider.baseUrl;
			const isAnthropic = editingProvider === 'anthropic';
			const isOAuth = apiKey.startsWith('sk-ant-oat-');

			if (isAnthropic) {
				const anthropicUrl = baseUrl || '/api/anthropic';
				const headers: Record<string, string> = {
					'Content-Type': 'application/json',
					'anthropic-version': '2023-06-01',
				};
				if (isOAuth) {
					headers['Authorization'] = `Bearer ${apiKey}`;
					headers['anthropic-beta'] = 'oauth-2025-04-01';
				} else {
					headers['x-api-key'] = apiKey;
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
				const headers: Record<string, string> = { 'Content-Type': 'application/json' };
				if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
				const res = await fetch(`${baseUrl}/models`, { headers });
				if (res.ok) { testStatus = 'success'; testMessage = 'Connected!'; }
				else { const err = await res.text(); testStatus = 'error'; testMessage = `HTTP ${res.status}: ${err.slice(0, 150)}`; }
			}
		} catch (e) {
			testStatus = 'error';
			testMessage = e instanceof Error ? e.message : 'Connection failed';
		}
	}

	// Generation settings (bound and saved)
	async function saveTemp(val: number) {
		settings.narrativeSettings.temperature = val;
		await settings.saveNarrativeSettings();
	}
	async function saveMaxTokens(val: number) {
		settings.narrativeSettings.maxTokens = val;
		await settings.saveNarrativeSettings();
	}

	const providerIcons: Record<string, typeof Zap> = {
		openrouter: Globe, nanogpt: Zap, anthropic: Sparkles, openai: Cpu,
	};
	const topProviders: ProviderType[] = ['anthropic', 'openrouter', 'nanogpt', 'openai'];
	const otherProviders = getProviderList().filter(p => !topProviders.includes(p.value));

	const tabs: Array<{ id: Tab; label: string; icon: typeof Globe }> = [
		{ id: 'providers', label: 'Providers & Models', icon: Globe },
		{ id: 'services', label: 'AI Services', icon: Wrench },
		{ id: 'memory', label: 'Memory', icon: Brain },
		{ id: 'images', label: 'Image Generation', icon: ImageIcon },
		{ id: 'interface', label: 'Interface', icon: Palette },
		{ id: 'inspector', label: 'Inspector', icon: ScrollText },
	];
</script>

{#if open}
<div class="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4" transition:fade={{ duration: 150 }}>
	<button class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick={onClose}></button>

	<!-- Modal: wider, taller -->
	<div class="relative flex w-full max-w-3xl overflow-hidden rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)]"
		style="height: min(92dvh, 800px);">

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

		<!-- Mobile tab bar -->
		<div class="absolute top-0 left-0 right-0 z-10 flex sm:hidden border-b border-[var(--border-primary)] bg-[var(--bg-secondary)]">
			{#each tabs as tab}
				<button
					class="flex-1 py-3 text-center text-[10px] font-medium uppercase tracking-wider transition-colors
						{activeTab === tab.id ? 'text-[var(--text-accent)] border-b-2 border-[var(--color-gold-400)]' : 'text-[var(--text-muted)]'}"
					onclick={() => activeTab = tab.id}
				>
					{tab.label}
				</button>
			{/each}
		</div>

		<!-- Content area -->
		<div class="flex flex-1 flex-col min-w-0">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-6 py-4 sm:py-3">
				<h3 class="font-display text-base tracking-wide text-[var(--text-primary)]">
					{tabs.find(t => t.id === activeTab)?.label ?? 'Settings'}
				</h3>
				<button class="text-[var(--text-muted)] hover:text-[var(--text-primary)]" onclick={onClose}>
					<X class="h-5 w-5" />
				</button>
			</div>

			<!-- Scrollable content -->
			<div class="flex-1 overflow-y-auto p-6 pt-4 sm:pt-6" style="margin-top: 0;">

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
								Key: {settings.activeProfile.apiKey.startsWith('sk-ant-oat-') ? 'Setup Token (OAuth)' : '••••' + settings.activeProfile.apiKey.slice(-4)}
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
								class="rounded-lg bg-[var(--color-gold-400)]/20 px-3 py-2 text-xs font-semibold text-[var(--text-accent)] hover:bg-[var(--color-gold-400)]/30"
								onclick={() => settings.saveNarrativeSettings()}
							>Save</button>
						</div>
						{#if settings.activeProvider?.fallbackModels?.length}
							<div class="flex flex-wrap gap-1">
								{#each settings.activeProvider.fallbackModels.slice(0, 6) as fm}
									<button
										class="rounded border border-[var(--border-primary)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]"
										onclick={() => { settings.narrativeSettings.model = fm; settings.saveNarrativeSettings(); }}
									>{fm}</button>
								{/each}
							</div>
						{/if}
					</div>

					<!-- Generation params -->
					<div class="grid grid-cols-2 gap-4">
						<div class="space-y-1.5">
							<label class="text-xs text-[var(--text-muted)]">Temperature</label>
							<input type="range" min="0" max="2" step="0.1"
								bind:value={settings.narrativeSettings.temperature}
								onchange={() => settings.saveNarrativeSettings()}
								class="w-full accent-[var(--color-gold-400)]" />
							<div class="text-center font-mono text-xs text-[var(--text-primary)]">{settings.narrativeSettings.temperature?.toFixed(1) ?? '1.0'}</div>
						</div>
						<div class="space-y-1.5">
							<label class="text-xs text-[var(--text-muted)]">Max Tokens</label>
							<input type="number" min="256" max="65536" step="256"
								bind:value={settings.narrativeSettings.maxTokens}
								onchange={() => settings.saveNarrativeSettings()}
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
								{@const isConfigured = !!getProfileByProvider(pid)?.apiKey}
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
										{@const isConfigured = !!getProfileByProvider(prov.value)?.apiKey}
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
											{editingProvider === 'anthropic' ? 'API Key or Setup Token' : 'API Key'}
										</label>
										{#if editingProvider === 'anthropic'}
											<span class="text-[9px] text-purple-400">Supports sk-ant-oat-* setup tokens</span>
										{/if}
									</div>
									<div class="relative">
										<input
											type={showApiKey ? 'text' : 'password'}
											bind:value={apiKey}
											placeholder={editingProvider === 'anthropic' ? 'sk-ant-... or sk-ant-oat-...' : 'sk-...'}
											class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 pr-8 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
										/>
										<button class="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
											onclick={() => showApiKey = !showApiKey}>
											{#if showApiKey}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}
										</button>
									</div>
								</div>
							{/if}

							<!-- Custom URL -->
							{#if editingProvider === 'openai-compatible' || editingProvider === 'ollama' || editingProvider === 'lmstudio'}
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
									placeholder={prov.fallbackModels[0] ?? 'model-name'}
									class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none" />
								{#if prov.fallbackModels.length > 1}
									<div class="flex flex-wrap gap-1">
										{#each prov.fallbackModels.slice(0, 6) as fm}
											<button class="rounded border border-[var(--border-primary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]"
												onclick={() => model = fm}>{fm}</button>
										{/each}
									</div>
								{/if}
							</div>

							<!-- Actions -->
							<div class="flex gap-2">
								<button class="flex-1 rounded-lg border border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-primary)] hover:border-[var(--color-gold-600)]"
									onclick={testConnection} disabled={testStatus === 'testing' || !apiKey}>
									{#if testStatus === 'testing'}Testing...
									{:else if testStatus === 'success'}Connected
									{:else if testStatus === 'error'}Failed — Retry
									{:else}Test{/if}
								</button>
								<button class="flex-1 rounded-lg bg-[var(--color-gold-400)]/20 px-3 py-2 text-xs font-semibold text-[var(--text-accent)] hover:bg-[var(--color-gold-400)]/30"
									onclick={saveProfile} disabled={!apiKey}>
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
				</div>

				<!-- ═══ TAB: AI SERVICES ═══ -->
				{:else if activeTab === 'services'}
				<ServiceConfigPanel onBack={() => activeTab = 'providers'} />

				<!-- ═══ TAB: MEMORY ═══ -->
				{:else if activeTab === 'memory'}
				<div class="space-y-5">
					<!-- Message History -->
					<div class="space-y-3">
						<h4 class="font-display text-xs uppercase tracking-wider text-[var(--text-accent)]">Conversation History</h4>
						<div class="space-y-2">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Max Messages ({settings.uiSettings.maxMessages})</label>
							<input type="range" value={settings.uiSettings.maxMessages} min="10" max="100" step="5"
								oninput={(e) => { settings.uiSettings.maxMessages = Number((e.target as HTMLInputElement).value); settings.saveUISettings(); }}
								class="w-full accent-[var(--color-gold-400)]" />
							<p class="text-[10px] text-[var(--text-muted)]">Maximum conversation turns sent to the narrator. Lower = cheaper, higher = better short-term memory.</p>
						</div>
						<div class="space-y-2">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Max History Entries ({settings.uiSettings.maxHistoryEntries})</label>
							<input type="range" value={settings.uiSettings.maxHistoryEntries} min="50" max="500" step="25"
								oninput={(e) => { settings.uiSettings.maxHistoryEntries = Number((e.target as HTMLInputElement).value); settings.saveUISettings(); }}
								class="w-full accent-[var(--color-gold-400)]" />
							<p class="text-[10px] text-[var(--text-muted)]">Hard cap on raw entries scanned for history. Token budget is the real gate.</p>
						</div>
					</div>

					<!-- Chapter Settings -->
					<div class="space-y-3 border-t border-[var(--border-primary)] pt-4">
						<h4 class="font-display text-xs uppercase tracking-wider text-[var(--text-accent)]">Chapter Creation</h4>
						<div class="space-y-2">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Chapter Threshold ({settings.uiSettings.chapterThreshold} entries)</label>
							<input type="range" value={settings.uiSettings.chapterThreshold} min="10" max="50" step="5"
								oninput={(e) => { settings.uiSettings.chapterThreshold = Number((e.target as HTMLInputElement).value); settings.saveUISettings(); }}
								class="w-full accent-[var(--color-gold-400)]" />
							<p class="text-[10px] text-[var(--text-muted)]">Entries needed before chapter analysis triggers. Lower = more frequent chapters.</p>
						</div>
						<div class="space-y-2">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Post-Chapter Buffer ({settings.uiSettings.postChapterBuffer})</label>
							<input type="range" value={settings.uiSettings.postChapterBuffer} min="5" max="30" step="1"
								oninput={(e) => { settings.uiSettings.postChapterBuffer = Number((e.target as HTMLInputElement).value); settings.saveUISettings(); }}
								class="w-full accent-[var(--color-gold-400)]" />
							<p class="text-[10px] text-[var(--text-muted)]">Raw entries kept in history after chapter creation. Rest is summarized.</p>
						</div>
						<div class="space-y-2">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Previous Chapters in Summary ({settings.uiSettings.maxPrevChaptersInSummary})</label>
							<input type="range" value={settings.uiSettings.maxPrevChaptersInSummary} min="2" max="10" step="1"
								oninput={(e) => { settings.uiSettings.maxPrevChaptersInSummary = Number((e.target as HTMLInputElement).value); settings.saveUISettings(); }}
								class="w-full accent-[var(--color-gold-400)]" />
							<p class="text-[10px] text-[var(--text-muted)]">How many prior chapter summaries the AI sees when creating a new chapter. More = better continuity, more tokens.</p>
						</div>
					</div>

					<!-- Arc Settings -->
					<div class="space-y-3 border-t border-[var(--border-primary)] pt-4">
						<h4 class="font-display text-xs uppercase tracking-wider text-[var(--text-accent)]">Arc Condensation</h4>
						<div class="space-y-2">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Chapters per Arc ({settings.uiSettings.chaptersPerArc})</label>
							<input type="range" value={settings.uiSettings.chaptersPerArc} min="3" max="10" step="1"
								oninput={(e) => { settings.uiSettings.chaptersPerArc = Number((e.target as HTMLInputElement).value); settings.saveUISettings(); }}
								class="w-full accent-[var(--color-gold-400)]" />
							<p class="text-[10px] text-[var(--text-muted)]">How many chapters get condensed into one arc summary. Lower = more arcs, higher = broader story arcs.</p>
						</div>
					</div>

					<!-- Snapshot Budget -->
					<div class="space-y-3 border-t border-[var(--border-primary)] pt-4">
						<h4 class="font-display text-xs uppercase tracking-wider text-[var(--text-accent)]">Context Snapshot</h4>
						<div class="space-y-2">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Snapshot Token Cap ({settings.uiSettings.snapshotTokenCap === 0 ? 'Unlimited' : settings.uiSettings.snapshotTokenCap.toLocaleString()})</label>
							<input type="range" value={settings.uiSettings.snapshotTokenCap} min="0" max="50000" step="2000"
								oninput={(e) => { settings.uiSettings.snapshotTokenCap = Number((e.target as HTMLInputElement).value); settings.saveUISettings(); }}
								class="w-full accent-[var(--color-gold-400)]" />
							<p class="text-[10px] text-[var(--text-muted)]">Max tokens for the state snapshot (arcs + chapters + world state). 0 = unlimited — the model's context window is the only limit.</p>
						</div>
					</div>
				</div>

				<!-- ═══ TAB: IMAGE GENERATION ═══ -->
				{:else if activeTab === 'images'}
				<div class="space-y-5">
					<!-- Image Generation Mode -->
					<div class="space-y-2">
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

					<!-- Generation Mode -->
					<div class="space-y-2 border-t border-[var(--border-primary)] pt-4">
						<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Generation Mode</label>
						<p class="text-xs text-[var(--text-muted)] leading-relaxed">
							Orchestrator uses tool calls for state tracking (faster, fewer tokens). Pipeline uses the classic multi-service approach.
						</p>
						<div class="grid grid-cols-2 gap-2">
							<button class="rounded-lg border border-[var(--border-primary)] px-4 py-3 text-left transition-colors
								{settings.uiSettings.generationMode === 'orchestrator'
									? 'border-[var(--color-gold-600)] text-[var(--text-accent)] bg-[rgba(212,168,83,0.08)]'
									: 'text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]'}"
								onclick={() => { settings.uiSettings.generationMode = 'orchestrator'; settings.saveUISettings(); }}>
								<div class="font-display text-sm tracking-wide">Orchestrator</div>
								<div class="mt-0.5 text-[10px] opacity-70">Faster, fewer tokens</div>
							</button>
							<button class="rounded-lg border border-[var(--border-primary)] px-4 py-3 text-left transition-colors
								{settings.uiSettings.generationMode === 'pipeline'
									? 'border-[var(--color-gold-600)] text-[var(--text-accent)] bg-[rgba(212,168,83,0.08)]'
									: 'text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]'}"
								onclick={() => { settings.uiSettings.generationMode = 'pipeline'; settings.saveUISettings(); }}>
								<div class="font-display text-sm tracking-wide">Pipeline</div>
								<div class="mt-0.5 text-[10px] opacity-70">Classic, more AI calls</div>
							</button>
						</div>
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
