<script lang="ts">
	import { X, Save, Trash2, Shield, ShieldOff, ArrowLeft, BookOpen } from 'lucide-svelte';
	import { updateLorebookEntry, deleteLorebookEntry, getRelationshipsForEntry } from '$lib/services/database';
	import type { Entry, EntryType, EntryInjectionMode, EntryRelationship, CharacterEntryState, FactionEntryState, LocationEntryState, ItemEntryState } from '$lib/types';
	import { fade } from 'svelte/transition';
	import { onMount, untrack } from 'svelte';
	import { renderWiki, findInboundMentions, parseWikiHref } from '$lib/utils/wikilinks';
	import ReputationPanel from './ReputationPanel.svelte';

	interface Props {
		entry: Entry;
		/** Full set of lorebook entries — used to resolve cross-references in the Wiki tab. */
		allEntries?: Entry[];
		onSave: (updated: Entry) => void;
		onDelete: (id: string) => void;
		onClose: () => void;
		/** Click on a wiki cross-reference link. Parent should swap detailEntry. */
		onNavigate?: (entryId: string) => void;
		/** Back button — enabled when the parent has a navigation stack. */
		canGoBack?: boolean;
		onBack?: () => void;
	}

	let { entry, allEntries = [], onSave, onDelete, onClose, onNavigate, canGoBack = false, onBack }: Props = $props();

	type Tab = 'wiki' | 'general' | 'state' | 'injection' | 'info';
	let activeTab = $state<Tab>('wiki');
	let confirmDelete = $state(false);
	let relationships = $state<EntryRelationship[]>([]);

	// Legacy entries may be missing `injection` or have it partially populated.
	// This default keeps the modal from crashing on first render.
	const DEFAULT_INJECTION = { mode: 'keyword' as EntryInjectionMode, keywords: [] as string[], priority: 100 };

	// Editable fields — re-init whenever the entry prop changes (cross-ref nav).
	let name = $state(entry.name);
	let type = $state<EntryType>(entry.type);
	let description = $state(entry.description);
	let hiddenInfo = $state(entry.hiddenInfo ?? '');
	let aliases = $state(entry.aliases?.join(', ') ?? '');
	let blacklisted = $state(entry.loreManagementBlacklisted ?? false);

	// Injection — guarded against legacy entries with missing fields.
	let injectionMode = $state<EntryInjectionMode>(entry.injection?.mode ?? DEFAULT_INJECTION.mode);
	let injectionPriority = $state(entry.injection?.priority ?? DEFAULT_INJECTION.priority);
	let keywords = $state((entry.injection?.keywords ?? []).join(', '));

	// State (deep copy)
	let entryState = $state(JSON.parse(JSON.stringify(entry.state)));

	const entryTypes: EntryType[] = ['character', 'location', 'item', 'faction', 'concept', 'event'];
	const typeIcons: Record<string, string> = {
		character: '👤', location: '📍', item: '🗡️',
		faction: '🏴', concept: '💡', event: '📅',
	};

	// Re-init editable state and reload relationships whenever entry changes
	// (e.g. parent swaps it via cross-reference navigation).
	$effect(() => {
		const e = entry;
		untrack(() => {
			name = e.name;
			type = e.type;
			description = e.description;
			hiddenInfo = e.hiddenInfo ?? '';
			aliases = e.aliases?.join(', ') ?? '';
			blacklisted = e.loreManagementBlacklisted ?? false;
			injectionMode = e.injection?.mode ?? DEFAULT_INJECTION.mode;
			injectionPriority = e.injection?.priority ?? DEFAULT_INJECTION.priority;
			keywords = (e.injection?.keywords ?? []).join(', ');
			entryState = JSON.parse(JSON.stringify(e.state));
			confirmDelete = false;
		});
		if (e.storyId && e.id) {
			getRelationshipsForEntry(e.storyId, e.id).then((r) => (relationships = r));
		}
	});

	// Wiki tab derived data
	const wikiDescription = $derived(renderWiki(description ?? '', allEntries, entry.id));
	const wikiHidden = $derived(renderWiki(hiddenInfo ?? '', allEntries, entry.id));
	const inboundMentions = $derived(findInboundMentions(entry, allEntries));

	function handleWikiClick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		const link = target.closest('a');
		if (!link) return;
		const id = parseWikiHref(link.getAttribute('href'));
		if (!id) return;
		e.preventDefault();
		onNavigate?.(id);
	}

	async function handleSave() {
		const updates: Partial<Entry> = {
			name,
			type,
			description,
			hiddenInfo: hiddenInfo || null,
			aliases: aliases.split(',').map(a => a.trim()).filter(Boolean),
			loreManagementBlacklisted: blacklisted,
			injection: {
				mode: injectionMode,
				keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
				priority: injectionPriority,
			},
			state: { ...entryState, type },
			updatedAt: Date.now(),
		};
		await updateLorebookEntry(entry.id, updates);
		onSave({ ...entry, ...updates } as Entry);
	}

	async function handleDelete() {
		await deleteLorebookEntry(entry.id);
		onDelete(entry.id);
	}

	const sourceLabel: Record<string, string> = { user: 'User', ai: 'AI', import: 'Import', forge: 'Forge' };
</script>

{#if true}
<div class="fixed inset-0 z-50 flex items-center justify-center p-4" transition:fade={{ duration: 150 }}>
	<button class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick={onClose} aria-label="Close"></button>

	<div class="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-2xl">
		<!-- Header -->
		<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-5 py-3">
			<div class="flex items-center gap-2">
				{#if canGoBack}
					<button onclick={onBack} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Back">
						<ArrowLeft class="h-4 w-4" />
					</button>
				{/if}
				<span class="text-lg">{typeIcons[type] ?? '📄'}</span>
				<h3 class="font-display text-sm tracking-wide text-[var(--text-primary)] truncate max-w-[18rem]">{name || 'Untitled'}</h3>
			</div>
			<button onclick={onClose} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
				<X class="h-4 w-4" />
			</button>
		</div>

		<!-- Tabs -->
		<div class="flex border-b border-[var(--border-primary)]">
			{#each [
				{ id: 'wiki', label: 'Wiki' },
				{ id: 'general', label: 'General' },
				{ id: 'state', label: 'State' },
				{ id: 'injection', label: 'Injection' },
				{ id: 'info', label: 'Info' },
			] as tab}
				<button
					class="flex-1 py-2.5 text-center text-xs font-medium uppercase tracking-wider transition-colors
						{activeTab === tab.id ? 'text-[var(--text-accent)] border-b-2 border-[var(--color-gold-400)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
					onclick={() => activeTab = tab.id as Tab}
				>{tab.label}</button>
			{/each}
		</div>

		<!-- Content -->
		<div class="flex-1 overflow-y-auto px-5 py-4 space-y-4">

			{#if activeTab === 'wiki'}
				<!-- Read-only rendered view with cross-references -->
				<div class="flex items-center gap-2 text-[var(--text-muted)]">
					<BookOpen class="h-3.5 w-3.5" />
					<span class="text-[10px] uppercase tracking-wider">{type}</span>
					{#if entry.aliases?.length}
						<span class="text-[10px]">· also known as {entry.aliases.join(', ')}</span>
					{/if}
				</div>

				{#if wikiDescription.html}
					<div class="wiki-prose text-sm text-[var(--text-primary)]" onclick={handleWikiClick} role="presentation">
						{@html wikiDescription.html}
					</div>
				{:else}
					<p class="text-sm italic text-[var(--text-muted)]">No description yet.</p>
				{/if}

				{#if wikiHidden.html}
					<div class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2.5">
						<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">GM Notes</div>
						<div class="wiki-prose text-sm text-[var(--text-primary)]" onclick={handleWikiClick} role="presentation">
							{@html wikiHidden.html}
						</div>
					</div>
				{/if}

				{#if inboundMentions.length > 0}
					<div class="border-t border-[var(--border-primary)] pt-3">
						<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">Mentioned in ({inboundMentions.length})</div>
						<div class="flex flex-wrap gap-1.5">
							{#each inboundMentions as ref}
								<button
									class="flex items-center gap-1 rounded-md bg-[var(--bg-tertiary)] px-2 py-1 text-xs text-[var(--text-primary)] hover:bg-[rgba(212,168,83,0.12)]"
									onclick={() => onNavigate?.(ref.id)}
								>
									<span>{typeIcons[ref.type] ?? '📄'}</span>
									<span>{ref.name}</span>
								</button>
							{/each}
						</div>
					</div>
				{/if}

				<ReputationPanel {entry} />

			{:else if activeTab === 'general'}
				<!-- Name -->
				<div class="space-y-1">
					<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Name</label>
					<input type="text" bind:value={name}
						class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
				</div>

				<!-- Type -->
				<div class="space-y-1">
					<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Type</label>
					<div class="flex flex-wrap gap-1.5">
						{#each entryTypes as t}
							<button class="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-all
								{type === t ? 'bg-[rgba(212,168,83,0.15)] text-[var(--text-accent)] ring-1 ring-[var(--color-gold-600)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-[var(--bg-primary)]'}"
								onclick={() => { type = t; entryState = { ...entryState, type: t }; }}>
								<span>{typeIcons[t]}</span> <span class="capitalize">{t}</span>
							</button>
						{/each}
					</div>
				</div>

				<!-- Description -->
				<div class="space-y-1">
					<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Description</label>
					<textarea bind:value={description} rows="4"
						class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
				</div>

				<!-- Hidden Info -->
				<div class="space-y-1">
					<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Hidden Info (GM Notes)</label>
					<textarea bind:value={hiddenInfo} rows="2" placeholder="Info visible to AI but hidden from player..."
						class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
				</div>

				<!-- Aliases -->
				<div class="space-y-1">
					<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Aliases (comma-separated)</label>
					<input type="text" bind:value={aliases} placeholder="The Stranger, Lord K..."
						class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
				</div>

				<!-- AI Blacklist -->
				<label class="flex items-center justify-between rounded-lg bg-[var(--bg-primary)] px-3 py-2.5">
					<div class="flex items-center gap-2">
						{#if blacklisted}<ShieldOff class="h-4 w-4 text-red-400" />{:else}<Shield class="h-4 w-4 text-emerald-400" />{/if}
						<span class="text-sm text-[var(--text-primary)]">Block AI edits</span>
					</div>
					<input type="checkbox" bind:checked={blacklisted} class="h-4 w-4 accent-[var(--color-gold-400)]" />
				</label>

			{:else if activeTab === 'state'}
				<!-- Type-specific state fields -->
				{#if type === 'character'}
					<div class="space-y-3">
						<div class="space-y-1">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Bio</label>
							<textarea bind:value={entryState.bio} rows="3" placeholder="Character biography..."
								class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
						</div>
						<div class="space-y-1">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Motivations</label>
							<textarea bind:value={entryState.motivations} rows="2" placeholder="What drives this character..."
								class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
						</div>
						<div class="space-y-1">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Personality</label>
							<textarea bind:value={entryState.personality} rows="2" placeholder="Personality traits..."
								class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
						</div>
						<div class="space-y-1">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Disposition</label>
							<input type="text" bind:value={entryState.currentDisposition} placeholder="friendly, wary, hostile..."
								class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
						</div>
						{#if entryState.relationship}
						<div class="grid grid-cols-2 gap-3">
							<div class="space-y-1">
								<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Relationship Level</label>
								<input type="range" bind:value={entryState.relationship.level} min="-100" max="100" step="5"
									class="w-full accent-[var(--color-gold-400)]" />
								<div class="text-center text-xs text-[var(--text-muted)]">{entryState.relationship.level ?? 0}</div>
							</div>
							<div class="space-y-1">
								<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Relationship Status</label>
								<input type="text" bind:value={entryState.relationship.status} placeholder="friend, rival..."
									class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
							</div>
						</div>
						{/if}
						<div class="space-y-1">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Personal Opinion (of player)</label>
							<input type="text" bind:value={entryState.personalOpinion} placeholder="How this NPC views the player..."
								class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
						</div>
					</div>

				{:else if type === 'faction'}
					<div class="space-y-3">
						<div class="grid grid-cols-2 gap-3">
							<div class="space-y-1">
								<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Player Standing</label>
								<input type="range" bind:value={entryState.playerStanding} min="-100" max="100" step="5"
									class="w-full accent-[var(--color-gold-400)]" />
								<div class="text-center text-xs text-[var(--text-muted)]">{entryState.playerStanding ?? 0}</div>
							</div>
							<div class="space-y-1">
								<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Status</label>
								<select bind:value={entryState.status}
									class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)]">
									<option value="unknown">Unknown</option>
									<option value="allied">Allied</option>
									<option value="neutral">Neutral</option>
									<option value="hostile">Hostile</option>
								</select>
							</div>
						</div>
						<div class="space-y-1">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Disposition</label>
							<select bind:value={entryState.disposition}
								class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)]">
								<option value="">None</option>
								<option value="aggressive">Aggressive</option>
								<option value="defensive">Defensive</option>
								<option value="scheming">Scheming</option>
								<option value="neutral">Neutral</option>
								<option value="desperate">Desperate</option>
							</select>
						</div>
						<div class="space-y-1">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Territory (comma-separated)</label>
							<input type="text" bind:value={entryState.territory} placeholder="Regions this faction controls..."
								class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
						</div>
					</div>

				{:else if type === 'location'}
					<div class="space-y-3">
						<div class="grid grid-cols-2 gap-3">
							<div class="space-y-1">
								<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Region</label>
								<input type="text" bind:value={entryState.region} placeholder="The Reach, Stormlands..."
									class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
							</div>
							<div class="space-y-1">
								<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Terrain</label>
								<input type="text" bind:value={entryState.terrain} placeholder="forest, mountain, coastal..."
									class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
							</div>
						</div>
						<div class="space-y-1">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Visit Count</label>
							<div class="text-sm text-[var(--text-primary)]">{entryState.visitCount ?? 0} visits</div>
						</div>
					</div>

				{:else if type === 'item'}
					<div class="space-y-3">
						<div class="space-y-1">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Condition</label>
							<input type="text" bind:value={entryState.condition} placeholder="pristine, damaged, cursed..."
								class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
						</div>
						<label class="flex items-center justify-between rounded-lg bg-[var(--bg-primary)] px-3 py-2.5">
							<span class="text-sm text-[var(--text-primary)]">In Inventory</span>
							<input type="checkbox" bind:checked={entryState.inInventory} class="h-4 w-4 accent-[var(--color-gold-400)]" />
						</label>
					</div>

				{:else if type === 'concept'}
					<div class="space-y-3">
						<label class="flex items-center justify-between rounded-lg bg-[var(--bg-primary)] px-3 py-2.5">
							<span class="text-sm text-[var(--text-primary)]">Revealed to Player</span>
							<input type="checkbox" bind:checked={entryState.revealed} class="h-4 w-4 accent-[var(--color-gold-400)]" />
						</label>
						<div class="space-y-1">
							<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Comprehension Level</label>
							<select bind:value={entryState.comprehensionLevel}
								class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)]">
								<option value="unknown">Unknown</option>
								<option value="basic">Basic</option>
								<option value="intermediate">Intermediate</option>
								<option value="advanced">Advanced</option>
							</select>
						</div>
					</div>

				{:else if type === 'event'}
					<div class="space-y-3">
						<label class="flex items-center justify-between rounded-lg bg-[var(--bg-primary)] px-3 py-2.5">
							<span class="text-sm text-[var(--text-primary)]">Has Occurred</span>
							<input type="checkbox" bind:checked={entryState.occurred} class="h-4 w-4 accent-[var(--color-gold-400)]" />
						</label>
					</div>
				{/if}

				<!-- Relationships (read-only display) -->
				{#if relationships.length > 0}
					<div class="mt-4 space-y-1 border-t border-[var(--border-primary)] pt-4">
						<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Relationships</label>
						<div class="space-y-1">
							{#each relationships as rel}
								<div class="flex items-center gap-2 rounded-lg bg-[var(--bg-primary)] px-3 py-2 text-xs text-[var(--text-muted)]">
									<span class="font-medium text-[var(--text-primary)]">{rel.type}</span>
									<span>→</span>
									<span>{rel.targetEntryId}</span>
									{#if rel.strength != null}
										<span class="ml-auto">str: {rel.strength}</span>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}

			{:else if activeTab === 'injection'}
				<!-- Injection Mode -->
				<div class="space-y-1">
					<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Injection Mode</label>
					<div class="grid grid-cols-3 gap-2">
						{#each ['always', 'keyword', 'never'] as mode}
							<button class="rounded-lg border border-[var(--border-primary)] px-3 py-2.5 text-center text-xs transition-colors
								{injectionMode === mode
									? 'border-[var(--color-gold-600)] text-[var(--text-accent)] bg-[rgba(212,168,83,0.08)]'
									: 'text-[var(--text-muted)] hover:border-[var(--color-gold-600)]'}"
								onclick={() => injectionMode = mode as EntryInjectionMode}>
								{mode === 'always' ? 'Always' : mode === 'keyword' ? 'Keyword' : 'Never'}
							</button>
						{/each}
					</div>
					<p class="text-[10px] text-[var(--text-muted)] mt-1">
						{injectionMode === 'always' ? 'Always included in narrator context.' : injectionMode === 'keyword' ? 'Included when keywords appear in action or narration.' : 'Never included (archived).'}
					</p>
				</div>

				<!-- Priority -->
				<div class="space-y-1">
					<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Priority ({injectionPriority})</label>
					<input type="range" bind:value={injectionPriority} min="0" max="1000" step="10"
						class="w-full accent-[var(--color-gold-400)]" />
					<p class="text-[10px] text-[var(--text-muted)]">Higher priority = injected first when budget is limited.</p>
				</div>

				<!-- Keywords -->
				<div class="space-y-1">
					<label class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Keywords (comma-separated)</label>
					<input type="text" bind:value={keywords} placeholder="keyword1, keyword2..."
						class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none" />
				</div>

			{:else if activeTab === 'info'}
				<!-- Read-only metadata -->
				<div class="space-y-3">
					<div class="grid grid-cols-2 gap-3">
						<div class="rounded-lg bg-[var(--bg-primary)] px-3 py-2.5">
							<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Created By</div>
							<div class="text-sm text-[var(--text-primary)]">{sourceLabel[entry.createdBy] ?? entry.createdBy}</div>
						</div>
						<div class="rounded-lg bg-[var(--bg-primary)] px-3 py-2.5">
							<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Mentions</div>
							<div class="text-sm text-[var(--text-primary)]">{entry.mentionCount}</div>
						</div>
					</div>
					{#if entry.firstMentioned}
						<div class="rounded-lg bg-[var(--bg-primary)] px-3 py-2.5">
							<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">First Mentioned</div>
							<div class="text-sm text-[var(--text-primary)]">{new Date(entry.firstMentioned).toLocaleDateString()}</div>
						</div>
					{/if}
					<div class="rounded-lg bg-[var(--bg-primary)] px-3 py-2.5">
						<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Last Updated</div>
						<div class="text-sm text-[var(--text-primary)]">{new Date(entry.updatedAt).toLocaleDateString()}</div>
					</div>
				</div>
			{/if}
		</div>

		<!-- Footer -->
		<div class="flex items-center justify-between border-t border-[var(--border-primary)] px-5 py-3">
			{#if confirmDelete}
				<div class="flex items-center gap-2">
					<span class="text-xs text-red-400">Delete permanently?</span>
					<button onclick={handleDelete} class="rounded-lg bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/30">Yes</button>
					<button onclick={() => confirmDelete = false} class="rounded-lg bg-[var(--bg-tertiary)] px-3 py-1.5 text-xs text-[var(--text-muted)]">No</button>
				</div>
			{:else}
				<button onclick={() => confirmDelete = true} class="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-red-400">
					<Trash2 class="h-3.5 w-3.5" /> Delete
				</button>
			{/if}
			<div class="flex gap-2">
				<button onclick={onClose} class="rounded-lg bg-[var(--bg-tertiary)] px-4 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
				<button onclick={handleSave} class="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] px-4 py-2 text-xs font-semibold text-[var(--bg-primary)]">
					<Save class="h-3.5 w-3.5" /> Save
				</button>
			</div>
		</div>
	</div>
</div>
{/if}

<style>
	/* Minimal prose styles for the rendered markdown in the Wiki tab. */
	.wiki-prose :global(p) { margin: 0 0 0.6em; line-height: 1.55; }
	.wiki-prose :global(p:last-child) { margin-bottom: 0; }
	.wiki-prose :global(h1),
	.wiki-prose :global(h2),
	.wiki-prose :global(h3) {
		font-family: var(--font-display, inherit);
		font-weight: 600;
		margin: 0.6em 0 0.3em;
		color: var(--text-primary);
	}
	.wiki-prose :global(h1) { font-size: 1.05rem; }
	.wiki-prose :global(h2) { font-size: 0.95rem; }
	.wiki-prose :global(h3) { font-size: 0.85rem; }
	.wiki-prose :global(ul),
	.wiki-prose :global(ol) { margin: 0 0 0.6em; padding-left: 1.25em; }
	.wiki-prose :global(li) { margin-bottom: 0.15em; }
	.wiki-prose :global(a) {
		color: var(--text-accent);
		text-decoration: underline;
		text-decoration-color: rgba(212, 168, 83, 0.4);
		text-underline-offset: 2px;
		cursor: pointer;
	}
	.wiki-prose :global(a:hover) { text-decoration-color: var(--color-gold-400); }
	.wiki-prose :global(em) { color: var(--text-muted); }
	.wiki-prose :global(strong) { color: var(--text-accent); font-weight: 600; }
	.wiki-prose :global(code) {
		background: var(--bg-primary);
		padding: 0.1em 0.35em;
		border-radius: 0.25rem;
		font-size: 0.85em;
	}
	.wiki-prose :global(blockquote) {
		border-left: 2px solid var(--color-gold-600);
		padding-left: 0.7em;
		color: var(--text-muted);
		font-style: italic;
		margin: 0 0 0.6em;
	}
</style>
