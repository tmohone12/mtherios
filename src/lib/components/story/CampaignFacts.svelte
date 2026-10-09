<script lang="ts">
	import { story } from '$lib/stores/story.svelte';
	import { sendEngineCommand } from '$lib/services/serverStories';
	let removing = $state<string | null>(null);
	let confirming = $state<string | null>(null);
	let error = $state('');

	async function removeFact(key: string, expectedSourceEntryId: string) {
		const storyId = story.currentStory?.serverStoryId;
		if (!storyId) return;
		removing = key;
		error = '';
		try {
			const response = await sendEngineCommand({ storyId, command: 'campaign.fact.remove', args: { key, expectedSourceEntryId } });
			if (response.status !== 'succeeded') throw new Error(response.error ?? 'Could not remove campaign fact.');
			await story.refreshCampaignProjection();
			confirming = null;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			removing = null;
		}
	}
</script>

<section aria-label="Campaign continuity brief">
	<h3 class="font-display text-xs uppercase text-[var(--text-accent)]">Campaign facts</h3>
	<p class="mt-1 text-xs text-[var(--text-muted)]">Durable state supplied to the GM before historical recall. Updated after state extraction; not shared NPC knowledge.</p>
	{#if error}<p role="alert" class="mt-2 text-xs text-rose-300">{error}</p>{/if}
	{#if story.currentStory?.campaignState?.length}
		<ul class="mt-3 space-y-3 text-sm">
			{#each story.currentStory.campaignState as fact (fact.key)}
				<li>
					<div class="flex items-start justify-between gap-2"><p>• {fact.statement}</p><button type="button" class="shrink-0 text-xs text-[var(--text-muted)] underline disabled:opacity-50" disabled={removing !== null} onclick={() => confirming = fact.key}>Remove</button></div>
					{#if confirming === fact.key}<div class="mt-1 flex items-center gap-2 text-xs"><span>Remove from the GM brief? The source history remains.</span><button type="button" class="underline" disabled={removing !== null} onclick={() => removeFact(fact.key, fact.sourceEntryId)}>{removing === fact.key ? 'Removing…' : 'Confirm'}</button><button type="button" class="underline" disabled={removing !== null} onclick={() => confirming = null}>Cancel</button></div>{/if}
					<details class="mt-1 text-xs text-[var(--text-muted)]">
						<summary class="cursor-pointer">Source · entry {fact.sourcePosition} · {fact.kind.replace('_', ' ')}</summary>
						<blockquote class="mt-1 whitespace-pre-wrap">{fact.evidence}</blockquote>
						<p class="break-all">{fact.sourceEntryId}</p>
					</details>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-xs text-[var(--text-muted)]">No campaign facts recorded yet. Major durable changes are collected from new canonical turns; older history is not automatically backfilled.</p>
	{/if}
</section>
