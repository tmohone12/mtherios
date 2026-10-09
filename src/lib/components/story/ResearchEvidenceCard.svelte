<script lang="ts">
  import type { BackendResearchTool } from '$lib/services/backendAgentRuns';

  let { research, projectId, gameId }: { research: BackendResearchTool['result']; projectId?: string | null; gameId?: string | null } = $props();

  function contentUrl(sourceId: string, revision: string) {
    if (!projectId || !sourceId.startsWith('content:') || !/^\d+$/.test(revision)) return null;
    const params = new URLSearchParams({ project: projectId, source: `${sourceId}@${revision}` });
    if (gameId) params.set('game', gameId);
    return `/?${params}`;
  }
</script>

<section class="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3 text-xs text-[var(--text-secondary)]" aria-label="Game Master research sources">
  <details>
    <summary class="cursor-pointer font-medium text-[var(--text-primary)]">Research sources · {research.statements.length} current</summary>
    <p class="mt-2">{research.question}</p>
    {#if research.statements.length}
      <ul class="mt-2 space-y-2">
        {#each research.statements as source (source.kind + source.sourceId + source.revision)}
          {@const url = contentUrl(source.sourceId, source.revision)}
          <li>
            <p class="whitespace-pre-wrap text-[var(--text-primary)]">“{source.statement}”</p>
            {#if url}<a href={url} data-sveltekit-reload class="underline">{source.sourceId}</a>{:else}<span>{source.sourceId}</span>{/if}
            <span> · {source.kind} · revision {source.revision}</span>
          </li>
        {/each}
      </ul>
    {:else if research.status === 'insufficient_evidence'}
      <p class="mt-2">No supported answer was found.</p>
    {:else}
      <p class="mt-2">The cited sources are no longer available at their recorded revisions.</p>
    {/if}
    {#if research.sourceUnavailable}<p class="mt-2">Some earlier citations were removed because their source changed or is no longer public.</p>{/if}
  </details>
</section>
