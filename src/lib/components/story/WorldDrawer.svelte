<script lang="ts">
	import { X, Users, MapPin, Swords, ScrollText } from 'lucide-svelte';
	import { story } from '$lib/stores/story.svelte';
	import { fly } from 'svelte/transition';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	const activeChars = $derived(story.characters.filter(c => c.status === 'active'));
	const protagonist = $derived(story.protagonist);
</script>

{#if open}
<div class="fixed inset-0 z-40 flex justify-end" transition:fly={{ x: 0, duration: 0 }}>
	<button class="absolute inset-0 bg-black/40" onclick={onClose}></button>

	<div class="relative z-10 flex h-full w-80 flex-col border-l border-[var(--border-primary)] bg-[var(--bg-secondary)]"
		transition:fly={{ x: 320, duration: 200 }}>

		<!-- Header -->
		<div class="flex items-center justify-between border-b border-[var(--border-primary)] px-4 py-3">
			<span class="font-display text-sm tracking-wide text-[var(--text-accent)]">World State</span>
			<button onclick={onClose} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
				<X class="h-5 w-5" />
			</button>
		</div>

		<div class="flex-1 overflow-y-auto px-4 py-4 space-y-6">
			<!-- Characters -->
			<div>
				<div class="mb-2 flex items-center gap-2">
					<Users class="h-4 w-4 text-[var(--text-accent)]" />
					<span class="font-display text-xs tracking-wider uppercase text-[var(--text-accent)]">Characters ({activeChars.length})</span>
				</div>
				{#if activeChars.length === 0}
					<p class="text-xs text-[var(--text-muted)]">No characters yet.</p>
				{:else}
					<div class="space-y-2">
						{#each activeChars as char}
							<div class="rounded-lg bg-[var(--bg-tertiary)] p-2.5">
								<div class="flex items-center gap-2">
									<span class="text-xs">{char.relationship === 'self' ? '⭐' : '👤'}</span>
									<span class="text-sm font-semibold text-[var(--text-primary)]">{char.name}</span>
									{#if char.relationship && char.relationship !== 'self'}
										<span class="rounded bg-[var(--bg-primary)] px-1 py-0.5 text-[9px] text-[var(--text-muted)]">{char.relationship}</span>
									{/if}
								</div>
								{#if char.description}
									<p class="mt-1 text-xs text-[var(--text-muted)] line-clamp-2">{char.description}</p>
								{/if}
								{#if char.traits && char.traits.length > 0}
									<div class="mt-1.5 flex flex-wrap gap-1">
										{#each char.traits as trait}
											<span class="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">{trait}</span>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Locations -->
			<div>
				<div class="mb-2 flex items-center gap-2">
					<MapPin class="h-4 w-4 text-blue-400" />
					<span class="font-display text-xs tracking-wider uppercase text-blue-400">Locations ({story.locations.length})</span>
				</div>
				{#if story.locations.length === 0}
					<p class="text-xs text-[var(--text-muted)]">No locations discovered.</p>
				{:else}
					<div class="space-y-1.5">
						{#each story.locations as loc}
							<div class="flex items-center gap-2 rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-2">
								<span class="text-xs">📍</span>
								<span class="text-sm text-[var(--text-primary)]">{loc.name}</span>
								{#if loc.current}
									<span class="rounded bg-blue-500/10 px-1 py-0.5 text-[9px] text-blue-400">here</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Items -->
			<div>
				<div class="mb-2 flex items-center gap-2">
					<Swords class="h-4 w-4 text-amber-400" />
					<span class="font-display text-xs tracking-wider uppercase text-amber-400">Items ({story.items.length})</span>
				</div>
				{#if story.items.length === 0}
					<p class="text-xs text-[var(--text-muted)]">No items found.</p>
				{:else}
					<div class="space-y-1.5">
						{#each story.items as item}
							<div class="flex items-center gap-2 rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-2">
								<span class="text-xs">🗡️</span>
								<span class="text-sm text-[var(--text-primary)]">{item.name}</span>
								{#if item.equipped}
									<span class="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] text-amber-400">equipped</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Lorebook -->
			{#if story.lorebookEntries.length > 0}
			<div>
				<div class="mb-2 flex items-center gap-2">
					<ScrollText class="h-4 w-4 text-purple-400" />
					<span class="font-display text-xs tracking-wider uppercase text-purple-400">Active Lore ({story.lorebookEntries.length})</span>
				</div>
				<div class="space-y-1.5">
					{#each story.lorebookEntries.slice(0, 10) as entry}
						<div class="rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-2">
							<div class="flex items-center gap-1.5">
								<span class="text-sm text-[var(--text-primary)]">{entry.name}</span>
								<span class="rounded bg-[var(--bg-primary)] px-1 py-0.5 text-[9px] capitalize text-[var(--text-muted)]">{entry.type}</span>
							</div>
							<p class="mt-0.5 text-xs text-[var(--text-muted)] line-clamp-1">{entry.description}</p>
						</div>
					{/each}
				</div>
			</div>
			{/if}
		</div>
	</div>
</div>
{/if}
