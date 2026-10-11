<script lang="ts">
	import { story } from '$lib/stores/story.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { normalizeBackendContextBudget, recordedDynamicContextBudget } from '$lib/services/backendTurnContext';
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

	/** Next-turn setting; 0 is Auto, which the server derives from the GameMaster model's capacity. */
	let selectedBudget = $state(0);

	$effect(() => { selectedBudget = normalizeBackendContextBudget(settings.contextBudget); });

	function onBudgetSliderInput(index: number) {
		selectedBudget = contextBudgetSliderIndexToValue(index);
	}

	async function onBudgetChange() {
		settings.contextBudget = normalizeBackendContextBudget(selectedBudget);
		selectedBudget = settings.contextBudget;
		await settings.saveContextBudget();
		await patchTerminalLlmSettings(['narrative', 'classifier'].map(serviceId => ({ serviceId, contextBudget: settings.contextBudget || null }))).catch((error) => {
			console.warn('[ContextWindow] Server context budget sync failed:', error);
		});
	}

	function formatBudget(val: number): string {
		return formatTokenBudgetCompact(val);
	}

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

	/** Token counts from the last recorded server request. Browser-only saves have no receipt. */
	const stats = $derived.by(() => {
		if (!backendReceipt) return null;
		const sectionTokens = (id: string) => backendReceipt.selection?.sections.find(section => section.id === id)?.tokens ?? 0;
		return { history: sectionTokens('history'), total: backendReceipt.included.totalTokens ?? 0 };
	});

	const recordedBudget = $derived(recordedDynamicContextBudget(backendReceipt));
	const usagePercent = $derived(recordedBudget?.percent ?? 0);

	const sections = $derived((backendReceipt?.selection?.sections ?? []).filter(section => section.tokens > 0)
		.map((section, index) => ({ key: section.id, label: section.label, tokens: section.tokens,
			color: ['bg-[var(--color-surface-400)]', 'bg-[var(--text-accent)]', 'bg-[var(--sage)]', 'bg-[#779a9c]'][index % 4] })));
</script>

<div class="context-window">
	<div class="mb-4 flex items-center justify-between gap-3">
		<div class="flex items-center gap-2">
			<Gauge class="h-4 w-4 text-[var(--text-accent)]" />
			<h3 class="font-display text-xl text-[var(--text-primary)]">Context window</h3>
		</div>
		<span class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2.5 py-1 text-xs font-medium tabular-nums text-[var(--text-accent)]" title="Setting for the next turn">Next turn: {formatBudget(selectedBudget)}</span>
	</div>

	<!-- Budget slider -->
	<div class="mb-4">
		<label for="story-context-budget" class="mb-1 block text-xs text-[var(--text-muted)]">Scene and memory budget for the next turn{selectedBudget ? '' : ' · Auto fits the GameMaster model'}</label>
		<input
			id="story-context-budget"
			type="range"
			min="0"
			max={CONTEXT_BUDGET_STEPS.length - 1}
			step="1"
			value={contextBudgetValueToSliderIndex(selectedBudget)}
			oninput={(event) => onBudgetSliderInput(Number((event.target as HTMLInputElement).value))}
			onchange={onBudgetChange}
			class="h-6 w-full cursor-pointer accent-[var(--text-accent)]"
			aria-valuetext={`${selectedBudget.toLocaleString()} tokens`}
		/>
		<div class="flex justify-between text-[10px] text-[var(--text-muted)] mt-0.5">
			<span>Auto</span><span>{formatBudget(CONTEXT_BUDGET_STEPS[CONTEXT_BUDGET_STEPS.length - 1])}</span>
		</div>
	</div>

	{#if stats}
		{#if backendReceipt?.budgets.recentDialogueTurnsMax !== undefined}
			<p class="mb-3 text-xs text-[var(--text-secondary)]">Recorded recent dialogue: ~{stats.history.toLocaleString()} tokens, up to {backendReceipt.budgets.recentDialogueTurnsMax} turns. Next turn: {settings.uiSettings.recentDialogueTurns} turns, adjustable in Settings → Memory.</p>
		{:else if backendReceipt?.budgets.recentDialogueTokensMax !== undefined}
			<p class="mb-3 text-xs text-[var(--text-secondary)]">Recorded recent dialogue: ~{stats.history.toLocaleString()} / {backendReceipt.budgets.recentDialogueTokensMax.toLocaleString()} tokens. Next turn: {settings.uiSettings.recentDialogueTurns} turns, adjustable in Settings → Memory.</p>
		{/if}
		<p class="mb-3 text-[11px] text-[var(--text-muted)]">{backendReceipt?.selection ? 'Last recorded narration request · token counts estimated by the server' : 'Older receipt · the final request selection was not recorded'}</p>
		<!-- Usage bar -->
		{#if recordedBudget}
		<div class="rounded-full bg-[var(--bg-primary)] h-2 overflow-hidden mb-3" role="meter" aria-label="Recorded scene and memory budget used" aria-valuenow={usagePercent} aria-valuemin="0" aria-valuemax="100">
			<div class="flex h-full">
				<div class="h-full bg-[var(--text-accent)]" style="width: {usagePercent}%"></div>
			</div>
		</div>

		<!-- Total -->
		<div class="flex items-center justify-between mb-4 gap-3">
			<span class="text-xs text-[var(--text-muted)]">
				Recorded scene and memory: ~{recordedBudget.used.toLocaleString()} / {formatBudget(recordedBudget.max)} tokens
			</span>
			<span class="text-xs font-semibold tabular-nums {usagePercent > 80 ? 'text-[var(--color-crimson-400)]' : usagePercent > 50 ? 'text-[var(--text-accent)]' : 'text-[var(--sage)]'}">
				{usagePercent.toFixed(1)}%
			</span>
		</div>
		{/if}
		{#if backendReceipt}
			<p class="mb-4 text-xs text-[var(--text-secondary)]">Recorded request total: ~{stats.total.toLocaleString()} tokens, including instructions, dialogue and action.{#if !recordedBudget} No scene budget was recorded for this request.{/if}</p>
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
	{:else}
		<p class="text-xs text-[var(--text-muted)]">{!story.currentStory ? 'No story loaded.' : story.currentStory.serverStoryId ? 'Send a turn to see the context recorded by the server.' : 'This story is saved only in this browser, so no request has been recorded. Import it to keep playing.'}</p>
	{/if}
</div>

<style>
	.context-window { padding: 1.25rem; border: 1px solid var(--border-primary); border-radius: 1rem; background: var(--bg-secondary); }
	.context-breakdown { font-variant-numeric: tabular-nums; }
	@media (max-width: 639px) { .context-window { padding: 1rem; } }
</style>
