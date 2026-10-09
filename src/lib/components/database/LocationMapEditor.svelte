<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { emptyLocationMap, type LocationMapBody } from '$lib/contracts/locationMap';
  type Row = Record<string, unknown>;
  type MapObject = LocationMapBody['regions'][number] | LocationMapBody['pins'][number] | LocationMapBody['tokens'][number];
  type MapResult = { locationId: string; projectId: string; revision: number; map: LocationMapBody; backgrounds: Array<{ id: string }> };
  let { locationId, gameId, runCommand, navigate, onDirty }: {
    locationId: string; gameId: string; runCommand: (command: string, args: Row) => Promise<Row>;
    navigate: (id: string) => void; onDirty: (value: boolean) => void;
  } = $props();
  let loaded = $state<MapResult | null>(null);
  let map = $state<LocationMapBody>(emptyLocationMap());
  let dirty = $state(false);
  let busy = $state(false);
  let error = $state('');
  let mode = $state<'select' | 'pin' | 'token' | 'region'>('select');
  let points = $state<Array<{ x: number; y: number }>>([]);
  let selectedId = $state('');
  let zoom = $state(1);
  let history = $state<Array<{ revision: number; reason: string; createdAt: string }>>([]);
  let linkQuery = $state('');
  let linkResults = $state<Array<{ id: string; name: string }>>([]);
  const objects = $derived([...map.regions, ...map.pins, ...map.tokens].sort((a, b) => a.order - b.order));
  const selected = $derived(objects.find(object => object.id === selectedId));
  $effect(() => onDirty(dirty || busy || points.length > 0));
  onDestroy(() => onDirty(false));
  onMount(() => { void reload(); });
  const assetUrl = (id: string) => loaded ? `/api/assets/${encodeURIComponent(id)}?projectId=${encodeURIComponent(loaded.projectId)}&gameId=${encodeURIComponent(gameId)}` : '';
  async function reload() {
    if (dirty) return;
    busy = true; error = '';
    try {
      const result = await runCommand('world.location.map.get', { locationId }) as MapResult;
      loaded = result; map = structuredClone(result.map); selectedId = ''; points = []; history = [];
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    finally { busy = false; }
  }
  function change() { dirty = true; }
  function position(event: MouseEvent) {
    const rect = event.currentTarget instanceof Element ? event.currentTarget.getBoundingClientRect() : null;
    if (!rect) return { x: 0.5, y: 0.5 };
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  }
  function placeAt(point: { x: number; y: number }) {
    if (!loaded || busy) return;
    if (mode === 'region') { if (points.length < 100) points = [...points, point]; return; }
    if (mode === 'select') {
      if (!selected) return;
      if (selected.kind === 'pin') selected.point = point;
      if (selected.kind === 'token') selected.point = point;
      if (selected.kind === 'region') return;
      change(); return;
    }
    const object = { id: crypto.randomUUID(), label: mode === 'pin' ? 'New pin' : 'New token', layerId: map.layers[0].id,
      order: objects.length, visibility: 'public' as const, kind: mode, point, color: '#d97706' };
    if (mode === 'pin') map.pins.push({ ...object, kind: 'pin', locationId: null });
    else map.tokens.push({ ...object, kind: 'token', entityId: null });
    selectedId = object.id; change(); mode = 'select';
  }
  function place(event: MouseEvent) { placeAt(position(event)); }
  function finishRegion() {
    if (points.length < 3) return;
    const object: LocationMapBody['regions'][number] = { id: crypto.randomUUID(), kind: 'region', label: 'New region',
      layerId: map.layers[0].id, order: objects.length, visibility: 'public', points: [...points], fill: '#fbbf24', stroke: '#92400e', locationId: null };
    map.regions.push(object); selectedId = object.id; points = []; mode = 'select'; change();
  }
  function addRegion() {
    points = [{ x: 0.35, y: 0.35 }, { x: 0.65, y: 0.35 }, { x: 0.5, y: 0.65 }];
    finishRegion();
  }
  function removeSelected() {
    map.regions = map.regions.filter(object => object.id !== selectedId);
    map.pins = map.pins.filter(object => object.id !== selectedId);
    map.tokens = map.tokens.filter(object => object.id !== selectedId);
    selectedId = ''; change();
  }
  async function save() {
    if (!loaded || !dirty) return;
    busy = true; error = '';
    try {
      await runCommand('world.location.map.save', { locationId, expectedRevision: loaded.revision, map });
      dirty = false; await reload();
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    finally { busy = false; }
  }
  async function showHistory() {
    try { const result = await runCommand('world.location.map.history', { locationId }); history = result.revisions as typeof history; }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  }
  async function restore(revision: number) {
    if (!loaded || dirty || busy) return;
    busy = true; error = '';
    try { await runCommand('world.location.map.restore', { locationId, expectedRevision: loaded.revision, fromRevision: revision }); await reload(); }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    finally { busy = false; }
  }
  async function searchLinks() {
    try {
      const result = await runCommand('world.records', { type: selected?.kind === 'token' ? 'entities' : 'locations', q: linkQuery, limit: 30 });
      linkResults = (Array.isArray(result.records) ? result.records as Row[] : []).filter(row => row.status === 'active' && ['public', 'player_known'].includes(String(row.visibility)))
        .map(row => ({ id: String(row.id), name: String(row.name) }));
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  }
</script>

<section class="map-editor" aria-label="Location map">
  <h3>Map</h3>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if !loaded}<p>Loading map…</p>{:else}
    <div class="map-controls">
      <label>Tool <select bind:value={mode} disabled={busy}><option value="select">Select or move</option><option value="pin">Add pin</option><option value="token">Add token</option><option value="region">Draw region</option></select></label>
      <button type="button" disabled={busy} onclick={addRegion}>Add region with coordinates</button>
      <button type="button" disabled={busy} onclick={() => { mode = 'pin'; placeAt({ x: 0.5, y: 0.5 }); }}>Add pin at center</button>
      <button type="button" disabled={busy} onclick={() => { mode = 'token'; placeAt({ x: 0.5, y: 0.5 }); }}>Add token at center</button>
      <label>Zoom <input type="range" min="1" max="3" step="0.25" bind:value={zoom} /></label>
      {#if mode === 'region'}<button type="button" disabled={points.length < 3} onclick={finishRegion}>Finish region ({points.length} points)</button><button type="button" onclick={() => { points = []; mode = 'select'; }}>Cancel outline</button>{/if}
    </div>
    <div class="map-canvas" style={`aspect-ratio:${map.width}/${map.height}; overflow:auto`}>
      <svg role="button" tabindex="0" aria-label="Location map canvas; press Enter to place at the center, or use the object list below" viewBox="0 0 1000 1000" style={`width:${zoom * 100}%; height:auto; display:block; background:#1d2430; cursor:crosshair`} onclick={place} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); placeAt({ x: 0.5, y: 0.5 }); } }}>
        {#if map.backgroundAssetId}<image href={assetUrl(map.backgroundAssetId)} x="0" y="0" width="1000" height="1000" preserveAspectRatio="none" />{/if}
        {#each map.regions.filter(object => map.layers.find(layer => layer.id === object.layerId)?.visible) as region}
          <polygon points={region.points.map(point => `${point.x * 1000},${point.y * 1000}`).join(' ')} fill={region.fill} fill-opacity="0.35" stroke={region.stroke} stroke-width={region.id === selectedId ? 6 : 3} />
        {/each}
        {#if points.length}<polyline points={points.map(point => `${point.x * 1000},${point.y * 1000}`).join(' ')} fill="none" stroke="#fbbf24" stroke-width="4" />{/if}
        {#each [...map.pins, ...map.tokens].filter(object => map.layers.find(layer => layer.id === object.layerId)?.visible) as object}
          <circle cx={object.point.x * 1000} cy={object.point.y * 1000} r={object.kind === 'token' ? 13 : 10} fill={object.color} stroke={object.id === selectedId ? '#ffffff' : '#111827'} stroke-width="4" />
        {/each}
      </svg>
    </div>
    <div class="map-controls"><label>Background image <select value={map.backgroundAssetId ?? ''} onchange={(event) => { map.backgroundAssetId = event.currentTarget.value || null; change(); }} disabled={busy}><option value="">None</option>{#each loaded.backgrounds as asset}<option value={asset.id}>{asset.id}</option>{/each}</select></label><label>Width <input type="number" min="256" max="8192" bind:value={map.width} oninput={change} /></label><label>Height <input type="number" min="256" max="8192" bind:value={map.height} oninput={change} /></label></div>
    <div class="map-controls"><h4>Layers</h4><button type="button" onclick={() => { map.layers.push({ id: crypto.randomUUID(), label: 'New layer', order: map.layers.length, visible: true }); change(); }}>Add layer</button></div>
    {#each map.layers as layer}<div class="map-controls"><label>Layer name <input bind:value={layer.label} oninput={change} /></label><label><input type="checkbox" bind:checked={layer.visible} onchange={change} /> Visible</label>{#if map.layers.length > 1 && !objects.some(object => object.layerId === layer.id)}<button type="button" onclick={() => { map.layers = map.layers.filter(item => item.id !== layer.id); change(); }}>Remove</button>{/if}</div>{/each}
    <h4>Objects</h4>
    <ul class="map-objects">{#each objects as object}<li><button type="button" class:selected={object.id === selectedId} onclick={() => { selectedId = object.id; linkResults = []; }} disabled={busy}>{object.kind}: {object.label} · {object.visibility}</button></li>{:else}<li>No regions, pins, or tokens yet.</li>{/each}</ul>
    {#if selected}
      <div class="map-object-fields"><label>Label <input bind:value={selected.label} oninput={change} /></label><label>Layer <select bind:value={selected.layerId} onchange={change}>{#each map.layers as layer}<option value={layer.id}>{layer.label}</option>{/each}</select></label><label>Visibility <select bind:value={selected.visibility} onchange={change}><option value="public">Public</option><option value="gm">GM only</option></select></label>
        {#if selected.kind === 'region'}<label>Fill <input type="color" bind:value={selected.fill} oninput={change} /></label><label>Outline <input type="color" bind:value={selected.stroke} oninput={change} /></label>
          <fieldset><legend>Region points</legend>{#each selected.points as point, index}<div class="map-controls"><label>Point {index + 1} X <input type="number" min="0" max="1" step="0.001" bind:value={point.x} oninput={change} /></label><label>Y <input type="number" min="0" max="1" step="0.001" bind:value={point.y} oninput={change} /></label><button type="button" disabled={selected.points.length <= 3} onclick={() => { if (selected.kind === 'region') { selected.points.splice(index, 1); change(); } }}>Remove point</button></div>{/each}<button type="button" disabled={selected.points.length >= 100} onclick={() => { if (selected.kind === 'region') { selected.points.push({ x: 0.5, y: 0.5 }); change(); } }}>Add point</button></fieldset>
        {:else}<label>Color <input type="color" bind:value={selected.color} oninput={change} /></label><label>X <input type="number" min="0" max="1" step="0.001" bind:value={selected.point.x} oninput={change} /></label><label>Y <input type="number" min="0" max="1" step="0.001" bind:value={selected.point.y} oninput={change} /></label>{/if}
        <div class="map-controls"><label>Linked {selected.kind === 'token' ? 'entity' : 'location'} <input readonly value={selected.kind === 'token' ? selected.entityId ?? '' : selected.locationId ?? ''} /></label><button type="button" onclick={() => { if (!selected) return; if (selected.kind === 'token') selected.entityId = null; else selected.locationId = null; change(); }}>Clear link</button><label>Find <input bind:value={linkQuery} /></label><button type="button" onclick={searchLinks}>Search</button></div>
        {#each linkResults as result}<button type="button" onclick={() => { if (!selected) return; if (selected.kind === 'token') selected.entityId = result.id; else selected.locationId = result.id; linkResults = []; change(); }}>{result.name}</button>{/each}
        {#if selected.kind !== 'token' && selected.locationId}<button type="button" onclick={() => navigate(selected.locationId as string)} disabled={dirty}>Open linked place</button>{/if}
        <button type="button" onclick={removeSelected}>Remove object</button>
      </div>
    {/if}
    <div class="map-controls"><button type="button" disabled={!dirty || busy || points.length > 0} onclick={save}>{busy ? 'Saving…' : 'Save map'}</button><button type="button" disabled={!dirty || busy} onclick={() => { dirty = false; void reload(); }}>Discard changes</button><button type="button" disabled={dirty || busy} onclick={showHistory}>History</button></div>
    {#if history.length}<ul>{#each history as entry}<li>Revision {entry.revision} · {entry.reason} <button type="button" disabled={dirty || busy || entry.revision === loaded.revision} onclick={() => restore(entry.revision)}>Restore</button></li>{/each}</ul>{/if}
  {/if}
</section>

<style>
  .map-editor{margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border-primary)}
  .map-controls{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin:.5rem 0}
  .map-canvas{max-height:34rem;border:1px solid var(--border-primary);border-radius:.5rem}
  .map-objects{display:flex;flex-wrap:wrap;gap:.4rem;margin:.5rem 0}
  .map-objects .selected{outline:2px solid var(--accent-primary,#d97706)}
  .map-object-fields{display:grid;gap:.5rem;max-width:32rem;padding:.75rem;border:1px solid var(--border-primary);border-radius:.5rem}
  .map-object-fields label{display:flex;justify-content:space-between;gap:.5rem}
  .map-object-fields input,.map-object-fields select{min-width:0;max-width:100%}
  @media(max-width:600px){.map-controls{align-items:stretch}.map-controls label,.map-object-fields label{display:grid;width:100%;gap:.2rem}.map-controls input,.map-controls select{min-width:0;max-width:100%}.map-canvas{max-height:24rem}}
  .error{color:#dc2626}
</style>
