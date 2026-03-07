<script lang="ts">
	import { Plus, Upload, Trash2, MoreVertical } from 'lucide-svelte';
	import { app } from '$lib/stores/app.svelte';
	import { getAllStories, deleteStory } from '$lib/services/database';
	import type { Story } from '$lib/types';
	import { onMount } from 'svelte';

	let stories = $state<Story[]>([]);
	let confirmDelete = $state<string | null>(null);

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
</script>

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
			<button onclick={() => app.startNewStory()}
				class="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-[var(--color-gold-400)] to-[var(--color-gold-600)] px-8 py-4 font-display text-sm font-semibold tracking-wide text-[var(--bg-primary)] transition-all hover:shadow-lg hover:shadow-[rgba(212,168,83,0.3)]">
				<Plus class="h-5 w-5" />
				Create Story
			</button>
		</div>
	{:else}
		<!-- Story list -->
		<div class="px-4 py-5">
			<div class="mb-5 flex items-center justify-between">
				<h2 class="font-display text-lg tracking-wide text-[var(--text-primary)]">Your Chronicles</h2>
				<button onclick={() => app.startNewStory()}
					class="flex items-center gap-2 rounded-lg bg-[rgba(212,168,83,0.12)] px-4 py-2 font-display text-xs tracking-wider uppercase text-[var(--text-accent)] transition-colors hover:bg-[rgba(212,168,83,0.2)]">
					<Plus class="h-3.5 w-3.5" /> New
				</button>
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
								<div class="truncate font-display text-sm font-semibold tracking-wide text-[var(--text-primary)]">{s.title}</div>
								<div class="mt-0.5 flex items-center gap-2 text-xs text-[var(--text-muted)]">
									<span class="capitalize">{s.genre ?? 'No genre'}</span>
									<span>·</span>
									<span>{formatDate(s.updatedAt)}</span>
								</div>
							</div>
						</button>

						<!-- Delete -->
						{#if confirmDelete === s.id}
							<div class="absolute right-2 top-2 flex items-center gap-1 rounded-lg bg-[var(--bg-primary)] p-1 shadow-lg border border-[var(--border-primary)]">
								<button onclick={() => handleDelete(s.id)} class="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-500/10">Delete</button>
								<button onclick={() => confirmDelete = null} class="rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]">Cancel</button>
							</div>
						{:else}
							<button
								class="absolute right-3 top-3 hidden rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] group-hover:block"
								onclick={(e) => { e.stopPropagation(); confirmDelete = s.id; }}
							>
								<Trash2 class="h-3.5 w-3.5" />
							</button>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
