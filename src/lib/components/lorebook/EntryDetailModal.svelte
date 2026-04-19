<script lang="ts">
	import { X, Save, Trash2, Shield, ShieldOff } from 'lucide-svelte';
	import { updateLorebookEntry, deleteLorebookEntry, getRelationshipsForEntry } from '$lib/services/database';
	import type { Entry, EntryType, EntryInjectionMode, EntryRelationship, CharacterEntryState, FactionEntryState, LocationEntryState, ItemEntryState } from '$lib/types';
	import { fade } from 'svelte/transition';
	import { onMount } from 'svelte';

	interface Props {
		entry: Entry;
		onSave: (updated: Entry) => void;
		onDelete: (id: string) => void;
		onClose: () => void;
	}

	let { entry, onSave, onDelete, onClose }: Props = $props();

	type Tab = 'general' | 'state' | 'injection' | 'info';
	let activeTab = $state<Tab>('general');
	let confirmDelete = $state(false);
	let relationships = $state<EntryRelationship[]>([]);

	// Editable fields
	let name = $state(entry.name);
	let type = $state<EntryType>(entry.type);
	let description = $state(entry.description);
	let hiddenInfo = $state(entry.hiddenInfo ?? '');
	let aliases = $state(entry.aliases?.join(', ') ?? '');
	let blacklisted = $state(entry.loreManagementBlacklisted ?? false);

	// Injection
	let injectionMode = $state<EntryInjectionMode>(entry.injection.mode);
	let injectionPriority = $state(entry.injection.priority);
	let keywords = $state(entry.injection.keywords.join(', '));

	// State (deep copy)
	let entryState = $state(JSON.parse(JSON.stringify(entry.state)));

	const entryTypes: EntryType[] = ['character', 'location', 'item', 'faction', 'concept', 'event'];
	const typeIcons: Record<string, string> = {
		character: '👤', location: '📍', item: '🗡️',
		faction: '🏴', concept: '💡', event: '📅',
	};

	// Load relationships on mount
	onMount(() => {
		if (entry.storyId && entry.id) {
			getRelationshipsForEntry(entry.storyId, entry.id).then(r => relationships = r);
		}
	});

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
				<span class="text-lg">{typeIcons[type] ?? '📄'}</span>
				<h3 class="font-display text-sm tracking-wide text-[var(--text-primary)]">Edit Entry</h3>
			</div>
			<button onclick={onClose} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
				<X class="h-4 w-4" />
			</button>
		</div>

		<!-- Tabs -->
		<div class="flex border-b border-[var(--border-primary)]">
			{#each [
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

			{#if activeTab === 'general'}
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
