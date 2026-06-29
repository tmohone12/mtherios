<script lang="ts">
	import { story } from '$lib/stores/story.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { getModelContextWindow } from '$lib/services/ai/context/modelWindows';
	import { MAX_BACKEND_CONTEXT_BUDGET, normalizeBackendContextBudget } from '$lib/services/backendTurnContext';
	import {
		CONTEXT_BUDGET_STEPS,
		contextBudgetSliderIndexToValue,
		contextBudgetValueToSliderIndex,
		formatTokenBudgetCompact,
	} from '$lib/services/memorySettings';
	import { syncTerminalLlmSettingsFromBrowser } from '$lib/services/terminalSettings';
	import { Gauge } from 'lucide-svelte';

	/** Effective budget: user-set value or auto (90% of model context) */
	const effectiveBudget = $derived(
		normalizeBackendContextBudget(settings.contextBudget > 0
			? settings.contextBudget
			: Math.floor(getModelContextWindow(settings.narrativeSettings?.model || '') * 0.90)) || MAX_BACKEND_CONTEXT_BUDGET
	);

	let selectedBudget = $state(0);

	// Sync from settings on mount / when effectiveBudget changes
	$effect(() => { selectedBudget = effectiveBudget; });

	function onBudgetSliderInput(index: number) {
		selectedBudget = contextBudgetSliderIndexToValue(index);
	}

	async function onBudgetChange() {
		settings.contextBudget = normalizeBackendContextBudget(selectedBudget);
		selectedBudget = settings.contextBudget || MAX_BACKEND_CONTEXT_BUDGET;
		await settings.saveContextBudget();
		await syncTerminalLlmSettingsFromBrowser(['narrative', 'classifier']).catch((error) => {
			console.warn('[ContextWindow] Terminal context budget sync failed:', error);
		});
	}

	function formatBudget(val: number): string {
		return formatTokenBudgetCompact(val);
	}

	const estimateTokens = (text: string) => Math.ceil(text.length / 4);

	const stats = $derived.by(() => {
		if (!story.currentStory) return null;

		// System prompt (without context block — that's counted separately in tiers)
		const systemTokens = estimateTokens(story.buildSystemPrompt());

		// Conversation history (token-budgeted, up to 50k)
		let historyTokens = 0;
		for (const msg of story.buildConversationMessages()) {
			historyTokens += estimateTokens(msg.content);
		}

		// Context assembly tiers (from last generation, or 0 if not yet generated)
		const tiers = story.lastTierUsage;
		const sceneTokens = tiers?.scene ?? 0;
		const recentTokens = tiers?.recent ?? 0;
		const worldTokens = tiers?.world ?? 0;
		const retrievedTokens = tiers?.retrieved ?? 0;
		const tierTotal = sceneTokens + recentTokens + worldTokens + retrievedTokens;

		// If we have real total from last gen, use it; otherwise estimate
		const total = story.lastContextTotal > 0
			? story.lastContextTotal
			: systemTokens + historyTokens + tierTotal;

		return {
			system: systemTokens,
			history: historyTokens,
			scene: sceneTokens,
			recent: recentTokens,
			world: worldTokens,
			retrieved: retrievedTokens,
			tierTotal,
			total,
		};
	});

	const usagePercent = $derived(stats ? Math.min((stats.total / selectedBudget) * 100, 100) : 0);

	interface Section {
		key: string;
		label: string;
		tokens: number;
		color: string;
	}

	const sections = $derived.by((): Section[] => {
		if (!stats) return [];
		return [
			{ key: 'system', label: 'System Prompt', tokens: stats.system, color: 'bg-slate-500' },
			{ key: 'history', label: 'Chat History', tokens: stats.history, color: 'bg-emerald-500' },
			{ key: 'scene', label: 'Scene', tokens: stats.scene, color: 'bg-amber-500' },
			{ key: 'recent', label: 'Recent Chapters', tokens: stats.recent, color: 'bg-blue-500' },
			{ key: 'world', label: 'World/Arcs', tokens: stats.world, color: 'bg-purple-500' },
			{ key: 'retrieved', label: 'Retrieved', tokens: stats.retrieved, color: 'bg-rose-500' },
		].filter(s => s.tokens > 0);
	});
</script>

<div>
	<div class="mb-2 flex items-center justify-between">
		<div class="flex items-center gap-2">
			<Gauge class="h-4 w-4 text-cyan-400" />
			<span class="font-display text-xs tracking-wider uppercase text-cyan-400">Context Window</span>
		</div>
		<span class="text-[10px] font-mono text-[var(--text-muted)]">{formatBudget(selectedBudget)}</span>
	</div>

	<!-- Budget slider -->
	<div class="mb-3">
		<input
			type="range"
			min="1"
			max={CONTEXT_BUDGET_STEPS.length - 1}
			step="1"
			value={contextBudgetValueToSliderIndex(selectedBudget)}
			oninput={(event) => onBudgetSliderInput(Number((event.target as HTMLInputElement).value))}
			onchange={onBudgetChange}
			class="w-full accent-[var(--color-gold-400)] h-1.5"
		/>
		<div class="flex justify-between text-[9px] text-[var(--text-muted)] mt-0.5">
			<span>{formatBudget(CONTEXT_BUDGET_STEPS[1])}</span><span>{formatBudget(MAX_BACKEND_CONTEXT_BUDGET)}</span>
		</div>
	</div>

	{#if stats}
		<!-- Usage bar -->
		<div class="rounded-full bg-[var(--bg-primary)] h-3 overflow-hidden mb-2">
			<div class="flex h-full">
				{#each sections as section}
					{@const pct = (section.tokens / selectedBudget) * 100}
					{#if pct > 0.3}
						<div
							class="{section.color} h-full transition-all duration-300"
							style="width: {pct}%"
							title="{section.label}: ~{section.tokens.toLocaleString()} tokens"
						></div>
					{/if}
				{/each}
			</div>
		</div>

		<!-- Total -->
		<div class="flex items-center justify-between mb-2">
			<span class="text-[10px] text-[var(--text-muted)]">
				~{stats.total.toLocaleString()} / {formatBudget(selectedBudget)} tokens
			</span>
			<span class="text-[10px] font-semibold {usagePercent > 80 ? 'text-rose-400' : usagePercent > 50 ? 'text-amber-400' : 'text-emerald-400'}">
				{usagePercent.toFixed(1)}%
			</span>
		</div>

		<!-- Breakdown -->
		<div class="space-y-1">
			{#each sections as section}
				<div class="flex items-center justify-between text-[10px]">
					<div class="flex items-center gap-1.5">
						<div class="h-2 w-2 rounded-full {section.color}"></div>
						<span class="text-[var(--text-muted)]">{section.label}</span>
					</div>
					<span class="text-[var(--text-primary)] tabular-nums">~{section.tokens.toLocaleString()}</span>
				</div>
			{/each}
		</div>

		{#if story.lastContextTotal === 0}
			<p class="mt-2 text-[9px] text-[var(--text-muted)] italic">Tier breakdown updates after first generation</p>
		{/if}
	{:else}
		<p class="text-xs text-[var(--text-muted)]">No story loaded.</p>
	{/if}
</div>
