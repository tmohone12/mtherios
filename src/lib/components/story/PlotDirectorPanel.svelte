<script lang="ts">
	import PlotDirectorEditor from './PlotDirectorEditor.svelte';
	import ThreadManager from './ThreadManager.svelte';
	import { Activity, Clock3, Eye, EyeOff, GitBranch, Loader2, Save, Zap } from 'lucide-svelte';
	import { runBackendPlotBrainPlan } from '$lib/services/backendMemory';
	import { strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
	import { appliedStrategicFrameFromProjection, storedStrategicFrameForStory } from '$lib/services/ai/context/strategicFramePromptCard';
	import { story } from '$lib/stores/story.svelte';
	import type { StrategicWorldFrame } from '$lib/types';

	let running = $state(false);
	let error = $state('');
	type JsonRecord = Record<string, unknown>;
	type DirectorThread = {
		id: string;
		title: string;
		description: string;
		status: string;
		significance: string;
		updatedTurn: number | null;
	};
	type DirectorEvent = {
		id: string;
		title: string;
		body: string;
		status: string;
		turn: number | null;
		threadIds: string[];
		metadata: JsonRecord;
	};

	function asRecord(value: unknown): JsonRecord {
		return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
	}

	function asRecords(value: unknown): JsonRecord[] {
		return Array.isArray(value) ? value.map(asRecord).filter(row => Object.keys(row).length > 0) : [];
	}

	function asStrings(value: unknown): string[] {
		return Array.isArray(value)
			? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
			: [];
	}

	function text(value: unknown): string {
		return typeof value === 'string' ? value.trim() : '';
	}

	function finiteTurn(value: unknown): number | null {
		return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
	}

	function compact(value: string, max = 72): string {
		return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
	}

	function uniqueRows(...values: unknown[]): JsonRecord[] {
		const seen = new Set<string>();
		return values.flatMap(asRecords).filter((row, index) => {
			const key = text(row.id) || `${text(row.title)}:${text(row.description)}:${index}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	function parseThread(row: JsonRecord): DirectorThread | null {
		const description = text(row.description ?? row.summary ?? row.logline);
		const title = text(row.title ?? row.name) || compact(description, 64);
		if (!title) return null;
		return {
			id: text(row.id) || title,
			title,
			description: description === title ? '' : description,
			status: (text(row.status) || 'open').toLowerCase(),
			significance: (text(row.significance ?? row.priority) || 'moderate').toLowerCase(),
			updatedTurn: finiteTurn(row.lastProgressTurn ?? row.updatedTurn ?? row.lastProgressedTurn),
		};
	}

	function parseEvent(row: JsonRecord): DirectorEvent | null {
		const title = text(row.title ?? row.name);
		if (!title) return null;
		const status = (text(row.status) || 'committed').toLowerCase();
		return {
			id: text(row.id) || title,
			title,
			body: text(row.body ?? row.description),
			status,
			turn: status === 'committed'
				? finiteTurn(row.occurredTurn ?? row.createdTurn)
				: finiteTurn(row.scheduledTurn ?? row.createdTurn),
			threadIds: asStrings(row.threadIds),
			metadata: asRecord(row.metadata),
		};
	}

	function parseFrame(value: unknown): StrategicWorldFrame | null {
		const parsed = strategicWorldFrameSchema.safeParse(value);
		return parsed.success ? parsed.data as unknown as StrategicWorldFrame : null;
	}

	function label(value: string): string {
		return value.replaceAll('_', ' ');
	}

	function activePlotCards(value: StrategicWorldFrame | null): StrategicWorldFrame['plotCards'] {
		if (!value) return [];
		const activeIds = new Set(value.activationPlan.activateNow.map(id => id.toLowerCase()));
		return value.plotCards
			.filter(card => activeIds.has(card.id.toLowerCase()) || activeIds.has(card.title.toLowerCase()))
			.filter(card => card.lifecycleStage !== 'resolved' && card.lifecycleStage !== 'dormant')
			.sort((a, b) => b.pressure - a.pressure)
			.slice(0, 3);
	}

	const projection = $derived(asRecord(story.campaignProjection));
	const projectionStory = $derived(asRecord(story.campaignProjection?.story));
	const plotBrain = $derived(asRecord(asRecord(projectionStory.metadata).plotBrain));
	const pendingFrame = $derived(parseFrame(plotBrain.pendingFrame));
	const currentTurn = $derived(finiteTurn(projectionStory.currentTurn ?? asRecord(projectionStory.state).currentTurn));
	const lastFrame = $derived(storedStrategicFrameForStory(projectionStory.id, projectionStory.metadata));
	const narratorFrame = $derived(appliedStrategicFrameFromProjection(story.campaignProjection));
	const pendingFrameId = $derived(typeof plotBrain.pendingFrameId === 'string' ? plotBrain.pendingFrameId.trim() : '');
	const plotBrainActive = $derived(plotBrain.active !== false);
	const quietUntilTurn = $derived(
		typeof plotBrain.quietUntilTurn === 'number' && Number.isFinite(plotBrain.quietUntilTurn)
			? Math.floor(plotBrain.quietUntilTurn)
			: null,
	);
	const retirementReason = $derived(
		typeof plotBrain.retirementReason === 'string' ? plotBrain.retirementReason.trim() : '',
	);
	const projectionVersion = $derived(typeof projectionStory.serverVersion === 'number' ? projectionStory.serverVersion : null);
	const pendingBaseVersion = $derived(typeof plotBrain.pendingBaseServerVersion === 'number' ? plotBrain.pendingBaseServerVersion : null);
	const pendingFresh = $derived(Boolean(
		pendingFrame
		&& pendingFrameId === pendingFrame.id
		&& projectionVersion !== null
		&& pendingBaseVersion === projectionVersion
	));
	const staleDraft = $derived(Boolean(pendingFrame && !pendingFresh));
	const frame = $derived((pendingFresh ? pendingFrame : (plotBrainActive ? lastFrame : null)) as StrategicWorldFrame | null);
	const activeCards = $derived(activePlotCards(frame));
	const appliedCards = $derived(activePlotCards(lastFrame));
	const lastFrameTurn = $derived(finiteTurn(plotBrain.lastFrameTurn));
	const frameAgeTurns = $derived(currentTurn !== null && lastFrameTurn !== null ? Math.max(0, currentTurn - lastFrameTurn) : null);
	const developmentAfterTurns = $derived(finiteTurn(plotBrain.developmentAfterTurns) ?? 12);
	const appliedFrameFresh = $derived(Boolean(narratorFrame));
	const inNarrator = $derived(Boolean(plotBrainActive && appliedFrameFresh && appliedCards.length > 0));
	const projectedThreads = $derived.by(() => uniqueRows(
		projection.threads,
		projection.storyThreads,
		projectionStory.threads,
		projectionStory.storyThreads,
	).map(parseThread).filter((thread): thread is DirectorThread => Boolean(thread)));
	const projectedEvents = $derived.by(() => uniqueRows(
		projection.recentEvents,
		projectionStory.recentEvents,
	).map(parseEvent).filter((event): event is DirectorEvent => Boolean(event)));
	const knownThreadIds = $derived(new Set(projectedThreads.map(thread => thread.id)));
	const plotEvents = $derived(projectedEvents.filter(event =>
		event.metadata.plotBrain === true
		|| event.metadata.plotBrain === 'true'
		|| text(event.metadata.plotCardId).length > 0
		|| event.threadIds.some(id => knownThreadIds.has(id))
	));
	const lastPlotEvent = $derived([...plotEvents]
		.filter(event => event.status === 'committed')
		.sort((a, b) => (b.turn ?? -1) - (a.turn ?? -1))[0] ?? null);
	const nextPlotEvent = $derived([...plotEvents]
		.filter(event => event.status === 'due' || event.status === 'scheduled')
		.sort((a, b) => Number(b.status === 'due') - Number(a.status === 'due') || (a.turn ?? Number.MAX_SAFE_INTEGER) - (b.turn ?? Number.MAX_SAFE_INTEGER))[0] ?? null);
	const activeThreadIds = $derived.by(() => {
		if (!frame) return new Set<string>();
		const cardIds = new Set(activeCards.map(card => card.id.toLowerCase()));
		const cardTitles = new Set(activeCards.map(card => card.title.toLowerCase()));
		const ids = frame.plotBrainWritePlan.timelineEvents
			.filter(event => cardIds.has(event.plotCardId.toLowerCase()))
			.map(event => event.threadId)
			.filter((id): id is string => Boolean(id));
		for (const card of activeCards) {
			if (card.storyThreadId) ids.push(card.storyThreadId);
			for (const ref of card.sourceRefs) if (ref.sourceType === 'thread' && ref.sourceId) ids.push(ref.sourceId);
		}
		for (const event of projectedEvents) {
			const plotCardId = text(event.metadata.plotCardId).toLowerCase();
			const plotCardTitle = text(event.metadata.plotCardTitle).toLowerCase();
			if (cardIds.has(plotCardId) || cardTitles.has(plotCardTitle)) ids.push(...event.threadIds);
		}
		for (const thread of projectedThreads) {
			const description = thread.description.toLowerCase();
			if ([...cardTitles].some(title => description === title || description.startsWith(`${title}:`))) ids.push(thread.id);
		}
		return new Set(ids);
	});
	const watchedThreads = $derived(projectedThreads
		.filter(thread => ['open', 'imminent', 'stalled'].includes(thread.status) && !activeThreadIds.has(thread.id))
		.sort((a, b) => {
			const statusOrder: Record<string, number> = { imminent: 0, open: 1, stalled: 2 };
			const significanceOrder: Record<string, number> = { critical: 0, major: 1, moderate: 2, minor: 3 };
			return (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3)
				|| (significanceOrder[a.significance] ?? 4) - (significanceOrder[b.significance] ?? 4);
		}).slice(0, 8));
	const dormantCards = $derived.by(() => {
		if (!frame) return [];
		const activeIds = new Set(activeCards.map(card => card.id.toLowerCase()));
		const dormantIds = new Set(frame.activationPlan.keepDormant.map(id => id.toLowerCase()));
		return frame.plotCards.filter(card => !activeIds.has(card.id.toLowerCase()) && (
			card.lifecycleStage === 'dormant'
			|| dormantIds.has(card.id.toLowerCase())
			|| dormantIds.has(card.title.toLowerCase())
		)).slice(0, 6);
	});
	const closedThreadCount = $derived.by(() => {
		const canonical = projectedThreads.filter(thread => ['closed', 'resolved', 'abandoned'].includes(thread.status)).length;
		if (projectedThreads.length > 0) return canonical;
		return new Set([
			...(frame?.plotCards.filter(card => card.lifecycleStage === 'resolved').map(card => card.id) ?? []),
			...(frame?.activationPlan.retireOrMerge ?? []),
		]).size;
	});
	const watchedCount = $derived(watchedThreads.length + dormantCards.length);
	const hasEventLedger = $derived(projectedEvents.length > 0);
	const needsDevelopment = $derived.by(() => {
		if (pendingFresh || !plotBrainActive) return false;
		if (typeof plotBrain.needsDevelopment === 'boolean') return plotBrain.needsDevelopment;
		if (!lastFrame || appliedCards.length === 0 || frameAgeTurns === null) return true;
		if (frameAgeTurns > developmentAfterTurns) return true;
		return hasEventLedger && plotEvents.some(event => event.status === 'committed') && !nextPlotEvent;
	});
	const developmentReason = $derived(
		pendingFresh ? 'A fresh draft is waiting for review.'
			: !plotBrainActive ? 'Plot pressure is intentionally quiet.'
				: !lastFrame ? 'No applied plot frame exists.'
					: appliedCards.length === 0 ? 'The applied frame has no active spotlight cards.'
						: frameAgeTurns === null ? 'The applied frame has no turn marker.'
							: frameAgeTurns > developmentAfterTurns ? `The frame has gone ${frameAgeTurns} turns without development.`
								: hasEventLedger && plotEvents.some(event => event.status === 'committed') && !nextPlotEvent ? 'Its last recorded movement has no next scheduled consequence.'
									: 'The applied frame still has current pressure.',
	);
	const pressureBeats = $derived(activeCards.flatMap(card =>
		card.pressureBeats.map(beat => ({ ...beat, plotTitle: card.title }))
	).sort((a, b) => a.delayTurns - b.delayTurns).slice(0, 4));

	async function run(execute: boolean): Promise<void> {
		const current = story.currentStory;
		if (running || !current?.serverStoryId || (execute && !pendingFresh)) return;
		running = true;
		error = '';
		try {
			await runBackendPlotBrainPlan(current, {
				execute,
				frameId: execute ? pendingFrame?.id : undefined,
				replacePendingFrameId: !execute && staleDraft ? pendingFrameId : undefined,
			});
			await story.pullBackendProjection();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			running = false;
		}
	}
</script>

<section class="director-panel space-y-4" aria-label="Plot Director">
	<PlotDirectorEditor applied={lastFrame} pending={pendingFrame} {pendingFresh} />
	<details class="rounded-xl bg-[var(--bg-tertiary)] p-3"><summary class="min-h-11 cursor-pointer text-sm">Manage all story threads</summary><ThreadManager /></details>
	<div class="director-header flex items-start justify-between gap-3">
		<div>
			<div class="flex items-center gap-2">
				<Zap class="h-4 w-4 text-[var(--text-accent)]" />
				<h3 class="font-display text-2xl text-[var(--text-primary)]">Plot Director</h3>
			</div>
			<p class="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">Author view · optional background pressure, never a script</p>
		</div>
		{#if frame || !plotBrainActive}
			<span class="rounded-full border px-2 py-1 text-[9px] uppercase tracking-wide {pendingFresh || (plotBrainActive && !appliedFrameFresh) ? 'border-amber-400/30 text-amber-300' : plotBrainActive ? 'border-[var(--success)]/30 text-[var(--success)]' : 'border-[var(--text-muted)]/30 text-[var(--text-muted)]'}">
				{pendingFresh ? 'Draft' : !plotBrainActive ? 'Quiet' : appliedFrameFresh ? 'Active' : 'Expired'}
			</span>
		{/if}
	</div>

	<div class="director-actions grid grid-cols-2 gap-2">
		<button onclick={() => run(false)} disabled={running || !story.currentStory?.serverStoryId} class="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[var(--text-accent)]/30 bg-[var(--text-accent)]/5 px-3 text-sm text-[var(--text-accent)] hover:bg-[var(--text-accent)]/10 disabled:cursor-not-allowed disabled:opacity-40" title="Draft a fresh strategic plot frame">
			{#if running}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Zap class="h-4 w-4" />{/if} Draft fresh
		</button>
		<button onclick={() => run(true)} disabled={running || !pendingFresh} class="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[var(--success)]/30 bg-[var(--success)]/5 px-3 text-sm text-[var(--success)] hover:bg-[var(--success)]/10 disabled:cursor-not-allowed disabled:opacity-40" title={pendingFresh ? 'Apply this exact reviewed plot draft' : 'Draft a fresh frame before applying'}>
			<Save class="h-4 w-4" /> Apply draft
		</button>
	</div>

	{#if staleDraft}<p class="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">The saved draft is older than the current story. Draft fresh to replace that exact stale draft.</p>{/if}
	{#if lastFrame && plotBrainActive && !appliedFrameFresh && !pendingFresh}<p class="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">This saved frame has expired and is excluded from narration. Its details remain here for review. Draft fresh to develop current events.</p>{/if}
	{#if error}<p class="rounded-lg border border-[var(--color-crimson-400)]/25 bg-[var(--color-crimson-400)]/5 px-3 py-2 text-xs text-[var(--color-crimson-400)]" aria-live="polite">{error}</p>{/if}

	<div class="flex flex-wrap gap-2" role="status" aria-label="Plot Director status">
		<span class="inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-semibold uppercase tracking-wide {inNarrator ? 'border-[var(--success)]/30 bg-[var(--success)]/5 text-[var(--success)]' : 'border-[var(--text-muted)]/25 bg-[var(--text-muted)]/5 text-[var(--text-muted)]'}">
			{#if inNarrator}<Eye class="h-3.5 w-3.5" /> In narrator{:else}<EyeOff class="h-3.5 w-3.5" /> Not in narrator{/if}
		</span>
		<span title={developmentReason} class="inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-semibold uppercase tracking-wide {needsDevelopment ? 'border-amber-400/30 bg-amber-500/5 text-amber-300' : pendingFresh ? 'border-[var(--sage)]/30 bg-[var(--sage)]/5 text-[var(--sage)]' : 'border-[var(--text-accent)]/25 bg-[var(--text-accent)]/5 text-[var(--text-accent)]'}">
			<Activity class="h-3.5 w-3.5" /> {needsDevelopment ? 'Needs development' : pendingFresh ? 'Review draft' : 'Current'}
		</span>
	</div>

	{#if lastFrame || pendingFrame || projectedThreads.length > 0}
		<div class="director-metrics grid grid-cols-2 gap-2" aria-label="Plot thread summary">
			<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
				<div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]"><Clock3 class="h-3.5 w-3.5" /> Frame age</div>
				<p class="mt-1 font-display text-lg text-[var(--text-primary)]">{frameAgeTurns === null ? 'Unknown' : `${frameAgeTurns}t`}</p>
				<p class="text-[10px] {appliedFrameFresh ? 'text-[var(--success)]' : 'text-amber-300'}">{appliedFrameFresh ? 'Fresh for narration' : lastFrame ? 'Outside narrator window' : 'No applied frame'}</p>
			</div>
			<div class="rounded-xl border border-[var(--text-accent)]/20 bg-[var(--text-accent)]/5 p-3">
				<div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--text-accent)]"><Zap class="h-3.5 w-3.5" /> Spotlight</div>
				<p class="mt-1 font-display text-lg text-[var(--text-primary)]">{activeCards.length}</p>
				<p class="text-[10px] text-[var(--text-muted)]">{!pendingFresh && !appliedFrameFresh ? 'previous' : 'active'} thread{activeCards.length === 1 ? '' : 's'}</p>
			</div>
			<div class="rounded-xl border border-[var(--sage)]/20 bg-[var(--sage)]/5 p-3">
				<div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--sage)]"><GitBranch class="h-3.5 w-3.5" /> Watched</div>
				<p class="mt-1 font-display text-lg text-[var(--text-primary)]">{watchedCount}</p>
				<p class="text-[10px] text-[var(--text-muted)]">open or dormant</p>
			</div>
			<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
				<div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]"><Activity class="h-3.5 w-3.5" /> Resolved</div>
				<p class="mt-1 font-display text-lg text-[var(--text-primary)]">{closedThreadCount}</p>
				<p class="text-[10px] text-[var(--text-muted)]">closed or retired</p>
			</div>
		</div>
	{/if}

	{#if frame}
		<div class="space-y-2 rounded-2xl border border-[var(--text-accent)]/20 bg-[var(--text-accent)]/5 p-3">
			{#if frame.publicSummary}<p class="text-sm leading-relaxed text-[var(--text-primary)]">{frame.publicSummary}</p>{/if}
			{#if frame.activationPlan.rationale}<details class="rounded-lg bg-[var(--bg-primary)]/65 px-3 py-2"><summary class="flex min-h-11 cursor-pointer items-center text-xs font-semibold text-[var(--text-accent)]">Activation / validation</summary><p class="mt-2 whitespace-pre-line text-xs leading-relaxed text-[var(--text-secondary)]">{frame.activationPlan.rationale}</p></details>{/if}
			{#if frame.hiddenStrategicSummary}<details class="rounded-lg bg-[var(--bg-primary)]/65 px-3 py-2"><summary class="flex min-h-11 cursor-pointer items-center text-xs font-semibold text-[var(--text-accent)]">Hidden strategy</summary><p class="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{frame.hiddenStrategicSummary}</p></details>{/if}
		</div>

		{#if activeCards.length}
			<details open class="rounded-2xl border border-[var(--text-accent)]/20 bg-[var(--bg-tertiary)] p-3">
				<summary class="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]"><span>{!pendingFresh && !appliedFrameFresh ? 'Previous spotlight' : 'Active spotlight'}</span><span class="rounded-full bg-[var(--text-accent)]/10 px-2 py-0.5 text-[9px] text-[var(--text-accent)]">{activeCards.length}</span></summary>
				<div class="mt-3 space-y-2">
					{#each activeCards as card}
						<article class="rounded-xl border border-[var(--text-accent)]/15 bg-[var(--bg-primary)]/45 p-3">
							<div class="flex flex-wrap items-start justify-between gap-2">
								<div><p class="text-[9px] uppercase tracking-wide text-[var(--text-accent)]">{label(card.lifecycleStage)} · {label(card.kind)}</p><h4 class="font-semibold text-[var(--text-primary)]">{card.title}</h4></div>
								<span class="rounded-full bg-[var(--bg-primary)]/75 px-2 py-1 text-[9px] uppercase text-[var(--text-muted)]">{label(card.urgency)} · {card.pressure}</span>
							</div>
							<p class="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{card.logline}</p>
						</article>
					{/each}
				</div>
			</details>
		{/if}

		{#if watchedThreads.length || dormantCards.length}
			<details open class="rounded-2xl border border-[var(--sage)]/15 bg-[var(--bg-tertiary)] p-3">
				<summary class="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-xs font-semibold uppercase tracking-wide text-[var(--sage)]"><span>Watched threads</span><span class="rounded-full bg-[var(--sage)]/10 px-2 py-0.5 text-[9px]">{watchedCount}</span></summary>
				<div class="mt-3 space-y-2">
					{#each watchedThreads as thread}
						<article class="rounded-xl bg-[var(--bg-primary)]/45 px-3 py-2.5">
							<div class="flex flex-wrap items-start justify-between gap-2">
								<h4 class="text-sm font-semibold text-[var(--text-primary)]">{thread.title}</h4>
								<span class="rounded-full px-2 py-0.5 text-[9px] uppercase {thread.status === 'imminent' ? 'bg-amber-500/10 text-amber-300' : thread.status === 'stalled' ? 'bg-[var(--text-muted)]/10 text-[var(--text-muted)]' : 'bg-[var(--sage)]/10 text-[var(--sage)]'}">{label(thread.status)} · {label(thread.significance)}</span>
							</div>
							{#if thread.description}<p class="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{compact(thread.description, 240)}</p>{/if}
							{#if thread.updatedTurn !== null}<p class="mt-1 text-[9px] uppercase tracking-wide text-[var(--text-muted)]">Last moved turn {thread.updatedTurn}</p>{/if}
						</article>
					{/each}
					{#each dormantCards as card}
						<article class="rounded-xl bg-[var(--bg-primary)]/45 px-3 py-2.5">
							<div class="flex flex-wrap items-start justify-between gap-2"><h4 class="text-sm font-semibold text-[var(--text-primary)]">{card.title}</h4><span class="rounded-full bg-[var(--text-muted)]/10 px-2 py-0.5 text-[9px] uppercase text-[var(--text-muted)]">Dormant · {card.pressure}</span></div>
							<p class="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{card.logline}</p>
						</article>
					{/each}
				</div>
			</details>
		{/if}

		{#if lastPlotEvent || nextPlotEvent || pressureBeats.length}
			<details open class="rounded-2xl border border-[var(--success)]/15 bg-[var(--bg-tertiary)] p-3">
				<summary class="flex min-h-11 cursor-pointer items-center text-xs font-semibold uppercase tracking-wide text-[var(--success)]">Plot movement</summary>
				<div class="mt-3 grid gap-2 sm:grid-cols-2">
					{#if lastPlotEvent}
						<article class="rounded-xl bg-[var(--bg-primary)]/45 p-3"><p class="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">Last movement{lastPlotEvent.turn !== null ? ` · turn ${lastPlotEvent.turn}` : ''}</p><h4 class="mt-1 text-sm font-semibold text-[var(--text-primary)]">{lastPlotEvent.title}</h4>{#if lastPlotEvent.body}<p class="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{compact(lastPlotEvent.body, 180)}</p>{/if}</article>
					{/if}
					{#if nextPlotEvent}
						<article class="rounded-xl bg-[var(--bg-primary)]/45 p-3"><p class="text-[9px] uppercase tracking-wide {nextPlotEvent.status === 'due' ? 'text-amber-300' : 'text-[var(--sage)]'}">Next consequence · {label(nextPlotEvent.status)}{nextPlotEvent.turn !== null ? ` turn ${nextPlotEvent.turn}` : ''}</p><h4 class="mt-1 text-sm font-semibold text-[var(--text-primary)]">{nextPlotEvent.title}</h4>{#if nextPlotEvent.body}<p class="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{compact(nextPlotEvent.body, 180)}</p>{/if}</article>
					{:else if pressureBeats[0]}
						<article class="rounded-xl bg-[var(--bg-primary)]/45 p-3"><p class="text-[9px] uppercase tracking-wide text-amber-300">Next planned beat · {pressureBeats[0].delayTurns ? `in ${pressureBeats[0].delayTurns} turns` : 'ready'}</p><h4 class="mt-1 text-sm font-semibold text-[var(--text-primary)]">{pressureBeats[0].title}</h4><p class="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{compact(pressureBeats[0].body, 180)}</p></article>
					{/if}
				</div>
			</details>
		{/if}

		{#if frame.mainPlots.length || frame.subplots.length}
			<details open class="rounded-2xl bg-[var(--bg-tertiary)] p-3">
				<summary class="flex min-h-11 cursor-pointer items-center text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]">Plots and subplots</summary>
				<div class="mt-3 space-y-3">
					{#each frame.mainPlots as plot}<article><p class="text-[10px] uppercase tracking-wide text-[var(--text-accent)]">Main plot · {plot.pressure}</p><h4 class="font-semibold text-[var(--text-primary)]">{plot.title}</h4><p class="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{plot.summary}</p></article>{/each}
					{#each frame.subplots as plot}<article><p class="text-[10px] uppercase tracking-wide text-[var(--sage)]">Subplot · {plot.pressure}</p><h4 class="font-semibold text-[var(--text-primary)]">{plot.title}</h4><p class="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{plot.summary}</p></article>{/each}
				</div>
			</details>
		{/if}

		{#if frame.antagonistCandidates.length}
			<details open class="rounded-2xl bg-[var(--bg-tertiary)] p-3">
				<summary class="flex min-h-11 cursor-pointer items-center text-xs font-semibold uppercase tracking-wide text-[var(--color-crimson-400)]">Antagonists and opposition</summary>
				<div class="mt-3 space-y-3">{#each frame.antagonistCandidates.slice(0, 4) as antagonist}<article><div class="flex flex-wrap items-center gap-2"><h4 class="font-semibold text-[var(--text-primary)]">{antagonist.name}</h4><span class="text-[9px] uppercase tracking-wide text-[var(--color-crimson-400)]">{label(antagonist.role)}</span></div><p class="mt-1 text-xs text-[var(--text-secondary)]"><span class="text-[var(--text-muted)]">Motive:</span> {antagonist.motive}</p><p class="mt-1 text-xs text-[var(--text-secondary)]"><span class="text-[var(--text-muted)]">Method:</span> {antagonist.method}</p></article>{/each}</div>
			</details>
		{/if}

		{#if pressureBeats.length}
			<details class="rounded-2xl bg-[var(--bg-tertiary)] p-3">
				<summary class="flex min-h-11 cursor-pointer items-center text-xs font-semibold uppercase tracking-wide text-amber-300">Upcoming pressure</summary>
				<div class="mt-3 space-y-3">{#each pressureBeats as beat}<article><p class="text-[10px] uppercase tracking-wide text-amber-300">{beat.plotTitle} · {beat.delayTurns ? `in ${beat.delayTurns} turns` : 'next beat'}</p><h4 class="font-semibold text-[var(--text-primary)]">{beat.title}</h4><p class="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{beat.body}</p></article>{/each}</div>
			</details>
		{/if}
	{:else if !plotBrainActive}
		<div class="space-y-2 rounded-2xl border border-[var(--text-muted)]/25 bg-[var(--text-muted)]/5 p-4">
			<p class="text-sm font-medium text-[var(--text-primary)]">Plot pressure is retired.</p>
			<p class="text-xs leading-relaxed text-[var(--text-secondary)]">The previous frame is kept as history, but none of its plots, antagonists, or pressure beats enter narration.</p>
			{#if quietUntilTurn !== null}<p class="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Automatic planning paused through turn {quietUntilTurn}</p>{/if}
			{#if retirementReason}<details class="rounded-lg bg-[var(--bg-primary)]/65 px-3 py-2"><summary class="flex min-h-11 cursor-pointer items-center text-xs font-semibold text-[var(--text-muted)]">Retirement reason</summary><p class="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{retirementReason}</p></details>{/if}
			<p class="text-xs leading-relaxed text-[var(--text-muted)]">Use Draft fresh only when you want to introduce a new direction from current canon.</p>
		</div>
	{:else}
		<p class="rounded-2xl bg-[var(--bg-tertiary)] p-4 text-sm leading-relaxed text-[var(--text-secondary)]">No strategic frame exists yet. Draft one to create background plots, subplots, opposition, and pressure beats from current canon.</p>
	{/if}
</section>

<style>
	.director-header { padding-bottom: 0.9rem; border-bottom: 1px solid var(--border-secondary); }
	.director-actions button { font-size: 0.75rem; font-weight: 550; transition: background 150ms ease, border-color 150ms ease; }
	.director-metrics > div { padding: 1rem; }
	.director-metrics .font-display { font-size: 1.65rem; line-height: 1.4; }
	.director-panel > details { border: 1px solid var(--border-secondary); padding: 0.65rem 1rem; }
	.director-panel summary { font-size: 0.7rem; letter-spacing: 0.045em; }
	.director-panel h4 { font-family: var(--font-display); font-size: 1.1rem; font-weight: 500; line-height: 1.4; }
	.director-panel article + article { border-top: 1px solid var(--border-secondary); padding-top: 0.75rem; }
	@media (max-width: 639px) { .director-metrics > div { padding: 0.8rem; } }
</style>
