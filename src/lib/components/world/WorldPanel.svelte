<script lang="ts">
	import { Plus, X, Users, MapPin, Swords, Edit3, Trash2 } from 'lucide-svelte';
	import { getAllStories, getCharacters, getLocations, getItems,
		createCharacter, createLocation, createItem,
		updateCharacter, updateLocation, updateItem,
		deleteCharacter, deleteLocation, deleteItem } from '$lib/services/database';
	import type { Story, Character, Location, Item } from '$lib/types';
	import { onMount } from 'svelte';

	type Tab = 'characters' | 'locations' | 'items';

	let stories = $state<Story[]>([]);
	let selectedStoryId = $state<string | null>(null);
	let activeTab = $state<Tab>('characters');
	let characters = $state<Character[]>([]);
	let locations = $state<Location[]>([]);
	let items = $state<Item[]>([]);
	let showCreate = $state(false);

	// Create form
	let createName = $state('');
	let createDescription = $state('');
	let createExtra = $state(''); // relationship for chars, etc.

	onMount(async () => {
		stories = await getAllStories();
		if (stories.length > 0) {
			selectedStoryId = stories[0].id;
			await loadAll();
		}
	});

	async function loadAll() {
		if (!selectedStoryId) return;
		characters = await getCharacters(selectedStoryId);
		locations = await getLocations(selectedStoryId);
		items = await getItems(selectedStoryId);
	}

	async function handleCreate() {
		if (!selectedStoryId || !createName.trim()) return;
		const id = crypto.randomUUID();
		const branchId = null;

		if (activeTab === 'characters') {
			const char: Character = {
				id, storyId: selectedStoryId, branchId,
				name: createName.trim(),
				description: createDescription || null,
				traits: [],
				relationship: createExtra || 'neutral',
				status: 'active',
				metadata: null,
				visualDescriptors: {},
				portrait: null,
			};
			await createCharacter(char);
			characters = [...characters, char];
		} else if (activeTab === 'locations') {
			const loc: Location = {
				id, storyId: selectedStoryId, branchId,
				name: createName.trim(),
				description: createDescription || null,
				visited: false,
				current: false,
				connections: [],
				metadata: null,
			};
			await createLocation(loc);
			locations = [...locations, loc];
		} else {
			const item: Item = {
				id, storyId: selectedStoryId, branchId,
				name: createName.trim(),
				description: createDescription || null,
				quantity: 1,
				equipped: false,
				location: '',
				metadata: null,
			};
			await createItem(item);
			items = [...items, item];
		}

		createName = ''; createDescription = ''; createExtra = '';
		showCreate = false;
	}

	async function handleDeleteChar(id: string) { await deleteCharacter(id); characters = characters.filter(c => c.id !== id); }
	async function handleDeleteLoc(id: string) { await deleteLocation(id); locations = locations.filter(l => l.id !== id); }
	async function handleDeleteItem(id: string) { await deleteItem(id); items = items.filter(i => i.id !== id); }

	const tabs = [
		{ id: 'characters' as Tab, icon: Users, label: 'Characters', count: () => characters.length },
		{ id: 'locations' as Tab, icon: MapPin, label: 'Locations', count: () => locations.length },
		{ id: 'items' as Tab, icon: Swords, label: 'Items', count: () => items.length },
	];
</script>

<div class="flex h-full flex-col overflow-hidden">
	<!-- Header -->
	<div class="border-b border-[var(--border-primary)] px-4 py-4">
		<div class="flex items-center justify-between mb-3">
			<h2 class="font-display text-lg tracking-wide text-[var(--text-primary)]">World</h2>
			<button onclick={() => showCreate = !showCreate}
				class="flex items-center gap-1.5 rounded-lg bg-[rgba(212,168,83,0.12)] px-3 py-1.5 font-display text-xs tracking-wider uppercase text-[var(--text-accent)] hover:bg-[rgba(212,168,83,0.2)]">
				<Plus class="h-3.5 w-3.5" /> Add
			</button>
		</div>

		{#if stories.length > 1}
			<select bind:value={selectedStoryId} onchange={loadAll}
				class="mb-3 w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)]">
				{#each stories as s}
					<option value={s.id}>{s.title}</option>
				{/each}
			</select>
		{/if}

		<!-- Tabs -->
		<div class="flex gap-1 rounded-lg bg-[var(--bg-primary)] p-1">
			{#each tabs as tab}
				<button class="flex flex-1 items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium transition-all
					{activeTab === tab.id ? 'bg-[rgba(212,168,83,0.12)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
					onclick={() => activeTab = tab.id}>
					<tab.icon class="h-3.5 w-3.5" />
					{tab.label}
					{#if tab.count() > 0}
						<span class="ml-0.5 text-[10px] opacity-60">({tab.count()})</span>
					{/if}
				</button>
			{/each}
		</div>
	</div>

	<!-- Create form -->
	{#if showCreate}
		<div class="border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-4 space-y-3">
			<div class="flex items-center justify-between">
				<span class="font-display text-xs tracking-wider uppercase text-[var(--text-accent)]">
					New {activeTab === 'characters' ? 'Character' : activeTab === 'locations' ? 'Location' : 'Item'}
				</span>
				<button onclick={() => showCreate = false} class="text-[var(--text-muted)]"><X class="h-4 w-4" /></button>
			</div>
			<input type="text" bind:value={createName} placeholder="Name"
				class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
			<textarea bind:value={createDescription} placeholder="Description..." rows="3"
				class="w-full resize-none rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
			{#if activeTab === 'characters'}
				<input type="text" bind:value={createExtra} placeholder="Relationship (e.g. ally, rival, self)"
					class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
			{/if}
			<button onclick={handleCreate} disabled={!createName.trim() || !selectedStoryId}
				class="w-full rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] py-2.5 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] disabled:opacity-50">
				Create
			</button>
		</div>
	{/if}

	<!-- Content -->
	<div class="flex-1 overflow-y-auto px-4 py-3">
		{#if !selectedStoryId}
			<p class="py-10 text-center text-sm text-[var(--text-muted)]">Create a story first.</p>
		{:else if activeTab === 'characters'}
			{#if characters.length === 0}
				<p class="py-10 text-center text-sm text-[var(--text-muted)]">No characters yet.</p>
			{:else}
				<div class="space-y-2">
					{#each characters as char}
						<div class="group flex items-start gap-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
							<div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-primary)] text-sm">
								{char.relationship === 'self' ? '⭐' : '👤'}
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="font-display text-sm font-semibold text-[var(--text-primary)]">{char.name}</span>
									{#if char.relationship}
										<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">{char.relationship}</span>
									{/if}
									<span class="rounded bg-{char.status === 'active' ? 'emerald' : char.status === 'deceased' ? 'red' : 'gray'}-500/10 px-1.5 py-0.5 text-[10px] text-{char.status === 'active' ? 'emerald' : char.status === 'deceased' ? 'red' : 'gray'}-400">{char.status}</span>
								</div>
								{#if char.description}
									<p class="mt-1 text-xs text-[var(--text-muted)] line-clamp-2">{char.description}</p>
								{/if}
							</div>
							<button onclick={() => handleDeleteChar(char.id)} class="hidden shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-red-400 group-hover:block">
								<Trash2 class="h-3.5 w-3.5" />
							</button>
						</div>
					{/each}
				</div>
			{/if}
		{:else if activeTab === 'locations'}
			{#if locations.length === 0}
				<p class="py-10 text-center text-sm text-[var(--text-muted)]">No locations yet.</p>
			{:else}
				<div class="space-y-2">
					{#each locations as loc}
						<div class="group flex items-start gap-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
							<div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-primary)] text-sm">📍</div>
							<div class="flex-1 min-w-0">
								<span class="font-display text-sm font-semibold text-[var(--text-primary)]">{loc.name}</span>
								{#if loc.description}<p class="mt-1 text-xs text-[var(--text-muted)] line-clamp-2">{loc.description}</p>{/if}
							</div>
							<button onclick={() => handleDeleteLoc(loc.id)} class="hidden shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-red-400 group-hover:block">
								<Trash2 class="h-3.5 w-3.5" />
							</button>
						</div>
					{/each}
				</div>
			{/if}
		{:else}
			{#if items.length === 0}
				<p class="py-10 text-center text-sm text-[var(--text-muted)]">No items yet.</p>
			{:else}
				<div class="space-y-2">
					{#each items as item}
						<div class="group flex items-start gap-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
							<div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-primary)] text-sm">🗡️</div>
							<div class="flex-1 min-w-0">
								<span class="font-display text-sm font-semibold text-[var(--text-primary)]">{item.name}</span>
								{#if item.description}<p class="mt-1 text-xs text-[var(--text-muted)] line-clamp-2">{item.description}</p>{/if}
							</div>
							<button onclick={() => handleDeleteItem(item.id)} class="hidden shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-red-400 group-hover:block">
								<Trash2 class="h-3.5 w-3.5" />
							</button>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>
