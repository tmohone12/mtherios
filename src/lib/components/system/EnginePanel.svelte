<script lang="ts">
	import { onMount } from 'svelte';
	import { Activity, RefreshCw, HardDrive } from 'lucide-svelte';
	import { fetchEngineCacheStatus } from '$lib/services/serverStories';
	import type { EngineCacheStatus } from '$lib/contracts/engine';

	let health = $state<Record<string, unknown> | null>(null);
	let cache = $state<EngineCacheStatus | null>(null);
	let loading = $state(false);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		try {
			const [healthRes, cacheRes] = await Promise.all([
				fetch('/api/health').then(r => r.ok ? r.json() : null).catch(() => null),
				fetchEngineCacheStatus().catch(() => null),
			]);
			health = healthRes;
			cache = cacheRes;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load engine status';
		} finally {
			loading = false;
		}
	}

	onMount(load);

	const hitRate = $derived(cache && (cache.hitCount + cache.missCount) > 0
		? Math.round((cache.hitCount / (cache.hitCount + cache.missCount)) * 100)
		: 0);
</script>

<div class="workspace-page diagnostic-page flex h-full flex-col overflow-y-auto">
	<div class="workspace-page-heading">
		<div>
			<p class="workspace-eyebrow">Behind the story</p>
			<h2>Engine core.</h2>
			<p class="workspace-subtitle">A clear view of your story engine and its working memory.</p>
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

	<!-- Health -->
	<div class="mb-4 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
		<div class="mb-3 flex items-center gap-2">
			<Activity class="h-4 w-4 text-emerald-400" />
			<span class="font-display text-xs tracking-wider text-[var(--text-secondary)]">Health</span>
		</div>
		{#if health}
			<div class="grid grid-cols-2 gap-3 text-sm">
				<div>
					<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Status</div>
					<div class="text-[var(--text-primary)]">{health.ok === true ? 'Healthy' : 'Needs attention'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Configured</div>
					<div class="{health.configured ? 'text-emerald-400' : 'text-amber-400'}">{health.configured ? 'Yes' : 'No'}</div>
				</div>
			</div>
		{:else}
			<div class="text-sm text-[var(--text-muted)]">No health data available.</div>
		{/if}
	</div>

	<!-- Cache -->
	<div class="mb-4 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
		<div class="mb-3 flex items-center gap-2">
			<HardDrive class="h-4 w-4 text-sky-400" />
			<span class="font-display text-xs tracking-wider text-[var(--text-secondary)]">Cache</span>
		</div>
		{#if cache}
			<div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
				<div>
					<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Entries</div>
					<div class="text-[var(--text-primary)]">{cache.entryCount}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Hits</div>
					<div class="text-emerald-400">{cache.hitCount}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Misses</div>
					<div class="text-amber-400">{cache.missCount}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Hit Rate</div>
					<div class="text-[var(--text-primary)]">{hitRate}%</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Tokens</div>
					<div class="text-[var(--text-primary)]">{cache.tokenEstimate.toLocaleString()}</div>
				</div>
				<div class="col-span-2 sm:col-span-3">
					<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Segments</div>
					<div class="text-[var(--text-primary)]">{cache.segments.length} kinds</div>
				</div>
			</div>
		{:else}
			<div class="text-sm text-[var(--text-muted)]">No cache data available.</div>
		{/if}
	</div>

	<div class="text-xs text-[var(--text-muted)]">
		Engine core diagnostics reflect the backend generation pipeline and prompt cache state.
	</div>
</div>
