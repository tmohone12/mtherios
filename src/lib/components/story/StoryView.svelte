<script lang="ts">
	import { story } from '$lib/stores/story.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { ai } from '$lib/services/ai';
	import ActionInput from './ActionInput.svelte';
	import WorldDrawer from './WorldDrawer.svelte';
	import WorldExplorer from '$lib/components/database/WorldExplorer.svelte';
	import { downloadStoryAsJson } from '$lib/services/storySync';
	import { deleteStoryEverywhere } from '$lib/services/serverStories';
	import { formatNarrative } from '$lib/utils/narrativeHtml';
	import { ArrowLeft, Database, Loader2, Users, BookOpen, Image, AlertTriangle, Download, Trash2, MoreVertical, X, ScrollText, Scissors } from 'lucide-svelte';
	import { tick, onMount } from 'svelte';
	import type { StyleReview } from '$lib/services/ai/sdk/schemas/style';
	import type { StoryEntry } from '$lib/types';


	let scrollContainer = $state<HTMLDivElement | null>(null);
	let streamingContent = $state('');
	let isStreaming = $state(false);

	// Service output states
	let styleReview = $state<StyleReview | null>(null);
	let sceneImageUrl = $state<string | null>(null);
	let loadingImage = $state(false);
	let imageError = $state<string | null>(null);
	let enrichmentErrors = $state<string[]>([]);

	// World drawer & floating menu
	let drawerOpen = $state(false);
	let exporting = $state(false);
	let fabOpen = $state(false);
	let confirmingDelete = $state(false);
	let headerEditorOpen = $state(false);
	let headerDraft = $state('');
	let titleDraft = $state('');
	let descriptionDraft = $state('');
	let editorTab = $state<'story' | 'character'>('story');
	let characterNameDraft = $state('');
	let characterDescriptionDraft = $state('');
	let characterTraitsDraft = $state('');
	let reputationDraft = $state('');
	let confirmingEntryDeleteId = $state<string | null>(null);
	let confirmingDeleteFromId = $state<string | null>(null);
	let messageControlError = $state<string | null>(null);
	let workspaceTab = $state<'play' | 'lore'>('play');

	async function handleExport() {
		if (!story.currentStory || exporting) return;
		exporting = true;
		try {
			await downloadStoryAsJson(story.currentStory.id);
		} catch (e) {
			console.error('Export failed:', e);
		}
		exporting = false;
	}

	function openHeaderEditor() {
		titleDraft = story.currentStory?.title ?? '';
		headerDraft = story.currentStory?.headerPrompt ?? '';
		descriptionDraft = story.currentStory?.description ?? '';
		editorTab = 'story';
		headerEditorOpen = true;
	}

	async function saveHeaderPrompt() {
		const newTitle = titleDraft.trim();
		if (newTitle && newTitle !== story.currentStory?.title) {
			await story.updateTitle(newTitle);
		}
		await story.updateHeaderPrompt(headerDraft);
		if (descriptionDraft !== (story.currentStory?.description ?? '')) {
			await story.updateDescription(descriptionDraft);
		}
		headerEditorOpen = false;
	}

	async function handleDelete() {
		if (!story.currentStory) return;
		const currentStory = story.currentStory;
		await deleteStoryEverywhere(currentStory);
		story.clear();
		app.closeStory();
	}

	async function handleDeleteEntry(entry: StoryEntry) {
		messageControlError = null;
		confirmingDeleteFromId = null;
		if (confirmingEntryDeleteId !== entry.id) {
			confirmingEntryDeleteId = entry.id;
			return;
		}
		try {
			await story.deleteEntry(entry.id);
			confirmingEntryDeleteId = null;
		} catch (e) {
			messageControlError = e instanceof Error ? e.message : 'Failed to delete message.';
		}
	}

	async function handleDeleteFromEntry(entry: StoryEntry) {
		messageControlError = null;
		confirmingEntryDeleteId = null;
		if (confirmingDeleteFromId !== entry.id) {
			confirmingDeleteFromId = entry.id;
			return;
		}
		try {
			await story.deleteEntriesFromPosition(entry.position);
			confirmingDeleteFromId = null;
		} catch (e) {
			messageControlError = e instanceof Error ? e.message : 'Failed to delete transcript range.';
		}
	}

	function clearMessageConfirmations() {
		confirmingEntryDeleteId = null;
		confirmingDeleteFromId = null;
	}

	async function generateSceneImage() {
		if (loadingImage || story.entries.length === 0) return;
		loadingImage = true;
		sceneImageUrl = null;
		imageError = null;
		try {
			const recentNarration = story.entries
				.filter(e => e.type === 'narration')
				.slice(-3)
				.map(e => e.content)
				.join('\n');
			if (!recentNarration) { loadingImage = false; return; }

			// Build scene context from world state
			const currentLoc = story.locations.find(l => l.current);
			const sceneContext = {
				characters: story.characters
					.filter(c => c.status === 'active')
					.slice(0, 3)
					.map(c => ({ name: c.name, visualDescriptors: c.visualDescriptors })),
				currentLocation: currentLoc
					? { name: currentLoc.name, description: currentLoc.description }
					: undefined,
			};

			const lastEntry = story.entries[story.entries.length - 1];
			const result = await ai.imageGen.generateSceneImage(recentNarration, sceneContext, undefined, lastEntry?.id);
			if (result.image) {
				sceneImageUrl = result.image.url;
			} else {
				imageError = result.error ?? 'Image generation failed.';
			}
		} catch (e) {
			console.error('Image generation failed:', e);
			imageError = e instanceof Error ? e.message : 'Image generation failed.';
		}
		loadingImage = false;
		scrollToBottom();
	}

	const isAdventure = $derived(story.storyMode === 'adventure');
	const visibleEntries = $derived(story.entries);
	const dialogueSpeakers = $derived.by(() => {
		const names = new Set<string>();
		const addName = (name: string | null | undefined) => {
			const trimmed = name?.trim();
			if (trimmed) names.add(trimmed);
		};

		addName(story.protagonist?.name);
		for (const character of story.characters) {
			addName(character.name);
		}

		return [...names];
	});

	async function scrollToBottom() {
		await tick();
		if (scrollContainer) {
			scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
		}
	}

	function handleStreamStart() {
		streamingContent = '';
		isStreaming = true;
		styleReview = null;
		// Don't clear sceneImageUrl here — leave the previous scene visible
		// until the new image actually arrives (or image gen is disabled,
		// in which case the user keeps their last scene). The user has an
		// explicit dismiss button (×) on the image card if they want to clear.
		scrollToBottom();
	}

	function handleStreamChunk(text: string) {
		streamingContent = text;
		scrollToBottom();
	}

	async function handleStreamEnd(fullText: string) {
		streamingContent = '';
		isStreaming = false;
		scrollToBottom();
		if (!fullText.trim()) return;

		// Orchestrator already updated world state in ActionInput. Here we run
		// only optional UI enrichment services in parallel.
		const errors: string[] = [];
		const jobs: Promise<void>[] = [];

		const styleConfig = settings.getServiceConfig('styleReviewer');
		if (styleConfig.enabled) {
			jobs.push(
				(async () => {
					try {
						styleReview = await ai.styleReviewer.review(fullText, story.pov, story.tense, story.currentStory?.genre ?? '');
					} catch (e) {
						errors.push(`StyleReview: ${e}`);
					}
				})()
			);
		}

		const imageMode = settings.uiSettings.imageGenerationMode ?? story.currentStory?.settings?.imageGenerationMode;
		if (imageMode && imageMode !== 'none') {
			jobs.push(
				(async () => {
					try {
						const recentNarration = story.entries
							.filter(e => e.type === 'narration')
							.slice(-3)
							.map(e => e.content)
							.join('\n');
						if (!recentNarration) return;
						const currentLoc = story.locations.find(l => l.current);
						const sceneContext = {
							characters: story.characters
								.filter(c => c.status === 'active')
								.slice(0, 3)
								.map(c => ({ name: c.name, visualDescriptors: c.visualDescriptors })),
							currentLocation: currentLoc
								? { name: currentLoc.name, description: currentLoc.description }
								: undefined,
						};
						const latestEntry = story.entries[story.entries.length - 1];
						const imgResult = await ai.imageGen.generateSceneImage(recentNarration, sceneContext, undefined, latestEntry?.id);
						if (imgResult.image) sceneImageUrl = imgResult.image.url;
					} catch (e) {
						errors.push(`ImageGen: ${e}`);
					}
				})()
			);
		}

		await Promise.allSettled(jobs);

		if (errors.length > 0) {
			enrichmentErrors = errors;
		}

		scrollToBottom();
	}

	function handleSuggestionSelect(text: string) {
		window.dispatchEvent(new CustomEvent('mtherios:inject-input', { detail: text }));
	}

	function goBack() {
		story.clear();
		app.closeStory();
	}

	onMount(() => {
		scrollToBottom();
	});
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<div class="flex items-center gap-3 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3">
		<button onclick={goBack} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
			<ArrowLeft class="h-5 w-5" />
		</button>
		<div class="flex-1 min-w-0">
			<h1 class="truncate font-display text-sm font-semibold tracking-wide text-[var(--text-primary)]">
				{story.currentStory?.title ?? 'Untitled'}
			</h1>
			<span class="text-xs text-[var(--text-muted)]">
				{story.currentStory?.genre ?? ''} · {isAdventure ? 'Adventure' : 'Creative Writing'}
			</span>
		</div>
		<div class="hidden items-center gap-1 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] p-1 sm:flex">
			<button
				onclick={() => workspaceTab = 'play'}
				class="rounded-md px-3 py-1.5 text-xs transition-colors {workspaceTab === 'play' ? 'bg-[var(--bg-tertiary)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}"
			>
				Play
			</button>
			<button
				onclick={() => workspaceTab = 'lore'}
				class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors {workspaceTab === 'lore' ? 'bg-[var(--bg-tertiary)] text-[var(--text-accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}"
			>
				<Database class="h-3.5 w-3.5" />
				Lore
			</button>
		</div>
		<button onclick={() => drawerOpen = true} class="relative rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]" title="World State">
			<Users class="h-4 w-4" />
			{#if story.characters.length > 0}
				<span class="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--color-gold-400)] text-[8px] font-bold text-[var(--bg-primary)]">{story.characters.length}</span>
			{/if}
		</button>
	</div>

	<div class="grid grid-cols-2 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] sm:hidden">
		<button
			onclick={() => workspaceTab = 'play'}
			class="px-3 py-2 text-xs transition-colors {workspaceTab === 'play' ? 'bg-[var(--bg-tertiary)] text-[var(--text-accent)]' : 'text-[var(--text-muted)]'}"
		>
			Play
		</button>
		<button
			onclick={() => workspaceTab = 'lore'}
			class="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs transition-colors {workspaceTab === 'lore' ? 'bg-[var(--bg-tertiary)] text-[var(--text-accent)]' : 'text-[var(--text-muted)]'}"
		>
			<Database class="h-3.5 w-3.5" />
			Lore
		</button>
	</div>

	<!-- Meters HUD: visible meters tracked by the GM -->
	{#if story.currentStory?.meters && story.currentStory.meters.some(m => m.visible)}
		<div class="flex flex-wrap items-center gap-2 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)]/60 px-4 py-2">
			{#each story.currentStory.meters.filter(m => m.visible) as meter}
				{@const pct = meter.max > 0 ? Math.round((meter.value / meter.max) * 100) : 0}
				<div class="flex items-center gap-1.5 rounded-md bg-[var(--bg-tertiary)] px-2 py-1" title="{meter.name}: {meter.value}/{meter.max}">
					<span class="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{meter.name}</span>
					<div class="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--border-primary)]">
						<div
							class="h-full transition-all"
							style="width: {pct}%; background: {pct < 25 ? 'var(--color-crimson-400)' : pct < 60 ? 'var(--color-gold-400)' : 'var(--color-emerald-400, #10b981)'}"
						></div>
					</div>
					<span class="text-[10px] tabular-nums text-[var(--text-primary)]">{meter.value}</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if workspaceTab === 'lore'}
		<div class="min-h-0 flex-1 overflow-hidden">
			<WorldExplorer storyId={story.currentStory?.serverStoryId ?? story.currentStory?.id ?? null} title="Story Lore" />
		</div>
	{:else}
	<!-- Story entries -->
	<div bind:this={scrollContainer} class="flex-1 overflow-y-auto pb-4">
		{#if story.loading}
			<div class="flex items-center justify-center py-20">
				<Loader2 class="h-6 w-6 animate-spin text-[var(--text-accent)]" />
			</div>
		{:else if story.entries.length === 0 && !isStreaming}
			<div class="flex flex-col items-center justify-center gap-4 px-8 py-20 text-center">
				<div class="flex h-16 w-16 items-center justify-center rounded-full bg-[rgba(212,168,83,0.1)]">
					<BookOpen class="h-8 w-8 text-[var(--text-accent)]" />
				</div>
				<div>
					<p class="font-display text-base text-[var(--text-primary)]">Your story begins here</p>
					<p class="mt-2 text-sm text-[var(--text-muted)]">
						{#if isAdventure}
							Type what you want to do and the AI will narrate the world around you.
						{:else}
							Describe what happens next and the AI will weave your narrative.
						{/if}
					</p>
				</div>
			</div>
		{:else}
			<div class="mx-auto max-w-2xl space-y-4 px-4 pt-4">
				{#if story.hasOlderEntries}
					<div class="flex justify-center">
						<button
							onclick={() => story.loadOlderEntries()}
							disabled={story.loadingOlderEntries}
							class="rounded-full border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-muted)] transition-colors hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)] disabled:opacity-50"
						>
							{story.loadingOlderEntries ? 'Loading older messages...' : `Load older messages (${story.entries.length}/${story.entryCount})`}
						</button>
					</div>
				{/if}
				{#if messageControlError}
					<div class="flex items-start gap-2 rounded-xl border border-[var(--color-crimson-500)]/20 bg-[var(--color-crimson-900)]/10 px-3 py-2.5">
						<AlertTriangle class="h-4 w-4 shrink-0 text-[var(--color-crimson-400)] mt-0.5" />
						<div class="flex-1 text-xs text-[var(--color-crimson-400)]">{messageControlError}</div>
						<button onclick={() => messageControlError = null} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="Dismiss message control error" aria-label="Dismiss message control error">
							<X class="h-3.5 w-3.5" />
						</button>
					</div>
				{/if}
				{#each visibleEntries as entry (entry.id)}
					{#if entry.type === 'user_action'}
						<div class="group flex flex-col items-end gap-1" role="group" onmouseleave={clearMessageConfirmations}>
							<div class="max-w-[85%] rounded-2xl rounded-br-md bg-[rgba(212,168,83,0.12)] px-4 py-3">
								<p class="text-sm leading-relaxed text-[var(--text-primary)]">{entry.content.replace(/^>\s*/, '')}</p>
							</div>
							<div class="flex gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
								<button
									onclick={() => handleDeleteFromEntry(entry)}
									class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-muted)] active:scale-95 sm:h-7 sm:w-7 hover:border-amber-500/40 hover:text-amber-300 {confirmingDeleteFromId === entry.id ? 'border-amber-500/60 bg-amber-500/10 text-amber-300' : ''}"
									title={confirmingDeleteFromId === entry.id ? 'Confirm delete from here' : 'Delete from here'}
									aria-label={confirmingDeleteFromId === entry.id ? 'Confirm delete from here' : 'Delete from here'}
								>
									<Scissors class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
								<button
									onclick={() => handleDeleteEntry(entry)}
									class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-muted)] active:scale-95 sm:h-7 sm:w-7 hover:border-[var(--color-crimson-500)]/40 hover:text-[var(--color-crimson-400)] {confirmingEntryDeleteId === entry.id ? 'border-[var(--color-crimson-500)]/60 bg-[var(--color-crimson-900)]/20 text-[var(--color-crimson-400)]' : ''}"
									title={confirmingEntryDeleteId === entry.id ? 'Confirm delete message' : 'Delete message'}
									aria-label={confirmingEntryDeleteId === entry.id ? 'Confirm delete message' : 'Delete message'}
								>
									<Trash2 class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
							</div>
						</div>
					{:else if entry.type === 'narration'}
						<div class="group space-y-1" role="group" onmouseleave={clearMessageConfirmations}>
							<div class="prose-mtherios">
							<div class="rounded-2xl rounded-bl-md border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3">
								{@html formatNarrative(entry.content, dialogueSpeakers)}
							</div>
							{#if story.getImageForEntry(entry.id)}
								{@const img = story.getImageForEntry(entry.id)}
								{#if img}
								<div class="relative mt-2 overflow-hidden rounded-xl border border-[var(--border-primary)]">
									<img src={img.imageData} alt="Scene" class="w-full" loading="lazy" />
									<button
										onclick={() => story.removeImage(img.id)}
										class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg bg-black/50 text-white/80 backdrop-blur-sm hover:bg-black/70"
										title="Remove image"
									>
										<X class="h-3.5 w-3.5" />
									</button>
								</div>
								{/if}
							{/if}
							</div>
							<div class="flex justify-end gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
								<button
									onclick={() => handleDeleteFromEntry(entry)}
									class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-muted)] active:scale-95 sm:h-7 sm:w-7 hover:border-amber-500/40 hover:text-amber-300 {confirmingDeleteFromId === entry.id ? 'border-amber-500/60 bg-amber-500/10 text-amber-300' : ''}"
									title={confirmingDeleteFromId === entry.id ? 'Confirm delete from here' : 'Delete from here'}
									aria-label={confirmingDeleteFromId === entry.id ? 'Confirm delete from here' : 'Delete from here'}
								>
									<Scissors class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
								<button
									onclick={() => handleDeleteEntry(entry)}
									class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-muted)] active:scale-95 sm:h-7 sm:w-7 hover:border-[var(--color-crimson-500)]/40 hover:text-[var(--color-crimson-400)] {confirmingEntryDeleteId === entry.id ? 'border-[var(--color-crimson-500)]/60 bg-[var(--color-crimson-900)]/20 text-[var(--color-crimson-400)]' : ''}"
									title={confirmingEntryDeleteId === entry.id ? 'Confirm delete message' : 'Delete message'}
									aria-label={confirmingEntryDeleteId === entry.id ? 'Confirm delete message' : 'Delete message'}
								>
									<Trash2 class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
							</div>
						</div>
					{:else if entry.type === 'system'}
						{#if entry.content.startsWith('Roll:')}
							<div class="group space-y-1" role="group" onmouseleave={clearMessageConfirmations}>
							<div class="dice-player-roll">
								<span class="dice-card-icon">&#127922;</span>
								<span>{entry.content.slice(5).trim()}</span>
							</div>
							<div class="flex justify-end gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
								<button onclick={() => handleDeleteEntry(entry)} class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-muted)] active:scale-95 sm:h-7 sm:w-7 hover:border-[var(--color-crimson-500)]/40 hover:text-[var(--color-crimson-400)] {confirmingEntryDeleteId === entry.id ? 'border-[var(--color-crimson-500)]/60 bg-[var(--color-crimson-900)]/20 text-[var(--color-crimson-400)]' : ''}" title={confirmingEntryDeleteId === entry.id ? 'Confirm delete message' : 'Delete message'} aria-label={confirmingEntryDeleteId === entry.id ? 'Confirm delete message' : 'Delete message'}>
									<Trash2 class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
							</div>
							</div>
						{:else}
							<div class="group space-y-1" role="group" onmouseleave={clearMessageConfirmations}>
							<div class="rounded-lg bg-[var(--color-crimson-900)]/20 border border-[var(--color-crimson-500)]/20 px-4 py-3 text-center text-xs text-[var(--color-crimson-400)]">
								{entry.content}
							</div>
							<div class="flex justify-end gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
								<button onclick={() => handleDeleteEntry(entry)} class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-muted)] active:scale-95 sm:h-7 sm:w-7 hover:border-[var(--color-crimson-500)]/40 hover:text-[var(--color-crimson-400)] {confirmingEntryDeleteId === entry.id ? 'border-[var(--color-crimson-500)]/60 bg-[var(--color-crimson-900)]/20 text-[var(--color-crimson-400)]' : ''}" title={confirmingEntryDeleteId === entry.id ? 'Confirm delete message' : 'Delete message'} aria-label={confirmingEntryDeleteId === entry.id ? 'Confirm delete message' : 'Delete message'}>
									<Trash2 class="h-4 w-4 sm:h-3.5 sm:w-3.5" />
								</button>
							</div>
							</div>
						{/if}
					{/if}
				{/each}

				<!-- Streaming narration -->
				{#if isStreaming && streamingContent}
					<div class="prose-mtherios">
						<div class="rounded-2xl rounded-bl-md border border-[var(--color-gold-600)]/30 bg-[var(--bg-tertiary)] px-4 py-3">
							{@html formatNarrative(streamingContent, dialogueSpeakers)}
							<span class="inline-block h-4 w-0.5 animate-pulse bg-[var(--text-accent)]"></span>
						</div>
					</div>
				{:else if isStreaming}
					<div class="flex items-center gap-2 px-4 py-3 text-sm text-[var(--text-muted)]">
						<Loader2 class="h-4 w-4 animate-spin" />
						<span>Weaving the narrative...</span>
					</div>
				{/if}

				<!-- Scene Image -->
				{#if sceneImageUrl}
					<div class="relative overflow-hidden rounded-xl border border-[var(--border-primary)]">
						<img src={sceneImageUrl} alt="Scene" class="w-full" loading="lazy" />
						<div class="absolute right-2 top-2 flex gap-1.5">
							<button
								onclick={generateSceneImage}
								disabled={loadingImage}
								class="flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white/80 backdrop-blur-sm active:scale-95 hover:bg-black/70 disabled:opacity-40"
								title="Regenerate"
							>
								<Image class="h-4 w-4" />
							</button>
							<button
								onclick={() => sceneImageUrl = null}
								class="flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white/80 backdrop-blur-sm active:scale-95 hover:bg-black/70"
								title="Dismiss"
							>
								<X class="h-4 w-4" />
							</button>
						</div>
					</div>
				{:else if loadingImage}
					<div class="flex items-center gap-2 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-xs text-[var(--text-muted)]">
						<Image class="h-4 w-4 animate-pulse" />
						<span>Generating scene...</span>
					</div>
				{/if}

				{#if imageError}
					<div class="flex items-start gap-2 rounded-xl border border-[var(--color-crimson-500)]/20 bg-[var(--color-crimson-900)]/10 px-3 py-2.5">
						<AlertTriangle class="h-4 w-4 shrink-0 text-[var(--color-crimson-400)] mt-0.5" />
						<div class="flex-1 text-xs text-[var(--color-crimson-400)]">
							<span class="font-semibold">Image failed:</span> {imageError}
						</div>
						<button onclick={() => imageError = null} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
							<X class="h-3.5 w-3.5" />
						</button>
					</div>
				{/if}

				<!-- Enrichment Errors -->
				{#if enrichmentErrors.length > 0}
					<div class="flex items-start gap-2 rounded-xl border border-[var(--color-crimson-500)]/20 bg-[var(--color-crimson-900)]/10 px-3 py-2.5">
						<AlertTriangle class="h-4 w-4 shrink-0 text-[var(--color-crimson-400)] mt-0.5" />
						<div class="flex-1 text-xs text-[var(--color-crimson-400)]">
							<span class="font-semibold">Enrichment {enrichmentErrors.length === 1 ? 'error' : 'errors'}:</span>
							{#each enrichmentErrors as error}
								<div class="mt-0.5 text-[var(--color-crimson-400)]/80">{error}</div>
							{/each}
						</div>
						<button onclick={() => enrichmentErrors = []} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
							<X class="h-3.5 w-3.5" />
						</button>
					</div>
				{/if}

				<!-- Style Review Warning -->
				{#if styleReview && !styleReview.approved && styleReview.issues.length > 0}
					<div class="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
						<AlertTriangle class="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
						<div class="text-xs text-amber-300">
							<span class="font-semibold">Style note:</span>
							{styleReview.issues[0].description}
							{#if styleReview.issues.length > 1}
								<span class="text-amber-400/60"> +{styleReview.issues.length - 1} more</span>
							{/if}
						</div>
					</div>
				{/if}

			</div>
		{/if}
	</div>

	<!-- Input tray with menu -->
	<div class="border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3 pb-[max(env(safe-area-inset-bottom),12px)]">
		<div class="mx-auto max-w-2xl">
			<div class="flex items-end gap-2">
				<!-- Tray menu button -->
				{#if story.entries.length > 0}
					<div class="relative shrink-0 mb-0.5">
						<button
							onclick={() => { fabOpen = !fabOpen; confirmingDelete = false; }}
							class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] transition-all hover:bg-[var(--bg-primary)] active:scale-95"
						>
							{#if fabOpen}
								<X class="h-4 w-4 text-[var(--text-primary)]" />
							{:else}
								<MoreVertical class="h-4 w-4 text-[var(--text-accent)]" />
							{/if}
						</button>

						{#if fabOpen}
							<div class="absolute bottom-11 left-0 z-30 flex flex-col gap-1.5 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2 shadow-xl shadow-black/30 min-w-[160px]">
								<button
									onclick={() => { drawerOpen = true; fabOpen = false; }}
									class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
								>
									<Users class="h-4 w-4 text-[var(--text-accent)]" />
									<span class="text-xs font-medium text-[var(--text-primary)]">World</span>
									{#if story.characters.length > 0}
										<span class="ml-auto flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-gold-400)] text-[8px] font-bold text-[var(--bg-primary)]">{story.characters.length}</span>
									{/if}
								</button>
								<button
									onclick={() => { workspaceTab = 'lore'; fabOpen = false; }}
									class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
								>
									<Database class="h-4 w-4 text-[var(--text-accent)]" />
									<span class="text-xs font-medium text-[var(--text-primary)]">Lore</span>
								</button>
								<button
									onclick={() => { openHeaderEditor(); fabOpen = false; }}
									class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
								>
									<ScrollText class="h-4 w-4 text-purple-400" />
									<span class="text-xs font-medium text-[var(--text-primary)]">Header</span>
									{#if story.currentStory?.headerPrompt}
										<span class="ml-auto h-1.5 w-1.5 rounded-full bg-purple-400"></span>
									{/if}
								</button>
								<button
									onclick={() => { generateSceneImage(); fabOpen = false; }}
									disabled={loadingImage}
									class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
								>
									{#if loadingImage}
										<Loader2 class="h-4 w-4 animate-spin text-sky-400" />
									{:else}
										<Image class="h-4 w-4 text-sky-400" />
									{/if}
									<span class="text-xs font-medium text-[var(--text-primary)]">Scene Image</span>
								</button>
								<button
									onclick={() => { handleExport(); fabOpen = false; }}
									disabled={exporting}
									class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
								>
									{#if exporting}
										<Loader2 class="h-4 w-4 animate-spin text-emerald-400" />
									{:else}
										<Download class="h-4 w-4 text-emerald-400" />
									{/if}
									<span class="text-xs font-medium text-[var(--text-primary)]">Export</span>
								</button>
								{#if !confirmingDelete}
									<button
										onclick={() => confirmingDelete = true}
										class="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--color-crimson-900)]/20"
									>
										<Trash2 class="h-4 w-4 text-[var(--color-crimson-400)]" />
										<span class="text-xs font-medium text-[var(--color-crimson-400)]">Delete</span>
									</button>
								{:else}
									<button
										onclick={handleDelete}
										class="flex items-center gap-2 rounded-lg bg-[var(--color-crimson-900)]/30 px-3 py-2 text-left border border-[var(--color-crimson-500)]/40"
									>
										<Trash2 class="h-4 w-4 text-[var(--color-crimson-400)]" />
										<span class="text-xs font-bold text-[var(--color-crimson-400)]">Confirm</span>
									</button>
								{/if}
							</div>
						{/if}
					</div>
				{/if}

				<div class="flex-1 min-w-0">
					<ActionInput
						onStreamStart={handleStreamStart}
						onStreamChunk={handleStreamChunk}
						onStreamEnd={handleStreamEnd}
						onStreamClear={() => { streamingContent = ''; isStreaming = false; }}
					/>
				</div>
			</div>
		</div>
	</div>
	{/if}
</div>


<!-- World State Drawer -->
<WorldDrawer open={drawerOpen} onClose={() => drawerOpen = false} />

<!-- Header Prompt Editor Modal -->
{#if headerEditorOpen}
	<div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
		<!-- Backdrop -->
		<button
			class="absolute inset-0 bg-black/60 backdrop-blur-sm"
			onclick={() => headerEditorOpen = false}
			aria-label="Close header editor"
		></button>

		<!-- Panel -->
		<div class="relative z-10 flex w-full max-w-xl flex-col rounded-t-2xl sm:rounded-2xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-2xl max-h-[85vh]">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-5 py-4">
				<div class="flex items-center gap-2.5">
					<ScrollText class="h-4 w-4 text-purple-400" />
					<h3 class="font-display text-sm font-semibold tracking-wide text-[var(--text-primary)]">Story Controls</h3>
				</div>
				<button onclick={() => headerEditorOpen = false} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="flex border-b border-[var(--border-primary)] px-5 pt-2">
				<button
					onclick={() => editorTab = 'story'}
					class="flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs transition-colors {editorTab === 'story' ? 'border-purple-400 text-purple-300' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
				>
					<ScrollText class="h-3.5 w-3.5" />
					<span>Story</span>
				</button>
			</div>

			<!-- Content -->
			<div class="flex-1 overflow-y-auto px-5 py-4 space-y-4">
				{#if editorTab === 'story'}
				<!-- Title -->
				<div class="space-y-1.5">
					<label for="story-title-input" class="text-xs font-medium text-[var(--text-muted)]">Story Title</label>
					<input
						id="story-title-input"
						type="text"
						bind:value={titleDraft}
						placeholder="Enter story title..."
						class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/30"
					/>
				</div>

				<div class="border-t border-[var(--border-primary)]"></div>

				<!-- World Description -->
				<div class="space-y-1.5">
					<label for="story-description-input" class="text-xs font-medium text-[var(--text-muted)]">World Description</label>
					<p class="text-[10px] text-[var(--text-muted)]/80 leading-relaxed">
						The setting summary the AI sees as "Setting: …" in every prompt. Edit if it contains stale facts (dates, character states, anachronisms).
					</p>
					<textarea
						id="story-description-input"
						bind:value={descriptionDraft}
						placeholder="A crumbling empire where ancient magic seeps through fractured ley lines..."
						rows="4"
						class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/30"
					></textarea>
				</div>

				<div class="border-t border-[var(--border-primary)]"></div>

				<!-- AI Preamble -->
				<p class="text-xs text-[var(--text-muted)] leading-relaxed">
					This preamble is prepended to every AI prompt for this story. Use it to define tone, rules, content guidelines, or narrative constraints unique to this story.
				</p>
				<textarea
					bind:value={headerDraft}
					placeholder={"Example:\nYou are narrating a gritty noir detective story. Keep dialogue sharp and cynical. Avoid flowery language. Violence is implied, never graphic. Every scene should feel like it's raining, even when it isn't."}
					rows="10"
					class="w-full resize-none rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/30 leading-relaxed"
				></textarea>
				<div class="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
					<span>{headerDraft.length > 0 ? `~${Math.ceil(headerDraft.length / 4)} tokens` : 'Empty — default behavior'}</span>
					{#if headerDraft !== (story.currentStory?.headerPrompt ?? '') || titleDraft !== (story.currentStory?.title ?? '') || descriptionDraft !== (story.currentStory?.description ?? '')}
						<span class="text-purple-400">Unsaved changes</span>
					{/if}
				</div>
				{:else}
				<div class="space-y-1.5">
					<label for="character-name-input" class="text-xs font-medium text-[var(--text-muted)]">Protagonist Name</label>
					<input
						id="character-name-input"
						type="text"
						bind:value={characterNameDraft}
						placeholder="Who the player controls..."
						class="w-full rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/30"
					/>
				</div>

				<div class="space-y-1.5">
					<label for="character-description-input" class="text-xs font-medium text-[var(--text-muted)]">Description</label>
					<textarea
						id="character-description-input"
						bind:value={characterDescriptionDraft}
						placeholder="Age, appearance, background, current condition, role, and anything the narrator must keep current..."
						rows="8"
						class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/30"
					></textarea>
				</div>

				<div class="space-y-1.5">
					<label for="character-traits-input" class="text-xs font-medium text-[var(--text-muted)]">Traits</label>
					<textarea
						id="character-traits-input"
						bind:value={characterTraitsDraft}
						placeholder="Comma or line separated traits..."
						rows="3"
						class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/30"
					></textarea>
				</div>

				<div class="space-y-1.5">
					<label for="player-reputation-input" class="text-xs font-medium text-[var(--text-muted)]">Player Reputation</label>
					<p class="text-[10px] text-[var(--text-muted)]/80 leading-relaxed">
						Public-facing reputation the narrator sees as its own prompt section.
					</p>
					<textarea
						id="player-reputation-input"
						bind:value={reputationDraft}
						placeholder="How the realm, smallfolk, noble courts, factions, enemies, and rumor networks currently speak of the player..."
						rows="6"
						class="w-full resize-none rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/30"
					></textarea>
				</div>

				<div class="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-muted)]">
					This is the live protagonist record used in prompts. Update age, injuries, identity changes, titles, or appearance here when long play drifts.
				</div>
				{#if characterNameDraft !== (story.protagonist?.name ?? '') || characterDescriptionDraft !== (story.protagonist?.description ?? '') || characterTraitsDraft !== (story.protagonist?.traits?.join(', ') ?? '') || reputationDraft !== (story.currentStory?.playerReputation ?? '')}
					<div class="text-right text-[10px] text-purple-400">Unsaved changes</div>
				{/if}
				{/if}
			</div>

			<!-- Footer -->
			<div class="flex items-center justify-end gap-2 border-t border-[var(--border-primary)] px-5 py-3">
				{#if editorTab === 'story' && headerDraft.trim()}
					<button
						onclick={() => { headerDraft = ''; }}
						class="rounded-lg px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--color-crimson-400)] transition-colors"
					>
						Clear
					</button>
				{/if}
				<button
					onclick={() => headerEditorOpen = false}
					class="rounded-lg px-4 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={saveHeaderPrompt}
					class="rounded-lg bg-purple-500/20 border border-purple-500/30 px-4 py-2 text-xs font-medium text-purple-300 hover:bg-purple-500/30 transition-colors"
				>
					Save
				</button>
			</div>
		</div>
	</div>
{/if}
