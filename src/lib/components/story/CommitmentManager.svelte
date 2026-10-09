<script lang="ts">
	import { onMount } from 'svelte';
	import { story } from '$lib/stores/story.svelte';
	import { fetchBackendCommitments } from '$lib/services/backendMemory';
	import { isCurrentAgreement } from '$lib/contracts/agreements';
	import CommitmentEditor from './CommitmentEditor.svelte';
	import type { Agreement, Scheme } from '$lib/types';
	let agreements = $state<(Agreement & { deleted: boolean })[]>([]);
	let schemes = $state<(Scheme & { deleted: boolean })[]>([]);
	let serverVersion = $state(0);
	let busy = $state(false);
	let error = $state('');
	let history = $state(false);
	let secrets = $state(false);
	let deleted = $state(false);
	async function refresh() {
		if (!story.currentStory) return;
		busy = true; error = '';
		try {
			const result = await fetchBackendCommitments(story.currentStory);
			agreements = result.agreements; schemes = result.schemes; serverVersion = result.serverVersion;
		} catch (e) { error = e instanceof Error ? e.message : String(e); }
		finally { busy = false; }
	}
	onMount(() => { void refresh(); });
	const visibleAgreements = $derived(agreements.filter(row => (secrets || row.secrecy !== 'secret') && (row.deleted ? deleted : history || isCurrentAgreement(row))));
	const visibleSchemes = $derived(schemes.filter(row => (secrets || row.secrecy !== 'secret') && (row.deleted ? deleted : history || !['resolved', 'foiled', 'abandoned'].includes(row.status))));
</script>

<section aria-label="Agreements and schemes" class="space-y-3">
	<div class="flex items-center justify-between"><h3 class="text-sm font-semibold">Agreements and schemes</h3><button class="min-h-11 text-xs text-[var(--text-accent)]" disabled={busy} onclick={refresh}>Refresh records</button></div>
	<label class="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" bind:checked={history} /> Show history and resolved records</label>
	<label class="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" bind:checked={secrets} /> Show secret records (author view)</label>
	<label class="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" bind:checked={deleted} /> Show deleted records</label>
	{#if error}<p role="alert" class="text-xs text-red-400">{error}</p>{/if}
	{#if busy}<p class="text-xs text-[var(--text-muted)]">Loading campaign records…</p>{/if}
	{#each visibleSchemes as scheme (scheme.id)}<article class="rounded-xl bg-[var(--bg-tertiary)] p-4"><p class="text-xs text-[var(--text-accent)]">Scheme · {scheme.ownerName}</p><h4 class="mt-1 text-sm">{scheme.goal}</h4><p class="text-xs text-[var(--text-muted)]">{scheme.deleted ? 'deleted' : scheme.status} · {scheme.pressure}% pressure · {scheme.secrecy}</p><CommitmentEditor {scheme} deleted={scheme.deleted} {serverVersion} onSaved={refresh} /></article>{/each}
	{#each visibleAgreements as agreement (agreement.id)}<article class="rounded-xl bg-[var(--bg-tertiary)] p-4"><p class="text-xs text-[var(--text-accent)]">{agreement.category} · {agreement.status} · {agreement.secrecy}</p><p class="mt-1 text-sm">{agreement.terms}</p><p class="text-xs text-[var(--text-muted)]">{agreement.parties.join(' · ')}</p><CommitmentEditor {agreement} deleted={agreement.deleted} {serverVersion} onSaved={refresh} /></article>{/each}
	{#if !busy && !error && !visibleAgreements.length && !visibleSchemes.length}<p class="text-xs text-[var(--text-muted)]">No records match these filters.</p>{/if}
</section>
