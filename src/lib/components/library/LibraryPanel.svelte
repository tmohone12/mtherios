<script lang="ts">
	import { BookOpen, Database, FileArchive, Plus, Trash2, Upload, Download } from 'lucide-svelte';
	import { app } from '$lib/stores/app.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { refreshStoryCatalog, deleteStoryEverywhere } from '$lib/services/serverStories';
	import { downloadStoryAsJson, importStoryFromJson } from '$lib/services/storySync';
	import { importStoryFromWiki } from '$lib/services/wikiImport';
	import type { Story } from '$lib/types';
	import { onMount } from 'svelte';

	let stories = $state<Story[]>([]);
	let confirmDelete = $state<string | null>(null);
	let importing = $state(false);
	let importingWiki = $state(false);
	let exporting = $state(false);
	let fileInput: HTMLInputElement;
	let wikiInput: HTMLInputElement;

	onMount(loadStories);

	async function loadStories() {
		stories = await refreshStoryCatalog();
	}

	function formatDate(ts: number) {
		const d = new Date(ts);
		const now = new Date();
		const diff = now.getTime() - d.getTime();
		if (diff < 86400000) return 'Today';
		if (diff < 172800000) return 'Yesterday';
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	async function handleDelete(id: string) {
		const target = stories.find(s => s.id === id);
		if (!target) return;
		try {
			await deleteStoryEverywhere(target);
			stories = stories.filter(s => s.id !== id);
			confirmDelete = null;
		} catch (err) {
			console.error('Delete failed:', err);
			alert(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		}
	}

	async function handleExport(e: Event, storyId: string) {
		e.stopPropagation();
		await downloadStoryAsJson(storyId);
	}

	async function handleExportTop() {
		if (stories.length === 0) return;
		exporting = true;
		try {
			if (stories.length === 1) {
				await downloadStoryAsJson(stories[0].id);
			} else {
				// Export all stories sequentially
				for (const s of stories) {
					await downloadStoryAsJson(s.id);
				}
			}
		} catch (err) {
			console.error('Export failed:', err);
		} finally {
			exporting = false;
		}
	}

	async function handleImport(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		importing = true;
		try {
			await importStoryFromJson(file);
			// Re-init settings store so any bundled API profiles are picked up in memory
			await settings.init();
			await loadStories();
		} catch (err) {
			console.error('Import failed:', err);
			alert(`Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		} finally {
			importing = false;
			input.value = '';
		}
	}

	async function handleImportWiki(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		importingWiki = true;
		try {
			const result = await importStoryFromWiki(file);
			await loadStories();
			console.log(
				`[Wiki Import] Created story ${result.storyId} — ${result.counts.entries} entries, ${result.counts.chapters} chapters, ${result.counts.agreements} agreements, ${result.counts.rumors} rumors, ${result.counts.meters} meters.`,
			);
		} catch (err) {
			console.error('Wiki import failed:', err);
			alert(`Wiki import failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		} finally {
			importingWiki = false;
			input.value = '';
		}
	}
</script>

<input
	bind:this={fileInput}
	type="file"
	accept=".json"
	class="hidden"
	onchange={handleImport}
/>
<input
	bind:this={wikiInput}
	type="file"
	accept=".zip"
	class="hidden"
	onchange={handleImportWiki}
/>

<div class="flex h-full flex-col overflow-y-auto">
	{#if stories.length === 0}
		<!-- Empty state -->
		<div class="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-20">
			<div class="relative">
				<svg viewBox="0 0 64 64" fill="none" class="h-20 w-20" style="filter: drop-shadow(0 0 20px rgba(212, 168, 83, 0.3));">
					<path d="M32 6L8 20v24l24 14 24-14V20L32 6z" stroke="url(#lg)" stroke-width="1.5" fill="none"/>
					<circle cx="32" cy="32" r="4" fill="url(#lg)" opacity="0.5"/>
					<defs><linearGradient id="lg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#d4a853"/><stop offset="100%" stop-color="#f0d078"/></linearGradient></defs>
				</svg>
			</div>
			<div class="text-center">
				<h2 class="font-display text-2xl tracking-wide text-[var(--text-primary)]">No Stories Yet</h2>
				<p class="mt-2 max-w-xs text-sm text-[var(--text-muted)]">Create your first story to begin your journey.</p>
			</div>
			<div class="flex flex-col items-center gap-3">
				<button onclick={() => app.startNewStory()}
					class="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] px-8 py-4 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] transition-all hover:shadow-lg hover:shadow-[rgba(212,168,83,0.3)]">
					<Plus class="h-5 w-5" />
					Create Story
				</button>
				<button onclick={() => fileInput.click()} disabled={importing}
					class="flex items-center gap-2 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-accent)]">
					<Upload class="h-4 w-4" />
					{importing ? 'Importing...' : 'Import Story'}
				</button>
				<button onclick={() => wikiInput.click()} disabled={importingWiki}
					class="flex items-center gap-2 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-accent)]">
					<FileArchive class="h-4 w-4" />
					{importingWiki ? 'Importing wiki...' : 'Import Wiki'}
				</button>
			</div>
		</div>
	{:else}
		<!-- Shelf dashboard -->
		<div class="px-4 py-5">
			<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
				<div>
					<div class="flex items-center gap-2">
						<Database class="h-4 w-4 text-[var(--text-accent)]" />
						<h2 class="font-display text-sm tracking-wide text-[var(--text-primary)]">Shelves</h2>
					</div>
					<p class="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--text-muted)]">
						Stories in this shelf use the same terminal world database and lore workspace. Open a story to play, or use its Lore screen to search and edit canon.
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<button onclick={() => fileInput.click()} disabled={importing}
						class="flex items-center gap-2 rounded-lg bg-[rgba(212,168,83,0.06)] px-3 py-2 font-display text-xs tracking-wider uppercase text-[var(--text-muted)] transition-colors hover:bg-[rgba(212,168,83,0.12)] hover:text-[var(--text-accent)]">
						<Upload class="h-3.5 w-3.5" /> {importing ? 'Importing...' : 'Import'}
					</button>
					<button onclick={() => wikiInput.click()} disabled={importingWiki}
						class="flex items-center gap-2 rounded-lg bg-[rgba(212,168,83,0.06)] px-3 py-2 font-display text-xs tracking-wider uppercase text-[var(--text-muted)] transition-colors hover:bg-[rgba(212,168,83,0.12)] hover:text-[var(--text-accent)]"
						title="Import story from a wiki .zip bundle">
						<FileArchive class="h-3.5 w-3.5" /> {importingWiki ? 'Importing...' : 'Import Wiki'}
					</button>
					<button onclick={() => app.startNewStory()}
						class="flex items-center gap-2 rounded-lg bg-[rgba(212,168,83,0.12)] px-4 py-2 font-display text-xs tracking-wider uppercase text-[var(--text-accent)] transition-colors hover:bg-[rgba(212,168,83,0.2)]">
						<Plus class="h-3.5 w-3.5" /> New
					</button>
				</div>
			</div>

			<section class="mb-4 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
				<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<BookOpen class="h-4 w-4 text-[var(--text-accent)]" />
							<h3 class="font-display text-sm tracking-wide text-[var(--text-primary)]">Mtherios Lore Shelf</h3>
						</div>
						<p class="mt-1 text-xs text-[var(--text-muted)]">
							{stories.length} {stories.length === 1 ? 'story' : 'stories'} linked to the shared canon workspace.
						</p>
					</div>
					<button onclick={() => app.startNewStory()}
						class="inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--color-gold-600)]/40 bg-[rgba(212,168,83,0.12)] px-4 py-2 font-display text-xs tracking-wider uppercase text-[var(--text-accent)] transition-colors hover:bg-[rgba(212,168,83,0.2)]">
						<Plus class="h-3.5 w-3.5" /> New Story
					</button>
				</div>
			</section>

			<div class="space-y-2">
				{#each stories as s}
					<div class="group relative">
						<button
							class="flex w-full items-center gap-4 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4 text-left transition-all hover:border-[var(--color-gold-600)] hover:bg-[rgba(212,168,83,0.04)] sm:pr-20"
							onclick={() => app.openStory(s.id)}
						>
							<div class="flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--bg-primary)]">
								<BookOpen class="h-5 w-5 text-[var(--text-accent)]" />
							</div>
							<div class="flex-1 min-w-0">
								<div class="truncate font-story text-sm font-semibold text-[var(--text-primary)]">{s.title}</div>
								<div class="mt-0.5 flex items-center gap-2 text-xs text-[var(--text-muted)]">
									<span class="capitalize">{s.genre ?? 'No genre'}</span>
									<span>·</span>
									<span>{formatDate(s.updatedAt)}</span>
								</div>
							</div>
						</button>

						<!-- Hover actions -->
						{#if confirmDelete === s.id}
							<div class="mt-1 flex items-center justify-end gap-1 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] p-1 shadow-lg sm:absolute sm:right-2 sm:top-2 sm:mt-0">
								<button onclick={(e) => { e.stopPropagation(); handleDelete(s.id); }} class="min-h-9 rounded px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10">Delete</button>
								<button onclick={(e) => { e.stopPropagation(); confirmDelete = null; }} class="min-h-9 rounded px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]">Cancel</button>
							</div>
						{:else}
							<div class="mt-1 flex items-center justify-end gap-1 opacity-100 sm:absolute sm:right-2 sm:top-2 sm:mt-0 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
								<button
									class="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] text-[var(--text-muted)] shadow-sm active:scale-95 hover:bg-[rgba(212,168,83,0.1)] hover:text-[var(--text-accent)] sm:h-8 sm:w-8"
									title="Export story"
									aria-label="Export story"
									onclick={(e) => handleExport(e, s.id)}
								>
									<Download class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
								<button
									class="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] text-[var(--text-muted)] shadow-sm active:scale-95 hover:bg-red-500/10 hover:text-red-400 sm:h-8 sm:w-8"
									title="Delete story"
									aria-label="Delete story"
									onclick={(e) => { e.stopPropagation(); confirmDelete = s.id; }}
								>
									<Trash2 class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
