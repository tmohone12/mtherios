<script lang="ts">
	import { Upload, FileJson, Check, AlertCircle, ChevronDown, ChevronUp, Trash2 } from 'lucide-svelte';
	import { parseLorebook, getImportSummary, convertToEntries, type ImportedEntry, type LorebookImportResult } from '$lib/services/lorebookImporter';
	import { saveCanonicalLorebookEntry } from '$lib/services/canonicalWrites';
	import { uuid } from '$lib/utils/uuid';
	import type { Entry } from '$lib/types';
	import { fade } from 'svelte/transition';

	interface Props {
		/** Pass a real storyId to save immediately, or 'buffer' to defer (wizard mode). */
		storyId: string;
		/** Called with count when saving directly, or with the raw ImportedEntry[] when buffered. */
		onImported?: (countOrEntries: number | ImportedEntry[]) => void;
	}

	let { storyId, onImported }: Props = $props();

	const isBuffered = $derived(storyId === 'buffer');

	let dragOver = $state(false);
	let importResult = $state<LorebookImportResult | null>(null);
	let importedEntries = $state<ImportedEntry[]>([]);
	let saving = $state(false);
	let saved = $state(false);
	let showDetails = $state(false);
	let selectedEntries = $state<Set<number>>(new Set());
	let errorMsg = $state('');

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		const file = e.dataTransfer?.files?.[0];
		if (file) processFile(file);
	}

	function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) processFile(file);
	}

	async function processFile(file: File) {
		importResult = null;
		importedEntries = [];
		saved = false;

		try {
			const text = await file.text();
			const result = parseLorebook(text);
			importResult = result;

			if (result.success) {
				importedEntries = result.entries;
				// Select all by default
				selectedEntries = new Set(result.entries.map((_, i) => i));
			}
		} catch (e) {
			importResult = {
				success: false,
				entries: [],
				errors: [e instanceof Error ? e.message : 'Failed to read file'],
				warnings: [],
				metadata: { format: 'unknown', totalEntries: 0, importedEntries: 0, skippedEntries: 0 },
			};
		}
	}

	function toggleEntry(index: number) {
		const next = new Set(selectedEntries);
		if (next.has(index)) next.delete(index);
		else next.add(index);
		selectedEntries = next;
	}

	function selectAll() {
		selectedEntries = new Set(importedEntries.map((_, i) => i));
	}

	function deselectAll() {
		selectedEntries = new Set();
	}

	async function saveSelected() {
		saving = true;
		errorMsg = '';
		
		// Debug: Check DB status
		const { debugDatabaseStatus } = await import('$lib/services/database');
		await debugDatabaseStatus();
		
		const selected = $state.snapshot(importedEntries).filter((_, i: number) => selectedEntries.has(i));

		if (isBuffered) {
			// Wizard mode: hand entries back to parent, don't write to DB yet
			saving = false;
			saved = true;
			onImported?.(selected);
		} else {
			// Direct mode: write to DB immediately
			try {
				const converted = convertToEntries(selected, 'import');
				const now = Date.now();
				let successCount = 0;

				for (const entry of converted) {
					try {
						const id = uuid();
						console.log('Creating lorebook entry:', { name: entry.name, id, storyId });
						
						const fullEntry: Entry = {
							...entry,
							id,
							storyId,
						};
						
						// Debug: log the full entry structure
						console.log('Full entry structure:', {
							id: fullEntry.id,
							storyId: fullEntry.storyId,
							name: fullEntry.name,
							type: fullEntry.type,
							stateType: fullEntry.state?.type,
							hasDescription: !!fullEntry.description,
							hasInjection: !!fullEntry.injection,
							injectionMode: fullEntry.injection?.mode,
							createdAt: fullEntry.createdAt,
							updatedAt: fullEntry.updatedAt,
						});
						
						await saveCanonicalLorebookEntry(fullEntry, 'create');
						successCount++;
					} catch (entryErr) {
						console.error('Failed to save lorebook entry:', entry.name, entryErr);
						// Log the actual entry data to diagnose schema issues
						console.error('Entry data:', JSON.stringify({
							name: entry.name,
							type: entry.type,
							stateType: entry.state?.type,
							hasInjection: !!entry.injection,
							injectionMode: entry.injection?.mode
						}, null, 2));
					}
				}

				saved = true;
				onImported?.(successCount);
			} catch (e) {
				console.error('Lorebook import failed:', e);
				errorMsg = e instanceof Error ? e.message : 'Import failed — check console for details';
			}
			saving = false;
		}
	}

	const summary = $derived(importedEntries.length > 0 ? getImportSummary(importedEntries) : null);
	const selectedCount = $derived(selectedEntries.size);

	const typeIcons: Record<string, string> = {
		character: '👤',
		location: '📍',
		item: '🗡️',
		faction: '🏴',
		concept: '💡',
		event: '📅',
	};
</script>

<div class="space-y-4">
	{#if !importResult}
		<!-- Drop zone -->
		<div
			class="relative rounded-xl border-2 border-dashed transition-all
				{dragOver ? 'border-[var(--color-gold-400)] bg-[rgba(212,168,83,0.08)]' : 'border-[var(--border-primary)] hover:border-[var(--color-gold-600)]'}"
			ondragover={(e) => { e.preventDefault(); dragOver = true; }}
			ondragleave={() => dragOver = false}
			ondrop={handleDrop}
			role="region"
		>
			<label class="flex cursor-pointer flex-col items-center gap-3 px-6 py-10">
				<div class="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--bg-tertiary)]">
					<Upload class="h-7 w-7 text-[var(--text-accent)]" />
				</div>
				<div class="text-center">
					<span class="font-display text-sm font-semibold text-[var(--text-primary)]">Import Lorebook</span>
					<p class="mt-1 text-xs text-[var(--text-muted)]">
						Drop a JSON file or tap to browse.<br/>
						Supports SillyTavern &amp; Aventura formats.
					</p>
				</div>
				<input type="file" accept=".json,.jsonl" class="hidden" onchange={handleFileSelect} />
			</label>
		</div>

	{:else if !importResult.success}
		<!-- Error state -->
		<div class="rounded-xl border border-red-500/20 bg-red-500/5 p-4" transition:fade>
			<div class="flex items-center gap-3">
				<AlertCircle class="h-5 w-5 text-red-400" />
				<span class="font-display text-sm font-semibold text-red-400">Import Failed</span>
			</div>
			{#each importResult.errors as error}
				<p class="mt-2 text-sm text-red-300">{error}</p>
			{/each}
			<button class="mt-3 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
				onclick={() => { importResult = null; importedEntries = []; }}>
				Try another file
			</button>
		</div>

	{:else if saved}
		<!-- Success state -->
		<div class="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-center" transition:fade>
			<Check class="mx-auto h-8 w-8 text-emerald-400" />
			<p class="mt-2 font-display text-sm font-semibold text-emerald-400">{selectedCount} entries imported!</p>
			<button class="mt-3 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
				onclick={() => { importResult = null; importedEntries = []; saved = false; }}>
				Import another
			</button>
		</div>

	{:else}
		<!-- Preview & select -->
		<div class="space-y-4" transition:fade>
			<!-- Summary bar -->
			<div class="flex items-center justify-between rounded-xl bg-[var(--bg-tertiary)] px-4 py-3">
				<div class="flex items-center gap-3">
					<FileJson class="h-5 w-5 text-[var(--text-accent)]" />
					<div>
						<span class="font-display text-sm font-semibold text-[var(--text-primary)]">{summary?.total} entries found</span>
						<span class="ml-2 text-xs text-[var(--text-muted)]">({importResult.metadata.format})</span>
					</div>
				</div>
				<button class="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
					onclick={() => showDetails = !showDetails}>
					{#if showDetails}<ChevronUp class="h-4 w-4" />{:else}<ChevronDown class="h-4 w-4" />{/if}
				</button>
			</div>

			{#if summary && showDetails}
			<!-- Type breakdown -->
			<div class="grid grid-cols-3 gap-2">
				{#each Object.entries(summary.byType).filter(([_, count]) => count > 0) as [type, count]}
					<div class="flex items-center gap-2 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-xs">
						<span>{typeIcons[type] ?? '📄'}</span>
						<span class="capitalize text-[var(--text-muted)]">{type}</span>
						<span class="ml-auto font-mono text-[var(--text-primary)]">{count}</span>
					</div>
				{/each}
			</div>
			{/if}

			<!-- Select/deselect all -->
			<div class="flex items-center justify-between">
				<span class="text-xs text-[var(--text-muted)]">{selectedCount} of {importedEntries.length} selected</span>
				<div class="flex gap-2">
					<button class="text-xs text-[var(--text-accent)] hover:underline" onclick={selectAll}>All</button>
					<button class="text-xs text-[var(--text-muted)] hover:underline" onclick={deselectAll}>None</button>
				</div>
			</div>

			<!-- Entry list -->
			<div class="max-h-64 space-y-1.5 overflow-y-auto">
				{#each importedEntries as entry, i}
					<button
						class="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors
							{selectedEntries.has(i)
								? 'border-[var(--color-gold-600)]/30 bg-[rgba(212,168,83,0.06)]'
								: 'border-[var(--border-primary)] opacity-50'}"
						onclick={() => toggleEntry(i)}
					>
						<div class="flex h-6 w-6 items-center justify-center rounded border text-xs
							{selectedEntries.has(i) ? 'border-[var(--color-gold-400)] bg-[var(--color-gold-400)] text-[var(--bg-primary)]' : 'border-[var(--border-primary)]'}">
							{#if selectedEntries.has(i)}<Check class="h-3.5 w-3.5" />{/if}
						</div>
						<span class="text-sm">{typeIcons[entry.type] ?? '📄'}</span>
						<div class="flex-1 min-w-0">
							<div class="truncate text-sm text-[var(--text-primary)]">{entry.name}</div>
							<div class="truncate text-xs text-[var(--text-muted)]">{entry.keywords.slice(0, 3).join(', ')}</div>
						</div>
					</button>
				{/each}
			</div>

			<!-- Actions -->
			<div class="flex gap-3">
				<button class="flex-1 rounded-xl border border-[var(--border-primary)] px-4 py-3 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
					onclick={() => { importResult = null; importedEntries = []; }}>
					Cancel
				</button>
				<button class="flex-1 rounded-xl bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] px-4 py-3 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] transition-all hover:shadow-lg hover:shadow-[rgba(212,168,83,0.3)] disabled:opacity-50"
					disabled={selectedCount === 0 || saving}
					onclick={saveSelected}>
					{#if saving}Importing...{:else}Import {selectedCount} Entries{/if}
				</button>
			</div>

			{#if errorMsg}
				<div class="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
					{errorMsg}
				</div>
			{/if}

			{#if importResult.warnings.length > 0}
				<div class="text-xs text-amber-400/70">
					⚠ {importResult.warnings.length} warnings during parsing
				</div>
			{/if}
		</div>
	{/if}
</div>
