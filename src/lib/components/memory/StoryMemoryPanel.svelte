<script lang="ts">
	import { onMount } from 'svelte';
	import { BookOpen, CloudUpload, Edit3, GitBranch, Loader2, RotateCcw, Save, Search, Shield, Trash2, X } from 'lucide-svelte';
	import {
		getAgreements,
		getArcs,
		getChapters,
		getConversationMemory,
		getFactionActions,
		getStoryThreads,
	} from '$lib/services/database';
	import { importLocalStoryToBackend } from '$lib/services/backendMemory';
	import { deleteCanonicalArc, deleteCanonicalChapter, saveCanonicalArc, saveCanonicalChapter } from '$lib/services/canonicalWrites';
	import {
		createContextCheckpoint,
		listContextCheckpoints,
		refreshStoryCatalog,
		revertToContextCheckpoint,
	} from '$lib/services/serverStories';
	import { story } from '$lib/stores/story.svelte';
	import type { Agreement, Arc, Chapter, ConversationMemoryEntry, FactionActionRecord, Story, StoryThread } from '$lib/types';

	let stories = $state<Story[]>([]);
	let selectedStoryId = $state<string | null>(null);
	let chapters = $state<Chapter[]>([]);
	let arcs = $state<Arc[]>([]);
	let loading = $state(false);
	let searchQuery = $state('');
	let viewMode = $state<'ledger' | 'chapters' | 'arcs'>('ledger');
	let backendSyncing = $state(false);
	let backendMessage = $state<string | null>(null);
	let storyThreads = $state<StoryThread[]>([]);
	let agreements = $state<Agreement[]>([]);
	let factionActions = $state<FactionActionRecord[]>([]);
	let conversationMemory = $state<ConversationMemoryEntry[]>([]);
	let editingChapter = $state<Chapter | null>(null);
	let editingArc = $state<Arc | null>(null);
	let savingEdit = $state(false);
	let deletingRecordId = $state<string | null>(null);
	let contextCheckpoints = $state<Array<Record<string, unknown>>>([]);
	let checkpointLabel = $state('');
	let checkpointBusy = $state(false);
	let checkpointMessage = $state<string | null>(null);

	let chapterTitleDraft = $state('');
	let chapterSummaryDraft = $state('');
	let chapterKeywordsDraft = $state('');
	let chapterCharactersDraft = $state('');
	let chapterLocationsDraft = $state('');
	let chapterThreadsDraft = $state('');
	let chapterToneDraft = $state('');
	let chapterPinnedDraft = $state(false);

	let arcTitleDraft = $state('');
	let arcSummaryDraft = $state('');
	let arcKeyPointsDraft = $state('');
	let arcCharacterArcsDraft = $state('');
	let arcThreadsDraft = $state('');
	let arcEmotionDraft = $state('');

	onMount(async () => {
		stories = await refreshStoryCatalog();
		selectedStoryId = stories[0]?.id ?? null;
		await loadMemory();
	});

	async function loadMemory() {
		if (!selectedStoryId) {
			chapters = [];
			arcs = [];
			storyThreads = [];
			agreements = [];
			factionActions = [];
			conversationMemory = [];
			contextCheckpoints = [];
			return;
		}

		loading = true;
		try {
			if (story.currentStory?.id === selectedStoryId && story.currentStory.serverStoryId) {
				await story.pullBackendProjection();
			}
			const terminalStoryId = story.currentStory?.id === selectedStoryId
				? story.currentStory.serverStoryId
				: selectedStory?.serverStoryId;
			const [loadedChapters, loadedArcs, loadedThreads, loadedAgreements, loadedFactionActions, loadedConversationMemory, loadedCheckpoints] = await Promise.all([
				getChapters(selectedStoryId),
				getArcs(selectedStoryId),
				getStoryThreads(selectedStoryId),
				getAgreements(selectedStoryId),
				getFactionActions(selectedStoryId),
				getConversationMemory(selectedStoryId),
				terminalStoryId ? listContextCheckpoints(terminalStoryId, 20).then((result) => result.checkpoints) : Promise.resolve([]),
			]);
			chapters = loadedChapters;
			arcs = loadedArcs;
			storyThreads = loadedThreads;
			agreements = loadedAgreements;
			factionActions = loadedFactionActions;
			conversationMemory = loadedConversationMemory;
			contextCheckpoints = loadedCheckpoints;
		} finally {
			loading = false;
		}
	}

	async function handleStoryChange(event: Event) {
		selectedStoryId = (event.currentTarget as HTMLSelectElement).value;
		await loadMemory();
	}

	function includesQuery(parts: Array<string | null | undefined>): boolean {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return true;
		return parts.some(part => (part ?? '').toLowerCase().includes(q));
	}

	const selectedStory = $derived(stories.find(s => s.id === selectedStoryId) ?? null);

	const coveredChapterIds = $derived.by(() => new Set(arcs.flatMap(arc => arc.chapterIds)));

	const filteredChapters = $derived.by(() => chapters.filter(chapter => includesQuery([
		chapter.title,
		chapter.summary,
		chapter.emotionalTone,
		...chapter.keywords,
		...chapter.characters,
		...chapter.locations,
		...chapter.plotThreads,
	])));

	const filteredArcs = $derived.by(() => arcs.filter(arc => includesQuery([
		arc.title,
		arc.summary,
		arc.chapterRange,
		arc.emotionalProgression,
		...arc.keyPlotPoints,
		...arc.unresolvedThreads,
		...arc.characterArcs.flatMap(characterArc => [characterArc.name, characterArc.development]),
	])));

	const openThreads = $derived(storyThreads.filter(thread => thread.status !== 'closed' && thread.status !== 'abandoned'));
	const openThreadCount = $derived(openThreads.length || arcs.reduce((count, arc) => count + arc.unresolvedThreads.length, 0));
	const activeAgreements = $derived(agreements.filter(agreement => agreement.status === 'active' || agreement.status === 'contested'));
	const recentFactionPressure = $derived([...factionActions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8));
	const criticalNpcMemory = $derived(conversationMemory
		.filter(memory => memory.importance === 'critical' || memory.importance === 'significant')
		.sort((a, b) => b.storyPosition - a.storyPosition)
		.slice(0, 8));
	const chapterLookup = $derived.by(() => new Map(chapters.map(chapter => [chapter.id, chapter])));

	function applyBackendVersion(localStoryId: string, serverVersion: number) {
		stories = stories.map(s => s.id === localStoryId
			? { ...s, serverVersion, syncStatus: 'synced' }
			: s);
		if (story.currentStory?.id === localStoryId) {
			story.currentStory = {
				...story.currentStory,
				serverVersion,
				syncStatus: 'synced',
			};
		}
	}

	async function bindStoryToBackend() {
		if (!selectedStory || backendSyncing) return;
		backendSyncing = true;
		backendMessage = null;
		try {
			const result = await importLocalStoryToBackend(selectedStory.id);
			backendMessage = `Terminal database bound: ${Object.entries(result.counts).map(([key, value]) => `${key} ${value}`).join(', ')}`;
			stories = stories.map(story => story.id === selectedStory.id
				? { ...story, serverStoryId: result.serverStoryId, serverVersion: result.serverVersion, syncStatus: 'synced' }
				: story);
		} catch (error) {
			backendMessage = error instanceof Error ? error.message : 'Terminal import failed.';
		} finally {
			backendSyncing = false;
		}
	}

	async function saveChapterMemory(chapter: Chapter) {
		const serverVersion = await saveCanonicalChapter(chapter, 'update');
		if (serverVersion) applyBackendVersion(chapter.storyId, serverVersion);
	}

	async function saveArcMemory(arc: Arc) {
		const serverVersion = await saveCanonicalArc(arc, 'update');
		if (serverVersion) applyBackendVersion(arc.storyId, serverVersion);
	}

	async function deleteChapterMemory(chapter: Chapter) {
		if (deletingRecordId) return;
		if (!confirm(`Delete ${chapterTitle(chapter)}?`)) return;
		deletingRecordId = chapter.id;
		try {
			const serverVersion = await deleteCanonicalChapter(chapter.storyId, chapter.id);
			if (serverVersion) applyBackendVersion(chapter.storyId, serverVersion);
			chapters = chapters.filter(item => item.id !== chapter.id);
			arcs = arcs.map(arc => ({
				...arc,
				chapterIds: arc.chapterIds.filter(id => id !== chapter.id),
			}));
		} finally {
			deletingRecordId = null;
		}
	}

	async function deleteArcMemory(arc: Arc) {
		if (deletingRecordId) return;
		if (!confirm(`Delete ${arc.title}?`)) return;
		deletingRecordId = arc.id;
		try {
			const serverVersion = await deleteCanonicalArc(arc.storyId, arc.id);
			if (serverVersion) applyBackendVersion(arc.storyId, serverVersion);
			arcs = arcs.filter(item => item.id !== arc.id);
		} finally {
			deletingRecordId = null;
		}
	}

	async function makeCheckpoint() {
		if (!selectedStory?.serverStoryId || checkpointBusy) return;
		checkpointBusy = true;
		checkpointMessage = null;
		try {
			const result = await createContextCheckpoint(selectedStory.serverStoryId, {
				label: checkpointLabel.trim() || undefined,
				reason: 'Manual context checkpoint',
			});
			applyBackendVersion(selectedStory.id, result.serverVersion);
			contextCheckpoints = [result.checkpoint, ...contextCheckpoints];
			checkpointLabel = '';
			checkpointMessage = 'Checkpoint saved.';
		} catch (error) {
			checkpointMessage = error instanceof Error ? error.message : String(error);
		} finally {
			checkpointBusy = false;
		}
	}

	async function revertCheckpoint(checkpoint: Record<string, unknown>) {
		if (!selectedStory?.serverStoryId || checkpointBusy) return;
		const checkpointId = typeof checkpoint.id === 'string' ? checkpoint.id : '';
		const label = typeof checkpoint.label === 'string' ? checkpoint.label : checkpointId;
		if (!checkpointId || !confirm(`Revert context to ${label}?`)) return;
		checkpointBusy = true;
		checkpointMessage = null;
		try {
			const result = await revertToContextCheckpoint(selectedStory.serverStoryId, checkpointId, 'Manual context checkpoint revert');
			applyBackendVersion(selectedStory.id, result.serverVersion);
			checkpointMessage = `Reverted to ${label}.`;
			await story.pullBackendProjection().catch(() => undefined);
			await loadMemory();
		} catch (error) {
			checkpointMessage = error instanceof Error ? error.message : String(error);
		} finally {
			checkpointBusy = false;
		}
	}

	function chapterTitle(chapter: Chapter): string {
		return chapter.title?.trim() || `Chapter ${chapter.number}`;
	}

	function formatDate(ts: number): string {
		return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function formatCheckpointDate(value: unknown): string {
		if (typeof value !== 'string') return '';
		const time = new Date(value).getTime();
		return Number.isFinite(time) ? new Date(time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
	}

	function splitList(text: string): string[] {
		return text
			.split(/\n|,/)
			.map(item => item.trim())
			.filter(Boolean);
	}

	function splitLines(text: string): string[] {
		return text
			.split('\n')
			.map(item => item.trim())
			.filter(Boolean);
	}

	function openChapterEditor(chapter: Chapter) {
		editingChapter = chapter;
		chapterTitleDraft = chapter.title ?? '';
		chapterSummaryDraft = chapter.summary;
		chapterKeywordsDraft = chapter.keywords.join(', ');
		chapterCharactersDraft = chapter.characters.join(', ');
		chapterLocationsDraft = chapter.locations.join(', ');
		chapterThreadsDraft = chapter.plotThreads.join('\n');
		chapterToneDraft = chapter.emotionalTone ?? '';
		chapterPinnedDraft = chapter.pinned ?? false;
	}

	function closeChapterEditor() {
		editingChapter = null;
		chapterTitleDraft = '';
		chapterSummaryDraft = '';
		chapterKeywordsDraft = '';
		chapterCharactersDraft = '';
		chapterLocationsDraft = '';
		chapterThreadsDraft = '';
		chapterToneDraft = '';
		chapterPinnedDraft = false;
	}

	async function saveChapterEdit() {
		if (!editingChapter || savingEdit) return;
		savingEdit = true;
		const updates: Partial<Chapter> = {
			title: chapterTitleDraft.trim() || null,
			summary: chapterSummaryDraft.trim(),
			keywords: splitList(chapterKeywordsDraft),
			characters: splitList(chapterCharactersDraft),
			locations: splitList(chapterLocationsDraft),
			plotThreads: splitLines(chapterThreadsDraft),
			emotionalTone: chapterToneDraft.trim() || null,
			pinned: chapterPinnedDraft,
		};
		try {
			const updatedChapter: Chapter = { ...editingChapter, ...updates };
			await saveChapterMemory(updatedChapter);
			chapters = chapters.map(chapter =>
				chapter.id === editingChapter?.id ? updatedChapter : chapter,
			);
			closeChapterEditor();
		} finally {
			savingEdit = false;
		}
	}

	function openArcEditor(arc: Arc) {
		editingArc = arc;
		arcTitleDraft = arc.title;
		arcSummaryDraft = arc.summary;
		arcKeyPointsDraft = arc.keyPlotPoints.join('\n');
		arcCharacterArcsDraft = arc.characterArcs.map(item => `${item.name}: ${item.development}`).join('\n');
		arcThreadsDraft = arc.unresolvedThreads.join('\n');
		arcEmotionDraft = arc.emotionalProgression;
	}

	function closeArcEditor() {
		editingArc = null;
		arcTitleDraft = '';
		arcSummaryDraft = '';
		arcKeyPointsDraft = '';
		arcCharacterArcsDraft = '';
		arcThreadsDraft = '';
		arcEmotionDraft = '';
	}

	function parseCharacterArcs(text: string): Arc['characterArcs'] {
		return splitLines(text).map(line => {
			const separator = line.indexOf(':');
			if (separator < 0) return { name: line, development: '' };
			return {
				name: line.slice(0, separator).trim(),
				development: line.slice(separator + 1).trim(),
			};
		}).filter(item => item.name);
	}

	async function saveArcEdit() {
		if (!editingArc || savingEdit) return;
		savingEdit = true;
		const updates: Partial<Arc> = {
			title: arcTitleDraft.trim() || `Arc ${editingArc.arcNumber}`,
			summary: arcSummaryDraft.trim(),
			keyPlotPoints: splitLines(arcKeyPointsDraft),
			characterArcs: parseCharacterArcs(arcCharacterArcsDraft),
			unresolvedThreads: splitLines(arcThreadsDraft),
			emotionalProgression: arcEmotionDraft.trim(),
		};
		try {
			const updatedArc: Arc = { ...editingArc, ...updates };
			await saveArcMemory(updatedArc);
			arcs = arcs.map(arc =>
				arc.id === editingArc?.id ? updatedArc : arc,
			);
			closeArcEditor();
		} finally {
			savingEdit = false;
		}
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<div class="border-b border-[var(--border-primary)] px-4 py-4">
		<div class="mb-3 flex items-center justify-between gap-3">
			<div class="min-w-0">
				<h2 class="font-display text-sm tracking-wide text-[var(--text-primary)]">Chapters & Arcs</h2>
				{#if selectedStory}
					<p class="mt-1 truncate text-xs text-[var(--text-muted)]">{selectedStory.title}</p>
				{/if}
			</div>

			<div class="flex items-center gap-1 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-1">
				<button
					class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors {viewMode === 'ledger' ? 'bg-[rgba(212,168,83,0.14)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
					onclick={() => viewMode = 'ledger'}
					title="What matters now"
				>
					<Shield class="h-3.5 w-3.5" />
					Ledger
				</button>
				<button
					class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors {viewMode === 'chapters' ? 'bg-[rgba(212,168,83,0.14)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
					onclick={() => viewMode = 'chapters'}
				>
					<BookOpen class="h-3.5 w-3.5" />
					Chapters
				</button>
				<button
					class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors {viewMode === 'arcs' ? 'bg-[rgba(212,168,83,0.14)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
					onclick={() => viewMode = 'arcs'}
				>
					<GitBranch class="h-3.5 w-3.5" />
					Arcs
				</button>
			</div>
		</div>

		{#if stories.length > 1}
			<select
				bind:value={selectedStoryId}
				onchange={handleStoryChange}
				class="mb-3 w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)]"
			>
				{#each stories as storyOption}
					<option value={storyOption.id}>{storyOption.title}</option>
				{/each}
			</select>
		{/if}

		{#if selectedStory}
			<div class="mb-3 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
				<div class="flex items-center justify-between gap-3">
					<div class="min-w-0">
						<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Terminal Database</div>
						<p class="mt-1 truncate text-xs text-[var(--text-secondary)]">
							{selectedStory.serverStoryId
								? `Bound at v${selectedStory.serverVersion ?? 0} (${selectedStory.syncStatus ?? 'synced'})`
								: 'Local-only. Import to use terminal memory retrieval and sync.'}
						</p>
					</div>
					<button
						class="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-primary)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-accent)] disabled:opacity-50"
						disabled={backendSyncing}
						onclick={bindStoryToBackend}
						title="Import local story to the terminal world database"
					>
						{#if backendSyncing}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<CloudUpload class="h-3.5 w-3.5" />{/if}
						{selectedStory.serverStoryId ? 'Reimport' : 'Bind'}
					</button>
				</div>
				{#if backendMessage}
					<p class="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">{backendMessage}</p>
				{/if}
			</div>

			{#if selectedStory.serverStoryId}
				<div class="mb-3 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
					<div class="mb-2 flex items-center justify-between gap-3">
						<div class="min-w-0">
							<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Context Checkpoints</div>
							<p class="mt-1 truncate text-xs text-[var(--text-secondary)]">{contextCheckpoints.length} saved</p>
						</div>
						<button
							class="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-primary)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:border-[var(--color-gold-600)] hover:text-[var(--text-accent)] disabled:opacity-50"
							disabled={checkpointBusy}
							onclick={makeCheckpoint}
							title="Save context checkpoint"
						>
							{#if checkpointBusy}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Save class="h-3.5 w-3.5" />{/if}
							Save
						</button>
					</div>
					<input
						type="text"
						bind:value={checkpointLabel}
						placeholder="Checkpoint label"
						class="mb-2 w-full rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
					/>
					{#if contextCheckpoints.length > 0}
						<div class="max-h-28 space-y-1 overflow-y-auto">
							{#each contextCheckpoints.slice(0, 5) as checkpoint}
								<div class="flex items-center justify-between gap-2 rounded-md bg-[var(--bg-primary)] px-2 py-1.5">
									<div class="min-w-0">
										<div class="truncate text-xs text-[var(--text-primary)]">{typeof checkpoint.label === 'string' ? checkpoint.label : 'Checkpoint'}</div>
										<div class="text-[10px] text-[var(--text-muted)]">{formatCheckpointDate(checkpoint.createdAt)} · turn {typeof checkpoint.currentTurn === 'number' ? checkpoint.currentTurn : 0}</div>
									</div>
									<button
										class="shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[rgba(212,168,83,0.08)] hover:text-[var(--text-accent)] disabled:opacity-50"
										disabled={checkpointBusy}
										onclick={() => revertCheckpoint(checkpoint)}
										title="Revert to checkpoint"
									>
										<RotateCcw class="h-3.5 w-3.5" />
									</button>
								</div>
							{/each}
						</div>
					{/if}
					{#if checkpointMessage}
						<p class="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">{checkpointMessage}</p>
					{/if}
				</div>
			{/if}
		{/if}

		<div class="mb-3 grid grid-cols-3 gap-2">
			<div class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2">
				<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Chapters</div>
				<div class="mt-1 font-mono text-sm text-[var(--text-primary)]">{chapters.length}</div>
			</div>
			<div class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2">
				<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Arcs</div>
				<div class="mt-1 font-mono text-sm text-[var(--text-primary)]">{arcs.length}</div>
			</div>
			<div class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2">
				<div class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Open Threads</div>
				<div class="mt-1 font-mono text-sm text-[var(--text-primary)]">{openThreadCount}</div>
			</div>
		</div>

		<div class="relative">
			<Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
			<input
				type="text"
				bind:value={searchQuery}
				placeholder="Search chapters and arcs..."
				class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] py-2 pl-9 pr-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-gold-600)] focus:outline-none"
			/>
		</div>
	</div>

	<div class="flex-1 overflow-y-auto px-4 py-3">
		{#if loading}
			<div class="flex items-center justify-center py-16 text-[var(--text-accent)]">
				<Loader2 class="h-6 w-6 animate-spin" />
			</div>
		{:else if stories.length === 0}
			<p class="py-10 text-center text-sm text-[var(--text-muted)]">Create a story first to build chapters and arcs.</p>
		{:else if viewMode === 'ledger'}
			<div class="space-y-3">
				<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
					<div class="mb-2 text-[10px] uppercase tracking-wider text-[var(--text-accent)]">What Matters Now</div>
					{#if openThreads.length === 0 && activeAgreements.length === 0 && recentFactionPressure.length === 0}
						<p class="text-sm text-[var(--text-muted)]">No open ledger pressure yet.</p>
					{:else}
						<div class="space-y-2">
							{#each openThreads.slice(0, 6) as thread}
								<div class="rounded-lg bg-[var(--bg-primary)] px-3 py-2">
									<div class="text-[10px] uppercase tracking-wider text-amber-300">{thread.significance} thread</div>
									<p class="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{thread.description}</p>
								</div>
							{/each}
							{#each activeAgreements.slice(0, 5) as agreement}
								<div class="rounded-lg bg-[var(--bg-primary)] px-3 py-2">
									<div class="text-[10px] uppercase tracking-wider text-sky-300">{agreement.category} - {agreement.status}</div>
									<p class="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{agreement.parties.join(' / ')}: {agreement.terms}</p>
								</div>
							{/each}
						</div>
					{/if}
				</section>

				<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
					<div class="mb-2 text-[10px] uppercase tracking-wider text-[var(--text-accent)]">Faction Pressure</div>
					{#if recentFactionPressure.length === 0}
						<p class="text-sm text-[var(--text-muted)]">No recorded faction moves yet.</p>
					{:else}
						<div class="space-y-2">
							{#each recentFactionPressure as action}
								<div class="rounded-lg bg-[var(--bg-primary)] px-3 py-2">
									<div class="flex items-center justify-between gap-3">
										<span class="text-xs font-semibold text-[var(--text-primary)]">{action.factionName}</span>
										<div class="flex items-center gap-1.5">
											<span class="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--text-muted)]">{action.actionType}</span>
											<span class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{action.urgency}</span>
										</div>
									</div>
									{#if action.motivation}
										<div class="mt-1 text-[10px] uppercase tracking-wider text-[var(--text-accent)]/80">{action.motivation}</div>
									{/if}
									<p class="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{action.action}</p>
									{#if action.consequences.length > 0}
										<p class="mt-1 text-[11px] text-[var(--text-muted)]">{action.consequences.slice(0, 2).join('; ')}</p>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</section>

				<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
					<div class="mb-2 text-[10px] uppercase tracking-wider text-[var(--text-accent)]">NPC Belief Seeds</div>
					{#if criticalNpcMemory.length === 0}
						<p class="text-sm text-[var(--text-muted)]">No significant NPC-specific memories yet.</p>
					{:else}
						<div class="space-y-2">
							{#each criticalNpcMemory as memory}
								<div class="rounded-lg bg-[var(--bg-primary)] px-3 py-2">
									<div class="text-xs font-semibold text-[var(--text-primary)]">{memory.npcName}</div>
									<p class="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{memory.topic}</p>
									{#if memory.npcLearned.length > 0}
										<p class="mt-1 text-[11px] text-[var(--text-muted)]">{memory.npcLearned.slice(0, 3).join('; ')}</p>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</section>
			</div>
		{:else if viewMode === 'chapters'}
			{#if filteredChapters.length === 0}
				<p class="py-10 text-center text-sm text-[var(--text-muted)]">{searchQuery ? 'No chapter matches.' : 'No chapters yet. They appear after chapter analysis runs.'}</p>
			{:else}
				<div class="space-y-2">
					{#each filteredChapters as chapter}
						<article class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0">
									<div class="flex flex-wrap items-center gap-2">
										<span class="font-mono text-[10px] uppercase tracking-wider text-[var(--text-accent)]">Chapter {chapter.number}</span>
										{#if chapter.pinned}
											<span class="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-300">Pinned</span>
										{/if}
										<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
											{coveredChapterIds.has(chapter.id) ? 'In arc' : 'Recent'}
										</span>
									</div>
									<h3 class="mt-1 font-story text-base font-semibold text-[var(--text-primary)]">{chapterTitle(chapter)}</h3>
								</div>
								<div class="shrink-0 text-right text-[10px] text-[var(--text-muted)]">
									<div>{chapter.entryCount} entries</div>
									<div>{formatDate(chapter.createdAt)}</div>
								</div>
							</div>

							<div class="mt-2 flex justify-end">
								<button
									class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] text-[var(--text-muted)] hover:bg-[rgba(212,168,83,0.08)] hover:text-[var(--text-accent)]"
									onclick={() => openChapterEditor(chapter)}
									title="Edit chapter memory"
								>
									<Edit3 class="h-3 w-3" />
									Edit
								</button>
								<button
									class="ml-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
									disabled={deletingRecordId === chapter.id}
									onclick={() => deleteChapterMemory(chapter)}
									title="Delete chapter"
								>
									{#if deletingRecordId === chapter.id}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Trash2 class="h-3 w-3" />{/if}
									Delete
								</button>
							</div>

							<p class="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">{chapter.summary}</p>

							{#if chapter.characters.length > 0 || chapter.locations.length > 0 || chapter.plotThreads.length > 0}
								<div class="mt-3 flex flex-wrap gap-1.5">
									{#each chapter.characters.slice(0, 5) as character}
										<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">{character}</span>
									{/each}
									{#each chapter.locations.slice(0, 4) as location}
										<span class="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">{location}</span>
									{/each}
									{#each chapter.plotThreads.slice(0, 4) as thread}
										<span class="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">{thread}</span>
									{/each}
								</div>
							{/if}
						</article>
					{/each}
				</div>
			{/if}
		{:else}
			{#if filteredArcs.length === 0}
				<p class="py-10 text-center text-sm text-[var(--text-muted)]">{searchQuery ? 'No arc matches.' : 'No arcs yet. Arcs appear after enough chapters are condensed.'}</p>
			{:else}
				<div class="space-y-3">
					{#each filteredArcs as arc}
						<article class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0">
									<div class="font-mono text-[10px] uppercase tracking-wider text-[var(--text-accent)]">Arc {arc.arcNumber} - Chapters {arc.chapterRange}</div>
									<h3 class="mt-1 font-story text-base font-semibold text-[var(--text-primary)]">{arc.title}</h3>
								</div>
								<div class="shrink-0 text-right text-[10px] text-[var(--text-muted)]">
									<div>{arc.chapterIds.length} chapters</div>
									<div>{formatDate(arc.createdAt)}</div>
								</div>
							</div>

							<div class="mt-2 flex justify-end">
								<button
									class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] text-[var(--text-muted)] hover:bg-[rgba(212,168,83,0.08)] hover:text-[var(--text-accent)]"
									onclick={() => openArcEditor(arc)}
									title="Edit arc memory"
								>
									<Edit3 class="h-3 w-3" />
									Edit
								</button>
								<button
									class="ml-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
									disabled={deletingRecordId === arc.id}
									onclick={() => deleteArcMemory(arc)}
									title="Delete arc"
								>
									{#if deletingRecordId === arc.id}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Trash2 class="h-3 w-3" />{/if}
									Delete
								</button>
							</div>

							<p class="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">{arc.summary}</p>

							{#if arc.keyPlotPoints.length > 0}
								<div class="mt-3">
									<div class="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Key Beats</div>
									<ul class="space-y-1 text-xs leading-relaxed text-[var(--text-secondary)]">
										{#each arc.keyPlotPoints.slice(0, 5) as point}
											<li>{point}</li>
										{/each}
									</ul>
								</div>
							{/if}

							{#if arc.characterArcs.length > 0}
								<div class="mt-3">
									<div class="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Character Arcs</div>
									<div class="space-y-1">
										{#each arc.characterArcs.slice(0, 4) as characterArc}
											<p class="text-xs leading-relaxed text-[var(--text-secondary)]">
												<span class="font-semibold text-[var(--text-primary)]">{characterArc.name}:</span>
												{characterArc.development}
											</p>
										{/each}
									</div>
								</div>
							{/if}

							{#if arc.unresolvedThreads.length > 0}
								<div class="mt-3 flex flex-wrap gap-1.5">
									{#each arc.unresolvedThreads.slice(0, 6) as thread}
										<span class="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">{thread}</span>
									{/each}
								</div>
							{/if}

							{#if arc.chapterIds.length > 0}
								<div class="mt-3 flex flex-wrap gap-1.5 border-t border-[var(--border-primary)] pt-2">
									{#each arc.chapterIds.slice(0, 8) as chapterId}
										{@const linkedChapter = chapterLookup.get(chapterId)}
										<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
											{linkedChapter ? `Ch. ${linkedChapter.number}` : 'Chapter'}
										</span>
									{/each}
									{#if arc.chapterIds.length > 8}
										<span class="text-[10px] text-[var(--text-muted)]">+{arc.chapterIds.length - 8}</span>
									{/if}
								</div>
							{/if}
						</article>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>

{#if editingChapter}
	<div class="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
		<button class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick={closeChapterEditor} aria-label="Close chapter editor"></button>
		<div class="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col rounded-t-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-2xl sm:rounded-2xl">
			<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-5 py-4">
				<div>
					<div class="font-mono text-[10px] uppercase tracking-wider text-[var(--text-accent)]">Chapter {editingChapter.number}</div>
					<h3 class="font-display text-sm tracking-wide text-[var(--text-primary)]">Edit Chapter Memory</h3>
				</div>
				<button onclick={closeChapterEditor} class="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]" title="Close">
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="flex-1 space-y-4 overflow-y-auto px-5 py-4">
				<div class="space-y-1.5">
					<label for="chapter-title" class="text-xs text-[var(--text-muted)]">Title</label>
					<input id="chapter-title" bind:value={chapterTitleDraft} class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
				</div>

				<div class="space-y-1.5">
					<label for="chapter-summary" class="text-xs text-[var(--text-muted)]">Summary</label>
					<textarea id="chapter-summary" bind:value={chapterSummaryDraft} rows="8" class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm leading-relaxed text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
				</div>

				<div class="grid gap-3 sm:grid-cols-2">
					<div class="space-y-1.5">
						<label for="chapter-characters" class="text-xs text-[var(--text-muted)]">Characters</label>
						<input id="chapter-characters" bind:value={chapterCharactersDraft} placeholder="Comma separated" class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
					</div>
					<div class="space-y-1.5">
						<label for="chapter-locations" class="text-xs text-[var(--text-muted)]">Locations</label>
						<input id="chapter-locations" bind:value={chapterLocationsDraft} placeholder="Comma separated" class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
					</div>
				</div>

				<div class="space-y-1.5">
					<label for="chapter-keywords" class="text-xs text-[var(--text-muted)]">Keywords</label>
					<input id="chapter-keywords" bind:value={chapterKeywordsDraft} placeholder="Comma separated" class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
				</div>

				<div class="space-y-1.5">
					<label for="chapter-threads" class="text-xs text-[var(--text-muted)]">Plot Threads</label>
					<textarea id="chapter-threads" bind:value={chapterThreadsDraft} rows="4" placeholder="One thread per line" class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
				</div>

				<div class="grid gap-3 sm:grid-cols-[1fr_auto]">
					<div class="space-y-1.5">
						<label for="chapter-tone" class="text-xs text-[var(--text-muted)]">Emotional Tone</label>
						<input id="chapter-tone" bind:value={chapterToneDraft} class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
					</div>
					<label class="flex items-center gap-2 self-end rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-primary)]">
						<input type="checkbox" bind:checked={chapterPinnedDraft} class="h-4 w-4 accent-[var(--color-gold-400)]" />
						Pinned
					</label>
				</div>
			</div>

			<div class="flex gap-3 border-t border-[var(--border-primary)] px-5 py-4">
				<button onclick={closeChapterEditor} class="flex-1 rounded-lg border border-[var(--border-primary)] py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
				<button onclick={saveChapterEdit} disabled={savingEdit || !chapterSummaryDraft.trim()} class="flex flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] py-2 font-display text-xs font-semibold tracking-wide text-[var(--bg-primary)] disabled:opacity-50">
					{#if savingEdit}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Save class="h-3.5 w-3.5" />{/if}
					Save Chapter
				</button>
			</div>
		</div>
	</div>
{/if}

{#if editingArc}
	<div class="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
		<button class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick={closeArcEditor} aria-label="Close arc editor"></button>
		<div class="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col rounded-t-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-2xl sm:rounded-2xl">
			<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-5 py-4">
				<div>
					<div class="font-mono text-[10px] uppercase tracking-wider text-[var(--text-accent)]">Arc {editingArc.arcNumber}</div>
					<h3 class="font-display text-sm tracking-wide text-[var(--text-primary)]">Edit Arc Memory</h3>
				</div>
				<button onclick={closeArcEditor} class="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]" title="Close">
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="flex-1 space-y-4 overflow-y-auto px-5 py-4">
				<div class="space-y-1.5">
					<label for="arc-title" class="text-xs text-[var(--text-muted)]">Title</label>
					<input id="arc-title" bind:value={arcTitleDraft} class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none" />
				</div>

				<div class="space-y-1.5">
					<label for="arc-summary" class="text-xs text-[var(--text-muted)]">Summary</label>
					<textarea id="arc-summary" bind:value={arcSummaryDraft} rows="8" class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm leading-relaxed text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
				</div>

				<div class="space-y-1.5">
					<label for="arc-key-points" class="text-xs text-[var(--text-muted)]">Key Beats</label>
					<textarea id="arc-key-points" bind:value={arcKeyPointsDraft} rows="4" placeholder="One beat per line" class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
				</div>

				<div class="space-y-1.5">
					<label for="arc-character-arcs" class="text-xs text-[var(--text-muted)]">Character Arcs</label>
					<textarea id="arc-character-arcs" bind:value={arcCharacterArcsDraft} rows="4" placeholder="Name: development" class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
				</div>

				<div class="space-y-1.5">
					<label for="arc-threads" class="text-xs text-[var(--text-muted)]">Open Threads</label>
					<textarea id="arc-threads" bind:value={arcThreadsDraft} rows="4" placeholder="One thread per line" class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
				</div>

				<div class="space-y-1.5">
					<label for="arc-emotion" class="text-xs text-[var(--text-muted)]">Emotional Progression</label>
					<textarea id="arc-emotion" bind:value={arcEmotionDraft} rows="3" class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-primary)] focus:border-[var(--color-gold-600)] focus:outline-none"></textarea>
				</div>
			</div>

			<div class="flex gap-3 border-t border-[var(--border-primary)] px-5 py-4">
				<button onclick={closeArcEditor} class="flex-1 rounded-lg border border-[var(--border-primary)] py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">Cancel</button>
				<button onclick={saveArcEdit} disabled={savingEdit || !arcSummaryDraft.trim()} class="flex flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] py-2 font-display text-xs font-semibold tracking-wide text-[var(--bg-primary)] disabled:opacity-50">
					{#if savingEdit}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Save class="h-3.5 w-3.5" />{/if}
					Save Arc
				</button>
			</div>
		</div>
	</div>
{/if}
