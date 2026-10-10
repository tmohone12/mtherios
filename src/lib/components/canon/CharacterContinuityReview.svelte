<script lang="ts">
	let { metadata, notes = $bindable('') }: { metadata: Record<string, unknown> | null; notes?: string } = $props();
	const conflicts = $derived(Array.isArray(metadata?.identityConflicts) ? metadata.identityConflicts as Array<Record<string, unknown>> : []);
</script>

{#if conflicts.length}
	<section aria-label="Character identity conflicts" class="w-full space-y-3 rounded border border-[var(--border-primary)] p-3">
		<p>Current identity is preserved. Compare each proposed change with its original passage and confirm who it describes. Rumors, disguises and beliefs belong in attributed notes.</p>
		{#each conflicts as conflict}
			<details><summary>{String(conflict.field)} — review required</summary>
				<p>Current: {JSON.stringify(conflict.previous)}</p><p>Proposed: {JSON.stringify(conflict.proposed)}</p>
				<p>{String(conflict.reason)}</p>
				{#each (Array.isArray(conflict.sources) ? conflict.sources : []) as source}
					<blockquote>{String(source.quote)}</blockquote><small>Source: {String(source.id)}</small>
				{/each}
			</details>
		{/each}
		<label class="block">Author decision
			<textarea class="mt-1 block w-full rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2" rows="3" bind:value={notes} placeholder="For an unsupported change, write retcon: followed by your explicit correction and reason."></textarea>
		</label>
	</section>
{/if}
