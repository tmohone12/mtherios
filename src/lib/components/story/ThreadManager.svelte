<script lang="ts">
	import { story } from '$lib/stores/story.svelte';
	import { saveBackendPlotEdit } from '$lib/services/backendMemory';
	import { isDeletedThread, type PlotEdit } from '$lib/contracts/plotEditing';
	let editing = $state<string | null>(null);
	let description = $state('');
	let status = $state<'open' | 'imminent' | 'stalled' | 'closed' | 'deleted'>('open');
	let significance = $state<'minor' | 'moderate' | 'major' | 'critical'>('moderate');
	let version = $state(0);
	let busy = $state(false);
	let error = $state('');
	let showHistory = $state(false);
	let confirming = $state<string | null>(null);
	const threads = $derived(story.campaignProjection?.threads ?? []);
	const visible = $derived(threads.filter(row => showHistory || !['closed', 'abandoned', 'resolved'].includes(String(row.status))));
	function begin(row: Record<string, unknown>) {
		editing = String(row.id); description = String(row.description ?? '');
		status = isDeletedThread(row.closureReason) ? 'deleted' : ['closed', 'resolved', 'abandoned'].includes(String(row.status)) ? 'closed' : row.status as typeof status;
		significance = row.significance as typeof significance;
		version = Number(story.campaignProjection?.story.serverVersion);
		error = ''; confirming = null;
	}
	async function save() {
		if (!story.currentStory || !editing) return;
		busy = true; error = '';
		try {
			await saveBackendPlotEdit(story.currentStory, { target: 'thread', serverVersion: version, threadId: editing, description, status, significance } satisfies PlotEdit);
			await story.pullBackendProjection(); editing = null; confirming = null;
		} catch (e) { error = e instanceof Error ? e.message : String(e); }
		finally { busy = false; }
	}
</script>

<section class="space-y-3" aria-label="Manage story threads">
	<h3 class="text-sm font-semibold">Story threads</h3>
	<p class="text-xs text-[var(--text-muted)]">Edit the continuity the GM uses. Closing or deleting removes linked Director pressure and cancels future linked beats. Past events remain history. Reopening does not replay cancelled beats.</p>
	<label class="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" bind:checked={showHistory} /> Show closed and deleted threads</label>
	{#if error}<p role="alert" class="text-sm text-red-400">{error}</p>{/if}
	{#each visible as row (row.id)}
		<article class="space-y-2 rounded-xl bg-[var(--bg-tertiary)] p-3">
			{#if editing === row.id}
				<label class="block text-xs">Thread description<textarea class="mt-1 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-sm" rows="5" bind:value={description} disabled={busy}></textarea></label>
				<label class="block text-xs">Thread status<select class="ml-2 rounded bg-[var(--bg-primary)] p-2" bind:value={status} disabled={busy}><option value="open">Open</option><option value="imminent">Imminent</option><option value="stalled">Stalled</option><option value="closed">Closed</option><option value="deleted">Deleted (recoverable)</option></select></label>
				<label class="block text-xs">Significance<select class="ml-2 rounded bg-[var(--bg-primary)] p-2" bind:value={significance} disabled={busy}><option>minor</option><option>moderate</option><option>major</option><option>critical</option></select></label>
				<div class="flex gap-3"><button class="min-h-11 text-sm text-[var(--text-accent)]" disabled={busy || !description.trim()} onclick={save}>{busy ? 'Saving…' : 'Save thread'}</button><button class="min-h-11 text-sm" disabled={busy} onclick={() => editing = null}>Cancel</button></div>
			{:else}
				<p class="whitespace-pre-wrap text-sm">{row.description}</p>
				<p class="text-xs text-[var(--text-muted)]">{isDeletedThread(row.closureReason) ? 'deleted' : row.status} · {row.significance}</p>
				<div class="flex flex-wrap gap-4 text-xs">
					<button class="min-h-11 text-[var(--text-accent)]" disabled={busy} onclick={() => begin(row)}>Edit / reopen</button>
					{#if !['closed', 'abandoned', 'resolved'].includes(String(row.status))}<button class="min-h-11" disabled={busy} onclick={() => { begin(row); status = 'closed'; }}>Mark closed</button>{/if}
					{#if !isDeletedThread(row.closureReason)}<button class="min-h-11 text-red-400" disabled={busy} onclick={() => confirming = String(row.id)}>Delete thread</button>{/if}
				</div>
				{#if confirming === row.id}<p class="text-xs">Delete this thread? It will be hidden and its future beats cancelled. You can restore it from history.</p><button class="min-h-11 text-xs text-red-400" disabled={busy} onclick={() => { begin(row); status = 'deleted'; void save(); }}>Confirm deletion</button><button class="ml-4 min-h-11 text-xs" onclick={() => confirming = null}>Cancel deletion</button>{/if}
			{/if}
		</article>
	{:else}<p class="text-sm text-[var(--text-muted)]">No {showHistory ? '' : 'active '}story threads.</p>{/each}
</section>
