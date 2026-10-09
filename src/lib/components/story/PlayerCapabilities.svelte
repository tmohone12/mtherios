<script lang="ts">
	import { Loader2, Pencil, Save, Shield, Sparkles } from 'lucide-svelte';
	import { playerCapabilitiesSchema, readPlayerCapabilities } from '$lib/contracts/playerCapabilities';
	import { story } from '$lib/stores/story.svelte';
	import type { Character } from '$lib/types';

	let { character }: { character: Character } = $props();
	const capabilities = $derived(readPlayerCapabilities(character.metadata?.playerCapabilities));
	let editing = $state(false);
	let saving = $state(false);
	let abilitiesDraft = $state('');
	let buffsDraft = $state('');
	let error = $state<string | null>(null);

	function edit() {
		abilitiesDraft = capabilities.abilities.join('\n');
		buffsDraft = capabilities.buffs.join('\n');
		error = null;
		editing = true;
	}

	async function save() {
		if (saving) return;
		const lines = (text: string) => [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
		const parsed = playerCapabilitiesSchema.safeParse({ abilities: lines(abilitiesDraft), buffs: lines(buffsDraft) });
		if (!parsed.success) {
			error = 'Use up to 12 entries per list, with 300 characters or fewer per entry.';
			return;
		}
		saving = true;
		error = null;
		try {
			await story.saveProtagonist({ name: character.name, playerCapabilities: parsed.data });
			editing = false;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not save buffs and abilities.';
		} finally {
			saving = false;
		}
	}
</script>

<section aria-labelledby="player-capabilities-title" class="space-y-3 rounded-2xl border border-[var(--text-accent)]/20 bg-[var(--bg-tertiary)] p-4">
	<div class="flex items-start justify-between gap-3">
		<div><h3 id="player-capabilities-title" class="font-semibold text-[var(--text-primary)]">Buffs &amp; Abilities</h3><p class="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">Effects, limits, and duration notes for the GM.</p></div>
		{#if !editing}<button onclick={edit} aria-label="Edit buffs and abilities" class="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-[var(--text-accent)] hover:bg-white/8"><Pencil class="h-3.5 w-3.5" />Edit</button>{/if}
	</div>
	{#if editing}
		<p class="text-xs text-[var(--text-muted)]">One entry per line, up to 12 in each list. Include a name and what it does. Remove buffs when they end.</p>
		<label class="block text-xs font-semibold text-[var(--text-accent)]">Active buffs
			<textarea bind:value={buffsDraft} disabled={saving} rows="4" placeholder="Blessing — resists cold until the next rest" class="mt-1.5 w-full resize-y rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 text-sm font-normal leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)] disabled:opacity-50"></textarea>
		</label>
		<label class="block text-xs font-semibold text-[var(--text-accent)]">Abilities
			<textarea bind:value={abilitiesDraft} disabled={saving} rows="4" placeholder="Keen senses — can track faint sounds in darkness" class="mt-1.5 w-full resize-y rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3 text-sm font-normal leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--text-accent)] disabled:opacity-50"></textarea>
		</label>
		<div class="flex gap-2">
			<button onclick={save} disabled={saving} class="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--text-accent)] px-3 text-sm font-semibold text-[var(--text-on-accent)] disabled:opacity-50">{#if saving}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Save class="h-4 w-4" />{/if}Save buffs and abilities</button>
			<button onclick={() => { editing = false; error = null; }} disabled={saving} class="min-h-10 rounded-xl px-3 text-sm text-[var(--text-secondary)] hover:bg-white/8 disabled:opacity-50">Cancel</button>
		</div>
		{#if error}<p role="alert" class="text-xs text-rose-300">{error}</p>{/if}
	{:else}
		{#each [{ title: 'Active buffs', notes: capabilities.buffs, icon: Shield, empty: 'No active buffs recorded.' }, { title: 'Abilities', notes: capabilities.abilities, icon: Sparkles, empty: 'No abilities recorded yet.' }] as group}
			<article class="rounded-xl bg-[var(--bg-primary)]/55 p-3">
				<h4 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]"><group.icon class="h-3.5 w-3.5" />{group.title}<span class="ml-auto text-[var(--text-muted)]">{group.notes.length}</span></h4>
				{#if group.notes.length}<ul class="mt-2 space-y-2">{#each group.notes as note}<li class="break-words border-l-2 border-[var(--text-accent)]/25 pl-3 text-sm leading-relaxed text-[var(--text-secondary)]">{note}</li>{/each}</ul>{:else}<p class="mt-2 text-xs text-[var(--text-muted)]">{group.empty}</p>{/if}
			</article>
		{/each}
	{/if}
</section>
