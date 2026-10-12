<script lang="ts">
	import { onMount } from 'svelte';
	import { RefreshCw, Wifi, WifiOff, ScrollText, AlertTriangle } from 'lucide-svelte';

	let appStatus = $state<Record<string, unknown> | null>(null);
	let wikiStatus = $state<Record<string, unknown> | null>(null);
	let loading = $state(false);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		try {
			const [appRes, wikiRes] = await Promise.all([
				fetch('/api/app/status').then(r => r.ok ? r.json() : null).catch(() => null),
				fetch('/api/wiki/status').then(r => r.ok ? r.json() : null).catch(() => null),
			]);
			appStatus = appRes;
			wikiStatus = wikiRes;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load terminal status';
		} finally {
			loading = false;
		}
	}

	onMount(load);

	const gatewayOk = $derived(appStatus?.ok === true);
	const wikiOk = $derived(wikiStatus?.ok === true);
	const jobs = $derived(appStatus?.jobs && typeof appStatus.jobs === 'object' ? appStatus.jobs as Record<string, unknown> : null);
	const failureClasses = $derived(Array.isArray(jobs?.failureClasses)
		? jobs.failureClasses.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
		: []);

	function textValue(value: unknown): string {
		return typeof value === 'string' ? value : value == null ? '' : String(value);
	}

	function displayLabel(value: unknown): string {
		return textValue(value).replaceAll('_', ' ');
	}
</script>

<div class="workspace-page diagnostic-page flex h-full flex-col overflow-y-auto">
	<div class="workspace-page-heading">
		<div>
			<p class="workspace-eyebrow">Connected worlds</p>
			<h2>Server sync.</h2>
			<p class="workspace-subtitle">Connections, background work, and the knowledge behind your stories.</p>
		</div>
		<button onclick={load} disabled={loading} class="workspace-refresh">
			<RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />{loading ? 'Refreshing' : 'Refresh status'}
		</button>
	</div>

	{#if error}
		<div class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-400">
			{error}
		</div>
	{/if}

	<!-- Gateway -->
	<div class="mb-4 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
		<div class="mb-3 flex items-center gap-2">
			{#if gatewayOk}
				<Wifi class="h-4 w-4 text-emerald-400" />
			{:else}
				<WifiOff class="h-4 w-4 text-amber-400" />
			{/if}
			<span class="font-display text-xs tracking-wider text-[var(--text-secondary)]">Gateway</span>
		</div>
		{#if appStatus}
			<div class="grid grid-cols-2 gap-3 text-sm">
				<div>
					<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Status</div>
					<div class="{gatewayOk ? 'text-emerald-400' : 'text-amber-400'}">{gatewayOk ? 'Connected' : 'Offline / Error'}</div>
				</div>
				{#if jobs}
					{#each ['queued', 'running', 'failed'] as state}
						<div><div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{state}</div><div class="text-[var(--text-primary)]">{typeof jobs[state] === 'number' ? jobs[state] : '—'}</div></div>
					{/each}
				{/if}
			</div>
			{#if failureClasses.length > 0}
				<div class="mt-4 border-t border-[var(--border-primary)] pt-3" aria-label="Job recovery signals">
					<div class="mb-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Recovery signals</div>
					<div class="space-y-2">
						{#each failureClasses.slice(0, 5) as failure}
							<div class="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-2 text-xs">
								<div class="flex flex-wrap items-center justify-between gap-2 text-[var(--text-primary)]">
									<strong>{displayLabel(failure.type)}</strong>
									<span>{textValue(failure.count)} {textValue(failure.count) === '1' ? 'failure' : 'failures'}</span>
								</div>
								<div class="mt-1 text-[var(--text-muted)]">
									{displayLabel(failure.cause)} · {failure.retryable === true ? 'retryable' : 'do not retry automatically'}
									{#if Array.isArray(failure.sourceVersions) && failure.sourceVersions.length > 0} · source {failure.sourceVersions.join(', ')}{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		{:else}
			<div class="text-sm text-[var(--text-muted)]">No gateway data available.</div>
		{/if}
	</div>

	<!-- Wiki -->
	<div class="mb-4 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
		<div class="mb-3 flex items-center gap-2">
			{#if wikiOk}
				<ScrollText class="h-4 w-4 text-emerald-400" />
			{:else}
				<AlertTriangle class="h-4 w-4 text-amber-400" />
			{/if}
			<span class="font-display text-xs tracking-wider text-[var(--text-secondary)]">Wiki Terminal</span>
		</div>
		{#if wikiStatus}
			<div class="grid grid-cols-2 gap-3 text-sm">
				<div>
					<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Status</div>
					<div class="{wikiOk ? 'text-emerald-400' : 'text-amber-400'}">{wikiOk ? 'Online' : 'Offline / Error'}</div>
				</div>
				{#if wikiStatus.indexedCount !== undefined}
					<div>
						<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Indexed</div>
						<div class="text-[var(--text-primary)]">{wikiStatus.indexedCount}</div>
					</div>
				{/if}
			</div>
		{:else}
			<div class="text-sm text-[var(--text-muted)]">No wiki terminal data available.</div>
		{/if}
	</div>

	<div class="text-xs text-[var(--text-muted)]">
		Server sync shows the command gateway, job runner, and wiki indexing on the story server.
	</div>
</div>
