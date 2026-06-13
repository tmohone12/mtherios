<script lang="ts">
	import { onMount } from 'svelte';
	import { RefreshCw, Wifi, WifiOff, Database, ScrollText, AlertTriangle } from 'lucide-svelte';

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

	const gatewayOk = $derived(appStatus && typeof appStatus === 'object' && !appStatus.error);
	const wikiOk = $derived(wikiStatus && typeof wikiStatus === 'object' && !wikiStatus.error);
</script>

<div class="flex h-full flex-col overflow-y-auto p-6">
	<div class="mb-6 flex items-center justify-between">
		<div class="flex items-center gap-3">
			<Database class="h-5 w-5 text-[var(--text-accent)]" />
			<h2 class="font-display text-lg tracking-wide text-[var(--text-primary)]">Terminal Sync</h2>
		</div>
		<button onclick={load} disabled={loading} class="rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-accent)] disabled:opacity-40">
			<RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
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
				{#if appStatus.jobs}
					<div>
						<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Jobs</div>
						<div class="text-[var(--text-primary)]">{typeof appStatus.jobs === 'object' && appStatus.jobs !== null ? JSON.stringify(appStatus.jobs).slice(0, 40) : String(appStatus.jobs)}</div>
					</div>
				{/if}
			</div>
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
		Terminal sync reflects the backend gateway, job runner, and wiki indexing pipeline.
	</div>
</div>
