<script lang="ts">
	import { ChevronLeft, ChevronDown, ChevronUp, RotateCcw, Save } from 'lucide-svelte';
	import { settings, SERVICE_DEFINITIONS, type ServiceConfig } from '$lib/stores/settings.svelte';

	interface Props {
		onBack: () => void;
	}

	let { onBack }: Props = $props();

	let expandedService = $state<string | null>(null);
	let editingConfigs = $state<Record<string, ServiceConfig>>({});
	let saving = $state(false);

	// Group services by category
	const categories = $derived.by(() => {
		const cats: Record<string, Array<{ id: string; def: typeof SERVICE_DEFINITIONS[string] }>> = {};
		for (const [id, def] of Object.entries(SERVICE_DEFINITIONS)) {
			if (!cats[def.category]) cats[def.category] = [];
			cats[def.category].push({ id, def });
		}
		return cats;
	});

	function getConfig(serviceId: string): ServiceConfig {
		return editingConfigs[serviceId] ?? settings.getServiceConfig(serviceId);
	}

	function updateConfig(serviceId: string, updates: Partial<ServiceConfig>) {
		const current = getConfig(serviceId);
		editingConfigs = { ...editingConfigs, [serviceId]: { ...current, ...updates } };
	}

	function resetConfig(serviceId: string) {
		const def = SERVICE_DEFINITIONS[serviceId];
		editingConfigs = {
			...editingConfigs,
			[serviceId]: {
				model: '',
				temperature: def.defaultTemp,
				maxTokens: def.defaultMaxTokens,
				systemPromptOverride: '',
				enabled: true,
			},
		};
	}

	async function saveAll() {
		saving = true;
		for (const [id, config] of Object.entries(editingConfigs)) {
			await settings.setServiceConfig(id, config);
		}
		editingConfigs = {};
		saving = false;
	}

	const hasChanges = $derived(Object.keys(editingConfigs).length > 0);

	const categoryIcons: Record<string, string> = {
		Generation: '⚡', Memory: '🧠', Quality: '✨',
		Lorebook: '📜', Retrieval: '🔍', Image: '🎨',
	};
</script>

<div class="space-y-4">
	<p class="text-sm text-[var(--text-muted)]">
		Configure model, temperature, and system prompt for each AI service. Leave model blank to use the default provider.
	</p>

	{#each Object.entries(categories) as [category, services]}
		<div class="space-y-2">
			<div class="flex items-center gap-2 pt-2">
				<span class="text-sm">{categoryIcons[category] ?? '⚙️'}</span>
				<span class="font-display text-xs tracking-wider uppercase text-[var(--text-accent)]">{category}</span>
			</div>

			{#each services as { id, def }}
				{@const config = getConfig(id)}
				{@const isExpanded = expandedService === id}

				<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] overflow-hidden transition-all
					{isExpanded ? 'border-[var(--color-gold-600)]/30' : ''}">

					<!-- Service header -->
					<button class="flex w-full items-center gap-3 px-4 py-3 text-left"
						onclick={() => expandedService = isExpanded ? null : id}>
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<span class="font-display text-sm font-semibold text-[var(--text-primary)]">{def.label}</span>
								{#if !config.enabled}
									<span class="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">OFF</span>
								{/if}
								{#if config.model}
									<span class="truncate rounded bg-[var(--bg-primary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">{config.model}</span>
								{/if}
							</div>
							<p class="text-xs text-[var(--text-muted)]">{def.description}</p>
						</div>
						{#if isExpanded}<ChevronUp class="h-4 w-4 text-[var(--text-muted)]" />{:else}<ChevronDown class="h-4 w-4 text-[var(--text-muted)]" />{/if}
					</button>

					<!-- Expanded config -->
					{#if isExpanded}
						<div class="space-y-4 border-t border-[var(--border-primary)] px-4 py-4">
							<!-- Enabled toggle -->
							<label class="flex items-center justify-between">
								<span class="text-sm text-[var(--text-primary)]">Enabled</span>
								<input type="checkbox" checked={config.enabled}
									onchange={(e) => updateConfig(id, { enabled: (e.target as HTMLInputElement).checked })}
									class="h-4 w-4 accent-[var(--color-gold-400)]" />
							</label>

							<!-- Model -->
							<div class="space-y-1">
								<label class="text-xs text-[var(--text-muted)]">Model <span class="opacity-50">(blank = default)</span></label>
								<input type="text" value={config.model} placeholder="Use default provider model"
									oninput={(e) => updateConfig(id, { model: (e.target as HTMLInputElement).value })}
									class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
							</div>

							<!-- Temperature -->
							<div class="space-y-1">
								<div class="flex items-center justify-between">
									<label class="text-xs text-[var(--text-muted)]">Temperature</label>
									<span class="font-mono text-xs text-[var(--text-primary)]">{config.temperature.toFixed(1)}</span>
								</div>
								<input type="range" min="0" max="2" step="0.1" value={config.temperature}
									oninput={(e) => updateConfig(id, { temperature: parseFloat((e.target as HTMLInputElement).value) })}
									class="w-full accent-[var(--color-gold-400)]" />
							</div>

							<!-- Max Tokens -->
							<div class="space-y-1">
								<label class="text-xs text-[var(--text-muted)]">Max Tokens</label>
								<input type="number" value={config.maxTokens} min="256" max="65536" step="256"
									oninput={(e) => updateConfig(id, { maxTokens: parseInt((e.target as HTMLInputElement).value) || def.defaultMaxTokens })}
									class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
							</div>

							<!-- System Prompt Override -->
							<div class="space-y-1">
								<label class="text-xs text-[var(--text-muted)]">System Prompt Override <span class="opacity-50">(blank = use built-in)</span></label>
								<textarea value={config.systemPromptOverride}
									oninput={(e) => updateConfig(id, { systemPromptOverride: (e.target as HTMLTextAreaElement).value })}
									placeholder="Leave empty to use the default prompt for this service..."
									rows="4"
									class="w-full resize-none rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
							</div>

							<!-- Reset -->
							<button class="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)]"
								onclick={() => resetConfig(id)}>
								<RotateCcw class="h-3 w-3" /> Reset to defaults
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/each}

	<!-- Save bar -->
	{#if hasChanges}
		<div class="sticky bottom-0 flex gap-3 rounded-xl border border-[var(--color-gold-600)]/30 bg-[var(--bg-secondary)] p-3">
			<button class="flex-1 rounded-lg border border-[var(--border-primary)] py-2.5 text-sm text-[var(--text-muted)]"
				onclick={() => editingConfigs = {}}>
				Discard
			</button>
			<button class="flex flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] py-2.5 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)]"
				onclick={saveAll} disabled={saving}>
				<Save class="h-4 w-4" />
				{saving ? 'Saving...' : 'Save All'}
			</button>
		</div>
	{/if}
</div>
