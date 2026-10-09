<script lang="ts">
	import { AlertTriangle, ArrowLeft, ArrowRight, BookOpen, ChevronDown, FileArchive, Plus, Search, Trash2, Upload, Download, Layers, RefreshCw, Wifi, ArchiveRestore } from 'lucide-svelte';
	import { app } from '$lib/stores/app.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import {
		createBackendShelf,
		deleteStoryEverywhere,
		listBackendShelves,
		listBackendStories,
		repairBackendWikiNow,
		restoreBackendStory,
		refreshStoryCatalog,
	} from '$lib/services/serverStories';
	import type { ShelfSummary } from '$lib/contracts/shelves';
	import { downloadStoryAsJson, importStoryFromJson } from '$lib/services/storySync';
	import { importStoryFromWiki } from '$lib/services/wikiImport';
	import { parseStoryExportBundle } from '$lib/contracts/worldDatabase';
	import type { Story } from '$lib/types';
	import { onMount } from 'svelte';

	let shelves = $state<ShelfSummary[]>([]);
	let stories = $state<Story[]>([]);
	let archivedStories = $state<Story[]>([]);
	let showTrash = $state(false);
	let confirmDelete = $state<string | null>(null);
	let confirmPurge = $state<string | null>(null);
	let importing = $state(false);
	type CampaignImportReview = { ready: boolean; mode: 'copy' | 'merge'; sourceProjectId: string; sourceProjectName: string; destinationProjectId: string | null; destinationProjectName: string | null; storyTitle: string; content: { typeCount: number; itemCount: number; reusedTypes: number; newTypes: number } | null; conflicts: { kind: string; message: string; sourceId: string; destinationId?: string }[] };
	let importFile = $state.raw<File | null>(null), importBundle = $state.raw<unknown>(null);
	let importPreview = $state<CampaignImportReview | null>(null), importDestination = $state(''), importSourceProjectId = $state(''), importError = $state('');
	let importingWiki = $state(false);
	let creatingShelf = $state(false);
	let backendStatus = $state<Record<string, unknown> | null>(null);
	let backendStatusError = $state('');
	let backendActionMessage = $state('');
	let backendActionError = $state('');
	let repairingWiki = $state(false);
	let newShelfName = $state('');
	let newShelfGenre = $state('');
	let searchQuery = $state('');
	let sortOrder = $state('recent');
	let shelfOpen = $state(false);
	let loadingStories = $state(true);
	let shelvesError = $state('');
	let storiesError = $state('');
	let catalogWarning = $state('');
	let storyRequest = 0;
	let shelfRequest = 0;
	let alive = true;
	let fileInput: HTMLInputElement;
	let wikiInput: HTMLInputElement;

	const selectedShelf = $derived(shelves.find((shelf) => shelf.id === app.activeShelfId) ?? shelves[0] ?? null);
	const selectedShelfId = $derived(selectedShelf?.id ?? app.activeShelfId ?? null);
	const visibleStories = $derived(selectedShelfId ? stories.filter((story) => (story.shelfId ?? 'shelf_default') === selectedShelfId) : stories);
	const filteredStories = $derived(visibleStories
		.filter((story) => `${story.title} ${story.description ?? ''} ${story.genre ?? ''}`.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()))
		.sort((a, b) => sortOrder === 'title' ? a.title.localeCompare(b.title) : sortOrder === 'oldest' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));
	const backendProjection = $derived.by(() => {
		if (!backendStatus) return null;
		const config = asRecord(backendStatus.config);
		const services = asRecord(backendStatus.services);
		const qdrant = asRecord(services.qdrant);
		const ollama = asRecord(services.ollama);
		const jobs = asRecord(backendStatus.jobs);
		const wiki = asRecord(backendStatus.wiki);
		const ollamaRequired = config.wikiEmbedProvider === 'ollama' || config.memoryEmbeddingProvider === 'ollama';
		const vaultAttention = numberField(wiki.vaultStale) + numberField(wiki.vaultMissing);
		const indexAttention = numberField(wiki.indexStale) + numberField(wiki.indexMissing);
		return {
			runtimeOk: backendStatus.ok === true && qdrant.ok === true && (!ollamaRequired || ollama.ok === true),
			qdrantOk: qdrant.ok === true,
			ollamaOk: ollama.ok === true,
			ollamaRequired,
			dataRoot: typeof config.dataRoot === 'string' ? config.dataRoot : 'Data root unavailable',
			failedJobs: numberField(jobs.failed),
			vaultAttention,
			indexAttention,
			wikiAttention: vaultAttention + indexAttention,
		};
	});
	const backendHealth = $derived(backendStatusError ? 'Needs attention' : !backendProjection ? 'Connecting' : backendProjection.runtimeOk && backendProjection.failedJobs === 0 && backendProjection.wikiAttention === 0 ? 'Ready' : 'Needs attention');

	onMount(() => {
		void loadLibrary();
		void loadBackendStatus();
		void loadTrash();
		return () => { alive = false; storyRequest += 1; shelfRequest += 1; };
	});

	function asRecord(value: unknown): Record<string, unknown> {
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	}

	function numberField(value: unknown): number {
		return typeof value === 'number' && Number.isFinite(value) ? value : 0;
	}

	async function loadLibrary() {
		const request = ++shelfRequest;
		shelvesError = '';
		try {
			const result = await listBackendShelves();
			if (!alive || request !== shelfRequest) return;
			shelves = result;
		} catch (error) {
			if (!alive || request !== shelfRequest) return;
			shelvesError = 'Could not refresh shelves. Check the runtime connection and try again.';
			console.warn('[Library] Backend shelves unavailable; using compatibility shelf:', error);
			if (shelves.length === 0) shelves = [{
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
		const request = ++storyRequest;
		const shelfId = selectedShelfId;
		loadingStories = true;
		storiesError = '';
		catalogWarning = '';
		try {
			let unavailable = false;
			const result = await refreshStoryCatalog(shelfId ? { shelfId } : {}, () => { unavailable = true; });
			if (!alive || request !== storyRequest) return;
			stories = result;
			if (unavailable) catalogWarning = 'Showing cached stories. The backend is unavailable; recent changes may be missing.';
		} catch (error) {
			if (alive && request === storyRequest) storiesError = error instanceof Error ? error.message : 'Could not load stories.';
		} finally {
			if (alive && request === storyRequest) loadingStories = false;
		}
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
		shelfOpen = true;
		searchQuery = '';
		showTrash = false;
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
		shelfOpen = true;
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
			await loadTrash();
		} catch (err) {
			console.error('Delete failed:', err);
			alert(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		}
	}

	function isArchived(story: Story): boolean {
		const metadata = story.settings as Record<string, unknown> | null;
		return metadata?.archived === true || ((story as Story & { archived?: boolean }).archived === true);
	}

	async function loadTrash() {
		try {
			const rows = await listBackendStories({ includeArchived: true });
			archivedStories = rows
				.filter((row) => row.metadata?.archived === true && Boolean(row.id))
				.map((row): Story => ({
					id: row.clientStoryId ?? row.id,
					shelfId: row.shelfId ?? 'shelf_default',
					title: row.title ?? 'Untitled Chronicle',
					description: row.description ?? null,
					genre: row.genre ?? null,
					serverStoryId: row.id,
					updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.parse(String(row.updatedAt)) || 0,
				} as unknown as Story));
		} catch (err) {
			console.error('Failed to load trash:', err);
			archivedStories = [];
		}
	}

	async function toggleTrash() {
		showTrash = !showTrash;
		if (showTrash) await loadTrash();
	}

	async function handleRestore(serverStoryId: string) {
		try {
			await restoreBackendStory(serverStoryId);
			archivedStories = archivedStories.filter(s => s.serverStoryId !== serverStoryId);
			await loadLibrary();
		} catch (err) {
			console.error('Restore failed:', err);
			alert(`Restore failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		}
	}

	async function handlePurgeForever(id: string | null | undefined) {
		if (!id) return;
		const target = archivedStories.find(s => s.serverStoryId === id);
		if (!target?.serverStoryId) return;
		try {
			await deleteStoryEverywhere(target as Story, { mode: 'purge' });
			archivedStories = archivedStories.filter(s => s.serverStoryId !== id);
			confirmPurge = null;
		} catch (err) {
			console.error('Permanent delete failed:', err);
			alert(`Permanent delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		}
	}

	async function handleExport(e: Event, storyId: string) {
		e.stopPropagation();
		try {
			await downloadStoryAsJson(storyId);
		} catch (err) {
			alert(`Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
		}
	}

	async function handleImport(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		importing = true; importPreview = null; importFile = null; importBundle = null; importError = ''; importDestination = ''; importSourceProjectId = '';
		try {
			const parsed = parseStoryExportBundle(JSON.parse(await file.text()));
			if (parsed.worldDatabase || parsed.backendCanon) {
				importFile = file; importBundle = parsed;
				await reviewCampaignImport();
			} else {
				await importStoryFromJson(file);
				await settings.init();
				await loadLibrary();
			}
		} catch (err) {
			console.error('Import failed:', err);
			importError = `Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
		} finally {
			importing = false;
			input.value = '';
		}
	}

	async function reviewCampaignImport() {
		if (!importBundle) return;
		importing = true; importError = ''; importPreview = null;
		try {
			const options = { preserveIds: false, replaceExisting: false, syncWiki: true,
				...(importDestination ? { sourceProjectId: importSourceProjectId, destinationProjectId: importDestination } : {}) };
			const response = await fetch('/api/database/import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bundle: importBundle, options }) });
			const body = await response.json();
			if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Import review failed.');
			importPreview = body as CampaignImportReview;
			importSourceProjectId = importPreview.sourceProjectId;
		} catch (error) {
			importError = error instanceof Error ? error.message : String(error);
		} finally { importing = false; }
	}

	async function confirmCampaignImport() {
		if (!importFile || !importPreview?.ready || importing) return;
		const previous = JSON.stringify(importPreview);
		await reviewCampaignImport();
		if (!importPreview?.ready || JSON.stringify(importPreview) !== previous) {
			if (!importError) importError = 'Destination changed. Review the updated import before continuing.';
			return;
		}
		importing = true; importError = '';
		try {
			await importStoryFromJson(importFile, importDestination ? { sourceProjectId: importPreview.sourceProjectId, destinationProjectId: importDestination } : undefined);
			importFile = null; importBundle = null; importPreview = null; importDestination = ''; importSourceProjectId = '';
			await settings.init(); await loadLibrary();
		} catch (error) {
			importError = error instanceof Error ? error.message : String(error);
		} finally { importing = false; }
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
<input bind:this={fileInput} type="file" accept=".json" class="hidden" aria-label="Import story file" onchange={handleImport} />
<input bind:this={wikiInput} type="file" accept=".zip" class="hidden" aria-label="Import wiki archive" onchange={handleImportWiki} />

<div class="library-scroll">
	<div class="library-page">
		<header class="library-header">
			<div>
				<p class="eyebrow">The stories you make your own</p>
				<h1>{shelfOpen ? selectedShelf?.name ?? "Your stories" : "Your shelves"}<span class="heading-period">.</span></h1>
				<p class="page-description">{shelfOpen ? "Choose a story to continue." : "Choose a shelf to explore its stories."}</p>
			</div>
			<div class="header-actions">
				<details class="import-menu">
					<summary class="button button-secondary"><Upload size={15} /> Import <ChevronDown size={14} /></summary>
					<div class="import-options">
						<button onclick={() => fileInput.click()} disabled={importing}><Upload size={16} /><span>{importing ? 'Importing story…' : 'Import story'}<small>Restore a story from JSON</small></span></button>
						<button onclick={() => wikiInput.click()} disabled={importingWiki}><FileArchive size={16} /><span>{importingWiki ? 'Importing wiki…' : 'Import wiki'}<small>Bring a wiki ZIP into a new story</small></span></button>
					</div>
				</details>
				{#if shelfOpen}<button class="button button-primary" onclick={() => app.startNewStory(selectedShelfId)} disabled={!selectedShelfId}><Plus size={17} /> New story</button>{/if}
			</div>
		</header>
		{#if importFile}
			<section class="campaign-import-review" aria-label="Campaign import review">
				<h2>Review campaign import</h2>
				{#if importPreview}<p>{importPreview.storyTitle} from {importPreview.sourceProjectName} ({importPreview.sourceProjectId})</p>{/if}
				<label>Destination project <select bind:value={importDestination} onchange={() => void reviewCampaignImport()} disabled={importing}>
					<option value="">Create a new project</option>
					{#each shelves as shelf}<option value={shelf.id}>Merge into {shelf.name}</option>{/each}
				</select></label>
				{#if importPreview}
					{#if importPreview.content}<p>{importPreview.content.itemCount} documents; {importPreview.content.newTypes} new types; {importPreview.content.reusedTypes} existing types.</p>{/if}
					{#if importPreview.conflicts.length}<p role="alert">{importPreview.conflicts.length} conflict{importPreview.conflicts.length === 1 ? '' : 's'} found. Nothing has been imported.</p><ul>{#each importPreview.conflicts as conflict}<li>{conflict.message} Source ID: {conflict.sourceId}{conflict.destinationId ? `; destination ID: ${conflict.destinationId}` : ''}</li>{/each}</ul>{:else}<p>No project type or path conflicts found. The complete bundle is validated again during import.</p>{/if}
				{:else}<p>{importing ? 'Checking destination…' : 'Choose a destination to retry the review.'}</p>{/if}
				<button class="button button-primary" onclick={confirmCampaignImport} disabled={importing || !importPreview?.ready}>Import reviewed campaign</button>
				<button class="button button-secondary" onclick={() => { importFile = null; importBundle = null; importPreview = null; importDestination = ''; importSourceProjectId = ''; importError = ''; }} disabled={importing}>Cancel</button>
			</section>
		{/if}
		{#if importError}<p role="alert" class="campaign-import-error">{importError}</p>{/if}

		<section class="shelf-section" aria-label="Library shelves">
			<div class="shelf-toolbar">
				{#if shelfOpen}<button class="button button-secondary" onclick={() => { shelfOpen = false; searchQuery = ''; showTrash = false; }}><ArrowLeft size={15} />All shelves</button>{/if}
				<details class="create-shelf">
					<summary class="button button-quiet"><Plus size={15} /> New shelf</summary>
					<form class="shelf-form" onsubmit={(e) => { e.preventDefault(); handleCreateShelf(); }}>
						<h3>A home for a new world</h3>
						<p>Group stories that share a setting or theme.</p>
						<label for="library-shelf-name">Shelf name</label>
						<input id="library-shelf-name" bind:value={newShelfName} placeholder="e.g. The Northern Kingdoms" required />
						<label for="library-shelf-genre">Genre <span>(optional)</span></label>
						<input id="library-shelf-genre" bind:value={newShelfGenre} placeholder="e.g. Epic fantasy" />
						<button type="submit" class="button button-primary" disabled={creatingShelf || !newShelfName.trim()}>{creatingShelf ? 'Creating…' : 'Create shelf'}<ArrowRight size={15} /></button>
					</form>
				</details>
			</div>
			{#if !shelfOpen}
				{#if shelvesError}<div class="catalog-notice" role="alert"><p>{shelvesError}</p><button class="button button-secondary" onclick={loadLibrary}>Retry</button></div>{/if}
				<div class="shelf-grid">
					{#each shelves as shelf (shelf.id)}
						<button class="shelf-card" onclick={() => selectShelf(shelf.id)} aria-label={`Open shelf ${shelf.name}`}>
							<Layers size={28} strokeWidth={1.2} /><h2>{shelf.name}</h2>
							<p>{shelf.description || shelf.genre || 'A home for your stories.'}</p>
							<span>{shelf.storyCount} {shelf.storyCount === 1 ? 'story' : 'stories'}<ArrowRight size={16} /></span>
						</button>
					{/each}
				</div>
			{:else}
			<div class="collection-toolbar">
				<div class="collection-heading"><h2>Stories</h2><p>{loadingStories ? 'Loading stories…' : `${visibleStories.length} ${visibleStories.length === 1 ? 'story' : 'stories'}`}{#if selectedShelf?.genre}<span> / </span>{selectedShelf.genre}{/if}</p></div>
				<div class="collection-controls">
					<label class="search-control"><Search size={16} /><input type="search" aria-label="Search stories in this shelf" placeholder="Find a story…" bind:value={searchQuery} /></label>
					<select aria-label="Sort stories" bind:value={sortOrder}><option value="recent">Recently updated</option><option value="title">Title A–Z</option><option value="oldest">Oldest updated</option></select>
				</div>
			</div>

			{#if shelvesError || storiesError || catalogWarning}
				<div class="catalog-notice" role="alert"><AlertTriangle size={16} /><div>{#if shelvesError}<p>{shelvesError}</p>{/if}{#if storiesError}<p>{storiesError}</p>{/if}{#if catalogWarning}<p>{catalogWarning}</p>{/if}</div><button class="button button-secondary" onclick={loadLibrary} disabled={loadingStories}><RefreshCw size={14} />Retry</button></div>
			{/if}
			{#if loadingStories}
				<div class="empty-collection" role="status"><RefreshCw size={26} class="animate-spin" /><p>Loading stories…</p></div>
			{:else if visibleStories.length === 0 && (shelvesError || storiesError || catalogWarning)}
				<div class="empty-collection"><BookOpen size={32} strokeWidth={1.2} /><h3>Stories are unavailable.</h3><p>Reconnect and retry to refresh your collection.</p></div>
			{:else if visibleStories.length === 0}
				<div class="empty-collection"><BookOpen size={32} strokeWidth={1.2} /><h3>An unwritten chapter.</h3><p>This shelf is ready for its first story.</p><button class="button button-secondary" onclick={() => app.startNewStory(selectedShelfId)} disabled={!selectedShelfId}><Plus size={16} /> Create a story</button></div>
			{:else if filteredStories.length === 0}
				<div class="empty-collection" role="status"><Search size={30} strokeWidth={1.2} /><h3>No stories found.</h3><p>Try another title, genre, or word from your story.</p><button class="button button-secondary" onclick={() => searchQuery = ''}>Clear search</button></div>
			{:else}
				<div class="story-grid">
					{#each filteredStories as story, index (story.id)}
						<article class="story-card">
							<button class="story-open" onclick={() => app.openStory(story.id)} aria-label={`Open ${story.title}`}>
								<div class="story-cover" aria-hidden="true"><span class="cover-index">{String(index + 1).padStart(2, '0')}</span><div class="cover-frame"><BookOpen size={32} strokeWidth={1} /></div><span class="cover-caption">{story.genre ?? selectedShelf?.genre ?? 'A MythEngine story'}</span></div>
									<div class="story-copy"><p class="story-genre">{story.genre ?? selectedShelf?.genre ?? 'Uncharted worlds'}</p><h3>{story.title}</h3><p class="story-description">{story.description || 'A story waiting for your next choice.'}</p></div>
							</button>
							<div class="story-footer"><span>{formatDate(story.updatedAt)}{#if story.syncStatus}<span class="sync-label"> · {story.syncStatus}</span>{/if}</span>
								<div class="story-actions"><button class="icon-button" title="Export story" aria-label={`Export ${story.title}`} onclick={(e) => handleExport(e, story.id)}><Download size={15} /></button><button class="icon-button danger-hover" title="Move to trash" aria-label={`Move ${story.title} to trash`} onclick={() => confirmDelete = story.id}><Trash2 size={15} /></button></div>
							</div>
							{#if confirmDelete === story.id}
								<div class="delete-confirmation" role="group" aria-label={`Confirm moving ${story.title} to trash`}><p>Move this story to trash?</p><div><button class="button button-quiet" onclick={() => confirmDelete = null}>Cancel</button><button class="button button-danger" onclick={() => handleDelete(story.id)}>Move to trash</button></div></div>
							{/if}
						</article>
					{/each}
					{#if !searchQuery.trim()}
						<button class="new-story-card" onclick={() => app.startNewStory(selectedShelfId)} disabled={!selectedShelfId}><span class="new-story-icon"><Plus size={25} strokeWidth={1.25} /></span><span class="new-story-title">Begin something new</span><span>A new world. A different you.</span></button>
					{/if}
				</div>
			{/if}
			{#if searchQuery.trim() && !loadingStories}<p class="search-result-count" aria-live="polite">{filteredStories.length} {filteredStories.length === 1 ? 'story' : 'stories'} matching “{searchQuery.trim()}”</p>{/if}
			{/if}
		</section>

		<footer class="library-footer">
			<div class="collection-facts"><span><Layers size={14} />{shelves.length} {shelves.length === 1 ? 'shelf' : 'shelves'}</span>{#if shelfOpen && selectedShelf}<span>{selectedShelf.canonRecordCount} canon records</span><span>{selectedShelf.sourceCount} sources</span>{/if}</div>
			<button class="button button-quiet trash-toggle" aria-expanded={showTrash} aria-controls="library-trash" onclick={toggleTrash}><Trash2 size={14} /> Trash <span class="shelf-count">{archivedStories.length}</span><ChevronDown size={14} class={showTrash ? 'rotate-180' : ''} /></button>
		</footer>
		{#if showTrash}
			<section id="library-trash" class="trash-section" aria-label="Trashed stories"><h2>Trash</h2><p class="trash-description">Stories here keep their canon and can be restored. Deleting forever is permanent.</p>
				{#if archivedStories.length === 0}<p class="trash-empty">Your trash is empty.</p>
				{:else}<div class="trash-list">{#each archivedStories as story (story.serverStoryId)}<div class="trash-row"><div class="trash-story"><h3>{story.title}</h3><p>Archived · {formatDate(story.updatedAt)}</p></div><div class="trash-actions">{#if confirmPurge === story.serverStoryId}<button class="button button-danger" onclick={() => handlePurgeForever(story.serverStoryId)}>Delete forever</button><button class="button button-quiet" onclick={() => confirmPurge = null}>Cancel</button>{:else}<button class="button button-quiet restore-button" onclick={() => handleRestore(story.serverStoryId as string)}><ArchiveRestore size={15} /> Restore</button><button class="icon-button danger-hover" title="Delete forever" aria-label={`Permanently delete ${story.title}`} onclick={() => confirmPurge = story.serverStoryId ?? null}><Trash2 size={15} /></button>{/if}</div></div>{/each}</div>{/if}
			</section>
		{/if}

		<details class="runtime-details">
			<summary><span class="runtime-indicator" class:healthy={backendHealth === 'Ready'}></span><span>{backendHealth === 'Ready' ? 'All systems ready' : backendHealth === 'Connecting' ? 'Connecting to your library' : 'Library needs attention'}</span><span class="runtime-label">Runtime details</span><ChevronDown size={13} /></summary>
			<div class="runtime-content">
				{#if backendProjection}
					<div class="runtime-facts"><span><Wifi size={14} /> Runtime {backendProjection.runtimeOk ? 'online' : 'needs attention'}</span><span>Qdrant {backendProjection.qdrantOk ? 'ok' : 'down'}</span><span>Ollama {backendProjection.ollamaOk ? 'ok' : backendProjection.ollamaRequired ? 'down' : 'optional'}</span></div><p class="data-root">Data location: {backendProjection.dataRoot}</p>
					{#if backendProjection.wikiAttention > 0}<div class="runtime-warning"><AlertTriangle size={15} /><span>{#if backendProjection.vaultAttention > 0}{backendProjection.vaultAttention} wiki vault {backendProjection.vaultAttention === 1 ? 'item needs' : 'items need'} sync{:else}{backendProjection.indexAttention} wiki {backendProjection.indexAttention === 1 ? 'index needs' : 'indexes need'} repair{/if}</span><button class="button button-secondary" disabled={repairingWiki} onclick={handleRepairWikiNow}><RefreshCw size={14} class={repairingWiki ? 'animate-spin' : ''} />{repairingWiki ? 'Repairing…' : 'Repair wiki now'}</button></div>{/if}
					{#if backendProjection.failedJobs > 0}<p class="runtime-error">{backendProjection.failedJobs} failed jobs</p>{/if}
				{:else if backendStatusError}<p class="runtime-warning">Runtime status unavailable: {backendStatusError}</p>{/if}
				{#if backendActionMessage}<p class="runtime-success" role="status">{backendActionMessage}</p>{/if}{#if backendActionError}<p class="runtime-error" role="alert">{backendActionError}</p>{/if}
			</div>
		</details>
	</div>
</div>

<style>
	.shelf-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap:20px; }
	.shelf-card { display:flex; flex-direction:column; align-items:flex-start; min-height:220px; padding:26px; text-align:left; border:1px solid var(--border-primary); border-radius:12px; background:var(--bg-secondary); color:var(--text-accent); }
	.shelf-card:hover { border-color:var(--text-accent); background:var(--bg-tertiary); }
	.shelf-card h2 { margin:20px 0 10px; font:24px var(--font-display); color:var(--text-primary); }
	.shelf-card p { color:var(--text-secondary); font-size:13px; line-height:1.6; }
	.shelf-card > span { display:flex; justify-content:space-between; width:100%; margin-top:auto; padding-top:18px; font-size:12px; }

	.library-scroll { height:100%; min-height:0; overflow-y:auto; overscroll-behavior:contain; }
	.library-page { max-width:1360px; margin:0 auto; padding:44px clamp(22px, 4.2vw, 64px) 36px; }
	.library-header { display:flex; align-items:center; justify-content:space-between; gap:24px; margin-bottom:32px; }
	.eyebrow { display:flex; align-items:center; gap:11px; margin:0 0 10px; color:var(--text-accent); font-size:10px; font-weight:600; letter-spacing:.17em; text-transform:uppercase; }
	h1, h2, h3, p { margin-top:0; }
	h1 { margin-bottom:9px; font-family:var(--font-display); font-size:clamp(36px, 3.4vw, 48px); font-weight:400; line-height:1.14; letter-spacing:-.035em; color:var(--text-primary); }
	.heading-period { color:var(--text-accent); }
	.page-description { margin-bottom:0; font-size:13px; color:var(--text-secondary); }
	.header-actions, .button { display:flex; align-items:center; gap:9px; }
	.button { justify-content:center; min-height:42px; padding:10px 16px; border:1px solid transparent; border-radius:8px; font-size:12px; font-weight:600; line-height:1.4; white-space:nowrap; cursor:pointer; transition:background .16s, border-color .16s, color .16s; }
	.button-primary { background:var(--text-accent); color:var(--bg-primary); }
	.button-primary:hover { filter:brightness(1.09); }
	.button-secondary { border-color:var(--border-primary); background:var(--bg-secondary); color:var(--text-secondary); }
	.button-secondary:hover { border-color:var(--text-accent); color:var(--text-primary); }
	.button-quiet { background:transparent; color:var(--text-secondary); }
	.button-quiet:hover { background:var(--bg-tertiary); color:var(--text-primary); }
	.button-danger { background:color-mix(in srgb, var(--danger) 14%, transparent); color:#dd9b97; border-color:color-mix(in srgb, var(--danger) 30%, transparent); }
	button:disabled { opacity:.45; cursor:not-allowed; }
	button:focus-visible, summary:focus-visible, input:focus-visible, select:focus-visible { outline:2px solid var(--text-accent); outline-offset:4px; }
	summary { list-style:none; cursor:pointer; }
	summary::-webkit-details-marker { display:none; }
	.import-menu, .create-shelf { position:relative; flex-shrink:0; }
	.import-options, .shelf-form { position:absolute; z-index:30; right:0; top:calc(100% + 10px); border:1px solid var(--border-primary); border-radius:12px; background:var(--bg-elevated); box-shadow:0 16px 40px #0005; }
	.import-options { width:264px; padding:6px; }
	.import-options button { display:flex; align-items:center; gap:12px; width:100%; padding:12px; border-radius:7px; text-align:left; color:var(--text-primary); font-size:13px; }
	.import-options button:hover { background:var(--bg-tertiary); }
	.import-options small { display:block; margin-top:3px; font-size:11px; color:var(--text-muted); }
	.campaign-import-review { margin-top:20px; padding:20px; border:1px solid var(--border-primary); border-radius:12px; background:var(--bg-elevated); }
	.campaign-import-review h2 { margin:0 0 8px; font-family:var(--font-display); }
	.campaign-import-review p, .campaign-import-review li { color:var(--text-secondary); font-size:13px; }
	.campaign-import-review select { display:block; margin:8px 0 16px; padding:9px; max-width:100%; color:var(--text-primary); background:var(--bg-primary); border:1px solid var(--border-primary); border-radius:6px; }
	.campaign-import-review .button { margin-right:8px; }
	.campaign-import-error { margin-top:12px; color:var(--text-error, #e77); }
	.shelf-section { margin-top:28px; }
	.shelf-toolbar { display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:1px solid var(--border-primary); padding-bottom:14px; }
	.shelf-count { display:inline-flex; align-items:center; justify-content:center; min-width:21px; padding:1px 5px; border-radius:4px; font-size:10px; background:var(--bg-tertiary); color:var(--text-secondary); }
	.shelf-form { width:310px; padding:22px; }
	.shelf-form h3 { margin:0 0 7px; font-family:var(--font-display); font-size:21px; font-weight:400; }
	.shelf-form p { color:var(--text-secondary); font-size:12px; line-height:1.6; margin-bottom:18px; }
	.shelf-form label { display:block; margin:12px 0 6px; color:var(--text-secondary); font-size:11px; }
	.shelf-form label span { color:var(--text-muted); }
	.shelf-form input { width:100%; padding:11px 12px; border:1px solid var(--border-primary); background:var(--bg-primary); border-radius:6px; font-size:12px; color:var(--text-primary); }
	.shelf-form .button { margin-top:19px; width:100%; }
	.collection-toolbar { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:27px 0 21px; }
	.collection-heading h2 { margin:0 0 5px; font-family:var(--font-display); font-size:23px; font-weight:400; letter-spacing:-.02em; }
	.collection-heading p { margin:0; color:var(--text-muted); font-size:11px; }
	.collection-heading p span { padding:0 5px; opacity:.6; }
	.collection-controls { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
	.catalog-notice { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin-bottom:18px; padding:14px; border:1px solid var(--border-primary); border-radius:8px; color:var(--text-accent); background:var(--bg-secondary); font-size:12px; }
	.catalog-notice > div { flex:1; min-width:160px; }
	.catalog-notice p { margin:0; line-height:1.6; }
	.search-control { display:flex; align-items:center; gap:9px; height:39px; padding:0 12px; border:1px solid var(--border-primary); border-radius:7px; color:var(--text-muted); background:var(--bg-secondary); }
	.search-control input { width:150px; min-width:0; font-size:12px; color:var(--text-primary); background:transparent; }
	.search-control:focus-within { border-color:var(--text-accent); }
	.search-control input:focus-visible { outline:none; }
	.collection-controls select { min-height:39px; max-width:160px; padding:0 9px; border:1px solid var(--border-primary); border-radius:7px; color:var(--text-secondary); background:var(--bg-secondary); font-size:11px; }
	.story-grid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:18px; }
	.story-card { position:relative; min-width:0; border:1px solid var(--border-primary); border-radius:11px; overflow:hidden; background:var(--bg-secondary); transition:border-color .2s, transform .2s; }
	.story-card:hover { border-color:color-mix(in srgb, var(--text-accent) 40%, transparent); transform:translateY(-2px); }
	.story-open { display:block; width:100%; text-align:left; }
	.story-open:focus-visible { outline-offset:-3px; }
	.story-cover { --cover-color:#9eaa8b; position:relative; display:flex; align-items:center; justify-content:center; height:140px; overflow:hidden; color:var(--cover-color); background:linear-gradient(130deg, color-mix(in srgb, var(--cover-color) 13%, var(--bg-secondary)), var(--bg-secondary)); border-bottom:1px solid var(--border-secondary); }
	.story-card:nth-child(3n + 2) .story-cover { --cover-color:#b5a18b; }
	.story-card:nth-child(3n + 3) .story-cover { --cover-color:#8e9ba8; }
	.story-cover::before, .story-cover::after { content:''; position:absolute; height:220px; width:220px; border:1px solid currentColor; opacity:.1; transform:rotate(45deg); }
	.story-cover::after { height:180px; width:180px; }
	.cover-frame { display:flex; align-items:center; justify-content:center; width:61px; height:70px; margin-top:-7px; border:1px solid color-mix(in srgb, var(--cover-color) 25%, transparent); border-radius:30px 30px 2px 2px; }
	.cover-index { position:absolute; top:16px; left:18px; font-family:var(--font-display); font-size:12px; opacity:.65; }
	.cover-caption { position:absolute; bottom:15px; left:18px; right:18px; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:8px; letter-spacing:.17em; text-transform:uppercase; opacity:.7; }
	.story-copy { min-height:159px; padding:21px 20px 17px; }
	.story-genre { margin:0 0 9px; color:var(--text-accent); font-size:9px; font-weight:500; letter-spacing:.1em; text-transform:uppercase; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.story-copy h3 { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2; overflow:hidden; margin:0 0 9px; font-family:var(--font-display); font-size:21px; line-height:1.23; font-weight:400; letter-spacing:-.02em; overflow-wrap:anywhere; }
	.story-description { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2; overflow:hidden; margin:0; color:var(--text-secondary); font-size:11px; line-height:1.7; }
	.story-footer { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:0 20px; padding:10px 0; border-top:1px solid var(--border-secondary); color:var(--text-muted); font-size:10px; }
	.story-footer > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.sync-label { text-transform:capitalize; }
	.story-actions { display:flex; gap:2px; }
	.icon-button { display:flex; align-items:center; justify-content:center; flex-shrink:0; width:32px; height:34px; border-radius:6px; color:var(--text-muted); }
	.icon-button:hover { color:var(--text-accent); background:var(--bg-tertiary); }
	.danger-hover:hover { color:#dd9b97; background:color-mix(in srgb, var(--danger) 10%, transparent); }
	.delete-confirmation { position:absolute; inset:auto 0 0; padding:15px; background:var(--bg-elevated); border-top:1px solid var(--border-primary); box-shadow:0 -10px 24px #0002; }
	.delete-confirmation p { font-size:12px; margin-bottom:10px; color:var(--text-primary); }
	.delete-confirmation > div { display:flex; justify-content:flex-end; gap:6px; }
	.delete-confirmation .button { min-height:36px; font-size:11px; padding:8px 11px; }
	.new-story-card { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; min-height:260px; border:1px dashed var(--border-primary); border-radius:11px; color:var(--text-muted); background:transparent; font-size:11px; transition:background .2s, border-color .2s; }
	.new-story-card:hover { border-color:var(--text-accent); background:color-mix(in srgb, var(--text-accent) 3%, transparent); }
	.new-story-icon { display:flex; align-items:center; justify-content:center; width:49px; height:49px; margin-bottom:7px; border:1px solid var(--border-primary); border-radius:50%; color:var(--text-accent); }
	.new-story-title { font-family:var(--font-display); font-size:21px; color:var(--text-secondary); }
	.empty-collection { display:flex; flex-direction:column; align-items:center; padding:45px 20px; color:var(--text-accent); text-align:center; border:1px dashed var(--border-primary); border-radius:12px; }
	.empty-collection h3 { font-family:var(--font-display); font-size:25px; font-weight:400; margin:17px 0 7px; color:var(--text-primary); }
	.empty-collection p { color:var(--text-secondary); font-size:12px; margin-bottom:22px; }
	.search-result-count { color:var(--text-muted); font-size:11px; margin:15px 0 0; }
	.library-footer { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:14px; margin-top:26px; padding:13px 0; border-top:1px solid var(--border-primary); }
	.collection-facts { display:flex; align-items:center; flex-wrap:wrap; gap:17px; color:var(--text-muted); font-size:10px; }
	.collection-facts span { display:flex; align-items:center; gap:6px; }
	.trash-toggle { padding:6px 8px; min-height:36px; font-size:11px; }
	.trash-section { padding:23px; margin-bottom:18px; border:1px solid var(--border-primary); border-radius:11px; background:var(--bg-secondary); }
	.trash-section h2 { margin:0 0 7px; font-family:var(--font-display); font-weight:400; font-size:23px; }
	.trash-description, .trash-empty { color:var(--text-muted); font-size:12px; line-height:1.6; }
	.trash-empty { margin-bottom:0; }
	.trash-row { display:flex; align-items:center; justify-content:space-between; gap:15px; padding:12px 0; border-top:1px solid var(--border-secondary); }
	.trash-story { min-width:0; }
	.trash-story h3 { font-size:13px; font-weight:500; margin:0 0 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.trash-story p { font-size:10px; color:var(--text-muted); margin:0; }
	.trash-actions { display:flex; align-items:center; gap:4px; flex-shrink:0; }
	.trash-actions .button { min-height:36px; padding:7px 10px; font-size:11px; }
	.restore-button { color:var(--success); }
	.runtime-details { color:var(--text-muted); font-size:10px; }
	.runtime-details summary { display:flex; align-items:center; gap:7px; padding:11px 0; }
	.runtime-indicator { height:5px; width:5px; border-radius:50%; background:var(--text-accent); }
	.runtime-indicator.healthy { background:var(--success); }
	.runtime-label { margin-left:auto; }
	.runtime-content { margin:8px 0; padding:17px; border:1px solid var(--border-primary); border-radius:8px; background:var(--bg-secondary); }
	.runtime-facts, .runtime-facts span { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
	.runtime-facts span { gap:6px; }
	.data-root { margin:12px 0 0; overflow-wrap:anywhere; }
	.runtime-warning { display:flex; align-items:center; flex-wrap:wrap; gap:8px; color:var(--text-accent); margin:12px 0 0; }
	.runtime-warning .button { margin-left:auto; min-height:34px; padding:7px 10px; font-size:10px; }
	.runtime-error { color:#dd9b97; margin:10px 0 0; }
	.runtime-success { color:var(--success); margin:10px 0 0; }
	@media (min-width:1600px) { .story-grid { grid-template-columns:repeat(4, minmax(0, 1fr)); } }
	@media (max-width:1100px) { .story-grid { grid-template-columns:repeat(2, minmax(0, 1fr)); }     .collection-toolbar { align-items:flex-start; } .collection-controls { flex-direction:column; align-items:stretch; } .search-control input { width:145px; } .collection-controls select { max-width:none; } }
	@media (max-width:700px) { .library-page { padding:26px 20px 100px; } .library-header { align-items:flex-start; flex-direction:column; gap:19px; margin-bottom:24px; } .header-actions { width:100%; } .header-actions > .button-primary { margin-left:auto; }       .shelf-section { margin-top:20px; } .shelf-toolbar { gap:8px; } .create-shelf > summary { padding:9px 6px; font-size:11px; } .shelf-form { width:min(310px, calc(100vw - 40px)); } .collection-toolbar { flex-direction:column; gap:16px; padding-top:22px; } .collection-controls { flex-direction:row; width:100%; gap:8px; } .search-control { flex:1; min-width:0; } .search-control input { width:100%; } .collection-controls select { max-width:145px; } .story-grid { gap:13px; } .story-cover { height:125px; } .story-copy { padding:16px; min-height:145px; } .story-copy h3 { font-size:20px; } .story-footer { margin:0 15px; } .sync-label { display:none; } .collection-facts { gap:11px; } .trash-section { padding:18px; } .trash-row { flex-wrap:wrap; gap:8px; } .trash-actions { margin-left:auto; } }
	@media (max-width:440px) { .story-grid { grid-template-columns:1fr; } .story-cover { height:150px; } .story-copy { min-height:0; } .story-copy h3 { font-size:23px; } .new-story-card { min-height:185px; } .story-footer { padding:9px 0; } .icon-button { width:40px; height:40px; } .collection-facts span:last-child { display:none; } }
	@media (max-width:700px) { .import-options { left:0; right:auto; max-width:calc(100vw - 40px); } }
	@media (max-width:700px) { .collection-controls .search-control { flex-basis:100%; } .collection-controls select { flex:1; max-width:none; } }
	@media (prefers-reduced-motion:reduce) { .story-card, .button, .new-story-card { transition:none; } .story-card:hover { transform:none; } }
</style>
