<script lang="ts">
	import { sendEngineCommand } from '$lib/services/serverStories';
	import { RefreshCw } from 'lucide-svelte';
	let { storyId }: { storyId: string } = $props();
	let counts = $state<{ complete: number; failed: number; waiting: number; running: number } | null>(null);
	let stages = $state<Record<string, { status: 'current' | 'updating' | 'attention' | 'unknown'; jobCount: number; completedCount: number; activeCount: number; failedCount: number; latestUpdatedAt: string | null }> | null>(null);
	let coverage = $state<{
		status: 'current' | 'updating' | 'attention';
		eligibleSources: number;
		completeSources: number;
		missingSources: number;
		failedSources: number;
		outdatedSources: number;
		waitingSources: number;
		runningSources: number;
		recentUnresolvedSources: number;
		lastContiguousPosition: number | null;
		oldestUnresolvedPosition: number | null;
		oldestUnresolvedReason: string | null;
	} | null>(null);
	let error = $state('');
	let providerCooldownMs = $state(0);
	let recoveryMessage = $state('');
	let recovering = $state(false);
	let loading = $state(false);
	let refresh = $state(0);

	$effect(() => {
		const id = storyId;
		void refresh;
		let disposed = false;
		let pending = false;
		counts = null;
		stages = null;
		coverage = null;
		recoveryMessage = '';
		async function load() {
			if (pending) return;
			pending = true;
			loading = true;
			try {
				const response = await sendEngineCommand({ storyId: id, command: 'jobs.status', args: { limit: 1 } });
				if (disposed) return;
				if (response.status !== 'succeeded') throw new Error('Memory processing status unavailable.');
				const stats = (response.result as Record<string, unknown> | undefined)?.stats as Record<string, unknown> | undefined;
				providerCooldownMs = typeof stats?.providerCooldownMs === 'number' ? stats.providerCooldownMs : 0;
				const value = stats?.memoryProcessing as Record<string, unknown> | undefined;
				if (!value || !['complete', 'failed', 'waiting', 'running'].every(key => typeof value[key] === 'number')) throw new Error('Memory processing status unavailable.');
				counts = { complete: value.complete as number, failed: value.failed as number, waiting: value.waiting as number, running: value.running as number };
				const stageValue = stats?.memoryStageFreshness as Record<string, unknown> | undefined;
				const parsedStages: Record<string, { status: 'current' | 'updating' | 'attention' | 'unknown'; jobCount: number; completedCount: number; activeCount: number; failedCount: number; latestUpdatedAt: string | null }> = {};
				for (const key of ['checkpoint', 'consolidation', 'optionalIndex']) {
					const stage = stageValue?.[key] as Record<string, unknown> | undefined;
					if (!stage || !['current', 'updating', 'attention', 'unknown'].includes(String(stage.status)) || !['jobCount', 'completedCount', 'activeCount', 'failedCount'].every(field => typeof stage[field] === 'number')) continue;
					parsedStages[key] = {
						status: stage.status as 'current' | 'updating' | 'attention' | 'unknown',
						jobCount: stage.jobCount as number,
						completedCount: stage.completedCount as number,
						activeCount: stage.activeCount as number,
						failedCount: stage.failedCount as number,
						latestUpdatedAt: typeof stage.latestUpdatedAt === 'string' ? stage.latestUpdatedAt : null,
					};
				}
				stages = Object.keys(parsedStages).length === 3 ? parsedStages : null;
				const derived = stats?.memoryCoverage as Record<string, unknown> | undefined;
				if (derived && ['current', 'updating', 'attention'].includes(String(derived.status))
					&& typeof derived.eligibleSources === 'number'
					&& typeof derived.completeSources === 'number'
					&& typeof derived.missingSources === 'number'
					&& typeof derived.failedSources === 'number'
					&& typeof derived.outdatedSources === 'number'
					&& typeof derived.waitingSources === 'number'
					&& typeof derived.runningSources === 'number'
					&& (typeof derived.lastContiguousPosition === 'number' || derived.lastContiguousPosition === null)
					&& (typeof derived.oldestUnresolvedPosition === 'number' || derived.oldestUnresolvedPosition === null)
				) {
					coverage = {
						status: derived.status as 'current' | 'updating' | 'attention',
						eligibleSources: derived.eligibleSources as number,
						completeSources: derived.completeSources as number,
						missingSources: derived.missingSources as number,
						failedSources: derived.failedSources as number,
						outdatedSources: derived.outdatedSources as number,
						waitingSources: derived.waitingSources as number,
						runningSources: derived.runningSources as number,
						recentUnresolvedSources: typeof derived.recentUnresolvedSources === 'number' ? derived.recentUnresolvedSources : 0,
						lastContiguousPosition: derived.lastContiguousPosition as number | null,
						oldestUnresolvedPosition: derived.oldestUnresolvedPosition as number | null,
						oldestUnresolvedReason: typeof derived.oldestUnresolvedReason === 'string' ? derived.oldestUnresolvedReason : null,
					};
				}
				error = '';
			} catch {
				if (!disposed) error = 'Could not refresh memory processing. Status may be out of date.';
			} finally {
				pending = false;
				if (!disposed) loading = false;
			}
		}
		void load();
		const timer = setInterval(load, 15_000);
		return () => { disposed = true; clearInterval(timer); };
	});

	async function recoverMissingSource(order: 'oldest' | 'recent' = 'oldest'): Promise<void> {
		if (recovering) return;
		recovering = true;
		recoveryMessage = '';
		try {
			const response = await sendEngineCommand({ storyId, command: 'jobs.recoverMemory', args: { limit: order === 'recent' ? 3 : 1, order } });
			if (response.status !== 'succeeded') throw new Error('Recovery command failed.');
			const result = response.result as Record<string, unknown> | undefined;
			const queued = Array.isArray(result?.queued) ? result.queued.length : 0;
			recoveryMessage = queued > 0 ? `${queued} unresolved source${queued === 1 ? '' : 's'} queued for recovery.` : 'No recoverable source was queued; review the unresolved item below.';
			refresh++;
		} catch (cause) {
			recoveryMessage = cause instanceof Error ? cause.message : String(cause);
		} finally {
			recovering = false;
		}
	}

	function stageLabel(status: 'current' | 'updating' | 'attention' | 'unknown'): string {
		return status === 'current' ? 'Current' : status === 'updating' ? 'Updating' : status === 'attention' ? 'Needs attention' : 'Not run yet';
	}
</script>

<section class="memory-processing" aria-label="Memory and Context turn memory">
	<div class="heading"><strong>Memory &amp; Context · Turn memory</strong><button aria-label="Refresh memory processing" disabled={loading} onclick={() => refresh++}><RefreshCw size={14} class={loading ? 'animate-spin' : ''} /></button></div>
	<div aria-live="polite">
		{#if counts}
			{#if stages}
				<div class="stage-grid" aria-label="Memory stage freshness">
					{#each [['checkpoint', 'Checkpoint'], ['consolidation', 'Chapter / arc / saga'], ['optionalIndex', 'Optional vector / wiki index']] as [key, label]}
						{@const stage = stages[key]}
						<div class:attention={stage.status === 'attention'} class:updating={stage.status === 'updating'} class="stage-card">
							<strong>{label}</strong><span>{stageLabel(stage.status)}</span>
							<small>{stage.jobCount === 0 ? 'No job recorded' : `${stage.completedCount} complete · ${stage.activeCount} active · ${stage.failedCount} failed`}</small>
						</div>
					{/each}
				</div>
			{/if}
			{#if coverage}
				<p class:attention={coverage.status !== 'current'} class="coverage-badge" role="status">
					{coverage.status === 'current' ? 'Memory current' : coverage.status === 'updating' ? 'Updating' : 'Needs attention'}
					<span>{coverage.completeSources.toLocaleString()}/{coverage.eligibleSources.toLocaleString()} eligible turn sources covered · contiguous through position {coverage.lastContiguousPosition ?? 'none'}</span>
					<span>{coverage.recentUnresolvedSources} of the latest 5 turns awaiting memory processing</span>
				</p>
				{#if coverage.status !== 'current'}
					<p class="attention">Oldest unresolved source: {coverage.oldestUnresolvedReason ?? 'unknown'}{coverage.oldestUnresolvedPosition === null ? '' : ` at position ${coverage.oldestUnresolvedPosition}`}. Review the source-linked job in World explorer → Advanced → Jobs.</p>
				{/if}
				{#if coverage.missingSources > 0 || coverage.outdatedSources > 0}
					<button class="recover-button" disabled={recovering} onclick={() => recoverMissingSource('recent')}>{recovering ? 'Queueing recovery…' : 'Recover 3 recent turns'}</button>
					<button class="recover-button" disabled={recovering} onclick={() => recoverMissingSource('oldest')}>Recover oldest missing source</button>
				{/if}
			{/if}
			{#if providerCooldownMs > 0}<p class="attention">Provider cooling down · retry in about {Math.ceil(providerCooldownMs / 1000)} seconds</p>{/if}
			<p>{counts.complete.toLocaleString()} turn extractions complete · {counts.waiting} waiting · {counts.running} running</p>
			{#if counts.failed > 0}
				<p class="attention">Failed turn extractions: {counts.failed}. Some lasting facts may be missing from memory.</p>
				<p>The original transcript remains available for recall. Review failed items in World explorer → Advanced → Jobs.</p>
			{:else if !coverage}
				<p>No failed turn extractions. Coverage is still being assessed.</p>
			{/if}
		{:else if !error}<p>Checking memory processing…</p>{/if}
		{#if error}<p class="attention">{error}</p>{/if}
		{#if recoveryMessage}<p role="status">{recoveryMessage}</p>{/if}
	</div>
</section>

<style>
	.memory-processing { padding: 1rem; border: 1px solid var(--border-primary); border-radius: .75rem; background: var(--bg-secondary); }
	.heading { display: flex; align-items: center; justify-content: space-between; gap: .75rem; font-size: .8rem; color: var(--text-primary); }
	button { display: grid; place-items: center; min-width: 2rem; min-height: 2rem; border-radius: .4rem; color: var(--text-secondary); }
	button:hover { background: var(--bg-tertiary); }
	button:focus-visible { outline: 2px solid var(--text-accent); }
	.recover-button { display: inline-flex; margin-top: .65rem; padding: .4rem .6rem; border: 1px solid var(--border-primary); color: var(--text-accent); }
	.recover-button:disabled { opacity: .55; }
	p { margin-top: .5rem; font-size: .75rem; line-height: 1.5; color: var(--text-muted); }
	p.attention { color: var(--text-accent); }
	.coverage-badge span { display: block; color: var(--text-muted); }
	.stage-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .45rem; margin-top: .65rem; }
	.stage-card { display: grid; gap: .15rem; min-width: 0; padding: .5rem; border: 1px solid var(--border-primary); border-radius: .45rem; color: var(--text-muted); }
	.stage-card strong { color: var(--text-primary); font-size: .7rem; overflow-wrap: anywhere; }
	.stage-card span { color: var(--text-accent); font-size: .7rem; }
	.stage-card.updating span { color: var(--text-secondary); }
	.stage-card.attention span { color: var(--text-accent); }
	.stage-card small { font-size: .65rem; line-height: 1.35; }
	@media (max-width: 560px) { .stage-grid { grid-template-columns: 1fr; } }
</style>
