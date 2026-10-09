<script lang="ts">
	import type { BackendDiceRoll } from '$lib/services/backendAgentRuns';
	let { roll, actor, portrait = null }: { roll: BackendDiceRoll; actor: string; portrait?: string | null } = $props();
</script>

<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3" aria-label={`${actor} roll result`}>
	<div class="flex flex-wrap items-center justify-between gap-2">
		{#if portrait}<img src={portrait} alt="" class="h-9 w-9 rounded-full object-cover" />{/if}
		<div class="text-sm font-medium text-[var(--text-primary)]">{actor}{roll.reason ? ` — ${roll.reason}` : ''}</div>
		<strong class="text-lg tabular-nums text-[var(--text-accent)]">{roll.total}</strong>
	</div>
	<div class="text-xs text-[var(--text-muted)]">{roll.diceExpression}</div>
	<details class="mt-2 text-xs text-[var(--text-secondary)]">
		<summary class="cursor-pointer">Dice details</summary>
		<ul class="mt-2 space-y-1">
			{#each roll.groups as group}
				<li>
					{group.label ? `${group.label}: ` : ''}{group.notation}:
					{#if group.rolls.length}
						{#each group.rolls as face, index}
							<span class:line-through={!group.kept[index]} class:opacity-50={!group.kept[index]}>{face}</span>{index < group.rolls.length - 1 ? ', ' : ''}
						{/each}
					{:else}modifier{/if}
					= {group.subtotal}
				</li>
			{/each}
		</ul>
	</details>
</section>
