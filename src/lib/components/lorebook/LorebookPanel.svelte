<script lang="ts">
	import { Plus, X, Search, Upload, Trash2, Wand2, Loader2 } from 'lucide-svelte';
	import { getAllStories, getLorebookEntries, createLorebookEntry, updateLorebookEntry, deleteLorebookEntry } from '$lib/services/database';
	import { uuid } from '$lib/utils/uuid';
	import { ai } from '$lib/services/ai';
	import LorebookImport from './LorebookImport.svelte';
	import SeedImport from './SeedImport.svelte';
	import EntryDetailModal from './EntryDetailModal.svelte';
	import type { Story, Entry, EntryType } from '$lib/types';
	import type { VaultAction } from '$lib/services/ai/sdk/schemas/vault';
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

	// Detail modal
	let detailEntry = $state<Entry | null>(null);

	// Vault
	let vaultQuery = $state('');
	let vaultLoading = $state(false);
	let vaultReasoning = $state('');
	let vaultActions = $state<VaultAction[]>([]);
	let vaultError = $state('');

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

	function openDetail(entry: Entry) {
		detailNavStack = [];
		detailEntry = entry;
	}

	function closeDetail() {
		detailEntry = null;
		detailNavStack = [];
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
		closeDetail();
	}

	function handleDetailDelete(id: string) {
		entries = entries.filter(e => e.id !== id);
		closeDetail();
	}

	async function handleDelete(id: string, e: Event) {
		e.stopPropagation();
		await deleteLorebookEntry(id);
		entries = entries.filter(en => en.id !== id);
	}

	// ── Vault ──

	async function handleVaultSubmit() {
		if (!vaultQuery.trim() || vaultLoading) return;
		vaultLoading = true;
		vaultError = '';
		vaultReasoning = '';
		vaultActions = [];
		try {
			const result = await ai.vault.process(vaultQuery, entries);
			vaultReasoning = result.reasoning ?? '';
			vaultActions = result.actions;
			if (result.actions.length === 0 && !result.reasoning) {
				vaultReasoning = 'No changes needed.';
			}
		} catch (err) {
			vaultError = err instanceof Error ? err.message : 'Vault request failed.';
		} finally {
			vaultLoading = false;
		}
	}

	async function applyVaultAction(action: VaultAction) {
		if (!selectedStoryId) return;
		if (action.action === 'create' && action.name) {
			const entry: Entry = {
				id: uuid(),
				storyId: selectedStoryId,
				branchId: null,
				name: action.name,
				type: (action.type as EntryType) || 'concept',
				description: action.description ?? '',
				hiddenInfo: null,
				aliases: [],
				state: buildDefaultState((action.type as EntryType) || 'concept'),
				adventureState: null,
				creativeState: null,
				injection: {
					mode: 'keyword',
					keywords: action.keywords ?? [action.name.toLowerCase()],
					priority: 100,
				},
				firstMentioned: null,
				lastMentioned: null,
				mentionCount: 0,
				createdBy: 'ai',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				loreManagementBlacklisted: false,
			};
			await createLorebookEntry(entry);
			entries = [...entries, entry];
		} else if (action.action === 'update' && action.entryId) {
			const updates: Partial<Entry> = { updatedAt: Date.now() };
			if (action.description) updates.description = action.description;
			if (action.keywords) updates.injection = { mode: 'keyword', keywords: action.keywords, priority: 100 };
			await updateLorebookEntry(action.entryId, updates);
			entries = entries.map(e => e.id === action.entryId ? { ...e, ...updates } : e);
		} else if (action.action === 'delete' && action.entryId) {
			await deleteLorebookEntry(action.entryId);
			entries = entries.filter(e => e.id !== action.entryId);
		}
		// Remove applied action from list
		vaultActions = vaultActions.filter(a => a !== action);
	}

	function dismissVault() {
		vaultQuery = '';
		vaultReasoning = '';
		vaultActions = [];
		vaultError = '';
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

		<!-- Source filter -->
		<div class="mt-1.5 flex gap-1">
			{#each [{ v: 'all', l: 'All' }, { v: 'user', l: 'User' }, { v: 'ai', l: 'AI' }, { v: 'import', l: 'Import' }] as f}
				<button class="rounded-md px-2 py-0.5 text-[10px] tracking-wider transition-colors
					{sourceFilter === f.v ? 'bg-[var(--bg-primary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
					onclick={() => sourceFilter = f.v as any}>{f.l}</button>
			{/each}
		</div>
	</div>

	<!-- Vault bar -->
	<div class="border-b border-[var(--border-primary)] px-4 py-3">
		<div class="flex gap-2">
			<div class="relative flex-1">
				<Wand2 class="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
				<input type="text" bind:value={vaultQuery}
					placeholder="Ask the vault... &quot;Add a fire mage named Kael&quot;"
					class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] py-2 pl-9 pr-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
					onkeydown={(e) => { if (e.key === 'Enter') handleVaultSubmit(); }} />
			</div>
			<button onclick={handleVaultSubmit} disabled={vaultLoading || !vaultQuery.trim()}
				class="rounded-lg bg-[rgba(212,168,83,0.12)] px-3 py-2 text-xs text-[var(--text-accent)] hover:bg-[rgba(212,168,83,0.2)] disabled:opacity-40">
				{#if vaultLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}Ask{/if}
			</button>
		</div>

		{#if vaultError}
			<div class="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{vaultError}</div>
		{/if}

		{#if vaultReasoning}
			<div class="mt-2 rounded-lg bg-[var(--bg-primary)] px-3 py-2 text-xs text-[var(--text-muted)] leading-relaxed">
				{vaultReasoning}
			</div>
		{/if}

		{#if vaultActions.length > 0}
			<div class="mt-2 space-y-1.5">
				{#each vaultActions as action}
					<div class="flex items-center justify-between rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2">
						<div class="flex-1">
							<span class="mr-1.5 rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--text-muted)]">{action.action}</span>
							<span class="text-xs text-[var(--text-primary)]">{action.name ?? action.entryId}</span>
							{#if action.reason}
								<span class="ml-1 text-[10px] text-[var(--text-muted)]">— {action.reason}</span>
							{/if}
						</div>
						<div class="flex gap-1.5">
							<button onclick={() => applyVaultAction(action)} class="rounded bg-emerald-500/20 px-2 py-1 text-[10px] font-medium text-emerald-400 hover:bg-emerald-500/30">Apply</button>
							<button onclick={() => vaultActions = vaultActions.filter(a => a !== action)} class="rounded bg-[var(--bg-primary)] px-2 py-1 text-[10px] text-[var(--text-muted)]">Skip</button>
						</div>
					</div>
				{/each}
				<button onclick={dismissVault} class="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">Dismiss all</button>
			</div>
		{/if}
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
							<button onclick={(e) => handleDelete(entry.id, e)}
								class="rounded p-1 text-[var(--text-muted)] hover:text-red-400"
								title="Delete entry">
								<Trash2 class="h-3.5 w-3.5" />
							</button>
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
	/>
{/if}
