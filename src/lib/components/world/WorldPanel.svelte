<script lang="ts">
	import { Plus, X, Users, MapPin, Swords, Edit3, Trash2, Check, BookOpen, ChevronDown, ChevronRight, Brain, Zap, Eye, Settings2, Loader2 } from 'lucide-svelte';
	import { uuid } from '$lib/utils/uuid';
	import { getAllStories, getCharacters, getLocations, getItems, getChapters, getStoryEntries,
		createCharacter, createLocation, createItem, createChapter,
		updateCharacter, updateLocation, updateItem,
		deleteCharacter, deleteLocation, deleteItem } from '$lib/services/database';
	import { ai } from '$lib/services/ai';
	import { settings } from '$lib/stores/settings.svelte';
	import { story } from '$lib/stores/story.svelte';
	import type { Story, Character, Location, Item, Chapter, StoryEntry } from '$lib/types';
	import { onMount } from 'svelte';

	type Tab = 'characters' | 'locations' | 'items' | 'memory';

	let stories = $state<Story[]>([]);
	let selectedStoryId = $state<string | null>(null);
	let activeTab = $state<Tab>('characters');
	let characters = $state<Character[]>([]);
	let locations = $state<Location[]>([]);
	let items = $state<Item[]>([]);
	let chapters = $state<Chapter[]>([]);
	let expandedChapter = $state<string | null>(null);
	let showCreate = $state(false);

	// Memory agent state
	let creatingChapter = $state(false);
	let chapterStatus = $state('');

	// Manual chapter creation
	let showManualChapter = $state(false);
	let manualTitle = $state('');
	let manualSummary = $state('');
	let manualCharacters = $state('');
	let manualLocations = $state('');

	// Context viewer
	let showContext = $state(false);
	let contextPreview = $state('');
	let contextEntryCount = $state(10);
	let contextMaxTokens = $state(4096);

	// Create form
	let createName = $state('');
	let createDescription = $state('');
	let createExtra = $state(''); // relationship for chars, etc.

	// Edit state — only one entity can be edited at a time
	let editingCharId = $state<string | null>(null);
	let editingLocId = $state<string | null>(null);
	let editingItemId = $state<string | null>(null);

	// Character edit fields
	let editCharName = $state('');
	let editCharDescription = $state('');
	let editCharRelationship = $state('');
	let editCharStatus = $state<'active' | 'inactive' | 'deceased'>('active');
	let editCharTraits = $state('');

	// Location edit fields
	let editLocName = $state('');
	let editLocDescription = $state('');
	let editLocCurrent = $state(false);
	let editLocVisited = $state(false);

	// Item edit fields
	let editItemName = $state('');
	let editItemDescription = $state('');
	let editItemQuantity = $state(1);
	let editItemEquipped = $state(false);
	let editItemLocation = $state('');

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
		chapters = (await getChapters(selectedStoryId)).sort((a, b) => a.number - b.number);
	}

	function toggleChapter(id: string) {
		expandedChapter = expandedChapter === id ? null : id;
	}

	// ── Memory Agent Triggers ──

	async function forceCreateChapter() {
		if (!selectedStoryId || creatingChapter) return;
		creatingChapter = true;
		chapterStatus = 'Loading entries...';
		try {
			const allEntries = await getStoryEntries(selectedStoryId);
			const existingChapters = await getChapters(selectedStoryId);

			const lastChapterEndIndex = existingChapters.length > 0
				? allEntries.findIndex(e => e.id === existingChapters[existingChapters.length - 1].endEntryId) + 1
				: 0;

			const entriesOutsideChapter = allEntries.slice(lastChapterEndIndex);
			if (entriesOutsideChapter.length < 4) {
				chapterStatus = 'Not enough entries to create a chapter (need at least 4).';
				creatingChapter = false;
				return;
			}

			chapterStatus = 'Analyzing chapter boundary...';
			const tokensOutside = entriesOutsideChapter.reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0);

			const storyObj = stories.find(s => s.id === selectedStoryId);
			const mode = storyObj?.mode ?? 'adventure';
			const pov = storyObj?.settings?.pov ?? 'second';
			const tense = storyObj?.settings?.tense ?? 'present';

			chapterStatus = 'Summarizing chapter...';
			const summaryResult = await ai.memory.summarizeChapter(
				entriesOutsideChapter,
				existingChapters,
				mode, pov, tense,
			);

			const chapter: Chapter = {
				id: uuid(),
				storyId: selectedStoryId,
				number: existingChapters.length + 1,
				title: summaryResult.title,
				startEntryId: entriesOutsideChapter[0].id,
				endEntryId: entriesOutsideChapter[entriesOutsideChapter.length - 1].id,
				entryCount: entriesOutsideChapter.length,
				summary: summaryResult.summary,
				startTime: null,
				endTime: null,
				keywords: summaryResult.keywords,
				characters: summaryResult.keyCharacters,
				locations: summaryResult.keyLocations,
				plotThreads: [],
				emotionalTone: summaryResult.emotionalTone,
				branchId: null,
				createdAt: Date.now(),
			};

			await createChapter(chapter);
			chapters = [...chapters, chapter];
			// Advance history floor — chapter summary carries context, keep last 10 entries in chat
			story.chatHistoryFloor = Math.max(story.chatHistoryFloor, story.entries.length - 10);
			chapterStatus = `Chapter ${chapter.number}: "${chapter.title}" created!`;
		} catch (e) {
			console.error('Force chapter creation failed:', e);
			chapterStatus = `Failed: ${e instanceof Error ? e.message : String(e)}`;
		}
		creatingChapter = false;
	}

	async function createManualChapter() {
		if (!selectedStoryId || !manualSummary.trim()) return;
		creatingChapter = true;
		chapterStatus = 'Creating manual chapter...';
		try {
			const existingChapters = await getChapters(selectedStoryId);
			const allEntries = await getStoryEntries(selectedStoryId);

			// Use the last entry as a boundary anchor, or a sentinel if no entries exist
			const lastEntry = allEntries.length > 0 ? allEntries[allEntries.length - 1] : null;
			const anchorId = lastEntry?.id ?? 'manual';

			const chapter: Chapter = {
				id: uuid(),
				storyId: selectedStoryId,
				number: existingChapters.length + 1,
				title: manualTitle.trim() || null,
				startEntryId: anchorId,
				endEntryId: anchorId,
				entryCount: 0,
				summary: manualSummary.trim(),
				startTime: null,
				endTime: null,
				keywords: [],
				characters: manualCharacters.trim() ? manualCharacters.split(',').map(s => s.trim()).filter(Boolean) : [],
				locations: manualLocations.trim() ? manualLocations.split(',').map(s => s.trim()).filter(Boolean) : [],
				plotThreads: [],
				emotionalTone: null,
				branchId: null,
				createdAt: Date.now(),
			};

			await createChapter(chapter);
			chapters = [...chapters, chapter];
			// Advance history floor — chapter summary carries context, keep last 10 entries in chat
			story.chatHistoryFloor = Math.max(story.chatHistoryFloor, story.entries.length - 10);
			chapterStatus = `Manual chapter ${chapter.number}: "${chapter.title ?? 'Untitled'}" created!`;

			// Reset form
			manualTitle = '';
			manualSummary = '';
			manualCharacters = '';
			manualLocations = '';
			showManualChapter = false;
		} catch (e) {
			console.error('Manual chapter creation failed:', e);
			chapterStatus = `Failed: ${e instanceof Error ? e.message : String(e)}`;
		}
		creatingChapter = false;
	}

	// ── Context Viewer ──

	function buildContextPreview() {
		if (story.currentStory) {
			contextPreview = story.buildSystemPrompt();
		} else if (selectedStoryId) {
			contextPreview = '(Load a story in the Library tab to see context preview)';
		}
	}

	async function handleCreate() {
		if (!selectedStoryId || !createName.trim()) return;
		const id = uuid();
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

	// --- Edit helpers ---

	function startEditChar(char: Character) {
		cancelAllEdits();
		editingCharId = char.id;
		editCharName = char.name;
		editCharDescription = char.description ?? '';
		editCharRelationship = char.relationship ?? '';
		editCharStatus = char.status;
		editCharTraits = (char.traits ?? []).join(', ');
	}

	function startEditLoc(loc: Location) {
		cancelAllEdits();
		editingLocId = loc.id;
		editLocName = loc.name;
		editLocDescription = loc.description ?? '';
		editLocCurrent = loc.current;
		editLocVisited = loc.visited;
	}

	function startEditItem(item: Item) {
		cancelAllEdits();
		editingItemId = item.id;
		editItemName = item.name;
		editItemDescription = item.description ?? '';
		editItemQuantity = item.quantity;
		editItemEquipped = item.equipped;
		editItemLocation = item.location ?? '';
	}

	function cancelAllEdits() {
		editingCharId = null;
		editingLocId = null;
		editingItemId = null;
	}

	async function saveChar() {
		if (!editingCharId || !editCharName.trim()) return;
		const idx = characters.findIndex(c => c.id === editingCharId);
		if (idx === -1) return;

		const traitsArray = editCharTraits
			.split(',')
			.map(t => t.trim())
			.filter(t => t.length > 0);

		const updated: Character = {
			...characters[idx],
			name: editCharName.trim(),
			description: editCharDescription.trim() || null,
			relationship: editCharRelationship.trim() || null,
			status: editCharStatus,
			traits: traitsArray,
		};

		await updateCharacter(editingCharId, { name: updated.name, description: updated.description, relationship: updated.relationship, status: updated.status, traits: updated.traits });
		characters = characters.map(c => c.id === editingCharId ? updated : c);
		editingCharId = null;
	}

	async function saveLoc() {
		if (!editingLocId || !editLocName.trim()) return;
		const idx = locations.findIndex(l => l.id === editingLocId);
		if (idx === -1) return;

		const updated: Location = {
			...locations[idx],
			name: editLocName.trim(),
			description: editLocDescription.trim() || null,
			current: editLocCurrent,
			visited: editLocVisited,
		};

		await updateLocation(editingLocId, { name: updated.name, description: updated.description, current: updated.current, visited: updated.visited });
		locations = locations.map(l => l.id === editingLocId ? updated : l);
		editingLocId = null;
	}

	async function saveItem() {
		if (!editingItemId || !editItemName.trim()) return;
		const idx = items.findIndex(i => i.id === editingItemId);
		if (idx === -1) return;

		const updated: Item = {
			...items[idx],
			name: editItemName.trim(),
			description: editItemDescription.trim() || null,
			quantity: editItemQuantity,
			equipped: editItemEquipped,
			location: editItemLocation.trim(),
		};

		await updateItem(editingItemId, { name: updated.name, description: updated.description, quantity: updated.quantity, equipped: updated.equipped, location: updated.location });
		items = items.map(i => i.id === editingItemId ? updated : i);
		editingItemId = null;
	}

	const tabs = [
		{ id: 'characters' as Tab, icon: Users, label: 'Chars', count: () => characters.length },
		{ id: 'locations' as Tab, icon: MapPin, label: 'Locs', count: () => locations.length },
		{ id: 'items' as Tab, icon: Swords, label: 'Items', count: () => items.length },
		{ id: 'memory' as Tab, icon: BookOpen, label: 'Memory', count: () => chapters.length },
	];

	const inputClass = 'w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none';
</script>

<div class="flex h-full flex-col overflow-hidden">
	<!-- Header (compact) -->
	<div class="border-b border-[var(--border-primary)] px-4 py-3">
		<div class="flex items-center justify-between">
			<h2 class="font-display text-lg tracking-wide text-[var(--text-primary)]">World</h2>
			{#if activeTab !== 'memory'}
				<button onclick={() => showCreate = !showCreate}
					class="flex items-center gap-1.5 rounded-lg bg-[rgba(212,168,83,0.12)] px-3 py-1.5 font-display text-xs tracking-wider uppercase text-[var(--text-accent)] hover:bg-[rgba(212,168,83,0.2)]">
					<Plus class="h-3.5 w-3.5" /> Add
				</button>
			{/if}
		</div>

		{#if stories.length > 1}
			<select bind:value={selectedStoryId} onchange={loadAll}
				class="mt-2 w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)]">
				{#each stories as s}
					<option value={s.id}>{s.title}</option>
				{/each}
			</select>
		{/if}
	</div>

	<!-- Create form -->
	{#if showCreate && activeTab !== 'memory'}
		<div class="border-b border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-4 space-y-3">
			<div class="flex items-center justify-between">
				<span class="font-display text-xs tracking-wider uppercase text-[var(--text-accent)]">
					New {activeTab === 'characters' ? 'Character' : activeTab === 'locations' ? 'Location' : 'Item'}
				</span>
				<button onclick={() => showCreate = false} class="text-[var(--text-muted)]"><X class="h-4 w-4" /></button>
			</div>
			<input type="text" bind:value={createName} placeholder="Name"
				class={inputClass} />
			<textarea bind:value={createDescription} placeholder="Description..." rows="3"
				class="{inputClass} resize-none"></textarea>
			{#if activeTab === 'characters'}
				<input type="text" bind:value={createExtra} placeholder="Relationship (e.g. ally, rival, self)"
					class={inputClass} />
			{/if}
			<button onclick={handleCreate} disabled={!createName.trim() || !selectedStoryId}
				class="w-full rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] py-2.5 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] disabled:opacity-50">
				Create
			</button>
		</div>
	{/if}

	<!-- Content (scrollable) -->
	<div class="flex-1 overflow-y-auto px-4 py-3">
		{#if !selectedStoryId}
			<p class="py-10 text-center text-sm text-[var(--text-muted)]">Create a story first.</p>

		<!-- ======================== CHARACTERS ======================== -->
		{:else if activeTab === 'characters'}
			{#if characters.length === 0}
				<p class="py-10 text-center text-sm text-[var(--text-muted)]">No characters yet.</p>
			{:else}
				<div class="space-y-2">
					{#each characters as char}
						{#if editingCharId === char.id}
							<!-- Inline edit form -->
							<div class="rounded-xl border-2 border-[var(--color-gold-600)] bg-[var(--bg-tertiary)] p-4 space-y-3">
								<div class="flex items-center justify-between">
									<span class="font-display text-xs tracking-wider uppercase text-[var(--text-accent)]">Edit Character</span>
									<button onclick={cancelAllEdits} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X class="h-4 w-4" /></button>
								</div>
								<input type="text" bind:value={editCharName} placeholder="Name" class={inputClass} />
								<textarea bind:value={editCharDescription} placeholder="Description..." rows="3"
									class="{inputClass} resize-none"></textarea>
								<input type="text" bind:value={editCharRelationship} placeholder="Relationship (e.g. ally, rival, self)"
									class={inputClass} />
								<div>
									<label class="mb-1 block text-xs text-[var(--text-muted)]">Status</label>
									<select bind:value={editCharStatus}
										class="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none">
										<option value="active">Active</option>
										<option value="inactive">Inactive</option>
										<option value="deceased">Deceased</option>
									</select>
								</div>
								<div>
									<label class="mb-1 block text-xs text-[var(--text-muted)]">Traits (comma-separated)</label>
									<input type="text" bind:value={editCharTraits} placeholder="brave, clever, loyal"
										class={inputClass} />
								</div>
								<div class="flex gap-2 pt-1">
									<button onclick={saveChar} disabled={!editCharName.trim()}
										class="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] py-2 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] disabled:opacity-50">
										<Check class="h-3.5 w-3.5" /> Save
									</button>
									<button onclick={cancelAllEdits}
										class="flex-1 rounded-lg border border-[var(--border-primary)] py-2 font-display text-sm tracking-wide text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-secondary)]">
										Cancel
									</button>
								</div>
							</div>
						{:else}
							<!-- Character card (read-only) -->
							<div
								role="button" tabindex="0"
								onclick={() => startEditChar(char)}
								onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') startEditChar(char); }}
								class="group flex w-full items-start gap-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-left transition-colors hover:border-[var(--color-gold-600)]/40 cursor-pointer">
								<div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-primary)] text-sm">
									{char.relationship === 'self' ? '⭐' : '👤'}
								</div>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 flex-wrap">
										<span class="font-display text-sm font-semibold text-[var(--text-primary)]">{char.name}</span>
										{#if char.relationship}
											<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">{char.relationship}</span>
										{/if}
										<span class="rounded bg-{char.status === 'active' ? 'emerald' : char.status === 'deceased' ? 'red' : 'gray'}-500/10 px-1.5 py-0.5 text-[10px] text-{char.status === 'active' ? 'emerald' : char.status === 'deceased' ? 'red' : 'gray'}-400">{char.status}</span>
									</div>
									{#if char.traits && char.traits.length > 0}
										<div class="mt-1 flex flex-wrap gap-1">
											{#each char.traits as trait}
												<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">{trait}</span>
											{/each}
										</div>
									{/if}
									{#if char.description}
										<p class="mt-1 text-xs text-[var(--text-muted)] line-clamp-2">{char.description}</p>
									{/if}
								</div>
								<div class="flex shrink-0 items-center gap-1">
									<span class="block rounded p-1 text-[var(--text-muted)] opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
										<Edit3 class="h-3.5 w-3.5" />
									</span>
									<button
										type="button"
										onclick={(e: MouseEvent) => { e.stopPropagation(); handleDeleteChar(char.id); }}
										class="block shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-red-400 opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
										<Trash2 class="h-3.5 w-3.5" />
									</button>
								</div>
							</div>
						{/if}
					{/each}
				</div>
			{/if}

		<!-- ======================== LOCATIONS ======================== -->
		{:else if activeTab === 'locations'}
			{#if locations.length === 0}
				<p class="py-10 text-center text-sm text-[var(--text-muted)]">No locations yet.</p>
			{:else}
				<div class="space-y-2">
					{#each locations as loc}
						{#if editingLocId === loc.id}
							<!-- Inline edit form -->
							<div class="rounded-xl border-2 border-[var(--color-gold-600)] bg-[var(--bg-tertiary)] p-4 space-y-3">
								<div class="flex items-center justify-between">
									<span class="font-display text-xs tracking-wider uppercase text-[var(--text-accent)]">Edit Location</span>
									<button onclick={cancelAllEdits} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X class="h-4 w-4" /></button>
								</div>
								<input type="text" bind:value={editLocName} placeholder="Name" class={inputClass} />
								<textarea bind:value={editLocDescription} placeholder="Description..." rows="3"
									class="{inputClass} resize-none"></textarea>
								<div class="flex gap-4">
									<label class="flex items-center gap-2 text-sm text-[var(--text-primary)] cursor-pointer">
										<input type="checkbox" bind:checked={editLocCurrent}
											class="h-4 w-4 rounded border-[var(--border-secondary)] bg-[var(--bg-primary)] accent-[var(--color-gold-600)]" />
										Current
									</label>
									<label class="flex items-center gap-2 text-sm text-[var(--text-primary)] cursor-pointer">
										<input type="checkbox" bind:checked={editLocVisited}
											class="h-4 w-4 rounded border-[var(--border-secondary)] bg-[var(--bg-primary)] accent-[var(--color-gold-600)]" />
										Visited
									</label>
								</div>
								<div class="flex gap-2 pt-1">
									<button onclick={saveLoc} disabled={!editLocName.trim()}
										class="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] py-2 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] disabled:opacity-50">
										<Check class="h-3.5 w-3.5" /> Save
									</button>
									<button onclick={cancelAllEdits}
										class="flex-1 rounded-lg border border-[var(--border-primary)] py-2 font-display text-sm tracking-wide text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-secondary)]">
										Cancel
									</button>
								</div>
							</div>
						{:else}
							<!-- Location card (read-only) -->
							<div role="button" tabindex="0"
								onclick={() => startEditLoc(loc)}
								class="group flex w-full items-start gap-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-left transition-colors hover:border-[var(--color-gold-600)]/40 cursor-pointer">
								<div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-primary)] text-sm">📍</div>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 flex-wrap">
										<span class="font-display text-sm font-semibold text-[var(--text-primary)]">{loc.name}</span>
										{#if loc.current}
											<span class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">current</span>
										{/if}
										{#if loc.visited}
											<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">visited</span>
										{/if}
									</div>
									{#if loc.description}
										<p class="mt-1 text-xs text-[var(--text-muted)] line-clamp-2">{loc.description}</p>
									{/if}
								</div>
								<div class="flex shrink-0 items-center gap-1">
									<span class="block rounded p-1 text-[var(--text-muted)] opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
										<Edit3 class="h-3.5 w-3.5" />
									</span>
									<button
										type="button"
										onclick={(e: MouseEvent) => { e.stopPropagation(); handleDeleteLoc(loc.id); }}
										class="block shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-red-400 opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
										<Trash2 class="h-3.5 w-3.5" />
									</button>
								</div>
							</div>
						{/if}
					{/each}
				</div>
			{/if}

		<!-- ======================== ITEMS ======================== -->
		{:else if activeTab === 'items'}
			{#if items.length === 0}
				<p class="py-10 text-center text-sm text-[var(--text-muted)]">No items yet.</p>
			{:else}
				<div class="space-y-2">
					{#each items as item}
						{#if editingItemId === item.id}
							<!-- Inline edit form -->
							<div class="rounded-xl border-2 border-[var(--color-gold-600)] bg-[var(--bg-tertiary)] p-4 space-y-3">
								<div class="flex items-center justify-between">
									<span class="font-display text-xs tracking-wider uppercase text-[var(--text-accent)]">Edit Item</span>
									<button onclick={cancelAllEdits} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X class="h-4 w-4" /></button>
								</div>
								<input type="text" bind:value={editItemName} placeholder="Name" class={inputClass} />
								<textarea bind:value={editItemDescription} placeholder="Description..." rows="3"
									class="{inputClass} resize-none"></textarea>
								<div class="grid grid-cols-2 gap-3">
									<div>
										<label class="mb-1 block text-xs text-[var(--text-muted)]">Quantity</label>
										<input type="number" bind:value={editItemQuantity} min="0"
											class={inputClass} />
									</div>
									<div>
										<label class="mb-1 block text-xs text-[var(--text-muted)]">Location</label>
										<input type="text" bind:value={editItemLocation} placeholder="e.g. inventory, chest"
											class={inputClass} />
									</div>
								</div>
								<label class="flex items-center gap-2 text-sm text-[var(--text-primary)] cursor-pointer">
									<input type="checkbox" bind:checked={editItemEquipped}
										class="h-4 w-4 rounded border-[var(--border-secondary)] bg-[var(--bg-primary)] accent-[var(--color-gold-600)]" />
									Equipped
								</label>
								<div class="flex gap-2 pt-1">
									<button onclick={saveItem} disabled={!editItemName.trim()}
										class="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] py-2 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] disabled:opacity-50">
										<Check class="h-3.5 w-3.5" /> Save
									</button>
									<button onclick={cancelAllEdits}
										class="flex-1 rounded-lg border border-[var(--border-primary)] py-2 font-display text-sm tracking-wide text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-secondary)]">
										Cancel
									</button>
								</div>
							</div>
						{:else}
							<!-- Item card (read-only) -->
							<div role="button" tabindex="0"
								onclick={() => startEditItem(item)}
								class="group flex w-full items-start gap-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-left transition-colors hover:border-[var(--color-gold-600)]/40 cursor-pointer">
								<div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-primary)] text-sm">🗡️</div>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 flex-wrap">
										<span class="font-display text-sm font-semibold text-[var(--text-primary)]">{item.name}</span>
										{#if item.quantity > 1}
											<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">x{item.quantity}</span>
										{/if}
										{#if item.equipped}
											<span class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">equipped</span>
										{/if}
										{#if item.location}
											<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">{item.location}</span>
										{/if}
									</div>
									{#if item.description}
										<p class="mt-1 text-xs text-[var(--text-muted)] line-clamp-2">{item.description}</p>
									{/if}
								</div>
								<div class="flex shrink-0 items-center gap-1">
									<span class="block rounded p-1 text-[var(--text-muted)] opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
										<Edit3 class="h-3.5 w-3.5" />
									</span>
									<button
										type="button"
										onclick={(e: MouseEvent) => { e.stopPropagation(); handleDeleteItem(item.id); }}
										class="block shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-red-400 opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
										<Trash2 class="h-3.5 w-3.5" />
									</button>
								</div>
							</div>
						{/if}
					{/each}
				</div>
			{/if}

		<!-- ======================== MEMORY / CHAPTERS ======================== -->
		{:else}
			<!-- Agent Actions -->
			<div class="mb-4 space-y-2">
				<div class="flex gap-2">
					<button onclick={forceCreateChapter} disabled={creatingChapter || !selectedStoryId}
						class="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/5 py-2.5 text-xs font-medium text-rose-400 hover:bg-rose-500/10 disabled:opacity-40 transition-colors">
						{#if creatingChapter}
							<Loader2 class="h-3.5 w-3.5 animate-spin" />
						{:else}
							<Zap class="h-3.5 w-3.5" />
						{/if}
						AI Chapter
					</button>
					<button onclick={() => { showManualChapter = !showManualChapter; }}
						disabled={!selectedStoryId}
						class="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 py-2.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40 transition-colors">
						<Edit3 class="h-3.5 w-3.5" />
						Manual Chapter
					</button>
					<button onclick={() => { showContext = !showContext; if (showContext) buildContextPreview(); }}
						class="flex items-center justify-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2.5 text-xs font-medium text-blue-400 hover:bg-blue-500/10 transition-colors"
						title="View AI Context">
						<Eye class="h-3.5 w-3.5" />
					</button>
				</div>

				{#if chapterStatus}
					<div class="rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-muted)]">
						{chapterStatus}
					</div>
				{/if}

				<!-- Manual Chapter Form -->
				{#if showManualChapter}
					<div class="rounded-xl border border-emerald-500/20 bg-[var(--bg-tertiary)] overflow-hidden">
						<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-3 py-2">
							<div class="flex items-center gap-2">
								<Edit3 class="h-3.5 w-3.5 text-emerald-400" />
								<span class="font-display text-xs tracking-wider uppercase text-emerald-400">Manual Chapter</span>
							</div>
							<button onclick={() => showManualChapter = false} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
								<X class="h-3.5 w-3.5" />
							</button>
						</div>
						<div class="px-3 py-3 space-y-3">
							<div>
								<label class="block text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Title</label>
								<input type="text" bind:value={manualTitle} placeholder="e.g. The Fall of Ashenmere"
									class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-emerald-500/50 focus:outline-none" />
							</div>
							<div>
								<label class="block text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Summary / Timeline</label>
								<textarea bind:value={manualSummary} rows="6" placeholder="Paste your condensed timeline or chapter summary here..."
									class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-emerald-500/50 focus:outline-none resize-y" ></textarea>
							</div>
							<div class="grid grid-cols-2 gap-2">
								<div>
									<label class="block text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Characters (comma-separated)</label>
									<input type="text" bind:value={manualCharacters} placeholder="Kael, Lirien, Thorne"
										class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-emerald-500/50 focus:outline-none" />
								</div>
								<div>
									<label class="block text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Locations (comma-separated)</label>
									<input type="text" bind:value={manualLocations} placeholder="Ashenmere, The Hollow"
										class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-emerald-500/50 focus:outline-none" />
								</div>
							</div>
							<button onclick={createManualChapter}
								disabled={creatingChapter || !manualSummary.trim()}
								class="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 py-2.5 text-xs font-medium text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-40 transition-colors">
								{#if creatingChapter}
									<Loader2 class="h-3.5 w-3.5 animate-spin" />
								{:else}
									<Check class="h-3.5 w-3.5" />
								{/if}
								Create Chapter
							</button>
						</div>
					</div>
				{/if}
			</div>

			<!-- Context Viewer -->
			{#if showContext}
				<div class="mb-4 rounded-xl border border-blue-500/20 bg-[var(--bg-tertiary)] overflow-hidden">
					<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-3 py-2">
						<div class="flex items-center gap-2">
							<Eye class="h-3.5 w-3.5 text-blue-400" />
							<span class="font-display text-xs tracking-wider uppercase text-blue-400">AI Context</span>
						</div>
						<button onclick={() => showContext = false} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
							<X class="h-3.5 w-3.5" />
						</button>
					</div>

					<!-- Context Size Controls -->
					<div class="border-b border-[var(--border-primary)] px-3 py-2.5 space-y-2">
						<div class="flex items-center gap-3">
							<div class="flex-1">
								<label class="block text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Recent Entries</label>
								<div class="flex items-center gap-2">
									<input type="range" bind:value={contextEntryCount} min="3" max="30" step="1"
										class="flex-1 h-1 accent-blue-500" />
									<span class="text-xs font-mono text-blue-400 w-6 text-right">{contextEntryCount}</span>
								</div>
							</div>
							<div class="flex-1">
								<label class="block text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Max Tokens</label>
								<div class="flex items-center gap-2">
									<input type="range" bind:value={contextMaxTokens} min="1024" max="16384" step="512"
										class="flex-1 h-1 accent-blue-500" />
									<span class="text-xs font-mono text-blue-400 w-10 text-right">{(contextMaxTokens / 1024).toFixed(1)}k</span>
								</div>
							</div>
						</div>
					</div>

					<!-- Context Preview -->
					<div class="max-h-64 overflow-y-auto px-3 py-2">
						{#if contextPreview}
							<pre class="whitespace-pre-wrap text-[10px] leading-relaxed text-[var(--text-muted)] font-mono">{contextPreview}</pre>
						{:else}
							<p class="text-xs text-[var(--text-muted)]">Open a story to see context preview.</p>
						{/if}
					</div>

					<!-- Stats -->
					<div class="border-t border-[var(--border-primary)] px-3 py-2 flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
						<span>~{Math.ceil(contextPreview.length / 4).toLocaleString()} tokens</span>
						<span>{contextPreview.split('\n').length} lines</span>
						{#if story.lastWorldSimResult}
							<span class="text-rose-400">+ world ctx</span>
							{#if story.lastWorldSimResult.factionActions?.length > 0}
								<span class="text-amber-400">+ factions ({story.lastWorldSimResult.factionActions.filter(a => a.actionType !== 'none').length} active)</span>
							{/if}
						{/if}
					</div>
				</div>
			{/if}

			<!-- Chapters list -->
			{#if chapters.length === 0}
				<div class="py-8 text-center">
					<div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(212,168,83,0.1)]">
						<BookOpen class="h-6 w-6 text-[var(--text-accent)]" />
					</div>
					<p class="text-sm text-[var(--text-muted)]">No chapters yet.</p>
					<p class="mt-1 text-xs text-[var(--text-muted)]">Auto-created every ~20 messages, or use the button above.</p>
				</div>
			{:else}
				<div class="space-y-2">
					{#each chapters as chapter}
						<div class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] overflow-hidden transition-colors
							{expandedChapter === chapter.id ? 'border-rose-500/30' : 'hover:border-[var(--color-gold-600)]/40'}">
							<!-- Chapter header -->
							<button
								class="flex w-full items-center gap-3 p-3 text-left"
								onclick={() => toggleChapter(chapter.id)}
							>
								<div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-500/10">
									{#if expandedChapter === chapter.id}
										<ChevronDown class="h-4 w-4 text-rose-400" />
									{:else}
										<ChevronRight class="h-4 w-4 text-rose-400" />
									{/if}
								</div>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 flex-wrap">
										<span class="rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-bold text-rose-400">CH.{chapter.number}</span>
										<span class="font-display text-sm font-semibold text-[var(--text-primary)] truncate">{chapter.title ?? 'Untitled'}</span>
									</div>
									{#if !expandedChapter || expandedChapter !== chapter.id}
										<p class="mt-0.5 text-xs text-[var(--text-muted)] line-clamp-1">{chapter.summary}</p>
									{/if}
								</div>
							</button>

							<!-- Expanded content -->
							{#if expandedChapter === chapter.id}
								<div class="border-t border-[var(--border-primary)] px-4 py-3 space-y-3">
									<p class="text-xs leading-relaxed text-[var(--text-muted)]">{chapter.summary}</p>

									{#if chapter.emotionalTone}
										<div class="flex items-center gap-2">
											<span class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Tone</span>
											<span class="rounded bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-400">{chapter.emotionalTone}</span>
										</div>
									{/if}

									{#if chapter.characters.length > 0}
										<div>
											<span class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Characters</span>
											<div class="mt-1 flex flex-wrap gap-1">
												{#each chapter.characters as name}
													<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-primary)]">{name}</span>
												{/each}
											</div>
										</div>
									{/if}

									{#if chapter.locations.length > 0}
										<div>
											<span class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Locations</span>
											<div class="mt-1 flex flex-wrap gap-1">
												{#each chapter.locations as loc}
													<span class="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-400">{loc}</span>
												{/each}
											</div>
										</div>
									{/if}

									{#if chapter.keywords.length > 0}
										<div>
											<span class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Keywords</span>
											<div class="mt-1 flex flex-wrap gap-1">
												{#each chapter.keywords as kw}
													<span class="rounded bg-[var(--bg-primary)] px-1 py-0.5 text-[9px] italic text-[var(--text-muted)]">{kw}</span>
												{/each}
											</div>
										</div>
									{/if}

									<div class="flex items-center gap-3 pt-1 text-[10px] text-[var(--text-muted)]">
										<span>{chapter.entryCount} entries</span>
										<span>{new Date(chapter.createdAt).toLocaleDateString()}</span>
									</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>

	<!-- ======================== FLOATING TAB BAR ======================== -->
	<div class="border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 py-2">
		<div class="flex gap-1 rounded-lg bg-[var(--bg-primary)] p-1">
			{#each tabs as tab}
				<button class="flex flex-1 items-center justify-center gap-1 rounded-md py-2.5 text-xs font-medium transition-all
					{activeTab === tab.id ? 'bg-[rgba(212,168,83,0.12)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
					onclick={() => { activeTab = tab.id; cancelAllEdits(); showCreate = false; }}>
					<tab.icon class="h-3.5 w-3.5" />
					<span class="hidden sm:inline">{tab.label}</span>
					{#if tab.count() > 0}
						<span class="text-[10px] opacity-60">{tab.count()}</span>
					{/if}
				</button>
			{/each}
		</div>
	</div>
</div>
