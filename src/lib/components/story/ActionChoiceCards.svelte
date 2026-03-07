<script lang="ts">
	import { Sword, Shield, Lightbulb, Users, Search } from 'lucide-svelte';
	import type { ActionChoice } from '$lib/services/ai/sdk/schemas/actionchoices';

	interface Props {
		choices: ActionChoice[];
		onSelect: (text: string) => void;
	}

	let { choices, onSelect }: Props = $props();

	const typeIcons: Record<string, typeof Sword> = {
		bold: Sword, cautious: Shield, creative: Lightbulb, social: Users, investigate: Search,
	};
	const riskColors: Record<string, string> = {
		low: 'text-emerald-400', medium: 'text-amber-400', high: 'text-red-400',
	};
</script>

<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
	{#each choices as choice}
		{@const Icon = typeIcons[choice.type] ?? Sword}
		<button
			class="flex items-start gap-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-left transition-all hover:border-[var(--color-gold-600)] hover:bg-[rgba(212,168,83,0.04)] active:scale-[0.98]"
			onclick={() => onSelect(choice.text)}
		>
			<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-primary)]">
				<Icon class="h-4 w-4 text-[var(--text-accent)]" />
			</div>
			<div class="flex-1 min-w-0">
				<p class="text-sm text-[var(--text-primary)]">{choice.text}</p>
				<div class="mt-1 flex items-center gap-2">
					<span class="text-[10px] capitalize text-[var(--text-muted)]">{choice.type}</span>
					{#if choice.risk}
						<span class="text-[10px] {riskColors[choice.risk] ?? ''}">● {choice.risk} risk</span>
					{/if}
				</div>
			</div>
		</button>
	{/each}
</div>
