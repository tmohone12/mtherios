<script lang="ts">
  import CanonicalLayout from './CanonicalLayout.svelte';
  import FactionProfileEditor from './FactionProfileEditor.svelte';
  import type { CanonicalTypeSettings } from '$lib/contracts/canonicalTypes';
  import { onMount } from 'svelte';
  import type { CanonicalView } from '$lib/contracts/canonicalContent';
  let { projectId, gameId, kind, recordId, sourceRevision, onDirtyChange, onSaved, onBusyChange }: {projectId:string;gameId:string;kind:string;recordId:string;sourceRevision?:number;onDirtyChange:(dirty:boolean)=>void;onSaved:(value:CanonicalView)=>void;onBusyChange:(busy:boolean)=>void}=$props();
  let view=$state<CanonicalView|null>(null), name=$state(''), description=$state(''), folder=$state(''), slug=$state(''), context=$state(''), branchId=$state(''), povCharacter=$state(''), hidden=$state(false), extra=$state('{}');
  let typeSettings=$state<CanonicalTypeSettings|null>(null);
  let customFields=$state('{}'),customBaseline=$state('{}');
  let copying=$state(false),copyName=$state(''),copyFolder=$state(''),copySlug=$state('');
  let baseline=$state(''),busy=$state(false),message=$state(''),factionDirty=$state(false),factionBusy=$state(false);
  let revisions=$state<Array<{revision:number;reason:string;actor:Record<string,unknown>;created_at:string;snapshot:unknown}>>([]),next=$state<number|null>(null);
  let restoreReview=$state<{targetRevision:number;expectedSnapshot:string;compatible:boolean;conflicts:string[];changes:{field:string;from:unknown;to:unknown}[]}|null>(null);
  const snapshot=()=>JSON.stringify({name,description,folder,slug,context,branchId,povCharacter,hidden,extra,customFields});
  const recordDirty=$derived(snapshot()!==baseline);
  const dirty=$derived(copying || recordDirty || factionDirty);
  $effect(()=>onDirtyChange(dirty || busy || factionBusy));
  $effect(()=>onBusyChange(busy || factionBusy));
  async function call(command:string,args:Record<string,unknown>={}) {
    const response=await fetch('/api/engine/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storyId:gameId,command,args:{projectId,gameId,kind,...(recordId?{id:recordId}:{}),...args}})});
    const body=await response.json();if(!response.ok||body.status!=='succeeded')throw new Error(body.error??'Canonical content request failed.');return body.result;
  }
  function accept(value:CanonicalView) {view=value;customFields=JSON.stringify((value.record.metadata as Record<string,unknown>|undefined)?.contentFields??{},null,2);customBaseline=customFields;name=String(value.record.name??'');description=String(value.record.description??'');folder=value.envelope.folder;slug=value.envelope.slug;context=value.envelope.gm_context_mode??'';branchId=value.envelope.branch_id??'';povCharacter=value.envelope.pov_character??'';hidden=value.envelope.hidden;extra='{}';baseline=snapshot();revisions=[];next=null;restoreReview=null;}
  async function act(fn:()=>Promise<void>){busy=true;message='';try{await fn();}catch(error){message=String(error);}finally{busy=false;}}
  async function reload(){await act(async()=>{const response=await fetch('/api/engine/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storyId:'__app__',command:'content.canonicalTypes.read',args:{projectId,kind}})});const body=await response.json();if(!response.ok||body.status!=='succeeded')throw new Error(body.error??'Type settings could not be loaded.');typeSettings=body.result;if(recordId)accept(await call('content.canonical'));else{customFields=JSON.stringify(typeSettings?.definition.defaults??{},null,2);customBaseline=customFields;baseline=snapshot();}});}
  onMount(()=>{baseline=snapshot();void (async()=>{await reload();if(sourceRevision)await history();})();return()=>{onDirtyChange(false);onBusyChange(false);};});
  async function save(){await act(async()=>{
    const changes=JSON.parse(extra);if(!changes||typeof changes!=='object'||Array.isArray(changes))throw new Error('Additional updates must be an object.');
    if(customFields!==customBaseline||!view)changes.contentFields=JSON.parse(customFields);
    if(!view){const saved=await call('content.canonical.create',{fields:{...changes,name,...(kind!=='factions'?{description}:{})},metadata:{folder,...(slug?{slug}:{}),gmContextMode:context||null,branchId:branchId||null,povCharacter:povCharacter||null,hidden}});accept(saved);onSaved(saved);message='Canonical record created.';return;}
    if(name!==view!.record.name)changes.name=name;
    if(kind!=='factions'&&description!==String(view!.record.description??''))changes.description=description;
    const prior=view!.envelope;const metadata:Record<string,unknown>={};
    if(folder!==prior.folder)metadata.folder=folder;if(slug!==prior.slug)metadata.slug=slug;if(context!==(prior.gm_context_mode??''))metadata.gmContextMode=context||null;if(branchId!==(prior.branch_id??''))metadata.branchId=branchId||null;if(povCharacter!==(prior.pov_character??''))metadata.povCharacter=povCharacter||null;if(hidden!==prior.hidden)metadata.hidden=hidden;
    if(!Object.keys(changes).length&&!Object.keys(metadata).length){message='No changes to save.';return;}
    const saved=await call('content.canonical.edit',{expected:view!.revision,updates:changes,metadata});accept(saved);onSaved(saved);message='Canonical record and workspace metadata saved.';
  });}
  function beginCopy(){if(!view)return;copyName=name+' copy';copyFolder=folder;copySlug=(slug.slice(0,59)+'-copy');copying=true;message='';}
  async function copy(){if(!view)return;await act(async()=>{const saved=await call('content.canonical.copy',{expected:view!.revision,name:copyName,metadata:{folder:copyFolder,slug:copySlug}});copying=false;accept(saved);onSaved(saved);message='Canonical record copied with a new identity.';});}
  async function previewRestore(targetRevision:number){if(!view)return;await act(async()=>{restoreReview=await call('content.canonical.previewRestore',{targetRevision,expected:view!.revision});});}
  async function applyRestore(){if(!view||!restoreReview||!restoreReview.compatible||dirty)return;const reviewed=restoreReview;await act(async()=>{const result=await call('content.canonical.restore',{targetRevision:reviewed.targetRevision,expected:view!.revision,expectedSnapshot:reviewed.expectedSnapshot,confirmed:true});accept(result.restored);onSaved(result.restored);message='Canonical revision restored; later history retained.';});}
  async function history(more=false){await act(async()=>{const result=await call('content.canonical.history',{limit:10,...(more&&next?{beforeRevision:next}:{})});revisions=more?[...revisions,...result.revisions]:result.revisions;next=result.nextBeforeRevision;});}
</script>

<section aria-label="Canonical content editor">
  <p role="status">{busy?'Loading…':message}</p>
  {#if view || !recordId}
    <h3>{view?String(view.record.name):'New canonical record'}</h3>
    {#if view}<p>Record version {view.revision.recordVersion} · workspace revision {view.revision.metadataRevision}</p>{/if}
    <fieldset disabled={busy || copying}>
      <label>Name<input bind:value={name} /></label>
      {#if kind!=='factions'}<label>Description<textarea bind:value={description} rows="3"></textarea></label>{/if}
      <div class="row"><label>Canonical folder<input bind:value={folder} /></label><label>Canonical slug<input bind:value={slug} /></label></div>
      <label>Canonical GM context<select bind:value={context}><option value="">Use type default ({typeSettings?.definition.gmContextMode??'searchable'})</option><option value="pinned">Pinned</option><option value="partial">Partial</option><option value="searchable">Searchable</option></select></label>
      <p>Effective GM preload: {context||typeSettings?.definition.gmContextMode||'searchable'} {context?'(explicit)':'(inherited)'}. Partial sends title and description only.</p><div class="row"><label>Branch ID (optional)<input bind:value={branchId} placeholder="All branches" /></label><label>POV character (optional)<input bind:value={povCharacter} placeholder="All POVs" /></label></div>
      <label class="row"><input type="checkbox" bind:checked={hidden} /> Hide from workspace browsing</label>
      <p>Hiding changes only this workspace listing. The record remains available to gameplay and World explorer.</p>
      {#if Object.keys(typeSettings?.definition.fields??{}).length}<label>Custom canonical fields<textarea bind:value={customFields} rows="8"></textarea></label><p>Edits replace this custom-field object only. Other metadata stays intact. Required fields and the project schema are checked on save.</p>{/if}
      <details><summary>Additional field updates</summary><p>Supply only changed fields. Nested objects merge; arrays replace. Domain rules and source references are checked by the same owner as World explorer.</p><label>Canonical field updates<textarea bind:value={extra} rows="8"></textarea></label></details>
      <div class="row"><button onclick={save} disabled={!name.trim() || (view && !recordDirty)}>{view?'Save canonical changes':'Create canonical record'}</button>{#if view}<button onclick={reload} disabled={factionDirty || factionBusy}>Discard and reload canonical record</button><button onclick={()=>history()} disabled={dirty}>View canonical history</button><button onclick={beginCopy} disabled={dirty}>Copy canonical record</button>{/if}</div>
    </fieldset>
    {#if kind==='factions' && view}<FactionProfileEditor {gameId} factionId={String(view.record.id)} disabled={busy || copying || recordDirty} onDirtyChange={value=>factionDirty=value} onBusyChange={value=>factionBusy=value} onSaved={reload}/>{/if}
    {#if copying}<section aria-label="Copy canonical record"><h4>Copy within this game</h4><p>The copy gets a new identity and its own history. Fields and same-game references are retained. Relationships, location containment, aliases, evidence and linked faction tables stay with the source. Player characters cannot be copied.</p><fieldset disabled={busy}><label>Copy name<input bind:value={copyName}/></label><label>Copy folder<input bind:value={copyFolder}/></label><label>Copy slug<input bind:value={copySlug}/></label><div class="row"><button onclick={copy} disabled={!copyName.trim() || !copySlug}>Create canonical copy</button><button onclick={()=>copying=false}>Cancel copy</button></div></fieldset></section>{/if}
    {#if restoreReview}<section role="alert" aria-label="Canonical restore review"><h4>Restore canonical revision {restoreReview.targetRevision}?</h4>{#each restoreReview.changes as change}<details><summary>{change.field}</summary><pre>Current: {JSON.stringify(change.from,null,2)}
Restored: {JSON.stringify(change.to,null,2)}</pre></details>{/each}{#each restoreReview.conflicts as conflict}<p>{conflict}</p>{/each}<button onclick={applyRestore} disabled={dirty||busy||!restoreReview.compatible}>Confirm restore as new revision</button><button onclick={()=>restoreReview=null}>Cancel</button></section>{/if}
    {#if view && typeSettings}<h4>Record layout · type revision {typeSettings.revision}</h4><CanonicalLayout definition={typeSettings.definition} record={view.record}/>{/if}
    {#if view}<details><summary>Current canonical data</summary><pre>{JSON.stringify(view.record,null,2)}</pre></details>{/if}
    {#if revisions.length}<h4>Retained history</h4><p>Versions are captured from the catalog cutover onward. Restore changes editable domain and workspace fields through their current validators.</p>{#each revisions as revision}<details open={revision.revision===sourceRevision}><summary>Revision {revision.revision} · {revision.reason}</summary><p>{revision.created_at} · {String(revision.actor.role)} / {String(revision.actor.id)}</p><pre>{JSON.stringify(revision.snapshot,null,2)}</pre><button onclick={()=>previewRestore(revision.revision)} disabled={dirty||busy}>Preview restore</button></details>{/each}{#if next}<button onclick={()=>history(true)} disabled={busy}>Older canonical revisions</button>{/if}{/if}
  {/if}
</section>
<style>
  section{min-width:0}h3{font-size:1.1rem;margin:.8rem 0}p{font-size:.85rem;color:var(--text-secondary);margin:.5rem 0}label{display:grid;gap:.3rem;margin:.6rem 0;font-size:.85rem}.row{display:flex;gap:.7rem;flex-wrap:wrap;align-items:center}fieldset{border:0;padding:0;min-width:0}input,select,textarea,button{padding:.55rem .7rem;border:1px solid var(--border-primary);border-radius:.35rem;background:var(--bg-secondary);color:inherit;max-width:100%}textarea{width:100%;font: .85rem monospace}button{cursor:pointer;font-size:.8rem}button:disabled{opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8rem;margin:.6rem 0}summary{cursor:pointer;margin:.7rem 0}
</style>
