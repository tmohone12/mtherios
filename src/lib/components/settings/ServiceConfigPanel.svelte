<script lang="ts">
	import { ChevronDown, ChevronUp, RotateCcw, Save, Cpu, Plus, GripVertical } from 'lucide-svelte';
	import { settings, SERVICE_DEFINITIONS, type ServiceConfig } from '$lib/stores/settings.svelte';

	interface Props {
		onBack: () => void;
	}

	let { onBack }: Props = $props();

	let expandedService = $state<string | null>(null);
	let editingConfigs = $state<Record<string, ServiceConfig>>({});
	let saving = $state(false);
	let viewMode = $state<'profiles' | 'list'>('profiles');

	// ── Profile-based view: group services by model ──
	const profiles = $derived.by(() => {
		const groups: Record<string, { model: string; services: Array<{ id: string; label: string; description: string }> }> = {};
		
		for (const [id, def] of Object.entries(SERVICE_DEFINITIONS)) {
			const config = getConfig(id);
			const modelKey = config.model || '(default provider)';
			
			if (!groups[modelKey]) {
				groups[modelKey] = { model: modelKey, services: [] };
			}
			groups[modelKey].services.push({ id, label: def.label, description: def.description });
		}
		
		return Object.values(groups);
	});

	// Group services by category for list view
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
	<!-- View toggle -->
	<div class="flex items-center justify-between">
		<p class="text-xs text-[var(--text-muted)]">
			Assign a model, temperature, and prompt per service.
		</p>
		<div class="flex rounded-lg bg-[var(--bg-primary)] p-0.5">
			<button class="rounded-md px-2.5 py-1 text-[10px] font-medium transition-all
				{viewMode === 'profiles' ? 'bg-[rgba(212,168,83,0.12)] text-[var(--text-accent)]' : 'text-[var(--text-muted)]'}"
				onclick={() => viewMode = 'profiles'}>Profiles</button>
			<button class="rounded-md px-2.5 py-1 text-[10px] font-medium transition-all
				{viewMode === 'list' ? 'bg-[rgba(212,168,83,0.12)] text-[var(--text-accent)]' : 'text-[var(--text-muted)]'}"
				onclick={() => viewMode = 'list'}>List</button>
		</div>
	</div>

	{#if viewMode === 'profiles'}
	<!-- ═══ Profile Cards View ═══ -->
	<div class="space-y-3">
		{#each profiles as profile}
			<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] overflow-hidden">
				<!-- Profile header (model) -->
				<div class="flex items-center gap-3 border-b border-[var(--border-primary)] bg-[var(--bg-primary)]/50 px-4 py-3">
					<div class="flex h-8 w-8 items-center justify-center rounded-lg bg-[rgba(212,168,83,0.1)]">
						<Cpu class="h-4 w-4 text-[var(--text-accent)]" />
					</div>
					<div class="flex-1 min-w-0">
						<div class="font-mono text-xs text-[var(--text-primary)] truncate">{profile.model}</div>
						<div class="text-[10px] text-[var(--text-muted)]">{profile.services.length} services</div>
					</div>
				</div>

				<!-- Services in this profile -->
				<div class="divide-y divide-[var(--border-primary)]">
					{#each profile.services as svc}
						{@const config = getConfig(svc.id)}
						{@const isExpanded = expandedService === svc.id}

						<div>
							<button class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[rgba(212,168,83,0.02)]"
								onclick={() => expandedService = isExpanded ? null : svc.id}>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2">
										<span class="text-sm text-[var(--text-primary)]">{svc.label}</span>
										{#if !config.enabled}
											<span class="rounded bg-red-500/10 px-1 py-0.5 text-[9px] text-red-400">OFF</span>
										{/if}
									</div>
									<p class="text-[10px] text-[var(--text-muted)]">{svc.description}</p>
								</div>
								{#if isExpanded}<ChevronUp class="h-3.5 w-3.5 text-[var(--text-muted)]" />{:else}<ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />{/if}
							</button>

							{#if isExpanded}
								<div class="space-y-3 border-t border-[var(--border-primary)]/50 bg-[var(--bg-primary)]/30 px-4 py-3">
									<!-- Enabled -->
									<label class="flex items-center justify-between">
										<span class="text-xs text-[var(--text-primary)]">Enabled</span>
										<input type="checkbox" checked={config.enabled}
											onchange={(e) => updateConfig(svc.id, { enabled: (e.target as HTMLInputElement).checked })}
											class="h-4 w-4 accent-[var(--color-gold-400)]" />
									</label>

									<!-- Model override -->
									<div class="space-y-1">
										<label class="text-[10px] text-[var(--text-muted)]">Model <span class="opacity-50">(blank = default)</span></label>
										<input type="text" value={config.model} placeholder="Use default"
											oninput={(e) => updateConfig(svc.id, { model: (e.target as HTMLInputElement).value })}
											class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
									</div>

									<!-- Temperature -->
									<div class="space-y-1">
										<div class="flex items-center justify-between">
											<label class="text-[10px] text-[var(--text-muted)]">Temperature</label>
											<span class="font-mono text-[10px] text-[var(--text-primary)]">{config.temperature.toFixed(1)}</span>
										</div>
										<input type="range" min="0" max="2" step="0.1" value={config.temperature}
											oninput={(e) => updateConfig(svc.id, { temperature: parseFloat((e.target as HTMLInputElement).value) })}
											class="w-full accent-[var(--color-gold-400)]" />
									</div>

									<!-- Max Tokens -->
									<div class="space-y-1">
										<label class="text-[10px] text-[var(--text-muted)]">Max Tokens</label>
										<input type="number" value={config.maxTokens} min="256" max="65536" step="256"
											oninput={(e) => updateConfig(svc.id, { maxTokens: parseInt((e.target as HTMLInputElement).value) || 4096 })}
											class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
									</div>

									<!-- System Prompt -->
									<div class="space-y-1">
										<label class="text-[10px] text-[var(--text-muted)]">System Prompt Override</label>
										<textarea value={config.systemPromptOverride}
											oninput={(e) => updateConfig(svc.id, { systemPromptOverride: (e.target as HTMLTextAreaElement).value })}
											placeholder="Leave empty for built-in prompt..."
											rows="3"
											class="w-full resize-none rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
									</div>

									<!-- Reset -->
									<button class="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-accent)]"
										onclick={() => resetConfig(svc.id)}>
										<RotateCcw class="h-3 w-3" /> Reset
									</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/each}
	</div>

	{:else}
	<!-- ═══ List View (by category) ═══ -->
	{#each Object.entries(categories) as [category, services]}
		<div class="space-y-2">
			<div class="flex items-center gap-2 pt-1">
				<span class="text-sm">{categoryIcons[category] ?? '⚙️'}</span>
				<span class="font-display text-[10px] tracking-wider uppercase text-[var(--text-accent)]">{category}</span>
			</div>

			{#each services as { id, def }}
				{@const config = getConfig(id)}
				{@const isExpanded = expandedService === id}

				<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] overflow-hidden
					{isExpanded ? 'border-[var(--color-gold-600)]/30' : ''}">

					<button class="flex w-full items-center gap-3 px-4 py-2.5 text-left"
						onclick={() => expandedService = isExpanded ? null : id}>
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<span class="text-sm font-semibold text-[var(--text-primary)]">{def.label}</span>
								{#if !config.enabled}
									<span class="rounded bg-red-500/10 px-1 py-0.5 text-[9px] text-red-400">OFF</span>
								{/if}
								{#if config.model}
									<span class="truncate rounded bg-[var(--bg-primary)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--text-muted)]">{config.model}</span>
								{/if}
							</div>
							<p class="text-[10px] text-[var(--text-muted)]">{def.description}</p>
						</div>
						{#if isExpanded}<ChevronUp class="h-3.5 w-3.5 text-[var(--text-muted)]" />{:else}<ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />{/if}
					</button>

					{#if isExpanded}
						<div class="space-y-3 border-t border-[var(--border-primary)] px-4 py-3">
							<label class="flex items-center justify-between">
								<span class="text-xs text-[var(--text-primary)]">Enabled</span>
								<input type="checkbox" checked={config.enabled}
									onchange={(e) => updateConfig(id, { enabled: (e.target as HTMLInputElement).checked })}
									class="h-4 w-4 accent-[var(--color-gold-400)]" />
							</label>
							<div class="space-y-1">
								<label class="text-[10px] text-[var(--text-muted)]">Model</label>
								<input type="text" value={config.model} placeholder="Use default"
									oninput={(e) => updateConfig(id, { model: (e.target as HTMLInputElement).value })}
									class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
							</div>
							<div class="space-y-1">
								<div class="flex items-center justify-between">
									<label class="text-[10px] text-[var(--text-muted)]">Temperature</label>
									<span class="font-mono text-[10px] text-[var(--text-primary)]">{config.temperature.toFixed(1)}</span>
								</div>
								<input type="range" min="0" max="2" step="0.1" value={config.temperature}
									oninput={(e) => updateConfig(id, { temperature: parseFloat((e.target as HTMLInputElement).value) })}
									class="w-full accent-[var(--color-gold-400)]" />
							</div>
							<div class="space-y-1">
								<label class="text-[10px] text-[var(--text-muted)]">Max Tokens</label>
								<input type="number" value={config.maxTokens} min="256" max="65536" step="256"
									oninput={(e) => updateConfig(id, { maxTokens: parseInt((e.target as HTMLInputElement).value) || 4096 })}
									class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
							</div>
							<div class="space-y-1">
								<label class="text-[10px] text-[var(--text-muted)]">System Prompt Override</label>
								<textarea value={config.systemPromptOverride}
									oninput={(e) => updateConfig(id, { systemPromptOverride: (e.target as HTMLTextAreaElement).value })}
									placeholder="Leave empty for built-in prompt..."
									rows="3"
									class="w-full resize-none rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
							</div>
							<button class="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-accent)]"
								onclick={() => resetConfig(id)}>
								<RotateCcw class="h-3 w-3" /> Reset
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/each}
	{/if}

	<!-- Save bar -->
	{#if hasChanges}
		<div class="sticky bottom-0 flex gap-3 rounded-xl border border-[var(--color-gold-600)]/30 bg-[var(--bg-secondary)] p-3">
			<button class="flex-1 rounded-lg border border-[var(--border-primary)] py-2.5 text-xs text-[var(--text-muted)]"
				onclick={() => editingConfigs = {}}>
				Discard
			</button>
			<button class="flex flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] py-2.5 font-display text-xs font-semibold tracking-wide text-[var(--bg-primary)]"
				onclick={saveAll} disabled={saving}>
				<Save class="h-3.5 w-3.5" />
				{saving ? 'Saving...' : 'Save All'}
			</button>
		</div>
	{/if}
</div>
