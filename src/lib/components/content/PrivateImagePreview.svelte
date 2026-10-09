<script lang="ts">
  import { onDestroy } from 'svelte';

  let { assetId, projectId, gameId = null, alt = 'Private artwork' }: {
    assetId: string; projectId: string; gameId?: string | null; alt?: string;
  } = $props();
  let previewUrl = $state('');
  let busy = $state(false);
  let error = $state('');
  let activeScope = '';

  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    error = '';
  }

  $effect(() => {
    const scope = `${projectId}\0${gameId ?? ''}\0${assetId}`;
    if (scope === activeScope) return;
    activeScope = scope;
    clearPreview();
    busy = false;
  });

  onDestroy(() => { activeScope = ''; clearPreview(); });

  async function showPreview() {
    if (previewUrl) { clearPreview(); return; }
    const scope = activeScope;
    busy = true;
    error = '';
    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, ...(gameId ? { gameId } : {}) }),
      });
      if (!response.ok) throw new Error(response.status === 404 ? 'Image is no longer available in this project.' : 'Could not preview this image.');
      const objectUrl = URL.createObjectURL(await response.blob());
      if (scope !== activeScope) URL.revokeObjectURL(objectUrl);
      else previewUrl = objectUrl;
    } catch (cause) {
      if (scope === activeScope) error = cause instanceof Error ? cause.message : 'Could not preview this image.';
    } finally {
      if (scope === activeScope) busy = false;
    }
  }
</script>

<div class="mt-2 space-y-2">
  <button type="button" class="rounded-lg border border-[var(--border-primary)] px-3 py-1.5 text-xs text-[var(--text-primary)] disabled:opacity-50" onclick={showPreview} disabled={busy}>
    {busy ? 'Loading image…' : previewUrl ? 'Hide private image' : 'Preview private image'}
  </button>
  {#if previewUrl}<img src={previewUrl} {alt} class="max-h-80 max-w-full object-contain" />{/if}
  {#if error}<p role="alert" class="text-xs text-rose-300">{error}</p>{/if}
</div>
