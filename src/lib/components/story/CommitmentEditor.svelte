<script lang="ts">
	import { story } from '$lib/stores/story.svelte';
	import { saveBackendPlotEdit } from '$lib/services/backendMemory';
	import { AGREEMENT_STATUSES } from '$lib/contracts/agreements';
	import type { PlotEdit } from '$lib/contracts/plotEditing';
	import type { Agreement, Scheme } from '$lib/types';
	let { agreement, scheme, deleted = false, serverVersion, onSaved }: { agreement?: Agreement; scheme?: Scheme; deleted?: boolean; serverVersion: number; onSaved: () => Promise<void> } = $props();
	let confirmingDelete = $state(false);
	let draft = $state<Extract<PlotEdit, { target: 'agreement' | 'scheme' }> | null>(null);
	let parties = $state('');
	let consequences = $state('');
	let stagesJson = $state<string | null>(null);
	let busy = $state(false);
	let error = $state('');
	let saved = $state(false);
	async function changeDeletion(action: 'delete' | 'restore') {
		if (!story.currentStory || (!agreement && !scheme)) return;
		busy = true; error = ''; saved = false;
		try {
			await saveBackendPlotEdit(story.currentStory, { target: 'commitment', kind: agreement ? 'agreement' : 'scheme', recordId: (agreement ?? scheme)!.id, action, serverVersion });
			await story.pullBackendProjection(); await onSaved(); confirmingDelete = false; draft = null;
		} catch (e) { error = e instanceof Error ? e.message : String(e); }
		finally { busy = false; }
	}
	function begin() {
		if (agreement) {
			const { id: recordId, terms, category, status, secrecy } = agreement;
			parties = agreement.parties.join('\n'); consequences = agreement.consequences.join('\n');
			draft = { target: 'agreement', serverVersion, recordId, terms, category, status, secrecy, parties: [...agreement.parties], consequences: [...agreement.consequences] };
		} else if (scheme) {
			const { id: recordId, goal, trigger, status, secrecy, pressure, currentStageIndex } = scheme;
			draft = { target: 'scheme', serverVersion, recordId, goal, trigger, status, secrecy, pressure, currentStageIndex, stages: structuredClone($state.snapshot(scheme.stages)) };
		}
		error = ''; saved = false; stagesJson = null;
	}
	async function save() {
		if (!draft || !story.currentStory) return;
		busy = true; error = '';
		try {
			const edit = $state.snapshot(draft);
			if (edit.target === 'agreement') {
				edit.parties = parties.split('\n').map(s => s.trim()).filter(Boolean);
				edit.consequences = consequences.split('\n').map(s => s.trim()).filter(Boolean);
			} else if (stagesJson !== null) edit.stages = JSON.parse(stagesJson);
			await saveBackendPlotEdit(story.currentStory, edit);
			await story.pullBackendProjection(); await onSaved(); draft = null; saved = true;
		} catch (e) { error = e instanceof Error ? e.message : String(e); }
		finally { busy = false; }
	}
</script>

<div class="commitment-editor mt-2">
	{#if deleted}
		<p class="text-xs text-[var(--text-muted)]">Deleted from current context. Historical transcript text is unchanged.</p>
		<button disabled={busy} class="min-h-11 text-xs text-[var(--text-accent)]" onclick={() => changeDeletion('restore')}>Restore {agreement ? 'agreement' : 'scheme'}</button>
	{:else if !draft}
		<button disabled={busy} class="min-h-11 text-xs text-[var(--text-accent)]" onclick={begin}>Edit {agreement ? 'agreement' : 'scheme'}</button>
		<button disabled={busy} class="ml-4 min-h-11 text-xs text-red-400" onclick={() => confirmingDelete = true}>Delete {agreement ? 'agreement' : 'scheme'}</button>
	{/if}
	{#if confirmingDelete && !deleted}
		<p class="text-xs">Delete this record from current context and remove explicitly linked Director pressure? You can restore the record from deleted records; cancelled events will not restart.</p>
		<button disabled={busy} class="min-h-11 text-xs text-red-400" onclick={() => changeDeletion('delete')}>Confirm deletion</button>
		<button disabled={busy} class="ml-4 min-h-11 text-xs" onclick={() => confirmingDelete = false}>Keep record</button>
	{/if}
	{#if saved}<p role="status" class="text-xs text-[var(--text-accent)]">Saved to campaign records.</p>{/if}
	{#if error}<p role="alert" class="text-xs text-red-400">{error}</p>{/if}
	{#if draft}
		<fieldset class="space-y-3" disabled={busy}>
			<legend class="text-sm font-semibold">Edit {draft.target}</legend>
			{#if draft.target === 'agreement'}
				<label>Agreement terms<textarea rows="4" bind:value={draft.terms}></textarea></label>
				<label>Parties (one per line)<textarea rows="3" bind:value={parties}></textarea></label>
				<label>Category<select bind:value={draft.category}>{#each ['treaty','pact','alliance','oath','debt','promise','marriage','bond','contract','vassalage','bargain-with-entity'] as category}<option value={category}>{category}</option>{/each}</select></label>
				<label>Agreement status<select bind:value={draft.status}>{#each AGREEMENT_STATUSES as status}<option value={status}>{status}</option>{/each}</select></label>
				<label>Agreement visibility<select bind:value={draft.secrecy}><option>public</option><option>known</option><option>secret</option></select></label>
				<label>Consequences (one per line)<textarea rows="3" bind:value={consequences}></textarea></label>
				<p class="text-xs text-[var(--text-muted)]">Only active and contested agreements remain current obligations. Other statuses preserve them as history.</p>
			{:else}
				<label>Scheme goal<textarea rows="3" bind:value={draft.goal}></textarea></label>
				<label>Scheme trigger<textarea rows="2" bind:value={draft.trigger}></textarea></label>
				<label>Scheme status<select bind:value={draft.status}>{#each ['incubating','active','climaxing','resolved','foiled','abandoned'] as status}<option value={status}>{status}</option>{/each}</select></label>
				<label>Scheme visibility<select bind:value={draft.secrecy}><option>secret</option><option>rumored</option><option>known</option></select></label>
				<label>Pressure (0–100)<input type="number" min="0" max="100" bind:value={draft.pressure} /></label>
				<label>Current stage<select bind:value={draft.currentStageIndex}>{#each draft.stages as stage, index}<option value={index}>{index + 1}: {stage.label}</option>{/each}</select></label>
				{#if stagesJson === null}
					{#each draft.stages as stage, index}
						<div class="rounded-lg bg-[var(--bg-primary)] p-2">
							<label>Stage {index + 1} label<input bind:value={stage.label} /></label>
							<label>Stage {index + 1} hook<textarea rows="2" bind:value={stage.hook}></textarea></label>
							<label class="flex items-center gap-2"><input type="checkbox" checked={stage.completed} onchange={event => { stage.completed = event.currentTarget.checked; stage.completedAt = stage.completed ? Date.now() : null; }} /> Completed</label>
						</div>
					{/each}
					<button class="min-h-11 text-xs text-[var(--text-accent)]" onclick={() => { if (draft?.target === 'scheme') stagesJson = JSON.stringify($state.snapshot(draft.stages), null, 2); }}>Advanced: edit stages and conditions</button>
				{:else}<label>Stages JSON (including trigger conditions)<textarea rows="12" bind:value={stagesJson}></textarea></label>{/if}
				<p class="text-xs text-[var(--text-muted)]">Saving updates the linked story thread and removes its old Director pressure. Resolved, foiled and abandoned schemes stop being active.</p>
			{/if}
			<div class="flex gap-4"><button class="min-h-11 text-sm text-[var(--text-accent)]" onclick={save}>{busy ? 'Saving…' : 'Save changes'}</button><button class="min-h-11 text-sm" onclick={() => draft = null}>Cancel changes</button></div>
		</fieldset>
	{/if}
</div>

<style>
	label { display: block; font-size: 0.75rem; }
	textarea, select, input:not([type='checkbox']) { display: block; width: 100%; margin-top: 0.25rem; padding: 0.5rem; border-radius: 0.4rem; background: var(--bg-primary); color: var(--text-primary); font-size: 0.875rem; }
</style>
