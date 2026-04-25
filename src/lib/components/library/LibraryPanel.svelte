<script lang="ts">
	import { Plus, Upload, Trash2, Download, FileArchive } from 'lucide-svelte';
	import { app } from '$lib/stores/app.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { getAllStories, deleteStory } from '$lib/services/database';
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
		stories = (await getAllStories()).sort((a, b) => b.updatedAt - a.updatedAt);
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
		await deleteStory(id);
		stories = stories.filter(s => s.id !== id);
		confirmDelete = null;
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
		<!-- Story list -->
		<div class="px-4 py-5">
			<div class="mb-5 flex items-center justify-between">
				<h2 class="font-display text-sm tracking-wide text-[var(--text-primary)]">Your Chronicles</h2>
				<div class="flex items-center gap-2">
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

			<div class="space-y-2">
				{#each stories as s}
					<div class="group relative">
						<button
							class="flex w-full items-center gap-4 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4 text-left transition-all hover:border-[var(--color-gold-600)] hover:bg-[rgba(212,168,83,0.04)]"
							onclick={() => app.openStory(s.id)}
						>
							<div class="flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--bg-primary)]">
								<span class="text-lg">{s.mode === 'adventure' ? '⚔️' : '✍️'}</span>
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
							<div class="absolute right-2 top-2 flex items-center gap-1 rounded-lg bg-[var(--bg-primary)] p-1 shadow-lg border border-[var(--border-primary)]">
								<button onclick={() => handleDelete(s.id)} class="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-500/10">Delete</button>
								<button onclick={() => confirmDelete = null} class="rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]">Cancel</button>
							</div>
						{:else}
							<div class="absolute right-2 top-2 flex items-center gap-0.5 opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
								<button
									class="rounded p-1.5 text-[var(--text-muted)] hover:text-[var(--text-accent)] hover:bg-[rgba(212,168,83,0.1)]"
									title="Export story"
									onclick={(e) => handleExport(e, s.id)}
								>
									<Download class="h-3.5 w-3.5" />
								</button>
								<button
									class="rounded p-1.5 text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10"
									title="Delete story"
									onclick={(e) => { e.stopPropagation(); confirmDelete = s.id; }}
								>
									<Trash2 class="h-3.5 w-3.5" />
								</button>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
