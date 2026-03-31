<script lang="ts">
	import { story } from '$lib/stores/story.svelte';
	import { ai } from '$lib/services/ai';
	import type { CompactionDiff } from '$lib/services/ai/memory/CompactionService';
	import { RefreshCw, Pencil, Undo2, X, Check, XCircle, Loader2, BookMarked } from 'lucide-svelte';

	// ── State ──

	let isCompacting = $state(false);
	let compactionError = $state<string | null>(null);

	// Diff review modal
	let diffModalOpen = $state(false);
	let proposedLore = $state('');
	let pendingDiff = $state<CompactionDiff | null>(null);

	// Edit modal
	let editModalOpen = $state(false);
	let editDraft = $state('');

	// ── Derived ──

	const currentLore = $derived(story.currentStory?.compactedLore ?? null);
	const loreHistory = $derived(story.currentStory?.compactedLoreHistory ?? []);
	const canUndo = $derived(loreHistory.length > 0);
	const wordCount = $derived(proposedLore ? proposedLore.split(/\s+/).filter(Boolean).length : 0);

	// All diff lines in order for display
	const diffLines = $derived.by(() => {
		if (!pendingDiff) return [];

		const oldLines = (currentLore ?? '').split('\n').filter(l => l.trim());
		const newLines = proposedLore.split('\n').filter(l => l.trim());

		// Build ordered display: show new lore line by line, marking added vs unchanged
		return newLines.map(line => {
			const trimmed = line.trim();
			if (pendingDiff.added.some(a => a.trim() === trimmed)) {
				return { text: line, kind: 'added' as const };
			}
			return { text: line, kind: 'unchanged' as const };
		}).concat(
			// Append removed lines (they're not in newLines)
			(pendingDiff.removed ?? []).map(line => ({ text: line, kind: 'removed' as const }))
		);
	});

	// ── Actions ──

	async function handleCompact() {
		if (!story.currentStory || isCompacting) return;
		isCompacting = true;
		compactionError = null;

		try {
			const recentEntries = story.entries.slice(-30);
			const result = await ai.compaction.compact(
				recentEntries,
				currentLore,
				story.characters,
				story.locations,
				story.items,
				story.lorebookEntries,
				currentLore ? 'incremental' : 'full',
			);

			proposedLore = result.proposedLore;
			pendingDiff = result.diff;
			diffModalOpen = true;
		} catch (e) {
			compactionError = e instanceof Error ? e.message : String(e);
		} finally {
			isCompacting = false;
		}
	}

	async function handleApprove() {
		if (!proposedLore.trim()) return;
		await story.applyCompactedLore(proposedLore.trim());
		diffModalOpen = false;
		proposedLore = '';
		pendingDiff = null;
	}

	function handleReject() {
		diffModalOpen = false;
		proposedLore = '';
		pendingDiff = null;
	}

	function openEditModal() {
		editDraft = currentLore ?? '';
		editModalOpen = true;
	}

	async function saveEdit() {
		const trimmed = editDraft.trim();
		if (trimmed) {
			await story.applyCompactedLore(trimmed);
		} else {
			await story.clearCompactedLore();
		}
		editModalOpen = false;
	}

	async function handleUndo() {
		if (!canUndo) return;
		await story.undoCompactedLore();
	}
</script>

<!-- ── Toolbar ── -->
<div class="flex items-center gap-1.5">
	<!-- Compact Lore button -->
	<button
		onclick={handleCompact}
		disabled={isCompacting || story.entries.length === 0}
		class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors
			bg-violet-500/15 border border-violet-500/25 text-violet-300
			hover:bg-violet-500/25 hover:border-violet-500/40
			disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
		title="Compact world state into system prompt"
	>
		{#if isCompacting}
			<Loader2 class="h-3.5 w-3.5 animate-spin" />
		{:else}
			<RefreshCw class="h-3.5 w-3.5" />
		{/if}
		<span class="hidden sm:inline">Compact</span>
		{#if currentLore}
			<span class="ml-0.5 h-1.5 w-1.5 rounded-full bg-violet-400"></span>
		{/if}
	</button>

	<!-- Edit Lore button -->
	<button
		onclick={openEditModal}
		class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors
			bg-zinc-700/40 border border-zinc-600/30 text-zinc-300
			hover:bg-zinc-700/60 hover:text-zinc-100
			active:scale-95"
		title="Edit compacted lore"
	>
		<Pencil class="h-3.5 w-3.5" />
		<span class="hidden sm:inline">Edit Lore</span>
	</button>

	<!-- Undo button -->
	{#if canUndo}
		<button
			onclick={handleUndo}
			class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors
				bg-zinc-700/40 border border-zinc-600/30 text-zinc-400
				hover:bg-zinc-700/60 hover:text-zinc-200
				active:scale-95"
			title="Undo last compaction"
		>
			<Undo2 class="h-3.5 w-3.5" />
			<span class="hidden sm:inline">Undo</span>
		</button>
	{/if}

	<!-- Error badge -->
	{#if compactionError}
		<span class="text-xs text-red-400 truncate max-w-[120px]" title={compactionError}>
			⚠ Failed
		</span>
	{/if}
</div>


<!-- ── Diff Review Modal ── -->
{#if diffModalOpen}
	<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
		<!-- Backdrop -->
		<button
			class="absolute inset-0 bg-black/70 backdrop-blur-sm"
			onclick={handleReject}
		></button>

		<!-- Panel -->
		<div class="relative z-10 flex w-full max-w-2xl flex-col rounded-t-2xl sm:rounded-2xl
			border border-zinc-700/60 bg-zinc-900 shadow-2xl shadow-black/50
			max-h-[88vh]">

			<!-- Header -->
			<div class="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
				<div class="flex items-center gap-2.5">
					<BookMarked class="h-4 w-4 text-violet-400" />
					<h3 class="font-display text-sm font-semibold tracking-wide text-zinc-100">
						Review Compacted Lore
					</h3>
					<span class="rounded-md bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
						{wordCount} words
					</span>
				</div>
				<button onclick={handleReject} class="text-zinc-500 hover:text-zinc-300 transition-colors">
					<X class="h-4 w-4" />
				</button>
			</div>

			<!-- Diff legend -->
			<div class="flex items-center gap-4 border-b border-zinc-800 px-5 py-2 text-[10px]">
				<span class="flex items-center gap-1.5 text-emerald-400">
					<span class="h-2 w-2 rounded-sm bg-emerald-500/40 border border-emerald-500/60"></span>
					Added ({pendingDiff?.added.length ?? 0})
				</span>
				<span class="flex items-center gap-1.5 text-red-400">
					<span class="h-2 w-2 rounded-sm bg-red-500/40 border border-red-500/60"></span>
					Removed ({pendingDiff?.removed.length ?? 0})
				</span>
				<span class="flex items-center gap-1.5 text-zinc-500">
					<span class="h-2 w-2 rounded-sm bg-zinc-700 border border-zinc-600"></span>
					Unchanged ({pendingDiff?.unchanged.length ?? 0})
				</span>
			</div>

			<!-- Diff content -->
			<div class="flex-1 overflow-y-auto px-5 py-4">
				<div class="space-y-0.5 font-mono text-xs leading-relaxed">
					{#each diffLines as line}
						{#if line.kind === 'added'}
							<div class="rounded px-2 py-0.5 bg-emerald-950/40 border-l-2 border-emerald-500/60 text-emerald-300">
								+ {line.text}
							</div>
						{:else if line.kind === 'removed'}
							<div class="rounded px-2 py-0.5 bg-red-950/30 border-l-2 border-red-500/50 text-red-400 line-through opacity-70">
								− {line.text}
							</div>
						{:else}
							<div class="px-2 py-0.5 text-zinc-600">
								{line.text}
							</div>
						{/if}
					{/each}

					{#if diffLines.length === 0}
						<p class="text-zinc-500 text-center py-8">No changes detected.</p>
					{/if}
				</div>
			</div>

			<!-- Footer -->
			<div class="flex items-center justify-between border-t border-zinc-800 px-5 py-3">
				<span class="text-[10px] text-zinc-600">
					Review carefully — this replaces the World State in your system prompt.
				</span>
				<div class="flex items-center gap-2">
					<button
						onclick={handleReject}
						class="flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs text-zinc-400
							hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
					>
						<XCircle class="h-3.5 w-3.5" />
						Reject
					</button>
					<button
						onclick={handleApprove}
						class="flex items-center gap-1.5 rounded-lg bg-violet-600/25 border border-violet-500/40
							px-4 py-2 text-xs font-medium text-violet-300
							hover:bg-violet-600/40 hover:border-violet-500/60 transition-colors active:scale-95"
					>
						<Check class="h-3.5 w-3.5" />
						Approve
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}


<!-- ── Edit Modal ── -->
{#if editModalOpen}
	<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
		<!-- Backdrop -->
		<button
			class="absolute inset-0 bg-black/70 backdrop-blur-sm"
			onclick={() => editModalOpen = false}
		></button>

		<!-- Panel -->
		<div class="relative z-10 flex w-full max-w-xl flex-col rounded-t-2xl sm:rounded-2xl
			border border-zinc-700/60 bg-zinc-900 shadow-2xl shadow-black/50
			max-h-[88vh]">

			<!-- Header -->
			<div class="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
				<div class="flex items-center gap-2.5">
					<Pencil class="h-4 w-4 text-violet-400" />
					<h3 class="font-display text-sm font-semibold tracking-wide text-zinc-100">
						Edit Compacted Lore
					</h3>
				</div>
				<button onclick={() => editModalOpen = false} class="text-zinc-500 hover:text-zinc-300 transition-colors">
					<X class="h-4 w-4" />
				</button>
			</div>

			<!-- Content -->
			<div class="flex-1 overflow-y-auto px-5 py-4 space-y-3">
				<p class="text-xs text-zinc-500 leading-relaxed">
					This block is injected into the system prompt header as
					<span class="font-mono text-violet-400">## World State</span>.
					It receives the highest attention weight — above all five context tiers.
				</p>
				<textarea
					bind:value={editDraft}
					placeholder="## World State&#10;&#10;Write a present-tense summary of the current world situation...&#10;&#10;## Characters&#10;&#10;## Locations&#10;&#10;## Active Threads"
					rows="14"
					class="w-full resize-none rounded-xl border border-zinc-700/60 bg-zinc-800/60
						px-4 py-3 text-sm text-zinc-200 placeholder:text-zinc-600
						focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/30
						leading-relaxed font-mono"
				></textarea>
				<div class="flex items-center justify-between text-[10px] text-zinc-600">
					<span>
						{editDraft.trim() ? `~${Math.ceil(editDraft.trim().length / 4)} tokens · ${editDraft.split(/\s+/).filter(Boolean).length} words` : 'Empty — clears World State block'}
					</span>
					{#if editDraft !== (currentLore ?? '')}
						<span class="text-violet-400">Unsaved changes</span>
					{/if}
				</div>
			</div>

			<!-- Footer -->
			<div class="flex items-center justify-end gap-2 border-t border-zinc-800 px-5 py-3">
				{#if editDraft.trim() && editDraft !== (currentLore ?? '')}
					<button
						onclick={() => { editDraft = currentLore ?? ''; }}
						class="rounded-lg px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
					>
						Reset
					</button>
				{/if}
				<button
					onclick={() => editModalOpen = false}
					class="rounded-lg px-4 py-2 text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={saveEdit}
					class="rounded-lg bg-violet-600/20 border border-violet-500/30 px-4 py-2
						text-xs font-medium text-violet-300
						hover:bg-violet-600/35 hover:border-violet-500/50 transition-colors active:scale-95"
				>
					Save
				</button>
			</div>
		</div>
	</div>
{/if}
