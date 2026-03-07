<script lang="ts">
	import { Wand2, MessageSquare, Brain, Sparkles } from 'lucide-svelte';
	import type { Suggestion } from '$lib/services/ai/sdk/schemas/suggestions';

	interface Props {
		suggestions: Suggestion[];
		onSelect: (text: string) => void;
	}

	let { suggestions, onSelect }: Props = $props();

	const typeIcons: Record<string, typeof Wand2> = {
		action: Wand2, dialogue: MessageSquare, thought: Brain, direction: Sparkles,
	};
	const typeColors: Record<string, string> = {
		action: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
		dialogue: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
		thought: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
		direction: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
	};
</script>

<div class="flex flex-wrap gap-2">
	{#each suggestions as sug}
		{@const Icon = typeIcons[sug.type] ?? Wand2}
		{@const colors = typeColors[sug.type] ?? 'text-[var(--text-muted)] bg-[var(--bg-tertiary)] border-[var(--border-primary)]'}
		<button
			class="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-all hover:scale-[1.02] active:scale-95 {colors}"
			onclick={() => onSelect(sug.text)}
		>
			<Icon class="h-3 w-3" />
			<span>{sug.text}</span>
		</button>
	{/each}
</div>
