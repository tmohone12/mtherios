<script lang="ts">
	import { AlertTriangle, BookOpen, Database, FileArchive, Plus, Trash2, Upload, Download, Layers, Sparkles, RefreshCw, Wifi } from 'lucide-svelte';
	import { app } from '$lib/stores/app.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import {
		createBackendShelf,
		deleteStoryEverywhere,
		listBackendShelves,
		repairBackendWikiNow,
		refreshStoryCatalog,
	} from '$lib/services/serverStories';
	import type { ShelfSummary } from '$lib/contracts/shelves';
	import { downloadStoryAsJson, importStoryFromJson } from '$lib/services/storySync';
	import { importStoryFromWiki } from '$lib/services/wikiImport';
	import type { Story } from '$lib/types';
	import { onMount } from 'svelte';

	let shelves = $state<ShelfSummary[]>([]);
	let stories = $state<Story[]>([]);
	let confirmDelete = $state<string | null>(null);
	let importing = $state(false);
	let importingWiki = $state(false);
	let creatingShelf = $state(false);
	let backendStatus = $state<Record<string, unknown> | null>(null);
	let backendStatusError = $state('');
	let backendActionMessage = $state('');
	let backendActionError = $state('');
	let repairingWiki = $state(false);
	let newShelfName = $state('');
	let newShelfGenre = $state('');
	let fileInput: HTMLInputElement;
	let wikiInput: HTMLInputElement;

	const selectedShelf = $derived(shelves.find((shelf) => shelf.id === app.activeShelfId) ?? shelves[0] ?? null);
	const selectedShelfId = $derived(selectedShelf?.id ?? app.activeShelfId ?? null);
	const visibleStories = $derived(selectedShelfId ? stories.filter((story) => (story.shelfId ?? 'shelf_default') === selectedShelfId) : stories);
	const backendProjection = $derived.by(() => {
		if (!backendStatus) return null;
		const config = asRecord(backendStatus.config);
		const services = asRecord(backendStatus.services);
		const qdrant = asRecord(services.qdrant);
		const ollama = asRecord(services.ollama);
		const jobs = asRecord(backendStatus.jobs);
		const wiki = asRecord(backendStatus.wiki);
		const vaultAttention = numberField(wiki.vaultStale) + numberField(wiki.vaultMissing);
		const indexAttention = numberField(wiki.indexStale) + numberField(wiki.indexMissing);
		return {
			runtimeOk: backendStatus.ok === true && qdrant.ok === true && ollama.ok === true,
			qdrantOk: qdrant.ok === true,
			ollamaOk: ollama.ok === true,
			dataRoot: typeof config.dataRoot === 'string' ? config.dataRoot : 'Data root unavailable',
			failedJobs: numberField(jobs.failed),
			vaultAttention,
			indexAttention,
			wikiAttention: vaultAttention + indexAttention,
		};
	});

	onMount(() => {
		void loadLibrary();
		void loadBackendStatus();
	});

	function asRecord(value: unknown): Record<string, unknown> {
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	}

	function numberField(value: unknown): number {
		return typeof value === 'number' && Number.isFinite(value) ? value : 0;
	}

	async function loadLibrary() {
		try {
			shelves = await listBackendShelves();
		} catch (error) {
			console.warn('[Library] Backend shelves unavailable; using compatibility shelf:', error);
			shelves = [{
				id: 'shelf_default',
				name: 'Default Shelf',
				slug: 'default_shelf',
				description: 'Local cached stories and migrated canon.',
				genre: null,
				coverImageUrl: null,
				settings: {},
				metadata: {},
				storyCount: 0,
				canonRecordCount: 0,
				sourceCount: 0,
				serverVersion: 1,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}];
		}
		if (!app.activeShelfId && shelves[0]) app.openShelf(shelves[0].id);
		await loadStories();
	}

	async function loadBackendStatus() {
		backendStatusError = '';
		try {
			const response = await fetch('/api/app/status');
			if (!response.ok) throw new Error(`status ${response.status}`);
			backendStatus = await response.json() as Record<string, unknown>;
		} catch (error) {
			backendStatus = null;
			backendStatusError = error instanceof Error ? error.message : 'Backend status unavailable';
		}
	}

	async function handleRepairWikiNow() {
		if (repairingWiki) return;
		repairingWiki = true;
		backendActionMessage = '';
		backendActionError = '';
		try {
			const response = await repairBackendWikiNow();
			const result = asRecord(response.result);
			const count = numberField(result.queued);
			backendActionMessage = count > 0
				? `Ran ${count} wiki repair ${count === 1 ? 'job' : 'jobs'}.`
				: 'No wiki repair jobs needed.';
			await loadBackendStatus();
		} catch (error) {
			backendActionError = error instanceof Error ? error.message : 'Failed to repair wiki index.';
		} finally {
			repairingWiki = false;
		}
	}

	async function loadStories() {
		stories = await refreshStoryCatalog(selectedShelfId ? { shelfId: selectedShelfId } : {});
	}

	function formatDate(ts: number) {
		const d = new Date(ts);
		const now = new Date();
		const diff = now.getTime() - d.getTime();
		if (diff < 86400000) return 'Today';
		if (diff < 172800000) return 'Yesterday';
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	async function selectShelf(shelfId: string) {
		app.openShelf(shelfId);
		await loadStories();
	}

	async function handleCreateShelf() {
		const name = newShelfName.trim();
		if (!name) return;
		creatingShelf = true;
		try {
			const result = await createBackendShelf({
				name,
				genre: newShelfGenre.trim() || null,
				description: null,
				tags: [],
				settings: {},
			});
			newShelfName = '';
			newShelfGenre = '';
			shelves = [result.shelf, ...shelves.filter((shelf) => shelf.id !== result.shelfId)];
			app.openShelf(result.shelfId);
			await loadStories();
		} catch (error) {
			console.error('Shelf creation failed:', error);
			alert(`Shelf creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		} finally {
			creatingShelf = false;
		}
	}

	async function handleDelete(id: string) {
		const target = stories.find(s => s.id === id);
		if (!target) return;
		try {
			await deleteStoryEverywhere(target);
			stories = stories.filter(s => s.id !== id);
			confirmDelete = null;
			await loadLibrary();
		} catch (err) {
			console.error('Delete failed:', err);
			alert(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		}
	}

	async function handleExport(e: Event, storyId: string) {
		e.stopPropagation();
		await downloadStoryAsJson(storyId);
	}

	async function handleImport(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		importing = true;
		try {
			await importStoryFromJson(file);
			await settings.init();
			await loadLibrary();
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
			await loadLibrary();
			console.log(`[Wiki Import] Created story ${result.storyId}.`, result.counts);
		} catch (err) {
			console.error('Wiki import failed:', err);
			alert(`Wiki import failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		} finally {
			importingWiki = false;
			input.value = '';
		}
	}
</script>

<input bind:this={fileInput} type="file" accept=".json" class="hidden" onchange={handleImport} />
<input bind:this={wikiInput} type="file" accept=".zip" class="hidden" onchange={handleImportWiki} />

<div class="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
	<div class="px-4 pb-28 pt-5 sm:pb-5">
		<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
			<div>
				<div class="flex items-center gap-2">
					<Database class="h-4 w-4 text-[var(--text-accent)]" />
					<h2 class="font-display text-sm tracking-wide text-[var(--text-primary)]">Library Shelves</h2>
				</div>
				<p class="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--text-muted)]">
					Shelves group backend stories, story-owned canon, source imports, and terminal projections that draw from the same lore workspace.
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<button onclick={() => fileInput.click()} disabled={importing}
					class="flex min-h-11 items-center gap-2 rounded-lg bg-[rgba(212,168,83,0.06)] px-3 py-2 font-display text-xs tracking-wider uppercase text-[var(--text-muted)] transition-colors hover:bg-[rgba(212,168,83,0.12)] hover:text-[var(--text-accent)]">
					<Upload class="h-3.5 w-3.5" /> {importing ? 'Importing...' : 'Import Story'}
				</button>
				<button onclick={() => wikiInput.click()} disabled={importingWiki}
					class="flex min-h-11 items-center gap-2 rounded-lg bg-[rgba(212,168,83,0.06)] px-3 py-2 font-display text-xs tracking-wider uppercase text-[var(--text-muted)] transition-colors hover:bg-[rgba(212,168,83,0.12)] hover:text-[var(--text-accent)]">
					<FileArchive class="h-3.5 w-3.5" /> {importingWiki ? 'Importing...' : 'Import Wiki'}
				</button>
				<button onclick={() => app.startNewStory(selectedShelfId)} disabled={!selectedShelfId}
					class="flex min-h-11 items-center gap-2 rounded-lg bg-[rgba(212,168,83,0.12)] px-4 py-2 font-display text-xs tracking-wider uppercase text-[var(--text-accent)] transition-colors hover:bg-[rgba(212,168,83,0.2)] disabled:opacity-50">
					<Sparkles class="h-3.5 w-3.5" /> New Story + AI Assist
				</button>
			</div>
		</div>

		{#if backendProjection}
			<div class="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
				<span class="inline-flex items-center gap-1.5 {backendProjection.runtimeOk ? 'text-emerald-400' : 'text-amber-300'}">
					<Wifi class="h-3.5 w-3.5" />
					Runtime {backendProjection.runtimeOk ? 'online' : 'attention'}
				</span>
				<span class="max-w-full truncate sm:max-w-[24rem]" title={backendProjection.dataRoot}>Data {backendProjection.dataRoot}</span>
				<span>Qdrant {backendProjection.qdrantOk ? 'ok' : 'down'}</span>
				<span>Ollama {backendProjection.ollamaOk ? 'ok' : 'down'}</span>
				{#if backendProjection.wikiAttention > 0}
					<span class="inline-flex items-center gap-1 text-amber-300">
						<AlertTriangle class="h-3.5 w-3.5" />
						{#if backendProjection.vaultAttention > 0}
							{backendProjection.vaultAttention} wiki vault {backendProjection.vaultAttention === 1 ? 'item' : 'items'} need sync
						{:else}
							{backendProjection.indexAttention} wiki {backendProjection.indexAttention === 1 ? 'index' : 'indexes'} need repair
						{/if}
					</span>
					<button
						class="inline-flex min-h-11 items-center gap-1 rounded-md border border-amber-500/30 px-2 py-1 text-amber-200 transition-colors hover:bg-amber-500/10 disabled:opacity-50"
						disabled={repairingWiki}
						onclick={handleRepairWikiNow}
					>
						<RefreshCw class="h-3.5 w-3.5 {repairingWiki ? 'animate-spin' : ''}" />
						{repairingWiki ? 'Repairing...' : 'Repair wiki now'}
					</button>
				{/if}
				{#if backendProjection.failedJobs > 0}
					<span class="inline-flex items-center gap-1 text-rose-300">
						<AlertTriangle class="h-3.5 w-3.5" />
						{backendProjection.failedJobs} failed jobs
					</span>
				{/if}
				{#if backendActionMessage}
					<span class="text-emerald-300">{backendActionMessage}</span>
				{/if}
				{#if backendActionError}
					<span class="text-rose-300">{backendActionError}</span>
				{/if}
			</div>
		{:else if backendStatusError}
			<div class="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
				Runtime status unavailable: {backendStatusError}
			</div>
		{/if}

		<section class="mb-4 grid gap-3 lg:grid-cols-[1fr_18rem]">
			<div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
				{#each shelves as shelf}
					<button
						class="min-w-0 w-full rounded-xl border p-4 text-left transition-all {selectedShelfId === shelf.id ? 'border-[var(--color-gold-600)] bg-[rgba(212,168,83,0.10)]' : 'border-[var(--border-primary)] bg-[var(--bg-tertiary)] hover:border-[var(--color-gold-600)]/60'}"
						onclick={() => selectShelf(shelf.id)}
					>
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<Layers class="h-4 w-4 text-[var(--text-accent)]" />
									<h3 class="truncate font-display text-sm tracking-wide text-[var(--text-primary)]">{shelf.name}</h3>
								</div>
								<p class="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">{shelf.description ?? shelf.genre ?? 'Shared Mtherios canon shelf'}</p>
							</div>
							<span class="rounded-full bg-[rgba(212,168,83,0.10)] px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--text-accent)]">{shelf.storyCount} stories</span>
						</div>
						<div class="mt-3 flex gap-3 text-[11px] text-[var(--text-muted)]">
							<span>{shelf.canonRecordCount} canon</span>
							<span>{shelf.sourceCount} sources</span>
						</div>
					</button>
				{/each}
			</div>

			<form class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4" onsubmit={(e) => { e.preventDefault(); handleCreateShelf(); }}>
				<h3 class="font-display text-sm tracking-wide text-[var(--text-primary)]">Create Shelf</h3>
				<input bind:value={newShelfName} placeholder="Shelf name" class="mt-3 w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--color-gold-600)]" />
				<input bind:value={newShelfGenre} placeholder="Genre / tag" class="mt-2 w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--color-gold-600)]" />
				<button type="submit" disabled={creatingShelf || !newShelfName.trim()} class="mt-3 min-h-11 w-full rounded-lg bg-[rgba(212,168,83,0.12)] px-3 py-2 font-display text-xs uppercase tracking-wider text-[var(--text-accent)] hover:bg-[rgba(212,168,83,0.2)] disabled:opacity-50">
					{creatingShelf ? 'Creating...' : 'Create Shelf'}
				</button>
			</form>
		</section>

		<section class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
			<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div class="min-w-0">
					<div class="flex items-center gap-2">
						<BookOpen class="h-4 w-4 text-[var(--text-accent)]" />
						<h3 class="font-display text-sm tracking-wide text-[var(--text-primary)]">{selectedShelf?.name ?? 'Shelf Stories'}</h3>
					</div>
					<p class="mt-1 text-xs text-[var(--text-muted)]">
						{visibleStories.length} {visibleStories.length === 1 ? 'story' : 'stories'} linked to this backend shelf.
					</p>
				</div>
				<button onclick={() => app.startNewStory(selectedShelfId)} disabled={!selectedShelfId}
					class="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--color-gold-600)]/40 bg-[rgba(212,168,83,0.12)] px-4 py-2 font-display text-xs tracking-wider uppercase text-[var(--text-accent)] transition-colors hover:bg-[rgba(212,168,83,0.2)] disabled:opacity-50">
					<Sparkles class="h-3.5 w-3.5" /> New Story + AI Assist in Shelf
				</button>
			</div>
		</section>

		{#if visibleStories.length === 0}
			<div class="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
				<BookOpen class="h-14 w-14 text-[var(--text-accent)] opacity-60" />
				<div>
					<h2 class="font-display text-xl tracking-wide text-[var(--text-primary)]">No Stories in This Shelf</h2>
					<p class="mt-2 max-w-md text-sm text-[var(--text-muted)]">Create a story here, then import source material into that story's canon before play.</p>
				</div>
				<button onclick={() => app.startNewStory(selectedShelfId)} disabled={!selectedShelfId} class="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] px-8 py-4 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] transition-all hover:shadow-lg hover:shadow-[rgba(212,168,83,0.3)] disabled:opacity-50">
					<Plus class="h-5 w-5" /> Create Story
				</button>
			</div>
		{:else}
			<div class="mt-4 space-y-2">
				{#each visibleStories as s}
					<div class="group relative">
						<button class="flex w-full items-center gap-4 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4 text-left transition-all hover:border-[var(--color-gold-600)] hover:bg-[rgba(212,168,83,0.04)] sm:pr-20" onclick={() => app.openStory(s.id)}>
							<div class="flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--bg-primary)]">
								<BookOpen class="h-5 w-5 text-[var(--text-accent)]" />
							</div>
							<div class="flex-1 min-w-0">
								<div class="truncate font-story text-sm font-semibold text-[var(--text-primary)]">{s.title}</div>
								<div class="mt-0.5 flex items-center gap-2 text-xs text-[var(--text-muted)]">
									<span class="capitalize">{s.genre ?? selectedShelf?.genre ?? 'No genre'}</span>
									<span>·</span>
									<span>{formatDate(s.updatedAt)}</span>
								</div>
							</div>
						</button>

						{#if confirmDelete === s.id}
							<div class="mt-1 flex items-center justify-end gap-1 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] p-1 shadow-lg sm:absolute sm:right-2 sm:top-2 sm:mt-0">
								<button onclick={(e) => { e.stopPropagation(); handleDelete(s.id); }} class="min-h-9 rounded px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10">Delete</button>
								<button onclick={(e) => { e.stopPropagation(); confirmDelete = null; }} class="min-h-9 rounded px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]">Cancel</button>
							</div>
						{:else}
							<div class="mt-1 flex items-center justify-end gap-1 opacity-100 sm:absolute sm:right-2 sm:top-2 sm:mt-0 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
								<button class="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] text-[var(--text-muted)] shadow-sm active:scale-95 hover:bg-[rgba(212,168,83,0.1)] hover:text-[var(--text-accent)] sm:h-8 sm:w-8" title="Export story" aria-label="Export story" onclick={(e) => handleExport(e, s.id)}>
									<Download class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
								<button class="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] text-[var(--text-muted)] shadow-sm active:scale-95 hover:bg-red-500/10 hover:text-red-400 sm:h-8 sm:w-8" title="Delete story" aria-label="Delete story" onclick={(e) => { e.stopPropagation(); confirmDelete = s.id; }}>
									<Trash2 class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
