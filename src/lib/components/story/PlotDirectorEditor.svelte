<script lang="ts">
	import { story } from '$lib/stores/story.svelte';
	import { saveBackendPlotEdit, retireBackendPlot } from '$lib/services/backendMemory';
	import { strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
	import type { StrategicWorldFrame } from '$lib/types';
	import { normalizeStrategicFrameActivations } from '$lib/services/ai/context/strategicFramePromptCard';
	let { applied, pending, pendingFresh }: { applied: StrategicWorldFrame | null; pending: StrategicWorldFrame | null; pendingFresh: boolean } = $props();
	let draft = $state<StrategicWorldFrame | null>(null);
	let target = $state<'applied' | 'pending'>('applied');
	let version = $state(0);
	let frameId = $state('');
	let busy = $state(false);
	let error = $state('');
	let success = $state('');
	let confirmRetire = $state(false);
	let advanced = $state<string | null>(null);
	function begin(which: 'applied' | 'pending') {
		const frame = which === 'pending' ? pending : applied;
		if (!frame) return;
		draft = normalizeStrategicFrameActivations(structuredClone($state.snapshot(frame))); target = which; frameId = frame.id;
		version = Number(story.campaignProjection?.story.serverVersion); error = ''; success = ''; advanced = null;
	}
	async function save(retire = false) {
		if (!story.currentStory) return;
		busy = true; error = ''; success = '';
		try {
			if (retire) await retireBackendPlot(story.currentStory, Number(story.campaignProjection?.story.serverVersion));
			else {
				const frame = strategicWorldFrameSchema.parse(advanced === null ? $state.snapshot(draft) : JSON.parse(advanced));
				await saveBackendPlotEdit(story.currentStory, { target, serverVersion: version, frameId, frame });
			}
			await story.pullBackendProjection(); draft = null; confirmRetire = false;
			success = retire ? 'Director pressure retired. Automatic planning is quiet for five turns.' : target === 'pending' ? 'Draft saved. Apply it separately when ready.' : 'Applied guidance saved. Previous future Director beats cancelled; no past events changed.';
		} catch (e) { error = e instanceof Error ? e.message : String(e); }
		finally { busy = false; }
	}
</script>

<section class="space-y-3 rounded-xl border border-[var(--border-primary)] p-3" aria-label="Edit Plot Director">
	<div class="flex flex-wrap gap-4 text-xs">
		{#if applied}<button class="min-h-11 text-[var(--text-accent)]" disabled={busy} onclick={() => begin('applied')}>Edit applied guidance</button>{/if}
		{#if pending}<button class="min-h-11 text-[var(--text-accent)]" disabled={busy || !pendingFresh} onclick={() => begin('pending')}>Edit pending draft</button>{/if}
		{#if applied || pending}<button class="min-h-11 text-red-400" disabled={busy} onclick={() => confirmRetire = true}>Retire Director pressure</button>{/if}
	</div>
	{#if confirmRetire}<p class="text-xs">Retire current pressure, discard the pending draft, close its active threads, and cancel future Director events? Past events remain unchanged.</p><button class="min-h-11 text-xs text-red-400" disabled={busy} onclick={() => save(true)}>Confirm retirement</button><button class="ml-4 min-h-11 text-xs" disabled={busy} onclick={() => confirmRetire = false}>Cancel retirement</button>{/if}
	{#if error}<p role="alert" class="text-xs text-red-400">{error}</p>{/if}
	{#if success}<p role="status" class="text-xs text-[var(--text-accent)]">{success}</p>{/if}
	{#if draft}
		<p class="text-xs text-[var(--text-muted)]">Editing {target} guidance. {target === 'applied' ? 'Saving cancels old scheduled Director beats; it does not replay a write plan, revive retired pressure, or reset freshness.' : 'Saving does not activate the draft.'}</p>
		{#if advanced === null}
			<label class="block text-xs">Public summary<textarea class="mt-1 w-full rounded bg-[var(--bg-primary)] p-2 text-sm" rows="3" bind:value={draft.publicSummary}></textarea></label>
			<label class="block text-xs">Hidden strategy<textarea class="mt-1 w-full rounded bg-[var(--bg-primary)] p-2 text-sm" rows="3" bind:value={draft.hiddenStrategicSummary}></textarea></label>
			{#each draft.plotCards as card (card.id)}
				<div class="space-y-2 rounded-lg bg-[var(--bg-primary)] p-3">
					<label class="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={draft.activationPlan.activateNow.includes(card.id)} onchange={(event) => { if (draft) draft.activationPlan.activateNow = event.currentTarget.checked ? [...draft.activationPlan.activateNow, card.id] : draft.activationPlan.activateNow.filter(id => id !== card.id); }} /> Active spotlight</label>
					<label class="block text-xs">Plot title<input class="mt-1 w-full rounded bg-[var(--bg-secondary)] p-2 text-sm" bind:value={card.title} /></label>
					<label class="block text-xs">Plot guidance<textarea class="mt-1 w-full rounded bg-[var(--bg-secondary)] p-2 text-sm" rows="4" bind:value={card.logline}></textarea></label>
					<label class="block text-xs">Plot lifecycle<select class="ml-2 rounded bg-[var(--bg-secondary)] p-2" bind:value={card.lifecycleStage}><option value="seed">Seed</option><option value="simmer">Simmer</option><option value="reveal">Reveal</option><option value="escalate">Escalate</option><option value="crisis">Crisis</option><option value="fallout">Fallout</option><option value="resolved">Closed / resolved</option><option value="dormant">Dormant</option></select></label>
					<button class="min-h-11 text-xs text-red-400" onclick={() => { if (draft) { draft.activationPlan.activateNow = draft.activationPlan.activateNow.filter(id => id !== card.id && id !== card.title); draft.plotCards = draft.plotCards.filter(row => row.id !== card.id); } }}>Remove plot from draft</button>
				</div>
			{/each}
			<button class="min-h-11 text-xs text-[var(--text-accent)]" onclick={() => advanced = JSON.stringify($state.snapshot(draft), null, 2)}>Advanced: edit full Director JSON</button>
		{:else}
			<label class="block text-xs">Full Director frame (validated on save)<textarea class="mt-1 w-full rounded bg-[var(--bg-primary)] p-2 font-mono text-xs" rows="22" bind:value={advanced}></textarea></label>
		{/if}
		<div class="flex gap-4"><button class="min-h-11 text-sm text-[var(--text-accent)]" disabled={busy} onclick={() => save()}>{busy ? 'Saving…' : 'Save Director edits'}</button><button class="min-h-11 text-sm" disabled={busy} onclick={() => draft = null}>Cancel edits</button></div>
	{/if}
</section>
