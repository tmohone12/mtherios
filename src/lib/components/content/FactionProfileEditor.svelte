<script lang="ts">
	import { onMount } from 'svelte';

	type Profile = { factionId: string; version: number; members: { id: string; name: string }[]; goals: string[]; resources: Record<string, number> };
	type Character = { id: string; name: string };
	let { gameId, factionId, disabled = false, onDirtyChange, onBusyChange, onSaved } = $props<{
		gameId: string; factionId: string; disabled?: boolean;
		onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void; onSaved: () => Promise<void>;
	}>();
	const kinds = ['military', 'wealth', 'influence', 'information', 'morale'] as const;
	let profile = $state<Profile | null>(null);
	let memberDraft = $state<Character[]>([]);
	let characters = $state<Character[]>([]);
	let search = $state('');
	let characterId = $state('');
	let goal = $state('');
	let resource = $state<(typeof kinds)[number]>('military');
	let amount = $state('');
	let busy = $state(false);
	let message = $state('');
	const membersChanged = $derived(Boolean(profile && (memberDraft.length !== profile.members.length || memberDraft.some(member => !profile?.members.some(saved => saved.id === member.id)))));
	const dirty = $derived(Boolean(membersChanged || characterId || goal.trim() || amount.trim()));
	$effect(() => onDirtyChange(dirty));
	$effect(() => onBusyChange(busy));

	async function command(name: string, args: Record<string, unknown> = {}) {
		const response = await fetch('/api/engine/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storyId: gameId, command: name, args }) });
		const body = await response.json();
		if (!response.ok || body.status !== 'succeeded') throw new Error(body.error ?? 'Faction request failed.');
		return body.result;
	}
	async function load() {
		busy = true;
		try {
			const loaded = await command('world.faction.profile.get', { factionId }) as Profile;
			profile = loaded;
			memberDraft = [...loaded.members];
			await findCharacters();
		} catch (error) { message = String(error); }
		finally { busy = false; }
	}
	async function findCharacters() {
		try {
			const result = await command('world.records', { type: 'characters', q: search.trim(), limit: 200 });
			characters = (result.records ?? []).map((row: Character) => ({ id: row.id, name: row.name }));
			if (characterId && !characters.some(row => row.id === characterId)) characterId = '';
		} catch (error) { message = String(error); }
	}
	function addMember() {
		const selected = characters.find(row => row.id === characterId);
		if (!selected || memberDraft.some(row => row.id === selected.id)) return;
		memberDraft = [...memberDraft, selected];
		characterId = '';
		message = 'Member added to draft. Save members to apply changes.';
	}
	function removeMember(id: string) {
		memberDraft = memberDraft.filter(row => row.id !== id);
		message = 'Member removed from draft. Save members to apply changes.';
	}
	async function saveMembers() {
		if (!profile || !membersChanged || busy || disabled) return;
		busy = true;
		message = '';
		try {
			const saved = await command('world.faction.profile.saveMembers', { factionId, expectedVersion: profile.version, characterIds: memberDraft.map(row => row.id) }) as Profile;
			profile = saved;
			memberDraft = [...saved.members];
			await onSaved();
			message = 'Members saved.';
		} catch (error) { message = String(error); }
		finally { busy = false; }
	}
	async function add(kind: 'goal' | 'resource') {
		if (!profile || busy || disabled) return;
		busy = true;
		message = '';
		try {
			const detail = kind === 'goal' ? { goal: goal.trim() } : { resource, amount: Number(amount) };
			profile = await command('world.faction.profile.add', { factionId, expectedVersion: profile.version, kind, ...detail });
			if (kind === 'goal') goal = ''; else amount = '';
			await onSaved();
			message = kind === 'goal' ? 'Goal added.' : 'Resource score saved.';
		} catch (error) { message = String(error); }
		finally { busy = false; }
	}
	onMount(() => { void load(); return () => { onDirtyChange(false); onBusyChange(false); }; });
</script>

<section aria-label="Faction details">
	<h4>Faction members, goals, and resources</h4>
	<p>These details feed faction decisions and background moves. Create characters in Canonical records, then select them here.</p>
	<p role="status">{busy ? 'Loading or saving…' : message}</p>
	{#if profile}
		<fieldset disabled={busy || disabled}>
			<h5>Members ({memberDraft.length})</h5>
			{#if memberDraft.length}<ul class="members">{#each memberDraft as member (member.id)}<li><span>{member.name}</span><button type="button" onclick={() => removeMember(member.id)} aria-label={`Remove ${member.name}`}>Remove</button></li>{/each}</ul>{:else}<p>No members selected.</p>{/if}
			<div class="row"><label>Find character<input bind:value={search} placeholder="Search this game's characters" /></label><button type="button" onclick={findCharacters}>Find</button></div>
			<div class="row"><label>Character<select bind:value={characterId}><option value="">Choose a character</option>{#each characters as character}<option value={character.id}>{character.name}</option>{/each}</select></label><button type="button" onclick={addMember} disabled={!characterId || memberDraft.some(member => member.id === characterId)}>Add member</button><button type="button" onclick={saveMembers} disabled={!membersChanged}>Save members</button></div>
			<h5>Goals</h5>
			{#if profile.goals.length}<ul>{#each profile.goals.slice(0, 30) as currentGoal}<li>{currentGoal}</li>{/each}</ul>{:else}<p>No goals yet.</p>{/if}
			<div class="row"><label class="grow">New goal<input bind:value={goal} maxlength="500" placeholder="What is this faction trying to achieve?" /></label><button type="button" onclick={() => add('goal')} disabled={!goal.trim()}>Add goal</button></div>
			<h5>Resource scores</h5>
			<p>Use 0–100 for the faction's military, wealth, influence, information, or morale. Unset scores keep the simulation's defaults.</p>
			<div class="row"><label>Resource<select bind:value={resource}>{#each kinds as kind}<option value={kind}>{kind} {profile.resources[kind] === undefined ? '— unset' : `— ${profile.resources[kind]}`}</option>{/each}</select></label><label>Score<input type="number" min="0" max="100" step="1" value={amount} oninput={event => amount = event.currentTarget.value} /></label><button type="button" onclick={() => add('resource')} disabled={amount.trim() === '' || !Number.isFinite(Number(amount)) || Number(amount) < 0 || Number(amount) > 100}>Save score</button></div>
		</fieldset>
	{/if}
</section>

<style>
	section { border: 1px solid var(--border-primary); border-radius: .4rem; padding: .8rem; margin: 1rem 0; }
	h4, h5 { margin: .6rem 0; } h5 { font-size: .9rem; }
	p, li { color: var(--text-secondary); font-size: .85rem; }
	ul { margin: .3rem 0 .8rem; padding-left: 1.25rem; }
	.members { list-style: none; padding-left: 0; max-height: 15rem; overflow: auto; }
	.members li { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin: .3rem 0; }
	fieldset { border: 0; padding: 0; min-width: 0; }
	.row { display: flex; flex-wrap: wrap; gap: .6rem; align-items: end; }
	label { display: grid; gap: .3rem; margin: .4rem 0; font-size: .85rem; }
	.grow { flex: 1 1 280px; }
	input, select, button { padding: .55rem .7rem; border: 1px solid var(--border-primary); border-radius: .35rem; background: var(--bg-secondary); color: inherit; max-width: 100%; }
	button { cursor: pointer; font-size: .8rem; } button:disabled { opacity: .5; }
</style>
