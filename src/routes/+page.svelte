<script lang="ts">
	import { Plus, Upload, Settings } from 'lucide-svelte';
	import { app } from '$lib/stores/app.svelte';
	import { getAllStories } from '$lib/services/database';
	import type { Story } from '$lib/types';
	import { onMount } from 'svelte';

	let stories = $state<Story[]>([]);

	onMount(async () => {
		stories = await getAllStories();
	});

	function formatDate(ts: number) {
		return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}
</script>

<div class="flex h-full flex-col overflow-y-auto">
	{#if stories.length === 0}
	<!-- Empty state -->
	<div class="flex flex-1 flex-col items-center justify-center gap-8 px-4 pb-20">
		<div class="relative">
			<svg viewBox="0 0 64 64" fill="none" class="h-20 w-20" style="filter: drop-shadow(0 0 20px rgba(212, 168, 83, 0.3));">
				<path d="M32 6L8 20v24l24 14 24-14V20L32 6z" stroke="url(#goldGrad)" stroke-width="1.5" fill="none"/>
				<path d="M32 6v52M8 20l24 14 24-14M8 44l24-14 24 14" stroke="url(#goldGrad)" stroke-width="0.8" opacity="0.3"/>
				<circle cx="32" cy="32" r="8" fill="url(#goldGrad)" opacity="0.15"/>
				<circle cx="32" cy="32" r="4" fill="url(#goldGrad)" opacity="0.5"/>
				<defs>
					<linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
						<stop offset="0%" stop-color="#d4a853"/>
						<stop offset="100%" stop-color="#f0d078"/>
					</linearGradient>
				</defs>
			</svg>
		</div>

		<div class="text-center">
			<h1 class="font-display text-3xl font-normal tracking-wide text-[var(--text-primary)]">Mtherios</h1>
			<p class="mt-3 max-w-sm text-[var(--text-muted)]">
				AI-powered interactive fiction. Your stories, your rules, your world.
			</p>
		</div>

		<button class="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] px-8 py-4 font-display text-base font-semibold tracking-wide text-[var(--bg-primary)] transition-all hover:shadow-lg hover:shadow-[rgba(212,168,83,0.3)]"
			onclick={() => app.startNewStory()}>
			<Plus class="h-5 w-5" />
			Create Your First Story
		</button>

		<button class="flex items-center gap-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-accent)]">
			<Upload class="h-4 w-4" />
			Import existing story
		</button>
	</div>

	{:else}
	<!-- Story list -->
	<div class="px-4 py-6">
		<div class="mb-6 flex items-center justify-between">
			<h2 class="font-display text-xl tracking-wide text-[var(--text-primary)]">Your Chronicles</h2>
			<button class="flex items-center gap-2 rounded-lg bg-[rgba(212,168,83,0.12)] px-4 py-2 font-display text-xs tracking-wider uppercase text-[var(--text-accent)] transition-colors hover:bg-[rgba(212,168,83,0.2)]"
				onclick={() => app.startNewStory()}>
				<Plus class="h-3.5 w-3.5" />
				New
			</button>
		</div>

		<div class="space-y-3">
			{#each stories as story}
				<button class="flex w-full items-center gap-4 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4 text-left transition-all hover:border-[var(--color-gold-600)] hover:bg-[rgba(212,168,83,0.05)]"
					onclick={() => app.openStory(story.id)}>
					<div class="flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--bg-primary)]">
						<span class="text-xl">{story.mode === 'adventure' ? '⚔️' : '✍️'}</span>
					</div>
					<div class="flex-1 min-w-0">
						<div class="truncate font-display text-sm font-semibold tracking-wide text-[var(--text-primary)]">{story.title}</div>
						<div class="flex items-center gap-3 text-xs text-[var(--text-muted)]">
							<span>{story.genre ?? 'No genre'}</span>
							<span>·</span>
							<span>{formatDate(story.updatedAt)}</span>
						</div>
					</div>
				</button>
			{/each}
		</div>
	</div>
	{/if}
</div>
