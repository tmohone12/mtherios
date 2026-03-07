<script lang="ts">
	import { X, ChevronLeft, ChevronRight, Check, ExternalLink, Zap, Globe, Server, Eye, EyeOff, Cpu, Palette, SlidersHorizontal, Sparkles } from 'lucide-svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { PROVIDERS, getProviderList } from '$lib/services/ai/sdk/providers/config';
	import type { ProviderType, APIProfile } from '$lib/types';
	import { setSetting, getSetting } from '$lib/services/database';
	import { fade, fly } from 'svelte/transition';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	// Slide deck state
	type Step = 'main' | 'provider' | 'configure' | 'generation' | 'interface';
	let step = $state<Step>('main');
	let direction = $state<1 | -1>(1);

	// Provider config state
	let selectedProvider = $state<ProviderType | null>(null);
	let apiKey = $state('');
	let customUrl = $state('');
	let model = $state('');
	let showApiKey = $state(false);
	let testStatus = $state<'idle' | 'testing' | 'success' | 'error'>('idle');
	let testMessage = $state('');

	// Current saved profiles
	let savedProfiles = $state<Record<string, { apiKey: string; model: string; baseUrl?: string }>>({});

	// Load saved profiles on mount
	$effect(() => {
		if (open) {
			loadProfiles();
		}
	});

	async function loadProfiles() {
		const raw = await getSetting('apiProfiles');
		if (raw) {
			try {
				savedProfiles = JSON.parse(raw);
			} catch { savedProfiles = {}; }
		}
	}

	async function saveProfile() {
		const profile = {
			apiKey,
			model: model || PROVIDERS[selectedProvider!].fallbackModels[0],
			...(customUrl ? { baseUrl: customUrl } : {}),
		};
		savedProfiles[selectedProvider!] = profile;
		await setSetting('apiProfiles', JSON.stringify(savedProfiles));
		await setSetting('activeProvider', selectedProvider!);
		goTo('main');
	}

	async function testConnection() {
		testStatus = 'testing';
		try {
			const provider = PROVIDERS[selectedProvider!];
			const testModel = model || provider.fallbackModels[0];
			const baseUrl = customUrl || provider.baseUrl;

			// Simple test: list models or send a tiny request
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
			};
			if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

			const res = await fetch(`${baseUrl}/models`, { headers });
			if (res.ok) {
				testStatus = 'success';
				testMessage = 'Connected successfully!';
			} else {
				const err = await res.text();
				testStatus = 'error';
				testMessage = `HTTP ${res.status}: ${err.slice(0, 100)}`;
			}
		} catch (e) {
			testStatus = 'error';
			testMessage = e instanceof Error ? e.message : 'Connection failed';
		}
	}

	function goTo(target: Step) {
		direction = ['main', 'provider', 'configure', 'generation', 'interface'].indexOf(target) >
			['main', 'provider', 'configure', 'generation', 'interface'].indexOf(step) ? 1 : -1;
		step = target;
		testStatus = 'idle';
	}

	function selectProvider(id: ProviderType) {
		selectedProvider = id;
		const saved = savedProfiles[id];
		apiKey = saved?.apiKey ?? '';
		model = saved?.model ?? '';
		customUrl = saved?.baseUrl ?? '';
		goTo('configure');
	}

	const providerIcons: Record<string, typeof Zap> = {
		openrouter: Globe,
		nanogpt: Zap,
		anthropic: Sparkles,
		openai: Cpu,
	};

	const topProviders: ProviderType[] = ['openrouter', 'nanogpt', 'anthropic', 'openai'];
	const otherProviders = getProviderList().filter(p => !topProviders.includes(p.value));
</script>

{#if open}
<div class="fixed inset-0 z-50 flex items-center justify-center p-4" transition:fade={{ duration: 150 }}>
	<!-- Backdrop -->
	<button class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick={onClose}></button>

	<!-- Modal -->
	<div class="relative w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)]"
		style="max-height: 90dvh;"
	>
		<!-- Header -->
		<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-6 py-4">
			<div class="flex items-center gap-3">
				{#if step !== 'main'}
					<button class="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
						onclick={() => goTo('main')}>
						<ChevronLeft class="h-5 w-5" />
					</button>
				{/if}
				<h2 class="font-display text-lg tracking-wide text-[var(--text-accent)]">
					{#if step === 'main'}Settings
					{:else if step === 'provider'}Choose Provider
					{:else if step === 'configure'}{PROVIDERS[selectedProvider!]?.name ?? 'Configure'}
					{:else if step === 'generation'}Generation
					{:else if step === 'interface'}Interface
					{/if}
				</h2>
			</div>
			<button class="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors" onclick={onClose}>
				<X class="h-5 w-5" />
			</button>
		</div>

		<!-- Content -->
		<div class="overflow-y-auto p-6" style="max-height: calc(90dvh - 64px);">

			{#if step === 'main'}
			<!-- Main Menu -->
			<div class="space-y-2" in:fly={{ x: direction * -100, duration: 200 }}>
				<button class="flex w-full items-center gap-4 rounded-xl border border-[var(--border-primary)] p-4 text-left transition-all hover:border-[var(--color-gold-600)] hover:bg-[rgba(212,168,83,0.05)]"
					onclick={() => goTo('provider')}>
					<div class="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(212,168,83,0.12)]">
						<Globe class="h-5 w-5 text-[var(--text-accent)]" />
					</div>
					<div class="flex-1">
						<div class="font-display text-sm font-semibold tracking-wide text-[var(--text-primary)]">AI Providers</div>
						<div class="text-sm text-[var(--text-muted)]">Configure API keys & models</div>
					</div>
					<ChevronRight class="h-4 w-4 text-[var(--text-muted)]" />
				</button>

				<button class="flex w-full items-center gap-4 rounded-xl border border-[var(--border-primary)] p-4 text-left transition-all hover:border-[var(--color-gold-600)] hover:bg-[rgba(212,168,83,0.05)]"
					onclick={() => goTo('generation')}>
					<div class="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(139,46,59,0.15)]">
						<SlidersHorizontal class="h-5 w-5 text-[var(--color-crimson-400)]" />
					</div>
					<div class="flex-1">
						<div class="font-display text-sm font-semibold tracking-wide text-[var(--text-primary)]">Generation</div>
						<div class="text-sm text-[var(--text-muted)]">Temperature, tokens, reasoning</div>
					</div>
					<ChevronRight class="h-4 w-4 text-[var(--text-muted)]" />
				</button>

				<button class="flex w-full items-center gap-4 rounded-xl border border-[var(--border-primary)] p-4 text-left transition-all hover:border-[var(--color-gold-600)] hover:bg-[rgba(212,168,83,0.05)]"
					onclick={() => goTo('interface')}>
					<div class="flex h-10 w-10 items-center justify-center rounded-lg bg-[rgba(42,82,120,0.15)]">
						<Palette class="h-5 w-5 text-blue-400" />
					</div>
					<div class="flex-1">
						<div class="font-display text-sm font-semibold tracking-wide text-[var(--text-primary)]">Interface</div>
						<div class="text-sm text-[var(--text-muted)]">Font size, display options</div>
					</div>
					<ChevronRight class="h-4 w-4 text-[var(--text-muted)]" />
				</button>
			</div>

			{:else if step === 'provider'}
			<!-- Provider Selection -->
			<div class="space-y-4" in:fly={{ x: direction * 100, duration: 200 }}>
				<p class="text-sm text-[var(--text-muted)]">Select an AI provider to configure. You can set up multiple providers.</p>

				<!-- Top providers -->
				<div class="grid grid-cols-2 gap-3">
					{#each topProviders as pid}
						{@const prov = PROVIDERS[pid]}
						{@const Icon = providerIcons[pid] ?? Server}
						{@const isConfigured = !!savedProfiles[pid]?.apiKey}
						<button class="group relative flex flex-col items-center gap-3 rounded-xl border p-4 text-center transition-all hover:-translate-y-0.5 hover:shadow-lg
							{isConfigured
								? 'border-[var(--color-gold-600)]/30 bg-[rgba(212,168,83,0.08)]'
								: 'border-[var(--border-primary)] hover:border-[var(--color-gold-600)]'}"
							onclick={() => selectProvider(pid)}>
							{#if isConfigured}
								<div class="absolute top-2 right-2">
									<Check class="h-4 w-4 text-emerald-400" />
								</div>
							{/if}
							<div class="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-tertiary)]">
								<Icon class="h-6 w-6 text-[var(--text-accent)]" />
							</div>
							<div>
								<div class="font-display text-sm font-semibold text-[var(--text-primary)]">{prov.name}</div>
								<div class="mt-1 text-xs text-[var(--text-muted)]">{prov.description}</div>
							</div>
						</button>
					{/each}
				</div>

				<!-- Other providers -->
				<div class="space-y-2">
					<div class="font-mono text-xs uppercase tracking-widest text-[var(--text-muted)]">Other Providers</div>
					{#each otherProviders as prov}
						{@const isConfigured = !!savedProfiles[prov.value]?.apiKey}
						<button class="flex w-full items-center gap-3 rounded-lg border border-[var(--border-primary)] p-3 text-left transition-all hover:border-[var(--color-gold-600)]
							{isConfigured ? 'bg-[rgba(212,168,83,0.05)]' : ''}"
							onclick={() => selectProvider(prov.value)}>
							<Server class="h-4 w-4 text-[var(--text-muted)]" />
							<div class="flex-1">
								<span class="text-sm text-[var(--text-primary)]">{prov.label}</span>
								{#if isConfigured}<Check class="ml-2 inline h-3 w-3 text-emerald-400" />{/if}
							</div>
							<span class="text-xs text-[var(--text-muted)]">{prov.description}</span>
						</button>
					{/each}
				</div>
			</div>

			{:else if step === 'configure'}
			<!-- Provider Configuration -->
			{#if selectedProvider}
			{@const prov = PROVIDERS[selectedProvider]}
			<div class="space-y-5" in:fly={{ x: direction * 100, duration: 200 }}>

				<!-- API Key -->
				{#if prov.requiresApiKey}
				<div class="space-y-2">
					<label class="flex items-center justify-between">
						<span class="font-display text-sm tracking-wide text-[var(--text-primary)]">API Key</span>
						{#if prov.name === 'OpenRouter'}
							<a href="https://openrouter.ai/keys" target="_blank" rel="noopener"
								class="flex items-center gap-1 text-xs text-[var(--text-accent)] hover:underline">
								Get key <ExternalLink class="h-3 w-3" />
							</a>
						{:else if prov.name === 'NanoGPT'}
							<a href="https://nano-gpt.com/api" target="_blank" rel="noopener"
								class="flex items-center gap-1 text-xs text-[var(--text-accent)] hover:underline">
								Get key <ExternalLink class="h-3 w-3" />
							</a>
						{/if}
					</label>
					<div class="relative">
						<input
							type={showApiKey ? 'text' : 'password'}
							bind:value={apiKey}
							placeholder="sk-..."
							class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 pr-10 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none focus:ring-1 focus:ring-[var(--color-gold-600)]"
						/>
						<button class="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
							onclick={() => showApiKey = !showApiKey}>
							{#if showApiKey}<EyeOff class="h-4 w-4" />{:else}<Eye class="h-4 w-4" />{/if}
						</button>
					</div>
				</div>
				{/if}

				<!-- Custom URL (for OpenAI-compatible) -->
				{#if selectedProvider === 'openai-compatible' || selectedProvider === 'ollama' || selectedProvider === 'lmstudio'}
				<div class="space-y-2">
					<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Base URL</label>
					<input
						type="text"
						bind:value={customUrl}
						placeholder={prov.baseUrl || 'https://your-api.com/v1'}
						class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none focus:ring-1 focus:ring-[var(--color-gold-600)]"
					/>
				</div>
				{/if}

				<!-- Model -->
				<div class="space-y-2">
					<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Model</label>
					<input
						type="text"
						bind:value={model}
						placeholder={prov.fallbackModels[0] ?? 'model-name'}
						class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none focus:ring-1 focus:ring-[var(--color-gold-600)]"
					/>
					{#if prov.fallbackModels.length > 1}
						<div class="flex flex-wrap gap-1.5 pt-1">
							{#each prov.fallbackModels.slice(0, 5) as fm}
								<button class="rounded-md border border-[var(--border-primary)] px-2 py-1 font-mono text-xs text-[var(--text-muted)] transition-colors hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]"
									onclick={() => model = fm}>
									{fm}
								</button>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Test & Save -->
				<div class="flex gap-3 pt-2">
					<button class="flex-1 rounded-lg border border-[var(--border-primary)] px-4 py-3 font-display text-sm tracking-wide text-[var(--text-primary)] transition-colors hover:border-[var(--color-gold-600)]"
						onclick={testConnection}
						disabled={testStatus === 'testing'}>
						{#if testStatus === 'testing'}Testing...
						{:else if testStatus === 'success'}✓ Connected
						{:else if testStatus === 'error'}✗ Failed
						{:else}Test Connection
						{/if}
					</button>
					<button class="flex-1 rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] px-4 py-3 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] transition-all hover:shadow-lg hover:shadow-[rgba(212,168,83,0.3)]"
						onclick={saveProfile}>
						Save
					</button>
				</div>

				{#if testMessage}
					<div class="rounded-lg p-3 text-sm {testStatus === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}">
						{testMessage}
					</div>
				{/if}
			</div>
			{/if}

			{:else if step === 'generation'}
			<!-- Generation Settings -->
			<div class="space-y-5" in:fly={{ x: direction * 100, duration: 200 }}>
				<div class="space-y-2">
					<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Temperature</label>
					<input type="range" min="0" max="2" step="0.1" value="1.0"
						class="w-full accent-[var(--color-gold-400)]" />
					<div class="flex justify-between text-xs text-[var(--text-muted)]">
						<span>Precise (0)</span><span>Creative (2)</span>
					</div>
				</div>

				<div class="space-y-2">
					<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Max Tokens</label>
					<input type="number" value="8192" min="256" max="65536" step="256"
						class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 font-mono text-sm text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
				</div>

				<div class="space-y-2">
					<label class="font-display text-sm tracking-wide text-[var(--text-primary)]">Reasoning Effort</label>
					<div class="grid grid-cols-4 gap-2">
						{#each ['off', 'low', 'medium', 'high'] as effort}
							<button class="rounded-lg border border-[var(--border-primary)] px-3 py-2 font-display text-xs capitalize tracking-wide text-[var(--text-muted)] transition-colors hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)]
								{effort === 'high' ? 'border-[var(--color-gold-600)] text-[var(--text-accent)] bg-[rgba(212,168,83,0.08)]' : ''}">
								{effort}
							</button>
						{/each}
					</div>
				</div>

				<div class="space-y-3 border-t border-[var(--border-primary)] pt-4">
					<label class="flex items-center justify-between">
						<span class="text-sm text-[var(--text-primary)]">Show reasoning output</span>
						<input type="checkbox" class="h-4 w-4 accent-[var(--color-gold-400)]" checked />
					</label>
					<label class="flex items-center justify-between">
						<span class="text-sm text-[var(--text-primary)]">Image generation</span>
						<input type="checkbox" class="h-4 w-4 accent-[var(--color-gold-400)]" />
					</label>
				</div>
			</div>

			{:else if step === 'interface'}
			<!-- Interface Settings -->
			<div class="space-y-5" in:fly={{ x: direction * 100, duration: 200 }}>
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
							checked={settings.uiSettings.autoScroll} />
					</label>
					<label class="flex items-center justify-between">
						<span class="text-sm text-[var(--text-primary)]">Show word count</span>
						<input type="checkbox" class="h-4 w-4 accent-[var(--color-gold-400)]"
							checked={settings.uiSettings.showWordCount} />
					</label>
					<label class="flex items-center justify-between">
						<span class="text-sm text-[var(--text-primary)]">Disable suggestions</span>
						<input type="checkbox" class="h-4 w-4 accent-[var(--color-gold-400)]"
							checked={settings.uiSettings.disableSuggestions} />
					</label>
				</div>
			</div>
			{/if}

		</div>
	</div>
</div>
{/if}
