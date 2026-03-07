<script lang="ts">
	import { Plus, X, Search, ChevronDown, Upload, Edit3, Trash2, Save } from 'lucide-svelte';
	import { getAllStories, getLorebookEntries, createLorebookEntry, updateLorebookEntry, deleteLorebookEntry } from '$lib/services/database';
	import LorebookImport from './LorebookImport.svelte';
	import type { Story, Entry, EntryType } from '$lib/types';
	import { onMount } from 'svelte';

	let stories = $state<Story[]>([]);
	let selectedStoryId = $state<string | null>(null);
	let entries = $state<Entry[]>([]);
	let showCreate = $state(false);
	let showImport = $state(false);
	let editingId = $state<string | null>(null);
	let searchQuery = $state('');

	// Create form
	let newName = $state('');
	let newType = $state<EntryType>('concept');
	let newDescription = $state('');
	let newKeywords = $state('');

	// Edit form
	let editName = $state('');
	let editDescription = $state('');
	let editKeywords = $state('');

	const typeIcons: Record<string, string> = {
		character: '👤', location: '📍', item: '🗡️',
		faction: '🏴', concept: '💡', event: '📅',
	};

	const entryTypes: EntryType[] = ['character', 'location', 'item', 'faction', 'concept', 'event'];

	onMount(async () => {
		stories = await getAllStories();
		if (stories.length > 0) {
			selectedStoryId = stories[0].id;
			await loadEntries();
		}
	});

	async function loadEntries() {
		if (!selectedStoryId) { entries = []; return; }
		entries = await getLorebookEntries(selectedStoryId);
	}

	const filtered = $derived(
		searchQuery
			? entries.filter(e =>
				e.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
				e.description.toLowerCase().includes(searchQuery.toLowerCase()))
			: entries
	);

	async function handleCreate() {
		if (!selectedStoryId || !newName.trim()) return;
		const now = Date.now();
		const entry: Entry = {
			id: crypto.randomUUID(),
			storyId: selectedStoryId,
			branchId: null,
			name: newName.trim(),
			type: newType,
			description: newDescription,
			hiddenInfo: null,
			aliases: [],
			state: buildDefaultState(newType),
			adventureState: null,
			creativeState: null,
			injection: {
				mode: 'keyword',
				keywords: newKeywords.split(',').map(k => k.trim()).filter(Boolean),
				priority: 100,
			},
			firstMentioned: null,
			lastMentioned: null,
			mentionCount: 0,
			createdBy: 'user',
			createdAt: now,
			updatedAt: now,
			loreManagementBlacklisted: false,
		};
		await createLorebookEntry(entry);
		entries = [...entries, entry];
		resetCreate();
	}

	function resetCreate() {
		showCreate = false;
		newName = ''; newType = 'concept'; newDescription = ''; newKeywords = '';
	}

	function startEdit(entry: Entry) {
		editingId = entry.id;
		editName = entry.name;
		editDescription = entry.description;
		editKeywords = entry.injection.keywords.join(', ');
	}

	async function saveEdit() {
		if (!editingId) return;
		await updateLorebookEntry(editingId, {
			name: editName,
			description: editDescription,
			injection: { mode: 'keyword', keywords: editKeywords.split(',').map(k => k.trim()).filter(Boolean), priority: 100 },
			updatedAt: Date.now(),
		});
		entries = entries.map(e => e.id === editingId ? { ...e, name: editName, description: editDescription, injection: { ...e.injection, keywords: editKeywords.split(',').map(k => k.trim()).filter(Boolean) } } : e);
		editingId = null;
	}

	async function handleDelete(id: string) {
		await deleteLorebookEntry(id);
		entries = entries.filter(e => e.id !== id);
	}

	function buildDefaultState(type: EntryType): Entry['state'] {
		switch (type) {
			case 'character': return { type: 'character', isPresent: false, lastSeenLocation: null, currentDisposition: null, relationship: { level: 0, status: 'unknown', history: [] }, knownFacts: [], revealedSecrets: [] };
			case 'location': return { type: 'location', isCurrentLocation: false, visitCount: 0, changes: [], presentCharacters: [], presentItems: [] };
			case 'item': return { type: 'item', inInventory: false, currentLocation: null, condition: null, uses: [] };
			case 'faction': return { type: 'faction', playerStanding: 0, status: 'unknown', knownMembers: [] };
			case 'event': return { type: 'event', occurred: false, occurredAt: null, witnesses: [], consequences: [] };
			default: return { type: 'concept', revealed: false, comprehensionLevel: 'unknown', relatedEntries: [] };
		}
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<!-- Header -->
	<div class="border-b border-[var(--border-primary)] px-4 py-4">
		<div class="flex items-center justify-between mb-3">
			<h2 class="font-display text-lg tracking-wide text-[var(--text-primary)]">Lorebook</h2>
			<div class="flex gap-2">
				<button onclick={() => showImport = !showImport}
					class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-accent)] hover:bg-[rgba(212,168,83,0.08)]">
					<Upload class="h-3.5 w-3.5" /> Import
				</button>
				<button onclick={() => showCreate = !showCreate}
					class="flex items-center gap-1.5 rounded-lg bg-[rgba(212,168,83,0.12)] px-3 py-1.5 font-display text-xs tracking-wider uppercase text-[var(--text-accent)] hover:bg-[rgba(212,168,83,0.2)]">
					<Plus class="h-3.5 w-3.5" /> Add
				</button>
			</div>
		</div>

		<!-- Story selector -->
		{#if stories.length > 1}
			<select bind:value={selectedStoryId} onchange={loadEntries}
				class="mb-3 w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)]">
				{#each stories as s}
					<option value={s.id}>{s.title}</option>
				{/each}
			</select>
		{/if}

		<!-- Search -->
		<div class="relative">
			<Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
			<input type="text" bind:value={searchQuery} placeholder="Search entries..."
				class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] py-2 pl-9 pr-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
		</div>
	</div>

	<!-- Import section -->
	{#if showImport && selectedStoryId}
		<div class="border-b border-[var(--border-primary)] px-4 py-4">
			<LorebookImport storyId={selectedStoryId} onImported={() => { showImport = false; loadEntries(); }} />
		</div>
	{/if}

	<!-- Create form -->
	{#if showCreate}
		<div class="border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-4 space-y-3">
			<div class="flex items-center justify-between">
				<span class="font-display text-xs tracking-wider uppercase text-[var(--text-accent)]">New Entry</span>
				<button onclick={resetCreate} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X class="h-4 w-4" /></button>
			</div>
			<input type="text" bind:value={newName} placeholder="Entry name"
				class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
			<div class="flex flex-wrap gap-1.5">
				{#each entryTypes as t}
					<button class="flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-all
						{newType === t ? 'bg-[rgba(212,168,83,0.15)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
						onclick={() => newType = t}>
						<span>{typeIcons[t]}</span> <span class="capitalize">{t}</span>
					</button>
				{/each}
			</div>
			<textarea bind:value={newDescription} placeholder="Description..." rows="3"
				class="w-full resize-none rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
			<input type="text" bind:value={newKeywords} placeholder="Keywords (comma separated)"
				class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
			<button onclick={handleCreate} disabled={!newName.trim() || !selectedStoryId}
				class="w-full rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] py-2.5 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] disabled:opacity-50">
				Create Entry
			</button>
		</div>
	{/if}

	<!-- Entry list -->
	<div class="flex-1 overflow-y-auto px-4 py-3">
		{#if !selectedStoryId}
			<p class="py-10 text-center text-sm text-[var(--text-muted)]">Create a story first to add lore entries.</p>
		{:else if filtered.length === 0}
			<p class="py-10 text-center text-sm text-[var(--text-muted)]">{searchQuery ? 'No matches.' : 'No entries yet. Add one above.'}</p>
		{:else}
			<div class="space-y-2">
				{#each filtered as entry}
					{#if editingId === entry.id}
						<!-- Editing -->
						<div class="space-y-2 rounded-xl border border-[var(--color-gold-600)]/30 bg-[var(--bg-tertiary)] p-3">
							<input type="text" bind:value={editName} class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none" />
							<textarea bind:value={editDescription} rows="3" class="w-full resize-none rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none"></textarea>
							<input type="text" bind:value={editKeywords} class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-1.5 font-mono text-xs text-[var(--text-primary)] focus:outline-none" />
							<div class="flex gap-2">
								<button onclick={saveEdit} class="flex-1 rounded-lg bg-[rgba(212,168,83,0.15)] py-1.5 text-xs text-[var(--text-accent)]">Save</button>
								<button onclick={() => editingId = null} class="flex-1 rounded-lg bg-[var(--bg-primary)] py-1.5 text-xs text-[var(--text-muted)]">Cancel</button>
							</div>
						</div>
					{:else}
						<!-- Display -->
						<div class="group rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
							<div class="flex items-start justify-between">
								<div class="flex items-center gap-2">
									<span class="text-sm">{typeIcons[entry.type] ?? '📄'}</span>
									<span class="font-display text-sm font-semibold text-[var(--text-primary)]">{entry.name}</span>
									<span class="rounded-md bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] capitalize text-[var(--text-muted)]">{entry.type}</span>
								</div>
								<div class="hidden items-center gap-1 group-hover:flex">
									<button onclick={() => startEdit(entry)} class="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-accent)]"><Edit3 class="h-3.5 w-3.5" /></button>
									<button onclick={() => handleDelete(entry.id)} class="rounded p-1 text-[var(--text-muted)] hover:text-red-400"><Trash2 class="h-3.5 w-3.5" /></button>
								</div>
							</div>
							{#if entry.description}
								<p class="mt-1.5 text-xs leading-relaxed text-[var(--text-muted)] line-clamp-2">{entry.description}</p>
							{/if}
							{#if entry.injection.keywords.length > 0}
								<div class="mt-2 flex flex-wrap gap-1">
									{#each entry.injection.keywords.slice(0, 5) as kw}
										<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">{kw}</span>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
</div>
