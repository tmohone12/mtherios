<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { locationKindSchema, locationLoreSchema, type LocationLore, type LocationLoreContext } from '$lib/contracts/locationLore';
	import LocationMapEditor from './LocationMapEditor.svelte';
	type Row = Record<string, unknown>;
	type Fact = { id: string; title: string; statement: string; status: string; metadata: Row; sourceEntryIds: string[]; sourceEventIds: string[]; sourcePatchIds: string[] };
	type Workspace = { location: { id: string; name: string; state: Row }; storyVersion: number; currentTurn: number; context: LocationLoreContext; children: Array<{ id: string; name: string }>; nextCursor: string | null; ownFacts: Fact[] };
	let { locationId, gameId, runCommand, navigate, openSource, onDirty }: {
		locationId: string;
		gameId: string;
		runCommand: (command: string, args: Row) => Promise<Row>;
		navigate: (id: string) => void;
		openSource: (type: string, id: string) => void;
		onDirty: (dirty: boolean) => void;
	} = $props();
	let data = $state<Workspace | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let mapDirty = $state(false);
	let error = $state('');
	let editingHierarchy = $state(false);
	let kind = $state('');
	let parentId = $state<string | null>(null);
	let parentName = $state('');
	let parentQuery = $state('');
	let parentResults = $state<Row[]>([]);
	let searching = $state(false);
	let atTurn = $state<number | undefined>(undefined);
	let editor = $state<{ id?: string; title: string; statement: string; locationLore: LocationLore; validFromTurn: number; validToTurn: number | null } | null>(null);
	let alive = true;
	let request = 0;
	const dirty = $derived(editingHierarchy || editor !== null || saving || mapDirty);
	const orderedFacts = $derived([...(data?.context.facts ?? [])].sort((a, b) =>
		Number(b.lore.salience === 'core') - Number(a.lore.salience === 'core')
		|| Number(b.lore.origin === 'campaign') - Number(a.lore.origin === 'campaign')
		|| a.title.localeCompare(b.title)));
	$effect(() => onDirty(dirty));
	onDestroy(() => { alive = false; onDirty(false); });
	onMount(() => { void reload(); });

	async function reload(cursor?: string) {
		const sequence = ++request;
		loading = true; error = '';
		try {
			const result = await runCommand('world.location.get', { locationId, ...(atTurn !== undefined ? { atTurn } : {}), ...(cursor ? { cursor } : {}) });
			if (!alive || sequence !== request) return;
			const next = result as unknown as Workspace;
			if (cursor && data) next.children = [...data.children, ...next.children];
			data = next;
			kind = typeof next.location.state.locationKind === 'string' ? next.location.state.locationKind : '';
			const parent = next.context.chain.at(-2);
			parentId = parent?.id ?? null; parentName = parent?.name ?? '';
		} catch (caught) { if (alive && sequence === request) error = caught instanceof Error ? caught.message : String(caught); }
		finally { if (alive && sequence === request) loading = false; }
	}
	async function searchParents() {
		searching = true; error = '';
		const query = parentQuery;
		try {
			const result = await runCommand('world.records', { type: 'locations', q: query, limit: 30 });
			if (!alive || parentQuery !== query) return;
			parentResults = (Array.isArray(result.records) ? result.records as Row[] : []).filter(row => row.id !== locationId && row.status === 'active' && ['public', 'player_known'].includes(String(row.visibility)));
		} catch (caught) { if (alive) error = String(caught); }
		finally { if (alive) searching = false; }
	}
	async function save(updates: Row) {
		if (!data || saving) return;
		saving = true; error = '';
		try {
			await runCommand('world.location.save', { locationId, expectedVersion: data.storyVersion, ...updates });
			if (!alive) return;
			editingHierarchy = false; editor = null; parentResults = []; atTurn = undefined;
			await reload();
		} catch (caught) { if (alive) error = caught instanceof Error ? caught.message : String(caught); }
		finally { if (alive) saving = false; }
	}
	function editFact(fact?: Fact) {
		if (!data || saving) return;
		const parsed = locationLoreSchema.safeParse(fact?.metadata.locationLore);
		editor = { ...(fact ? { id: fact.id } : {}), title: fact?.title ?? '', statement: fact?.statement ?? '',
			locationLore: parsed.success ? parsed.data : { version: 1, category: 'identity', scope: 'descendants', origin: fact ? 'foundation' : 'campaign', salience: 'core', exceptionToFactIds: [] },
			validFromTurn: data.currentTurn, validToTurn: null };
	}
	function toggleException(id: string, checked: boolean) {
		if (!editor) return;
		editor.locationLore.exceptionToFactIds = checked ? [...new Set([...editor.locationLore.exceptionToFactIds, id])] : editor.locationLore.exceptionToFactIds.filter(value => value !== id);
	}
</script>

<section class="location-workspace" aria-label="Location lore and containing places">
	{#if error}<p role="alert" class="error">{error}</p>{/if}
	{#if loading && !data}<p>Loading this place and its lore…</p>{/if}
	{#if data}
		<nav aria-label="Containing places" class="breadcrumbs">
			{#each data.context.chain as place, index}
				{#if index > 0}<span aria-hidden="true">›</span>{/if}
				<button disabled={dirty || place.id === locationId} onclick={() => navigate(place.id)}>{place.name}</button>
			{/each}
		</nav>
		<div class="section-heading"><h3>How this place works</h3><button disabled={dirty || loading} onclick={() => editFact()}>Add lore</button></div>
		<div class="time-filter"><label>View at turn <input type="number" min="0" bind:value={atTurn} placeholder={String(data.currentTurn)} disabled={dirty} /></label><button disabled={dirty || loading} onclick={() => reload()}>View</button><button disabled={dirty || loading} onclick={() => { atTurn = undefined; void reload(); }}>Current</button></div>
		{#if data.context.atTurn !== data.currentTurn}<p class="note">Saved lore and containment at turn {data.context.atTurn}. The overview above is the current place record.</p>{/if}
		{#each data.context.warnings as warning}<p role="status" class="note">{warning}</p>{/each}
		{#if editor}
			<form onsubmit={(event) => { event.preventDefault(); if (editor) void save({ lore: editor }); }}>
				<h4>{editor.id ? 'Revise local lore' : 'Add local lore'}</h4>
				<p class="note">Saved on {data.location.name}. Earlier versions and their evidence remain in history.</p>
				<label>Title<input required maxlength="240" bind:value={editor.title} /></label>
				<label>Rule or established detail<textarea required rows="5" bind:value={editor.statement}></textarea></label>
				<div class="field-pair"><label>Category<select bind:value={editor.locationLore.category}>{#each locationLoreSchema.shape.category.options as category}<option value={category}>{category}</option>{/each}</select></label><label>Applies to<select bind:value={editor.locationLore.scope}><option value="descendants">This place and its sublocations</option><option value="self">This place only</option></select></label></div>
				<div class="field-pair"><label>Origin<select bind:value={editor.locationLore.origin}><option value="campaign">Established in this campaign</option><option value="foundation">Setting foundation</option></select></label><label>Importance<select bind:value={editor.locationLore.salience}><option value="core">Core to this place</option><option value="situational">Relevant in particular situations</option></select></label></div>
				<div class="field-pair"><label>Effective from turn<input required type="number" min="0" bind:value={editor.validFromTurn} /></label><label>Until turn (optional)<input type="number" min={editor.validFromTurn + 1} value={editor.validToTurn ?? ''} oninput={(event) => { if (editor) editor.validToTurn = event.currentTarget.value ? Number(event.currentTarget.value) : null; }} /></label></div>
				{#if data.context.facts.some(fact => fact.inherited)}<fieldset><legend>Explicit local exceptions (optional)</legend>{#each data.context.facts.filter(fact => fact.inherited) as fact}<label class="checkbox"><input type="checkbox" checked={editor.locationLore.exceptionToFactIds.includes(fact.id)} onchange={(event) => toggleException(fact.id, event.currentTarget.checked)} />{fact.title}</label>{/each}<p class="note">Describe the exception's conditions in the rule. An exception does not repeal the containing place's rule.</p></fieldset>{/if}
				<div class="actions"><button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save lore'}</button><button type="button" disabled={saving} onclick={() => { editor = null; }}>Cancel</button></div>
			</form>
		{/if}
		<div class="rules">
			{#each orderedFacts as fact}
				<article><div class="rule-meta">{fact.lore.category} · {fact.lore.origin === 'campaign' ? 'Campaign canon' : 'Setting foundation'}</div><h4>{fact.title}</h4><p>{fact.statement}</p>
					{#if fact.inherited}<p class="note">Inherited from {data.context.chain.find(place => place.id === fact.ownerId)?.name} · <button disabled={dirty} onclick={() => navigate(fact.ownerId)}>Open owner to edit</button></p>{:else}<button disabled={dirty || atTurn !== undefined} onclick={() => editFact(data?.ownFacts.find(row => row.id === fact.id))}>Revise</button>{/if}
					{#if fact.lore.exceptionToFactIds.length}<p class="note">Conditional local exception; keep its stated limits.</p>{/if}
					<details><summary>Evidence</summary><div class="actions">{#each fact.sourceEntryIds as id}<button disabled={dirty} onclick={() => openSource('transcript', id)}>Story source</button>{/each}{#each fact.sourceEventIds as id}<button disabled={dirty} onclick={() => openSource('events', id)}>Event source</button>{/each}{#each fact.sourcePatchIds as id}<button disabled={dirty} onclick={() => openSource('patches', id)}>Saved change</button>{/each}<button disabled={dirty} onclick={() => openSource('facts', fact.id)}>Full lore record</button></div></details>
				</article>
			{:else}<p class="note">This place's overview remains its lore foundation. Add scoped details here to carry its rules into sublocations.</p>{/each}
		</div>
		{#if data.ownFacts.some(fact => !fact.metadata.locationLore || fact.status !== 'active')}
			<details><summary>Existing lore and history</summary>{#each data.ownFacts.filter(fact => !fact.metadata.locationLore || fact.status !== 'active') as fact}<article><h4>{fact.title}</h4><p>{fact.statement}</p><p class="note">{fact.status === 'active' ? 'Existing lore — scope not yet assigned' : fact.status}</p><button disabled={dirty} onclick={() => openSource('facts', fact.id)}>Sources and record</button>{#if fact.status === 'active'}<button disabled={dirty || atTurn !== undefined} onclick={() => editFact(fact)}>Set scope</button>{/if}</article>{/each}</details>
		{/if}
		<div class="section-heading"><h3>Containing place</h3><button disabled={dirty || loading || atTurn !== undefined} onclick={() => { editingHierarchy = true; }}>Edit</button></div>
		{#if editingHierarchy}
			<form onsubmit={(event) => { event.preventDefault(); void save({ parentLocationId: parentId, ...(kind ? { locationKind: kind } : {}) }); }}>
				<label>Kind<select bind:value={kind}><option value="">Unspecified</option>{#each locationKindSchema.options as value}<option value={value}>{value}</option>{/each}</select></label>
				<p>Parent: {parentName || 'No containing place assigned'}</p>
				<div class="search"><label>Find parent<input bind:value={parentQuery} placeholder="Search locations" /></label><button type="button" disabled={searching} onclick={searchParents}>{searching ? 'Searching…' : 'Search'}</button></div>
				{#each parentResults as row}<button type="button" onclick={() => { parentId = String(row.id); parentName = String(row.name); parentResults = []; }}>{String(row.name)}</button>{/each}
				<div class="actions"><button type="button" onclick={() => { parentId = null; parentName = ''; }}>No parent</button><button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save place'}</button><button type="button" disabled={saving} onclick={() => { editingHierarchy = false; void reload(); }}>Cancel</button></div>
			</form>
		{:else}<p class="note">{parentName || 'No containing place assigned'}{kind ? ` · ${kind}` : ''}</p>{/if}
		<h3>Sublocations</h3><div class="children">{#each data.children as child}<button disabled={dirty} onclick={() => navigate(child.id)}>{child.name} <span aria-hidden="true">→</span></button>{:else}<p class="note">No linked sublocations.</p>{/each}</div>
		{#if data.nextCursor}<button disabled={loading || dirty} onclick={() => reload(data?.nextCursor ?? undefined)}>More sublocations</button>{/if}
		{#if !editingHierarchy && editor === null && !saving}<LocationMapEditor {locationId} {gameId} {runCommand} {navigate} onDirty={(value) => { mapDirty = value; }} />{/if}
	{/if}
</section>

<style>
	.location-workspace { margin-top: 1.5rem; border-top: 1px solid var(--border-default); padding-top: 1rem; color: var(--text-primary); }
	h3 { font-size: 1rem; font-weight: 650; margin: 1.3rem 0 .65rem; } h4 { font-size: .93rem; font-weight: 600; margin: .25rem 0; }
	p { font-size: .875rem; line-height: 1.6; white-space: pre-wrap; } .note, .rule-meta { color: var(--text-secondary); font-size: .78rem; } .rule-meta { text-transform: capitalize; }
	button { border: 1px solid var(--border-default); border-radius: .5rem; padding: .4rem .65rem; font-size: .78rem; background: var(--bg-tertiary); color: var(--text-primary); cursor: pointer; }
	button:disabled { opacity: .5; cursor: default; } button:hover:not(:disabled) { border-color: var(--text-accent); }
	.breadcrumbs, .actions, .time-filter, .section-heading, .search { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; } .section-heading { justify-content: space-between; } .section-heading h3 { margin-bottom: .5rem; }
	.breadcrumbs button { border: 0; padding: .15rem 0; background: transparent; } .breadcrumbs { font-size: .85rem; }
	article { padding: 1rem 0; border-bottom: 1px solid var(--border-default); } article p { margin: .4rem 0; } details { margin-top: .65rem; font-size: .8rem; } summary { cursor: pointer; color: var(--text-secondary); }
	form { padding: 1rem; border: 1px solid var(--border-default); border-radius: .75rem; margin: .8rem 0; } label { display: flex; flex-direction: column; gap: .3rem; font-size: .8rem; margin-bottom: .7rem; }
	input, select, textarea { min-width: 0; width: 100%; padding: .55rem; border: 1px solid var(--border-default); border-radius: .45rem; background: var(--bg-secondary); color: var(--text-primary); font: inherit; } textarea { resize: vertical; }
	.field-pair { display: grid; grid-template-columns: 1fr 1fr; gap: .7rem; } .time-filter input { width: 7rem; } .time-filter label { margin: 0; flex-direction: row; align-items: center; }
	.checkbox { flex-direction: row; align-items: center; } .checkbox input { width: auto; } fieldset { border: 1px solid var(--border-default); padding: .6rem; margin: .5rem 0; } legend { font-size: .8rem; }
	.children { display: grid; gap: .4rem; } .children button { display: flex; justify-content: space-between; text-align: left; padding: .7rem; } .error { color: var(--text-danger, #e78779); }
	@media (max-width: 520px) { .field-pair { grid-template-columns: 1fr; } form { padding: .65rem; } }
</style>
