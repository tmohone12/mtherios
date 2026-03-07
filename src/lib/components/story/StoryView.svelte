<script lang="ts">
	import { story } from '$lib/stores/story.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { ai } from '$lib/services/ai';
	import ActionInput from './ActionInput.svelte';
	import SuggestionChips from './SuggestionChips.svelte';
	import ActionChoiceCards from './ActionChoiceCards.svelte';
	import WorldStateToast from './WorldStateToast.svelte';
	import WorldDrawer from './WorldDrawer.svelte';
	import { ArrowLeft, Loader2, Users, Map, BookOpen, Image, AlertTriangle } from 'lucide-svelte';
	import { tick, onMount } from 'svelte';
	import type { Suggestion } from '$lib/services/ai/sdk/schemas/suggestions';
	import type { ActionChoice } from '$lib/services/ai/sdk/schemas/actionchoices';
	import type { ClassificationResult } from '$lib/services/ai/sdk/schemas/classifier';
	import type { StyleReview } from '$lib/services/ai/sdk/schemas/style';

	let scrollContainer = $state<HTMLDivElement | null>(null);
	let streamingContent = $state('');
	let isStreaming = $state(false);

	// Service output states
	let suggestions = $state<Suggestion[]>([]);
	let actionChoices = $state<ActionChoice[]>([]);
	let classificationResult = $state<ClassificationResult | null>(null);
	let styleReview = $state<StyleReview | null>(null);
	let sceneImageUrl = $state<string | null>(null);
	let loadingSuggestions = $state(false);
	let loadingClassifier = $state(false);
	let loadingImage = $state(false);

	// World drawer
	let drawerOpen = $state(false);

	const isAdventure = $derived(story.storyMode === 'adventure');

	async function scrollToBottom() {
		await tick();
		if (scrollContainer) {
			scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
		}
	}

	function handleStreamStart() {
		streamingContent = '';
		isStreaming = true;
		suggestions = [];
		actionChoices = [];
		classificationResult = null;
		styleReview = null;
		sceneImageUrl = null;
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

		// Run post-generation services in parallel
		const jobs: Promise<void>[] = [];

		// 1. Classifier — extract world state
		const classifierConfig = settings.getServiceConfig('classifier');
		if (classifierConfig.enabled) {
			jobs.push(runClassifier(fullText));
		}

		// 2. Suggestions
		const sugConfig = settings.getServiceConfig('suggestions');
		if (sugConfig.enabled && isAdventure) {
			jobs.push(runSuggestions());
		}

		// 3. Action Choices (only if adventure mode and enough story)
		const choicesConfig = settings.getServiceConfig('actionChoices');
		if (choicesConfig.enabled && isAdventure && story.entries.length >= 4) {
			jobs.push(runActionChoices());
		}

		// 4. Style Review
		const styleConfig = settings.getServiceConfig('styleReviewer');
		if (styleConfig.enabled) {
			jobs.push(runStyleReview(fullText));
		}

		// 5. Image Generation
		const imgConfig = settings.getServiceConfig('imageGeneration');
		if (imgConfig.enabled) {
			jobs.push(runImageGeneration(fullText));
		}

		await Promise.allSettled(jobs);
	}

	async function runClassifier(narrative: string) {
		loadingClassifier = true;
		try {
			classificationResult = await ai.classifier.classify(
				narrative,
				story.entries.slice(-5),
				story.characters,
				story.locations,
				story.items,
				story.storyMode,
				story.pov,
				story.tense,
			);

			// Auto-create new characters from classification
			if (classificationResult.characters.length > 0) {
				for (const charUpdate of classificationResult.characters) {
					const exists = story.characters.some(c => c.name.toLowerCase() === charUpdate.name.toLowerCase());
					if (!exists && charUpdate.name) {
						await story.addCharacter(charUpdate.name, charUpdate.description ?? undefined, charUpdate.relationship ?? undefined);
					}
				}
			}
		} catch (e) {
			console.error('Classifier failed:', e);
		}
		loadingClassifier = false;
	}

	async function runSuggestions() {
		loadingSuggestions = true;
		try {
			const result = await ai.suggestions.suggest(
				story.entries.slice(-5),
				story.protagonist,
				story.storyMode,
				story.pov,
			);
			suggestions = result.suggestions;
		} catch (e) {
			console.error('Suggestions failed:', e);
		}
		loadingSuggestions = false;
		scrollToBottom();
	}

	async function runActionChoices() {
		try {
			const currentLoc = story.locations.find(l => l.current);
			const result = await ai.actionChoices.generateChoices(
				story.entries.slice(-5),
				story.protagonist,
				currentLoc,
				story.storyMode,
			);
			actionChoices = result.choices;
		} catch (e) {
			console.error('Action choices failed:', e);
		}
		scrollToBottom();
	}

	async function runStyleReview(narrative: string) {
		try {
			styleReview = await ai.styleReviewer.review(
				narrative,
				story.pov,
				story.tense,
				story.currentStory?.genre ?? '',
			);
		} catch (e) {
			console.error('Style review failed:', e);
		}
	}

	async function runImageGeneration(narrative: string) {
		loadingImage = true;
		try {
			const img = await ai.imageGen.generateSceneImage(narrative);
			if (img) sceneImageUrl = img.url;
		} catch (e) {
			console.error('Image generation failed:', e);
		}
		loadingImage = false;
		scrollToBottom();
	}

	function handleSuggestionSelect(text: string) {
		// Dispatch to ActionInput by setting a global
		(window as any).__mtherios_input_inject = text;
		suggestions = [];
		actionChoices = [];
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
		<div class="flex items-center gap-1">
			<button onclick={() => drawerOpen = true} class="relative rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]" title="World State">
				<Users class="h-4 w-4" />
				{#if story.characters.length > 0}
					<span class="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--color-gold-400)] text-[8px] font-bold text-[var(--bg-primary)]">{story.characters.length}</span>
				{/if}
			</button>
		</div>
	</div>

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
				{#each story.entries as entry}
					{#if entry.type === 'user_action'}
						<div class="flex justify-end">
							<div class="max-w-[85%] rounded-2xl rounded-br-md bg-[rgba(212,168,83,0.12)] px-4 py-3">
								<p class="text-sm leading-relaxed text-[var(--text-primary)]">{entry.content}</p>
							</div>
						</div>
					{:else if entry.type === 'narration'}
						<div class="prose-mtherios">
							<div class="rounded-2xl rounded-bl-md border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3">
								{@html formatNarrative(entry.content)}
							</div>
						</div>
					{:else if entry.type === 'system'}
						<div class="rounded-lg bg-[var(--color-crimson-900)]/20 border border-[var(--color-crimson-500)]/20 px-4 py-3 text-center text-xs text-[var(--color-crimson-400)]">
							{entry.content}
						</div>
					{/if}
				{/each}

				<!-- Streaming narration -->
				{#if isStreaming && streamingContent}
					<div class="prose-mtherios">
						<div class="rounded-2xl rounded-bl-md border border-[var(--color-gold-600)]/30 bg-[var(--bg-tertiary)] px-4 py-3">
							{@html formatNarrative(streamingContent)}
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
					<div class="overflow-hidden rounded-xl border border-[var(--border-primary)]">
						<img src={sceneImageUrl} alt="Scene" class="w-full" loading="lazy" />
					</div>
				{:else if loadingImage}
					<div class="flex items-center gap-2 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-xs text-[var(--text-muted)]">
						<Image class="h-4 w-4 animate-pulse" />
						<span>Generating scene...</span>
					</div>
				{/if}

				<!-- World State Toast -->
				{#if classificationResult}
					<WorldStateToast result={classificationResult} onDismiss={() => classificationResult = null} />
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

				<!-- Suggestions (pill chips) -->
				{#if suggestions.length > 0 && !isStreaming}
					<div class="pt-2">
						<SuggestionChips {suggestions} onSelect={handleSuggestionSelect} />
					</div>
				{:else if loadingSuggestions}
					<div class="flex items-center gap-2 py-2 text-xs text-[var(--text-muted)]">
						<Loader2 class="h-3 w-3 animate-spin" />
						<span>Thinking of suggestions...</span>
					</div>
				{/if}

				<!-- Action Choices (cards) -->
				{#if actionChoices.length > 0 && !isStreaming}
					<div class="pt-1">
						<div class="mb-2 font-display text-[10px] tracking-wider uppercase text-[var(--text-accent)]">What will you do?</div>
						<ActionChoiceCards choices={actionChoices} onSelect={handleSuggestionSelect} />
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Input -->
	<div class="border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] px-4 py-3 pb-[max(env(safe-area-inset-bottom),12px)]">
		<div class="mx-auto max-w-2xl">
			<ActionInput
				onStreamStart={handleStreamStart}
				onStreamChunk={handleStreamChunk}
				onStreamEnd={handleStreamEnd}
			/>
		</div>
	</div>
</div>

<!-- World State Drawer -->
<WorldDrawer open={drawerOpen} onClose={() => drawerOpen = false} />

<script module lang="ts">
	function formatNarrative(text: string): string {
		return text
			.split('\n\n')
			.map(p => `<p class="text-sm leading-relaxed text-[var(--text-primary)] mb-2">${p.replace(/\n/g, '<br/>')}</p>`)
			.join('');
	}
</script>
