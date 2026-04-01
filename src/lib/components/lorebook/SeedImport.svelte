<script lang="ts">
	import { Loader2, Download, CheckCircle, AlertTriangle, Swords } from 'lucide-svelte';
	import { listBuiltinSeeds, importBuiltinSeed, type SeedImportResult } from '$lib/services/seedImporter';

	interface Props {
		storyId: string;
		onComplete?: () => void;
	}

	let { storyId, onComplete }: Props = $props();

	let seeds = $state(listBuiltinSeeds());
	let importing = $state(false);
	let result = $state<SeedImportResult | null>(null);
	let error = $state<string | null>(null);
	let selectedSeed = $state<string | null>(null);

	// Import options
	let skipDuplicates = $state(true);
	let markDiscovered = $state(true);

	async function handleImport() {
		if (!selectedSeed || !storyId) return;
		importing = true;
		error = null;
		result = null;

		try {
			result = await importBuiltinSeed(storyId, selectedSeed, {
				skipDuplicates,
				markDiscovered,
			});

			if (result.imported > 0) {
				onComplete?.();
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			importing = false;
		}
	}
</script>

<div class="space-y-4">
	<div class="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
		<Swords class="h-4 w-4 text-amber-400" />
		<span>Faction Seed Packs</span>
	</div>

	<p class="text-xs text-[var(--text-muted)]">
		Import pre-built faction sets with goals, resources, alliances, and hidden agendas.
		The Faction Simulation service will bring them to life.
	</p>

	<!-- Seed selection -->
	<div class="space-y-2">
		{#each seeds as seed}
			<button
				class="w-full rounded-lg border p-3 text-left transition-all
					{selectedSeed === seed.id
						? 'border-amber-500/50 bg-amber-500/10'
						: 'border-[var(--border-primary)] bg-[var(--bg-tertiary)] hover:border-[var(--color-gold-600)]/40'}"
				onclick={() => selectedSeed = selectedSeed === seed.id ? null : seed.id}
			>
				<div class="text-sm font-medium text-[var(--text-primary)]">{seed.name}</div>
				<div class="mt-1 text-xs text-[var(--text-muted)]">{seed.description}</div>
			</button>
		{/each}
	</div>

	<!-- Options -->
	{#if selectedSeed}
		<div class="space-y-2 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3">
			<label class="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
				<input type="checkbox" bind:checked={skipDuplicates}
					class="rounded border-[var(--border-primary)]" />
				Skip factions already in lorebook
			</label>
			<label class="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
				<input type="checkbox" bind:checked={markDiscovered}
					class="rounded border-[var(--border-primary)]" />
				Mark factions as discovered by player
			</label>
		</div>

		<button
			class="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-600/80 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
			onclick={handleImport}
			disabled={importing}
		>
			{#if importing}
				<Loader2 class="h-4 w-4 animate-spin" />
				Importing factions...
			{:else}
				<Download class="h-4 w-4" />
				Import Faction Pack
			{/if}
		</button>
	{/if}

	<!-- Result -->
	{#if result}
		<div class="rounded-lg border p-3 text-xs
			{result.errors.length > 0
				? 'border-red-500/30 bg-red-500/10'
				: 'border-emerald-500/30 bg-emerald-500/10'}">
			<div class="flex items-center gap-2">
				{#if result.errors.length > 0}
					<AlertTriangle class="h-4 w-4 text-red-400" />
				{:else}
					<CheckCircle class="h-4 w-4 text-emerald-400" />
				{/if}
				<span class="font-medium text-[var(--text-primary)]">
					{result.imported} imported{result.skipped > 0 ? `, ${result.skipped} skipped` : ''}
				</span>
			</div>

			{#if result.skippedNames.length > 0}
				<div class="mt-1 text-[var(--text-muted)]">
					Skipped (already exist): {result.skippedNames.join(', ')}
				</div>
			{/if}

			{#if result.errors.length > 0}
				<div class="mt-1 text-red-400">
					Errors: {result.errors.join('; ')}
				</div>
			{/if}
		</div>
	{/if}

	{#if error}
		<div class="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
			{error}
		</div>
	{/if}
</div>
