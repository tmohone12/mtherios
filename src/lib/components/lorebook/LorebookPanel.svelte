<script lang="ts">
	import { Plus, X, Search, Upload, Trash2, Sparkles, Loader2, List, LayoutList, Stethoscope } from 'lucide-svelte';
	import { getAllStories, getLorebookEntries, createLorebookEntry, updateLorebookEntry, deleteLorebookEntry, getEntryRelationships, getChapters } from '$lib/services/database';
	import { uuid } from '$lib/utils/uuid';
	import { ai } from '$lib/services/ai';
	import { story } from '$lib/stores/story.svelte';
	import LorebookImport from './LorebookImport.svelte';
	import SeedImport from './SeedImport.svelte';
	import EntryDetailModal from './EntryDetailModal.svelte';
	import WikiLintReport from './WikiLintReport.svelte';
	import type { Story, Entry, EntryType } from '$lib/types';
	import type { WikiLintResult } from '$lib/services/ai/sdk/schemas/wikiLint';
	import { onMount } from 'svelte';

	let stories = $state<Story[]>([]);
	let selectedStoryId = $state<string | null>(null);
	let entries = $state<Entry[]>([]);
	let showCreate = $state(false);
	let showImport = $state(false);
	let showSeedImport = $state(false);
	let searchQuery = $state('');
	let typeFilter = $state<EntryType | 'all'>('all');
	let sourceFilter = $state<'all' | 'user' | 'ai' | 'import'>('all');
	let viewMode = $state<'list' | 'index'>('list');
	let sortBy = $state<'name' | 'mentions' | 'updated'>('name');

	// Wiki lint
	let lintOpen = $state(false);
	let lintLoading = $state(false);
	let lintResult = $state<WikiLintResult | null>(null);
	let lintError = $state<string | null>(null);

	// Detail modal
	let detailEntry = $state<Entry | null>(null);
	let detailInitialRefineOpen = $state(false);

	// Create form
	let newName = $state('');
	let newType = $state<EntryType>('concept');
	let newDescription = $state('');
	let newKeywords = $state('');

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

	function summaryFor(e: Entry): string {
		const text = (e.description ?? '').trim();
		if (!text) return '';
		const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
		return firstSentence.length > 140 ? firstSentence.slice(0, 137) + '…' : firstSentence;
	}

	function compareEntries(a: Entry, b: Entry): number {
		switch (sortBy) {
			case 'mentions':
				return (b.mentionCount ?? 0) - (a.mentionCount ?? 0) || a.name.localeCompare(b.name);
			case 'updated':
				return (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.name.localeCompare(b.name);
			default:
				return a.name.localeCompare(b.name);
		}
	}

	const filtered = $derived.by(() => {
		let result = entries;
		if (typeFilter !== 'all') result = result.filter(e => e.type === typeFilter);
		if (sourceFilter !== 'all') result = result.filter(e => e.createdBy === sourceFilter);
		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			result = result.filter(e =>
				e.name.toLowerCase().includes(q) ||
				e.description.toLowerCase().includes(q) ||
				e.injection.keywords.some(k => k.toLowerCase().includes(q)) ||
				(e.aliases ?? []).some(a => a.toLowerCase().includes(q))
			);
		}
		return result;
	});

	const indexGrouped = $derived.by(() => {
		const buckets: Record<EntryType, Entry[]> = {
			character: [], location: [], item: [], faction: [], concept: [], event: [],
		};
		for (const e of filtered) buckets[e.type]?.push(e);
		for (const t of entryTypes) buckets[t].sort(compareEntries);
		return buckets;
	});

	async function runWikiLint() {
		if (!selectedStoryId || lintLoading) return;
		lintOpen = true;
		lintLoading = true;
		lintResult = null;
		lintError = null;
		try {
			const [relationships, chapters] = await Promise.all([
				getEntryRelationships(selectedStoryId),
				getChapters(selectedStoryId),
			]);
			lintResult = await ai.wikiLint.lint(entries, relationships, chapters);
		} catch (e) {
			lintError = e instanceof Error ? e.message : String(e);
		} finally {
			lintLoading = false;
		}
	}

	function closeLint() {
		lintOpen = false;
		lintResult = null;
		lintError = null;
	}

	async function handleCreate() {
		if (!selectedStoryId || !newName.trim()) return;
		const now = Date.now();
		const entry: Entry = {
			id: uuid(),
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

	// Cross-reference navigation stack: previously viewed entries while the
	// detail modal is open. Cleared whenever the modal closes.
	let detailNavStack = $state<Entry[]>([]);

	function openDetail(entry: Entry, refineOpen = false) {
		detailNavStack = [];
		detailInitialRefineOpen = refineOpen;
		detailEntry = entry;
	}

	function closeDetail() {
		detailEntry = null;
		detailNavStack = [];
		detailInitialRefineOpen = false;
	}

	function navigateDetail(entryId: string) {
		const target = entries.find((e) => e.id === entryId);
		if (!target || !detailEntry) return;
		detailNavStack = [...detailNavStack, detailEntry];
		detailEntry = target;
	}

	function navigateBack() {
		if (detailNavStack.length === 0) return;
		const prev = detailNavStack[detailNavStack.length - 1];
		detailNavStack = detailNavStack.slice(0, -1);
		detailEntry = prev;
	}

	function handleDetailSave(updated: Entry) {
		entries = entries.map(e => e.id === updated.id ? updated : e);
		// Sync the live story store too — without this, the narrator, executor,
		// and #sectionCharacters keep reading the pre-edit version until the
		// story is reloaded. Only sync when the panel is showing the active
		// story; editing a different story's lorebook must not stomp the live one.
		if (story.currentStory?.id === updated.storyId) {
			story.lorebookEntries = story.lorebookEntries.map(e =>
				e.id === updated.id ? updated : e,
			);
		}
		closeDetail();
	}

	function handleDetailDelete(id: string) {
		entries = entries.filter(e => e.id !== id);
		if (story.currentStory && selectedStoryId === story.currentStory.id) {
			story.lorebookEntries = story.lorebookEntries.filter(e => e.id !== id);
		}
		closeDetail();
	}

	async function handleDelete(id: string, e: Event) {
		e.stopPropagation();
		await deleteLorebookEntry(id);
		entries = entries.filter(en => en.id !== id);
		if (story.currentStory && selectedStoryId === story.currentStory.id) {
			story.lorebookEntries = story.lorebookEntries.filter(en => en.id !== id);
		}
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
			<h2 class="font-display text-sm tracking-wide text-[var(--text-primary)]">Lorebook</h2>
			<div class="flex gap-2">
				<button onclick={runWikiLint} disabled={!selectedStoryId || entries.length === 0 || lintLoading}
					class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-amber-400 hover:bg-amber-500/8 disabled:opacity-40"
					title="Health-check the wiki for contradictions, orphans, missing entries">
					{#if lintLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Stethoscope class="h-3.5 w-3.5" />{/if}
					Health
				</button>
				<button onclick={() => { showSeedImport = !showSeedImport; showImport = false; }}
					class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-amber-400 hover:bg-[rgba(212,168,83,0.08)]"
					title="Import faction seed packs">
					🏴 Seeds
				</button>
				<button onclick={() => { showImport = !showImport; showSeedImport = false; }}
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

		<!-- Type filter -->
		<div class="mt-2 flex flex-wrap gap-1">
			<button class="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider transition-colors
				{typeFilter === 'all' ? 'bg-[rgba(212,168,83,0.15)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
				onclick={() => typeFilter = 'all'}>All</button>
			{#each entryTypes as t}
				<button class="flex items-center gap-0.5 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider transition-colors
					{typeFilter === t ? 'bg-[rgba(212,168,83,0.15)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
					onclick={() => typeFilter = t}>
					<span class="text-xs">{typeIcons[t]}</span>{t}
				</button>
			{/each}
		</div>

		<!-- Source filter + view toggle -->
		<div class="mt-1.5 flex items-center justify-between gap-2">
			<div class="flex gap-1">
				{#each [{ v: 'all', l: 'All' }, { v: 'user', l: 'User' }, { v: 'ai', l: 'AI' }, { v: 'import', l: 'Import' }] as f}
					<button class="rounded-md px-2 py-0.5 text-[10px] tracking-wider transition-colors
						{sourceFilter === f.v ? 'bg-[var(--bg-primary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
						onclick={() => sourceFilter = f.v as any}>{f.l}</button>
				{/each}
			</div>
			<div class="flex items-center gap-1">
				{#if viewMode === 'index'}
					<select bind:value={sortBy}
						class="rounded-md border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] focus:outline-none">
						<option value="name">A–Z</option>
						<option value="mentions">Mentions</option>
						<option value="updated">Updated</option>
					</select>
				{/if}
				<button class="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] {viewMode === 'list' ? 'bg-[var(--bg-primary)] text-[var(--text-primary)]' : ''}"
					onclick={() => viewMode = 'list'} title="List view">
					<List class="h-3.5 w-3.5" />
				</button>
				<button class="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] {viewMode === 'index' ? 'bg-[var(--bg-primary)] text-[var(--text-primary)]' : ''}"
					onclick={() => viewMode = 'index'} title="Index view">
					<LayoutList class="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	</div>

	<!-- Import section -->
	{#if showImport && selectedStoryId}
		<div class="border-b border-[var(--border-primary)] px-4 py-4">
			<LorebookImport storyId={selectedStoryId} onImported={(result) => { showImport = false; loadEntries(); }} />
		</div>
	{/if}

	<!-- Seed import section -->
	{#if showSeedImport && selectedStoryId}
		<div class="border-b border-[var(--border-primary)] px-4 py-4">
			<SeedImport storyId={selectedStoryId} onComplete={() => { showSeedImport = false; loadEntries(); }} />
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
			<p class="py-10 text-center text-sm text-[var(--text-muted)]">{searchQuery || typeFilter !== 'all' ? 'No matches.' : 'No entries yet. Add one above.'}</p>
		{:else if viewMode === 'index'}
			<div class="space-y-4">
				{#each entryTypes as t}
					{@const bucket = indexGrouped[t]}
					{#if bucket.length > 0}
						<div>
							<div class="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
								<span>{typeIcons[t]}</span>
								<span>{t}s</span>
								<span class="text-[var(--text-muted)]/60">· {bucket.length}</span>
							</div>
							<div class="divide-y divide-[var(--border-primary)] rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)]">
								{#each bucket as entry}
									<button class="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-[rgba(212,168,83,0.06)]"
										onclick={() => openDetail(entry)}>
										<div class="flex-1 min-w-0">
											<div class="flex items-baseline gap-2">
												<span class="truncate font-story text-sm font-semibold text-[var(--text-primary)]">{entry.name}</span>
												{#if entry.aliases?.length}
													<span class="truncate text-[10px] text-[var(--text-muted)]">aka {entry.aliases.slice(0, 2).join(', ')}</span>
												{/if}
											</div>
											{#if summaryFor(entry)}
												<div class="mt-0.5 line-clamp-1 text-xs text-[var(--text-muted)]">{summaryFor(entry)}</div>
											{/if}
										</div>
										<div class="flex shrink-0 flex-col items-end gap-0.5 text-[10px] text-[var(--text-muted)]">
											{#if entry.mentionCount > 0}
												<span title="Mentions">{entry.mentionCount}×</span>
											{/if}
											<span title="Last updated">{new Date(entry.updatedAt).toLocaleDateString()}</span>
										</div>
									</button>
								{/each}
							</div>
						</div>
					{/if}
				{/each}
			</div>
		{:else}
			<div class="space-y-2">
				{#each filtered as entry}
					<div class="w-full text-left rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 transition-colors hover:border-[var(--color-gold-600)]/30 cursor-pointer"
						onclick={() => openDetail(entry)}
						role="button" tabindex="0"
						onkeydown={(e) => { if (e.key === 'Enter') openDetail(entry); }}>
						<div class="flex items-start justify-between">
							<div class="flex items-center gap-2">
								<span class="text-sm">{typeIcons[entry.type] ?? '📄'}</span>
								<span class="font-story text-sm font-semibold text-[var(--text-primary)]">{entry.name}</span>
								<span class="rounded-md bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] capitalize text-[var(--text-muted)]">{entry.type}</span>
								{#if entry.createdBy === 'ai'}
									<span class="rounded-md bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-400">AI</span>
								{/if}
								{#if entry.loreManagementBlacklisted}
									<span class="rounded-md bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">Protected</span>
								{/if}
							</div>
							<div class="flex items-center gap-1">
								<button onclick={(e) => { e.stopPropagation(); openDetail(entry, true); }}
									class="rounded p-1 text-[var(--text-muted)] hover:text-amber-400"
									title="Refine with AI">
									<Sparkles class="h-3.5 w-3.5" />
								</button>
								<button onclick={(e) => handleDelete(entry.id, e)}
									class="rounded p-1 text-[var(--text-muted)] hover:text-red-400"
									title="Delete entry">
									<Trash2 class="h-3.5 w-3.5" />
								</button>
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
								{#if entry.injection.keywords.length > 5}
									<span class="text-[10px] text-[var(--text-muted)]">+{entry.injection.keywords.length - 5}</span>
								{/if}
							</div>
						{/if}
						{#if entry.injection.mode !== 'keyword'}
							<div class="mt-1">
								<span class="rounded px-1.5 py-0.5 text-[10px] {entry.injection.mode === 'always' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}">
									{entry.injection.mode === 'always' ? 'Always active' : 'Archived'}
								</span>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<!-- Detail Modal -->
{#if detailEntry}
	<EntryDetailModal
		entry={detailEntry}
		allEntries={entries}
		onSave={handleDetailSave}
		onDelete={handleDetailDelete}
		onClose={closeDetail}
		onNavigate={navigateDetail}
		canGoBack={detailNavStack.length > 0}
		onBack={navigateBack}
		initialRefineOpen={detailInitialRefineOpen}
	/>
{/if}

<!-- Wiki Lint Report -->
{#if lintOpen}
	<WikiLintReport result={lintResult} loading={lintLoading} error={lintError} onClose={closeLint} />
{/if}
