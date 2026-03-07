<script lang="ts">
	import { story } from '$lib/stores/story.svelte';
	import { app } from '$lib/stores/app.svelte';
	import ActionInput from './ActionInput.svelte';
	import { ArrowLeft, Loader2, Users, Map, BookOpen, Settings } from 'lucide-svelte';
	import { tick, onMount } from 'svelte';

	let scrollContainer = $state<HTMLDivElement | null>(null);
	let streamingContent = $state('');
	let isStreaming = $state(false);

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
		scrollToBottom();
	}

	function handleStreamChunk(text: string) {
		streamingContent = text;
		scrollToBottom();
	}

	function handleStreamEnd(fullText: string) {
		streamingContent = '';
		isStreaming = false;
		scrollToBottom();
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
		<div class="flex items-center gap-2 text-[var(--text-muted)]">
			<button class="relative p-1.5 hover:text-[var(--text-primary)]" title="Characters">
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
			<!-- Empty state — prompt user to start -->
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

<script module lang="ts">
	function formatNarrative(text: string): string {
		// Convert double newlines to paragraph breaks, single to <br>
		return text
			.split('\n\n')
			.map(p => `<p class="text-sm leading-relaxed text-[var(--text-primary)] mb-2">${p.replace(/\n/g, '<br/>')}</p>`)
			.join('');
	}
</script>
