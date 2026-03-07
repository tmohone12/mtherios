<script lang="ts">
	import { X, UserPlus, MapPin, Swords, Bookmark } from 'lucide-svelte';
	import { fade, fly } from 'svelte/transition';
	import type { ClassificationResult } from '$lib/services/ai/sdk/schemas/classifier';

	interface Props {
		result: ClassificationResult;
		onDismiss: () => void;
	}

	let { result, onDismiss }: Props = $props();

	const newChars = $derived(result.characters.filter(c => c.name));
	const newLocs = $derived(result.locations.filter(l => l.name));
	const newItems = $derived(result.items.filter(i => i.name));
	const beats = $derived(result.storyBeats.filter(b => b.title));
	const hasChanges = $derived(newChars.length > 0 || newLocs.length > 0 || newItems.length > 0 || beats.length > 0);
</script>

{#if hasChanges}
<div class="rounded-xl border border-[var(--color-gold-600)]/20 bg-[var(--bg-tertiary)] p-3"
	in:fly={{ y: 20, duration: 200 }} out:fade={{ duration: 150 }}>
	<div class="flex items-center justify-between mb-2">
		<span class="font-display text-[10px] tracking-wider uppercase text-[var(--text-accent)]">World Updated</span>
		<button onclick={onDismiss} class="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
			<X class="h-3.5 w-3.5" />
		</button>
	</div>

	<div class="space-y-1.5">
		{#each newChars as char}
			<div class="flex items-center gap-2 text-xs">
				<UserPlus class="h-3 w-3 text-emerald-400" />
				<span class="text-[var(--text-primary)]">{char.name}</span>
				{#if char.relationship}<span class="text-[var(--text-muted)]">({char.relationship})</span>{/if}
			</div>
		{/each}
		{#each newLocs as loc}
			<div class="flex items-center gap-2 text-xs">
				<MapPin class="h-3 w-3 text-blue-400" />
				<span class="text-[var(--text-primary)]">{loc.name}</span>
				{#if loc.current}<span class="rounded bg-blue-500/10 px-1 text-[10px] text-blue-400">current</span>{/if}
			</div>
		{/each}
		{#each newItems as item}
			<div class="flex items-center gap-2 text-xs">
				<Swords class="h-3 w-3 text-amber-400" />
				<span class="text-[var(--text-primary)]">{item.name}</span>
			</div>
		{/each}
		{#each beats as beat}
			<div class="flex items-center gap-2 text-xs">
				<Bookmark class="h-3 w-3 text-purple-400" />
				<span class="text-[var(--text-primary)]">{beat.title}</span>
				<span class="rounded bg-purple-500/10 px-1 text-[10px] text-purple-400">{beat.significance}</span>
			</div>
		{/each}
	</div>

	{#if result.mood}
		<div class="mt-2 text-[10px] text-[var(--text-muted)]">Mood: {result.mood}</div>
	{/if}
</div>
{/if}
