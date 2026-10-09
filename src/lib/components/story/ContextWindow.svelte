<script lang="ts">
	import { story } from '$lib/stores/story.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { getModelContextWindow } from '$lib/services/ai/context/modelWindows';
	import { MAX_BACKEND_CONTEXT_BUDGET, normalizeBackendContextBudget, recordedDynamicContextBudget } from '$lib/services/backendTurnContext';
	import {
		CONTEXT_BUDGET_STEPS,
		contextBudgetSliderIndexToValue,
		contextBudgetValueToSliderIndex,
		formatTokenBudgetCompact,
	} from '$lib/services/memorySettings';
	import { patchTerminalLlmSettings } from '$lib/services/terminalSettings';
	import { gmTurnReceiptSchema } from '$lib/contracts/memory';
	import { Gauge } from 'lucide-svelte';
	import ContextSelection from './ContextSelection.svelte';

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
		await patchTerminalLlmSettings(['narrative', 'classifier'].map(serviceId => ({ serviceId, contextBudget: settings.contextBudget || null }))).catch((error) => {
			console.warn('[ContextWindow] Terminal context budget sync failed:', error);
		});
	}

	function formatBudget(val: number): string {
		return formatTokenBudgetCompact(val);
	}

	const estimateTokens = (text: string) => Math.ceil(text.length / 4);
	const backendReceipt = $derived(story.currentStory?.serverStoryId && story.lastContextReceipt?.storyId === story.currentStory.serverStoryId ? story.lastContextReceipt : null);
	const activeRecall = $derived.by(() => {
		for (const entry of [...story.entries].reverse()) {
			const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata as Record<string, unknown> : {};
			const parsed = gmTurnReceiptSchema.safeParse(metadata.gmTurnReceipt);
			if (parsed.success && parsed.data.activeRecall.status !== 'not_requested') return parsed.data.activeRecall;
		}
		return null;
	});
	const actorDecisions = $derived.by(() => {
		for (const entry of [...story.entries].reverse()) {
			const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata as Record<string, unknown> : {};
			const parsed = gmTurnReceiptSchema.safeParse(metadata.gmTurnReceipt);
			if (parsed.success) return parsed.data.actorDecisions;
		}
		return [];
	});

	const stats = $derived.by(() => {
		if (!story.currentStory) return null;
		if (story.currentStory.serverStoryId) {
			if (!backendReceipt) return null;
			const sectionTokens = (id: string) => backendReceipt.selection?.sections.find(section => section.id === id)?.tokens ?? 0;
			return { system: sectionTokens('system'), history: sectionTokens('history'), scene: sectionTokens('context'),
				recent: 0, world: 0, retrieved: 0, tierTotal: sectionTokens('context'), total: backendReceipt.included.totalTokens ?? 0 };
		}

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

	const recordedBudget = $derived(recordedDynamicContextBudget(backendReceipt));
	const usagePercent = $derived(backendReceipt ? recordedBudget?.percent ?? 0 : stats && selectedBudget > 0 ? Math.min((stats.total / selectedBudget) * 100, 100) : 0);

	interface Section {
		key: string;
		label: string;
		tokens: number;
		color: string;
	}

	const sections = $derived.by((): Section[] => {
		if (!stats) return [];
		if (backendReceipt) return (backendReceipt.selection?.sections ?? []).filter(section => section.tokens > 0)
			.map((section, index) => ({ key: section.id, label: section.label, tokens: section.tokens,
				color: ['bg-[var(--color-surface-400)]', 'bg-[var(--text-accent)]', 'bg-[var(--sage)]', 'bg-[#779a9c]'][index % 4] }));
		return [
			{ key: 'system', label: 'System Prompt', tokens: stats.system, color: 'bg-[var(--color-surface-400)]' },
			{ key: 'history', label: 'Chat History', tokens: stats.history, color: 'bg-[var(--sage)]' },
			{ key: 'scene', label: 'Scene', tokens: stats.scene, color: 'bg-[var(--text-accent)]' },
			{ key: 'recent', label: 'Recent Chapters', tokens: stats.recent, color: 'bg-[#779a9c]' },
			{ key: 'world', label: 'World/Arcs', tokens: stats.world, color: 'bg-[#9690aa]' },
			{ key: 'retrieved', label: 'Retrieved', tokens: stats.retrieved, color: 'bg-[#b18479]' },
		].filter(s => s.tokens > 0);
	});
</script>

<div class="context-window">
	<div class="mb-4 flex items-center justify-between gap-3">
		<div class="flex items-center gap-2">
			<Gauge class="h-4 w-4 text-[var(--text-accent)]" />
			<h3 class="font-display text-xl text-[var(--text-primary)]">Context window</h3>
		</div>
		<span class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2.5 py-1 text-xs font-medium tabular-nums text-[var(--text-accent)]">{formatBudget(selectedBudget)}</span>
	</div>

	<!-- Budget slider -->
	<div class="mb-4">
		<label for="story-context-budget" class="mb-1 block text-xs text-[var(--text-muted)]">{story.currentStory?.serverStoryId ? 'Scene and memory budget for the next turn' : 'Available context budget'}</label>
		<input
			id="story-context-budget"
			type="range"
			min="1"
			max={CONTEXT_BUDGET_STEPS.length - 1}
			step="1"
			value={contextBudgetValueToSliderIndex(selectedBudget)}
			oninput={(event) => onBudgetSliderInput(Number((event.target as HTMLInputElement).value))}
			onchange={onBudgetChange}
			class="h-6 w-full cursor-pointer accent-[var(--text-accent)]"
			aria-valuetext={`${selectedBudget.toLocaleString()} tokens`}
		/>
		<div class="flex justify-between text-[10px] text-[var(--text-muted)] mt-0.5">
			<span>{formatBudget(CONTEXT_BUDGET_STEPS[1])}</span><span>{formatBudget(MAX_BACKEND_CONTEXT_BUDGET)}</span>
		</div>
	</div>

	{#if stats}
		{#if backendReceipt?.budgets.recentDialogueTurnsMax !== undefined}
			<p class="mb-3 text-xs text-[var(--text-secondary)]">Recorded recent dialogue: ~{stats.history.toLocaleString()} tokens, up to {backendReceipt.budgets.recentDialogueTurnsMax} turns. Next turn: {settings.uiSettings.recentDialogueTurns} turns, adjustable in Settings → Memory.</p>
		{:else if backendReceipt?.budgets.recentDialogueTokensMax !== undefined}
			<p class="mb-3 text-xs text-[var(--text-secondary)]">Recorded recent dialogue: ~{stats.history.toLocaleString()} / {backendReceipt.budgets.recentDialogueTokensMax.toLocaleString()} tokens. Next turn: {settings.uiSettings.recentDialogueTurns} turns, adjustable in Settings → Memory.</p>
		{/if}
		<p class="mb-3 text-[11px] text-[var(--text-muted)]">{backendReceipt ? backendReceipt.selection ? 'Last recorded primary narration request · local token estimates' : 'Legacy receipt · final request selection was not recorded' : 'Local story context estimate'}</p>
		<!-- Usage bar -->
		{#if !backendReceipt || recordedBudget}
		<div class="rounded-full bg-[var(--bg-primary)] h-2 overflow-hidden mb-3" role="meter" aria-label="Context budget used" aria-valuenow={usagePercent} aria-valuemin="0" aria-valuemax="100">
			<div class="flex h-full">
				{#if backendReceipt}
					<div class="h-full bg-[var(--text-accent)]" style="width: {usagePercent}%"></div>
				{:else}
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
				{/if}
			</div>
		</div>

		<!-- Total -->
		<div class="flex items-center justify-between mb-4 gap-3">
			<span class="text-xs text-[var(--text-muted)]">
				{#if recordedBudget}Scene and memory: ~{recordedBudget.used.toLocaleString()} / {formatBudget(recordedBudget.max)} tokens{:else}~{stats.total.toLocaleString()} / {formatBudget(selectedBudget)} tokens{/if}
			</span>
			<span class="text-xs font-semibold tabular-nums {usagePercent > 80 ? 'text-[var(--color-crimson-400)]' : usagePercent > 50 ? 'text-[var(--text-accent)]' : 'text-[var(--sage)]'}">
				{usagePercent.toFixed(1)}%
			</span>
		</div>
		{/if}
		{#if backendReceipt}
			<p class="mb-4 text-xs text-[var(--text-secondary)]">Primary request total: ~{stats.total.toLocaleString()} tokens, including instructions, dialogue and action.{#if !recordedBudget} No scene budget was recorded for this request.{/if}</p>
		{/if}
		{#if activeRecall}
			<section class="mb-4 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-xs">
				<div class="flex items-center justify-between gap-3"><span class="font-medium text-[var(--text-primary)]">GM research</span><span class="capitalize text-[var(--text-accent)]">{activeRecall.status.replaceAll('_', ' ')}</span></div>
				{#if activeRecall.reason}<p class="mt-1 text-[var(--text-secondary)]">{activeRecall.reason}</p>{/if}
				{#if activeRecall.searchedSourceIds.length}<p class="mt-2 break-all text-[11px] text-[var(--text-muted)]">Evidence retained: {activeRecall.searchedSourceIds.join(', ')}</p>{/if}
				{#if activeRecall.omissions.length}<p class="mt-1 text-[11px] text-[var(--text-muted)]">Omitted: {activeRecall.omissions.join(' ')}</p>{/if}
				<p class="mt-2 text-[11px] text-[var(--text-muted)]">This runs only during submission; the next-turn preview contains preparation, not these observations.</p>
			</section>
		{/if}
		{#if actorDecisions.length}
			<section class="mb-4 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-xs">
				<div class="font-medium text-[var(--text-primary)]">Actor decision proposals</div>
				{#each actorDecisions as decision}
					<div class="mt-2 border-t border-[var(--border-secondary)] pt-2 first:border-0 first:pt-0">
						<div class="flex items-center justify-between gap-3"><span class="text-[var(--text-primary)]">{decision.actorName}</span><span class="capitalize text-[var(--text-accent)]">{decision.status.replaceAll('_', ' ')}</span></div>
						{#if decision.model}<p class="mt-1 text-[11px] text-[var(--text-muted)]">Model: {decision.model}</p>{/if}
                        {#if decision.psychology}
                            <div class="mt-2 space-y-1 text-[var(--text-secondary)]">
                                <p>Perception: {decision.psychology.judgment ?? 'uncertain'} · Emotional impact: {decision.psychology.emotionalIntensity === null ? 'uncertain' : decision.psychology.emotionalIntensity + '/5'}</p>
                                <p>Response style: {decision.psychology.actionTriage ?? 'uncertain'} · Confidence: {Math.round(decision.psychology.confidence * 100)}%</p>
                                <p>Suggested relationship change: {decision.psychology.relationshipDelta === null ? 'uncertain' : (decision.psychology.relationshipDelta > 0 ? '+' : '') + decision.psychology.relationshipDelta} (not applied)</p>
                            </div>
                        {/if}
                        {#if decision.rationale}<p class="mt-1 text-[11px] text-[var(--text-muted)]">{decision.rationale}</p>{/if}
						{#if decision.immediateAction}<p class="mt-1 text-[var(--text-secondary)]">{decision.immediateAction}</p>{/if}
						{#if decision.condition}<p class="mt-1 text-[var(--text-secondary)]">Condition: {decision.condition}</p>{/if}
						{#if decision.reason}<p class="mt-1 text-[11px] text-[var(--text-muted)]">{decision.reason}</p>{/if}
						{#if decision.knowledgeSourceIds.length}<p class="mt-1 break-all text-[11px] text-[var(--text-muted)]">Evidence: {decision.knowledgeSourceIds.join(', ')}</p>{/if}
					</div>
				{/each}
				<p class="mt-2 text-[11px] text-[var(--text-muted)]">These are submission-time proposals, not accepted canon or a replacement for player choice.</p>
			</section>
		{/if}

		<!-- Breakdown -->
		<div class="context-breakdown space-y-2.5 border-t border-[var(--border-secondary)] pt-3">
			{#each sections as section}
				<div class="flex items-center justify-between text-xs">
					<div class="flex items-center gap-1.5">
						<div class="h-2 w-2 rounded-full {section.color}"></div>
						<span class="text-[var(--text-muted)]">{section.label}</span>
					</div>
					<span class="text-[var(--text-primary)] tabular-nums">~{section.tokens.toLocaleString()}</span>
				</div>
			{/each}
		</div>

		{#if backendReceipt?.selection}
			<ContextSelection selection={backendReceipt.selection} />
		{/if}
		{#if !backendReceipt && story.lastContextTotal === 0}
			<p class="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">The breakdown updates after your first generation.</p>
		{/if}
	{:else}
		<p class="text-xs text-[var(--text-muted)]">{story.currentStory ? 'Send a turn to see the context recorded by the server.' : 'No story loaded.'}</p>
	{/if}
</div>

<style>
	.context-window { padding: 1.25rem; border: 1px solid var(--border-primary); border-radius: 1rem; background: var(--bg-secondary); }
	.context-breakdown { font-variant-numeric: tabular-nums; }
	@media (max-width: 639px) { .context-window { padding: 1rem; } }
</style>
