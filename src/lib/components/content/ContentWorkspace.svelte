<script lang="ts">
  import GameMigration from './GameMigration.svelte';
  import AssistantPanel from './AssistantPanel.svelte';
  import { app } from '$lib/stores/app.svelte';
  import FolderManager from './FolderManager.svelte';
  import { onMount } from 'svelte';
  import CanonicalTypeEditor from './CanonicalTypeEditor.svelte';
  import type { CanonicalKind } from '$lib/contracts/canonicalTypes';
  import CanonicalContentEditor from './CanonicalContentEditor.svelte';
  import { gearExample, type ContentItem, type ContentType, type ContentDefinition } from '$lib/contracts/content';
  let { onDirtyChange = (_dirty: boolean) => {} }: { onDirtyChange?: (dirty: boolean) => void } = $props();
  type Named = { id: string; name?: string; title?: string };
  let projects = $state<Named[]>([]), games = $state<Named[]>([]);
  let projectId = $state(''), gameId = $state('');
  let assistantOpen = $state(false);
  let types = $state<ContentType[]>([]), items = $state<ContentItem[]>([]);
  let selected = $state<ContentItem | null>(null), typeId = $state('');
  let title = $state(''), description = $state(''), folder = $state(''), slug = $state(''), dataText = $state('{}');
  let visibility = $state<'public' | 'gm'>('gm');
  let contextMode = $state(''), branchId = $state(''), povCharacter = $state('');
  let typeImpact = $state<{total:number;inherited:number;pinned:number;partial:number;estimatedTokens:number}|null>(null);
  let typeDraft = $state(''), editingType = $state<ContentType | null>(null);
  let editor = $state<'none' | 'item' | 'type' | 'canonical' | 'canonical-type' | 'folders' | 'migration'>('none');
  let baseline = $state(''), busy = $state(false), message = $state(''), query = $state('');
  let nextOffset = $state<number | null>(null), offset = $state(0);
  let includeDeleted = $state(false), restoreConfirmation = $state(false);
  let canonicalKind = $state<CanonicalKind>('characters'), canonicalTypeMode = $state('searchable'), canonicalRows = $state<Record<string, unknown>[]>([]);
  let canonicalBusy=$state(false), canonicalDirty=$state(false), canonicalId=$state(''), includeHidden=$state(false);
  let canonicalNext = $state<string | null>(null), canonicalOffset = $state(0);
  let preview = $state<ContentDefinition | null>(null), previewMessage = $state('');
  type ImportReview = { ready: boolean; conflicts: { kind: string; message: string; sourceId: string; destinationId?: string }[]; typeCount: number; itemCount: number; reusedTypes: number; newTypes: number; projectId: string; gameId: string | null };
  let importReview = $state<ImportReview | null>(null), importBundle = $state<unknown>(null);
  type Revision={revision:number;reason:string;snapshot:Record<string,unknown>;type_revision:number|null;created_at:string};
  type Review={targetKind:'item'|'type';id:string;targetRevision:number;currentRevision:number;expectedSnapshot:string;compatible:boolean;conflicts:string[];changes:{field:string;from:unknown;to:unknown}[];affectedDocuments:number};
  let historyRows=$state<Revision[]>([]),historyNext=$state<number|null>(null),restoreReview=$state<Review|null>(null);
  let sourceRevision=$state<number|null>(null);
  let clearReview=$state<{definition:ContentDefinition;expectedSnapshot:string;draft:string}|null>(null);
  const itemSnapshot = () => JSON.stringify({ typeId, title, description, folder, slug, dataText, visibility, contextMode, branchId, povCharacter });
  const dirty = $derived(editor === 'item' ? itemSnapshot() !== baseline : editor === 'type' ? typeDraft !== baseline : (editor === 'canonical'||editor === 'canonical-type'||editor === 'folders'||editor === 'migration') ? canonicalDirty : false);
  const selectedType = $derived(types.find(type => type.id === typeId));
  let savedFolderPaths=$state<string[]>([]);
  const folders = $derived([...new Set([...savedFolderPaths,...items.map(item => item.folder)])].sort());
  const writable = $derived(!selected || selected.game_id === (gameId || null));
  $effect(() => { onDirtyChange(dirty); });
  async function command(name: string, args: Record<string, unknown> = {}) {
    const response = await fetch('/api/engine/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storyId: '__app__', command: name, args }) });
    const body = await response.json();
    if (!response.ok || body.status !== 'succeeded') throw new Error(body.error ?? 'Content request failed.');
    return body.result;
  }
  const scope = () => ({ projectId, ...(gameId ? { gameId } : {}) });
  async function act(action: () => Promise<void>) { busy = true; message = ''; try { await action(); } catch (error) { message = String(error); } finally { busy = false; } }
  function leave() { if (dirty) { message = 'Save or discard your edits first.'; return false; } return !busy && !canonicalBusy; }
  function closeEditor() { sourceRevision=null; historyRows=[];historyNext=null;restoreReview=null;clearReview=null;canonicalId=''; canonicalDirty=false; editor = 'none'; selected = null; preview = null; previewMessage = ''; baseline = ''; }
  async function loadItems(append = false) {
    const folderList=await command('content.folders.list',scope());savedFolderPaths=includeDeleted?folderList.paths:folderList.activePaths;
    const result = await command('content.list', { ...scope(), q: query, offset, includeDeleted });
    items = append ? [...items, ...result.items] : result.items; nextOffset = result.nextOffset;
  }
  async function loadScope() {
    importReview = null; importBundle = null;
    closeEditor(); offset = 0;
    await act(async () => { types = (await command('content.types.list', scope())).types; await loadItems(); canonicalRows = [];  });
  }
  async function selectProject() {
    importReview = null; importBundle = null;
    gameId = ''; games = []; closeEditor();
    await act(async () => { games = (await command('story.list', { shelfId: projectId })).stories; types = (await command('content.types.list', scope())).types; offset = 0; await loadItems(); });
  }
  onMount(() => { void act(async () => {
    const params=new URLSearchParams(window.location.search),source=params.get('source');
    projects=(await command('shelf.list')).shelves;
    projectId=projects.some(project=>project.id===params.get('project'))?params.get('project')!:projects[0]?.id??'';
    if(!projectId)return;
    games=(await command('story.list',{shelfId:projectId})).stories;
    gameId=games.some(game=>game.id===params.get('game'))?params.get('game')!:'';
    types=(await command('content.types.list',scope())).types;await loadItems();
    if(!source)return;
    const content=/^content:([^@]+)@(\d+)/.exec(source);
    const contentType=/^content-type:([^@]+)@(\d+)/.exec(source);
    const canonical=/^canonical:(characters|locations|items|factions):([^@]+)@(\d+)/.exec(source);
    if(content){const result=await command('content.read',{...scope(),ids:[content[1]]});if(!result.items?.[0])throw new Error('Source document is unavailable in this scope.');setItem(result.items[0]);sourceRevision=Number(content[2]);const history=await command('content.history',{projectId,...(result.items[0].game_id?{gameId}:{}),targetKind:'item',id:content[1],limit:50});historyRows=history.revisions;historyNext=history.nextBeforeRevision;}
    else if(contentType){const type=types.find(value=>value.id===contentType[1]);if(!type)throw new Error('Source type is unavailable in this project.');setType(type);sourceRevision=Number(contentType[2]);const history=await command('content.history',{projectId,targetKind:'type',id:type.id,limit:50});historyRows=history.revisions;historyNext=history.nextBeforeRevision;}
    else if(canonical&&gameId){canonicalKind=canonical[1] as typeof canonicalKind;canonicalId=canonical[2];sourceRevision=Number(canonical[3]);editor='canonical';}
  }); return () => onDirtyChange(false); });
  function setItem(item: ContentItem) {
    sourceRevision=null; selected = item; historyRows=[];historyNext=null;restoreReview=null;restoreConfirmation = false; typeId = item.type_id; title = item.title; description = item.description; folder = item.folder; slug = item.slug; dataText = JSON.stringify(item.data, null, 2); visibility = item.visibility; contextMode = item.gm_context_mode ?? ''; branchId = item.branch_id ?? ''; povCharacter = item.pov_character ?? ''; editor = 'item'; baseline = itemSnapshot();
  }
  async function openItem(id: string) { if (!leave()) return; await act(async () => setItem((await command('content.read', { ...scope(), ids: [id] })).items[0])); }
  function newItem() {
    if (!leave() || !types.length) return;
    selected = null; typeId = types[0].id; title = ''; description = ''; folder = ''; slug = ''; dataText = JSON.stringify(types[0].definition.defaults, null, 2); visibility = 'gm'; contextMode = ''; branchId = ''; povCharacter = ''; editor = 'item'; baseline = itemSnapshot();
  }
  function changeType() { dataText = JSON.stringify(selectedType?.definition.defaults ?? {}, null, 2); }
  async function saveItem() {
    await act(async () => {
      if (!selectedType) throw new Error('Select a content type.');
      const result = await command('content.write', { ...scope(), ...(selected ? { id: selected.id, expectedRevision: selected.revision } : {}), typeId, expectedTypeRevision: selected ? selected.type_revision : selectedType.revision, title, description, folder, slug, data: JSON.parse(dataText), visibility, gmContextMode: contextMode || null, branchId: branchId || null, povCharacter: povCharacter || null });
      setItem(result.item); offset = 0; await loadItems(); message = 'Document saved.';
    });
  }
  const effectiveMode = (item: ContentItem) => item.gm_context_mode ?? types.find(type => type.id === item.type_id)?.definition.gmContextMode ?? 'searchable';
  const modeIcon = (mode: string) => mode === 'pinned' ? '📌' : mode === 'partial' ? '◐' : '⌕';
  async function setTreeMode(item: ContentItem, mode: string) {
    await act(async () => {
      const result = await command('content.update', { projectId, ...(item.game_id ? {gameId:item.game_id} : {}), id:item.id, expectedRevision:item.revision, expectedTypeRevision:item.type_revision, changes:{gmContextMode:mode || null} });
      items=items.map(value => value.id===item.id ? {...value,...result.item} : value);
      if(selected?.id===item.id) setItem(result.item);
      message='GM context policy saved.';
    });
  }
  async function setCanonicalTreeMode(record: Record<string, unknown>, mode: string) {
    const metadata=record.content_metadata as Record<string,unknown>;
    await act(async () => {
      const result=await command('content.canonical.edit',{projectId,gameId,kind:canonicalKind,id:String(record.id),expected:{metadataRevision:Number(metadata.revision),recordVersion:Number(record.server_version),adapterVersion:1},metadata:{gmContextMode:mode||null}});
      canonicalRows=canonicalRows.map(value => value.id===record.id ? {...result.record,content_metadata:result.envelope} : value);
      message='Canonical GM context policy saved.';
    });
  }
  async function organize(operation: 'move' | 'copy' | 'archive' | 'restore') {
    if (!selected) return;
    await act(async () => {
      const result = await command('content.organize', { ...scope(), id: selected!.id, expectedRevision: selected!.revision, expectedTypeRevision: selected!.type_revision, operation, ...(operation === 'restore' ? { confirmed: restoreConfirmation } : operation === 'archive' ? {} : { folder, slug }) });
      if (operation === 'archive') closeEditor(); else setItem(result.item);
      offset = 0; await loadItems(); message = operation === 'archive' ? 'Document archived; its history was retained.' : 'Content organized.';
    });
  }
  function setType(type: ContentType | null) {
    editingType = type; typeDraft = JSON.stringify(type ? { key: type.key, extension: type.extension, name: type.name, definition: type.definition } : { key: 'gear', extension: 'gear', name: 'Gear', definition: gearExample }, null, 2);
    editor = 'type'; baseline = typeDraft; typeImpact = null; preview = null; previewMessage = '';historyRows=[];historyNext=null;restoreReview=null;clearReview=null;
  }
  function editType(type: ContentType | null) { if (leave()) setType(type); }
  async function saveType(previewOnly = false) {
    await act(async () => {
      const args={ ...JSON.parse(typeDraft), projectId, ...(editingType ? { id: editingType.id, expectedRevision: editingType.revision } : {}) };
      const checked=await command('content.types.preview',args);preview=checked.definition;typeImpact=checked.impact;
      if(!checked.compatible){previewMessage=JSON.stringify(checked.conflicts,null,2);return;}
      if(previewOnly){previewMessage='Schema and layout are compatible with existing documents.';return;}
      if(checked.requiresClearConfirmation){clearReview={definition:checked.definition,expectedSnapshot:checked.expectedSnapshot,draft:typeDraft};return;}
      const result=await command('content.types.save',{...args,expectedSnapshot:checked.expectedSnapshot});types=(await command('content.types.list',scope())).types;editingType=result.type;typeDraft=JSON.stringify({key:result.type.key,extension:result.type.extension,name:result.type.name,definition:result.type.definition},null,2);baseline=typeDraft;clearReview=null;message='Content type saved.';
    });
  }
  async function confirmTypeClear(){if(!clearReview||!editingType||clearReview.draft!==typeDraft)return;await act(async()=>{const args={...JSON.parse(clearReview!.draft),projectId,id:editingType!.id,expectedRevision:editingType!.revision,expectedSnapshot:clearReview!.expectedSnapshot,confirmedClear:true};const result=await command('content.types.save',args);types=(await command('content.types.list',scope())).types;editingType=result.type;typeDraft=JSON.stringify({key:result.type.key,extension:result.type.extension,name:result.type.name,definition:result.type.definition},null,2);baseline=typeDraft;clearReview=null;message='Reviewed layout clear saved as a new type revision.';});}
  async function loadHistory(targetKind:'item'|'type',more=false){const id=targetKind==='item'?selected?.id:editingType?.id;if(!id)return;await act(async()=>{const result=await command('content.history',{projectId,...(targetKind==='item'&&gameId?{gameId}:{}),targetKind,id,limit:20,...(more&&historyNext?{beforeRevision:historyNext}:{})});historyRows=more?[...historyRows,...result.revisions]:result.revisions;historyNext=result.nextBeforeRevision;restoreReview=null;});}
  async function previewHistory(targetKind:'item'|'type',targetRevision:number){const source=targetKind==='item'?selected:editingType;if(!source)return;await act(async()=>{restoreReview={...(await command('content.history.previewRestore',{projectId,...(targetKind==='item'&&gameId?{gameId}:{}),targetKind,id:source.id,targetRevision,expectedRevision:source.revision})),targetKind,id:source.id};});}
  async function applyHistory(){const review=restoreReview;if(!review||!review.compatible||dirty)return;await act(async()=>{const result=await command('content.history.restore',{projectId,...(review.targetKind==='item'&&gameId?{gameId}:{}),targetKind:review.targetKind,id:review.id,targetRevision:review.targetRevision,expectedRevision:review.currentRevision,expectedSnapshot:review.expectedSnapshot,confirmed:true});if(review.targetKind==='item'){setItem(result.item);offset=0;await loadItems();}else{types=(await command('content.types.list',scope())).types;editingType=result.type;typeDraft=JSON.stringify({key:result.type.key,extension:result.type.extension,name:result.type.name,definition:result.type.definition},null,2);baseline=typeDraft;}historyRows=[];historyNext=null;restoreReview=null;message='Historical content restored as a new revision.';});}
  async function loadCanonical(append = false) {
    await act(async () => { const settings = await command('content.canonicalTypes.read',{projectId,kind:canonicalKind}); canonicalTypeMode=settings.definition.gmContextMode; const result = await command('content.canonical', { ...scope(), kind: canonicalKind, offset: canonicalOffset, includeHidden }); canonicalRows = append ? [...canonicalRows, ...result.records] : result.records; canonicalNext = result.nextCursor; editor = 'canonical';  canonicalId=''; });
  }
  function newCanonical(kind: CanonicalKind = canonicalKind){if(leave()){canonicalKind=kind;editor='canonical';canonicalId='__new__';canonicalDirty=false;}}
  function savedCanonical(value:import('$lib/contracts/canonicalContent').CanonicalView){canonicalRows=[{...value.record,content_metadata:value.envelope},...canonicalRows.filter(row=>row.id!==value.record.id)].filter(row=>includeHidden || !(row.content_metadata as {hidden?:boolean})?.hidden);canonicalId=String(value.record.id);canonicalDirty=false;}
  function openCanonical(id: string) { if(leave()) { sourceRevision=null; canonicalId=id; canonicalDirty=false; } }
  function display(value: unknown) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '—'; }
  function previewData() { try { return JSON.parse(dataText) as Record<string, unknown>; } catch { return {}; } }
  async function downloadContent() {
    await act(async () => {
      const bundle = await command('content.export', scope());
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'MythEngine-content.json'; link.click(); URL.revokeObjectURL(url);
      message = 'Content snapshot exported.';
    });
  }
  async function uploadContent(event: Event) {
    const input = event.currentTarget as HTMLInputElement; const file = input.files?.[0];
    if (!file) return;
    await act(async () => {
      importReview = null; importBundle = null;
      if (file.size > 20_000_000) throw new Error('Content imports are limited to 20 MB.');
      const bundle: unknown = JSON.parse(await file.text());
      const review = await command('content.import.preview', { ...scope(), bundle }) as ImportReview;
      importBundle = bundle; importReview = review;
      message = review.ready ? 'Review the snapshot below before importing.' : 'Resolve the listed conflicts before importing.';
    }); input.value = '';
  }
  async function confirmContentImport() {
    if (!importReview?.ready || !importBundle || dirty) return;
    await act(async () => {
      const next = await command('content.import.preview', { ...scope(), bundle: importBundle }) as ImportReview;
      if (JSON.stringify(next) !== JSON.stringify(importReview)) {
        importReview = next;
        message = 'Destination content changed. Review the updated result before importing.';
        return;
      }
      await command('content.import', { ...scope(), bundle: importBundle });
      importBundle = null; importReview = null;
      types = (await command('content.types.list', scope())).types; offset = 0; await loadItems(); message = 'Content imported with new document identities.';
    });
  }
</script>

<svelte:window onbeforeunload={(event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }} />
<section class="content-workspace" aria-label="Project content workspace">
  <header><h1>Project content</h1><p>Rules, equipment and custom documents alongside your game's canonical records.</p></header>
  <div class="toolbar">
    <label>Project<select aria-label="Content project" bind:value={projectId} onchange={selectProject} disabled={busy || canonicalBusy || dirty}>{#each projects as project}<option value={project.id}>{project.name}</option>{/each}</select></label>
    <label>Scope<select aria-label="Content game" bind:value={gameId} onchange={loadScope} disabled={busy || canonicalBusy || dirty}><option value="">Shared project documents</option>{#each games as game}<option value={game.id}>{game.title}</option>{/each}</select></label>
    <button onclick={newItem} disabled={busy || canonicalBusy || dirty || !types.length}>New document</button><button onclick={() => editType(null)} disabled={busy || canonicalBusy || dirty || !projectId}>New content type</button>
    <button onclick={()=>{if(leave()){closeEditor();editor='folders';}}} disabled={busy||canonicalBusy||dirty||!projectId}>Manage folders</button>
    {#if gameId}<button disabled={busy||canonicalBusy||dirty} onclick={()=>{if(leave()){closeEditor();editor='migration';}}}>Move game to project</button>{/if}
    <button onclick={downloadContent} disabled={busy || canonicalBusy || dirty || !projectId}>Export content</button>
    <button onclick={() => assistantOpen = true} disabled={!projectId} aria-label="Open Assistant">Assistant</button>
  </div>
  <details><summary>Import a content snapshot</summary><p>Imports create new document identities and remap document references. Conflicting types or paths stop the import without overwriting existing material. Use an empty project for a full copy.</p><label>Content snapshot<input type="file" accept="application/json,.json" onchange={uploadContent} disabled={busy || canonicalBusy || dirty || !projectId} /></label>
    {#if importReview}
      {@const review = importReview}
      <section aria-label="Content import review"><h2>Review content import</h2><p>Destination: {projects.find(project => project.id === review.projectId)?.name ?? review.projectId}{review.gameId ? ` / ${games.find(game => game.id === review.gameId)?.title ?? review.gameId}` : ' / shared documents'}</p><p>{review.itemCount} documents; {review.newTypes} new types; {review.reusedTypes} existing types.</p>
        {#if review.conflicts.length}<p role="alert">{review.conflicts.length} conflict{review.conflicts.length === 1 ? '' : 's'} found. Nothing has been imported.</p><ul>{#each review.conflicts as conflict}<li>{conflict.message} Source ID: {conflict.sourceId}{conflict.destinationId ? `; destination ID: ${conflict.destinationId}` : ''}</li>{/each}</ul>{:else}<p>No type or path conflicts found. The import will validate the complete snapshot again when applied.</p>{/if}
        <button onclick={confirmContentImport} disabled={busy || canonicalBusy || dirty || !review.ready}>Import reviewed snapshot</button><button onclick={() => { importReview = null; importBundle = null; message = 'Content import cancelled.'; }} disabled={busy}>Cancel import</button>
      </section>
    {/if}
  </details>
  <p role="status" class="notice">{busy ? 'Loading…' : message}</p>
  <div class="workspace-grid">
    <aside aria-label="Content tree">
      <form onsubmit={(event) => { event.preventDefault(); if (leave()) { offset = 0; void act(() => loadItems()); } }}><label>Search documents<input bind:value={query} disabled={busy || canonicalBusy || dirty} /></label><button disabled={busy || canonicalBusy || dirty}>Search</button></form>
      <label>Include archived<input type="checkbox" bind:checked={includeDeleted} onchange={() => { offset = 0; void act(() => loadItems()); }} disabled={busy || canonicalBusy || dirty} /></label>
      {#each folders as group}<details open><summary>{group || 'Root'}{gameId ? ' · project + game' : ''}</summary>{#each items.filter(item => item.folder === group) as item}<button class:selected={selected?.id === item.id} class="tree-item" onclick={() => openItem(item.id)} disabled={busy || canonicalBusy || dirty}>{modeIcon(effectiveMode(item))} {item.title}{item.deleted_at ? ' (archived)' : ''}<small>{item.slug}.{types.find(type => type.id === item.type_id)?.extension} · {item.game_id ? 'game' : 'shared'}</small></button><select aria-label={`GM context for ${item.title}`} value={item.gm_context_mode ?? ''} onchange={event => void setTreeMode(item,event.currentTarget.value)} disabled={busy || canonicalBusy || dirty || !!item.deleted_at || item.game_id !== (gameId || null)}><option value="">Use type default ({types.find(type => type.id === item.type_id)?.definition.gmContextMode ?? 'searchable'})</option><option value="pinned">📌 Pinned</option><option value="partial">◐ Partial</option><option value="searchable">⌕ Searchable</option></select>{/each}</details>{/each}
      {#if !items.length}<p>No documents in this scope. Create a content type, then a document.</p>{/if}
      {#if nextOffset !== null}<button onclick={() => { offset = nextOffset!; void act(() => loadItems(true)); }} disabled={busy || canonicalBusy || dirty}>Load more documents</button>{/if}
      <h2>Content types</h2>{#each types as type}<button class="tree-item" onclick={() => editType(type)} disabled={busy || canonicalBusy || dirty}>{type.name}<small>.{type.extension} · revision {type.revision}</small></button>{/each}
      <h2>Built-in type settings</h2>{#each ['characters','locations','items','factions'] as kind}<button class="tree-item" disabled={busy || canonicalBusy || dirty} onclick={()=>{if(leave()){closeEditor();canonicalKind=kind as CanonicalKind;editor='canonical-type';}}}>{kind} layout and settings</button>{/each}
      {#if gameId}<h2>Canonical records</h2><label>Record kind<select bind:value={canonicalKind} onchange={() => { canonicalId=''; canonicalRows=[]; }} disabled={busy || canonicalBusy || dirty}><option value="characters">Characters</option><option value="locations">Locations</option><option value="items">Items</option><option value="factions">Factions</option></select></label><button onclick={() => { if (leave()) { canonicalOffset = 0; void loadCanonical(); } }} disabled={busy || canonicalBusy || dirty}>Browse canonical records</button><button onclick={() => newCanonical()} disabled={busy || canonicalBusy || dirty}>New canonical record</button><button onclick={() => newCanonical('characters')} disabled={busy || canonicalBusy || dirty}>Add character</button><button onclick={() => newCanonical('factions')} disabled={busy || canonicalBusy || dirty}>Add faction</button>{/if}
    </aside>
    <main>
      {#if editor === 'none'}<h2>A place for your world's material</h2><p>Create a Gear type from the example, or define a Rules type with a longtext field. Folders are logical paths such as Rules/Core.</p>
      {:else if editor === 'type'}
        <h2>{editingType ? `Edit ${editingType.name}` : 'Create content type'}</h2><p>Define fields, defaults and sections. Supported fields: text, longtext, number, boolean, enum, object, array and document reference (itemId). Layouts display plain text.</p>
        <label>Type definition<textarea aria-label="Type definition" bind:value={typeDraft} rows="23" disabled={busy}></textarea></label>
        <div class="actions"><button onclick={() => saveType(true)} disabled={busy}>Preview schema and layout</button><button onclick={() => saveType()} disabled={busy}>Save content type</button><button onclick={closeEditor} disabled={busy}>Discard edits</button>{#if editingType}<button onclick={()=>loadHistory('type')} disabled={busy||dirty}>View type history</button>{/if}</div>
        {#if clearReview}<div role="alert"><p>Clear the saved layout for {editingType?.name}? The reviewed type revision remains in history.</p><button onclick={confirmTypeClear} disabled={clearReview.draft!==typeDraft}>Confirm layout clear</button><button onclick={()=>clearReview=null}>Cancel</button></div>{/if}
        {#if typeImpact}<p role="status">This type has {typeImpact.total} active documents; {typeImpact.inherited} inherit its default. With the draft policy: {typeImpact.pinned} Pinned, {typeImpact.partial} Partial, about {typeImpact.estimatedTokens.toLocaleString()} preload tokens across documents before game, branch, and POV filtering.</p>{/if}
        {#if preview}<p>{previewMessage}</p><div class="preview"><h3>Layout preview</h3>{#each preview.layout.length ? preview.layout : [{ title: 'Fields', fields: Object.keys(preview.fields) }] as section}<h4>{section.title}</h4>{#each section.fields as field}<dl><dt>{preview.fields[field]?.label ?? field}</dt><dd>{display(preview.defaults[field])}</dd></dl>{/each}{/each}</div>{/if}
        {#if historyRows.length}<section aria-label="Content history"><h3>Retained revisions</h3>{#each historyRows as entry}<details open={entry.revision===sourceRevision}><summary>Revision {entry.revision} · {entry.reason}</summary><p>{entry.created_at}{#if entry.type_revision!==null} · type revision {entry.type_revision}{/if}</p><pre>{JSON.stringify(entry.snapshot,null,2)}</pre><button onclick={()=>previewHistory(editor==='type'?'type':'item',entry.revision)} disabled={busy||dirty}>Preview restore of revision {entry.revision}</button></details>{/each}{#if historyNext}<button onclick={()=>loadHistory(editor==='type'?'type':'item',true)} disabled={busy||dirty}>Older revisions</button>{/if}</section>{/if}
        {#if restoreReview}<section role="alert" aria-label="Restore review"><h3>Restore revision {restoreReview.targetRevision}?</h3><p>Current revision {restoreReview.currentRevision}; {restoreReview.affectedDocuments} documents checked for schema compatibility.</p>{#each restoreReview.changes as change}<details><summary>{change.field}</summary><pre>Current: {display(change.from)}
Restored: {display(change.to)}</pre></details>{/each}{#each restoreReview.conflicts as conflict}<p>{conflict}</p>{/each}<button onclick={applyHistory} disabled={busy||dirty||!restoreReview.compatible}>Confirm restore as new revision</button><button onclick={()=>restoreReview=null}>Cancel</button></section>{/if}
      {:else if editor === 'item'}
        <h2>{selected ? selected.title : 'New document'}</h2>
        {#if selected?.cover_asset_id}<section aria-label="Document cover"><h3>Cover</h3>{#if selected.visibility === 'public'}<img src={`/api/assets/${encodeURIComponent(selected.cover_asset_id)}?projectId=${encodeURIComponent(selected.project_id)}${selected.game_id ? `&gameId=${encodeURIComponent(selected.game_id)}` : ''}`} alt={`${selected.title} cover`} class="max-h-72 max-w-full rounded-lg object-contain" />{:else}<p>A private cover is attached. Author preview is not available yet.</p>{/if}</section>{/if}
        {#if !writable}<p>Shared project document. Switch scope to Shared project documents to edit it.</p>{/if}
        {#if selected?.deleted_at}<p>This document is archived. Review its content below before restoring.</p>{#if writable}<button onclick={() => restoreConfirmation = true} disabled={busy}>Restore archived document</button>{#if restoreConfirmation}<p>Restore “{selected.title}” at {selected.folder}/{selected.slug}? This creates a new revision and keeps its history.</p><button onclick={() => organize('restore')} disabled={busy}>Confirm restore</button><button onclick={() => restoreConfirmation = false}>Cancel restore</button>{/if}{/if}{/if}
        <fieldset disabled={busy || !writable || !!selected?.deleted_at}>
          <label>Content type<select bind:value={typeId} onchange={changeType} disabled={!!selected}>{#each types as type}<option value={type.id}>{type.name}</option>{/each}</select></label>
          <label>Title<input bind:value={title} /></label><label>Description<textarea bind:value={description} rows="2"></textarea></label>
          <div class="toolbar"><label>Folder<input bind:value={folder} placeholder="Rules/Core" /></label><label>Slug<input bind:value={slug} placeholder="core-rules" /></label></div>
          <div class="toolbar"><label>Audience<select bind:value={visibility}><option value="gm">GM only</option><option value="public">Public</option></select></label><label>GM context preference<select bind:value={contextMode}><option value="">Use type default ({selectedType?.definition.gmContextMode ?? 'searchable'})</option><option value="pinned">Pinned</option><option value="partial">Partial</option><option value="searchable">Searchable</option></select></label></div>
          <p>Effective GM preload: {modeIcon(contextMode || selectedType?.definition.gmContextMode || 'searchable')} {contextMode || selectedType?.definition.gmContextMode || 'searchable'} {contextMode ? '(explicit)' : '(inherited)'}. Pinned sends full authored fields; Partial sends only title and description; Searchable has no catalog preload.</p><div class="toolbar"><label>Branch ID (optional)<input bind:value={branchId} placeholder="All branches" /></label><label>POV character (optional)<input bind:value={povCharacter} placeholder="All POVs" /></label></div>
          <label>Document fields<textarea aria-label="Document fields" bind:value={dataText} rows="14"></textarea></label>
          <div class="actions"><button onclick={saveItem}>Save document</button>{#if selected}<button onclick={() => organize('move')} disabled={title !== selected.title || description !== selected.description || dataText !== JSON.stringify(selected.data, null, 2) || visibility !== selected.visibility || contextMode !== (selected.gm_context_mode ?? '') || branchId !== (selected.branch_id ?? '') || povCharacter !== (selected.pov_character ?? '')}>Move to folder / slug</button><button onclick={() => organize('copy')} disabled={dirty && (title !== selected.title || description !== selected.description || dataText !== JSON.stringify(selected.data, null, 2) || visibility !== selected.visibility || contextMode !== (selected.gm_context_mode ?? '') || branchId !== (selected.branch_id ?? '') || povCharacter !== (selected.pov_character ?? ''))}>Copy to folder / slug</button><button onclick={() => organize('archive')} disabled={dirty}>Archive document</button>{/if}</div>
        </fieldset>
        {#if selected && writable}<button onclick={()=>loadHistory('item')} disabled={busy||dirty}>View document history</button>{/if}
        <button onclick={closeEditor} disabled={busy}>Discard / close</button>
        {#if selectedType}<div class="preview"><h3>Document preview</h3>{#each selectedType.definition.layout.length ? selectedType.definition.layout : [{ title: 'Fields', fields: Object.keys(selectedType.definition.fields) }] as section}<h4>{section.title}</h4>{#each section.fields as field}<dl><dt>{selectedType.definition.fields[field]?.label ?? field}</dt><dd>{display(previewData()[field])}</dd></dl>{/each}{/each}</div>{/if}
        {#if historyRows.length}<section aria-label="Content history"><h3>Retained revisions</h3>{#each historyRows as entry}<details open={entry.revision===sourceRevision}><summary>Revision {entry.revision} · {entry.reason}</summary><p>{entry.created_at}{#if entry.type_revision!==null} · type revision {entry.type_revision}{/if}</p><pre>{JSON.stringify(entry.snapshot,null,2)}</pre><button onclick={()=>previewHistory(editor==='type'?'type':'item',entry.revision)} disabled={busy||dirty}>Preview restore of revision {entry.revision}</button></details>{/each}{#if historyNext}<button onclick={()=>loadHistory(editor==='type'?'type':'item',true)} disabled={busy||dirty}>Older revisions</button>{/if}</section>{/if}
        {#if restoreReview}<section role="alert" aria-label="Restore review"><h3>Restore revision {restoreReview.targetRevision}?</h3><p>Current revision {restoreReview.currentRevision}; {restoreReview.affectedDocuments} documents checked for schema compatibility.</p>{#each restoreReview.changes as change}<details><summary>{change.field}</summary><pre>Current: {display(change.from)}
Restored: {display(change.to)}</pre></details>{/each}{#each restoreReview.conflicts as conflict}<p>{conflict}</p>{/each}<button onclick={applyHistory} disabled={busy||dirty||!restoreReview.compatible}>Confirm restore as new revision</button><button onclick={()=>restoreReview=null}>Cancel</button></section>{/if}
      {:else if editor === 'migration'}<GameMigration {projectId} {gameId} {projects} onDirtyChange={value=>canonicalDirty=value} onBusyChange={value=>canonicalBusy=value} onMoved={async destination=>{projectId=destination;await selectProject();}}/><button disabled={canonicalDirty||canonicalBusy} onclick={closeEditor}>Close game migration</button>
      {:else if editor === 'folders'}{#key projectId+gameId}<FolderManager {projectId} gameId={gameId||undefined} onChanged={async()=>{offset=0;await loadItems();canonicalRows=[];}} onDirtyChange={(value)=>canonicalDirty=value} onBusyChange={(value)=>canonicalBusy=value}/>{/key}<button onclick={closeEditor} disabled={busy||canonicalBusy||dirty}>Close folder manager</button>
      {:else if editor === 'canonical-type'}{#key projectId+canonicalKind}<CanonicalTypeEditor {projectId} kind={canonicalKind} onDirtyChange={(value)=>canonicalDirty=value} onBusyChange={(value)=>canonicalBusy=value}/>{/key}<button onclick={closeEditor} disabled={busy||canonicalBusy}>Close type editor</button>
      {:else}<h2>Canonical {canonicalKind}</h2><p>These records use their existing canonical owners. Workspace metadata and retained history are linked to the same record.</p><label>Include hidden canonical records<input type="checkbox" bind:checked={includeHidden} disabled={busy || canonicalBusy || dirty} /></label><button onclick={() => { if(leave()) { canonicalOffset=0; void loadCanonical(); } }} disabled={busy || canonicalBusy || dirty}>Refresh canonical list</button>{#each canonicalRows as record}<button class="tree-item" onclick={() => openCanonical(String(record.id))} disabled={busy || canonicalBusy || dirty}>{modeIcon(String((record.content_metadata as Record<string,unknown>)?.gm_context_mode ?? canonicalTypeMode))} {String(record.name ?? record.id)}</button><select aria-label={`GM context for ${String(record.name ?? record.id)}`} value={String((record.content_metadata as Record<string,unknown>)?.gm_context_mode ?? '')} onchange={event => void setCanonicalTreeMode(record,event.currentTarget.value)} disabled={busy || canonicalBusy || dirty}><option value="">Use type default ({canonicalTypeMode})</option><option value="pinned">📌 Pinned</option><option value="partial">◐ Partial</option><option value="searchable">⌕ Searchable</option></select>{/each}{#if canonicalNext}<button onclick={() => { canonicalOffset = Number(canonicalNext); void loadCanonical(true); }} disabled={busy || canonicalBusy || dirty}>Load more canonical records</button>{/if}{#if canonicalId}{#key projectId+gameId+canonicalKind+canonicalId}<CanonicalContentEditor {projectId} {gameId} kind={canonicalKind} recordId={canonicalId==='__new__'?'':canonicalId} sourceRevision={sourceRevision ?? undefined} onDirtyChange={(value)=>canonicalDirty=value} onSaved={savedCanonical} onBusyChange={(value)=>canonicalBusy=value} />{/key}<button onclick={closeEditor} disabled={busy || canonicalBusy}>Discard / close canonical editor</button>{/if}{/if}
    </main>
  </div>
  {#if assistantOpen && projectId}<AssistantPanel {projectId} {gameId} authoringDirty={dirty} onClose={() => assistantOpen = false} onOpenStoryEntry={!dirty && !busy && !canonicalBusy && gameId ? (id) => { assistantOpen = false; app.openStorySource(gameId, id); } : undefined} />{/if}
</section>
<style>
  .content-workspace { height: 100%; overflow: auto; padding: 1.5rem; color: var(--text-primary); }
  h1 { font-family: var(--font-display); font-size: 1.7rem; } h2 { font-size: 1.1rem; margin: 1rem 0 .6rem; } h3,h4 { margin: .6rem 0; }
  p,small { color: var(--text-secondary); font-size: .85rem; } p { margin: .5rem 0; } small { display: block; }
  .toolbar,.actions { display: flex; flex-wrap: wrap; gap: .7rem; align-items: end; margin: .7rem 0; }
  .workspace-grid { display: grid; grid-template-columns: minmax(190px,260px) minmax(0,1fr); gap: 1.5rem; }
  aside { border-right: 1px solid var(--border-primary); padding-right: 1rem; } main { min-width: 0; max-width: 1000px; }
  label { display: grid; gap: .3rem; margin: .6rem 0; font-size: .85rem; } input,select,textarea,button { padding: .55rem .7rem; background: var(--bg-secondary); color: inherit; border: 1px solid var(--border-primary); border-radius: .35rem; }
  input,select,textarea { max-width: 100%; min-width: 0; } textarea { width: 100%; font-family: monospace; font-size: .8rem; resize: vertical; } button { cursor: pointer; font-size: .8rem; } button:hover { border-color: var(--text-accent); } button:disabled { opacity: .45; cursor: default; }
  .tree-item { display: block; width: 100%; text-align: left; margin: .4rem 0; overflow-wrap: anywhere; } .tree-item.selected { border-color: var(--text-accent); } summary { margin: .8rem 0 .3rem; cursor: pointer; font-size: .9rem; }
  .notice { min-height: 1.3rem; white-space: pre-wrap; overflow-wrap: anywhere; } fieldset { border: 0; padding: 0; min-width: 0; }
  .preview { padding: 1rem; margin: 1rem 0; border: 1px solid var(--border-primary); border-radius: .4rem; } dl { padding: .5rem 0; border-bottom: 1px solid var(--border-secondary); } dt { font-size: .8rem; color: var(--text-secondary); } dd { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .85rem; }
  @media(max-width: 750px) { .workspace-grid { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--border-primary); padding-bottom: 1rem; } .content-workspace { padding: 1rem; } }
</style>
