<script lang="ts">
  import { onMount } from 'svelte';
  let { projectId, gameId, onChanged, onDirtyChange, onBusyChange }: { projectId:string; gameId?:string; onChanged:()=>Promise<void>; onDirtyChange:(value:boolean)=>void; onBusyChange:(value:boolean)=>void } = $props();
  type Preview={skipped?:{id:string;kind:string;reason:string}[];importedRecovery?:boolean;expectedSnapshot:string;counts:{folders:number;documents:number;canonical:number};items:{id:string;kind:string;name?:string;from:string;to:string}[]};
  let operation=$state<'move'|'copy'|'archive'|'restore'>('move');
  let archivedPaths=$state<string[]>([]);
  const organizing=$derived(operation==='move'||operation==='copy');

  let paths=$state<string[]>([]), path=$state(''), from=$state(''), to=$state(''), busy=$state(false), message=$state(''), review=$state<Preview|null>(null);
  const sourcePaths=$derived(operation==='restore'?archivedPaths:paths);
  $effect(()=>onDirtyChange(Boolean(path||to||review)));
  $effect(()=>onBusyChange(busy));
  async function command(name:string,args:Record<string,unknown>={}){
    const response=await fetch('/api/engine/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storyId:'__app__',command:name,args:{projectId,...(gameId?{gameId}:{}),...args}})});
    const body=await response.json();if(!response.ok||body.status!=='succeeded')throw new Error(body.error??'Folder request failed.');return body.result;
  }
  async function act(action:()=>Promise<void>){busy=true;message='';try{await action();}catch(error){review=null;message=String(error);}finally{busy=false;}}
  async function refresh(){const result=await command('content.folders.list');paths=result.paths;archivedPaths=result.explicit.filter((row:{archived_at:string|null})=>row.archived_at).map((row:{path:string})=>row.path);}
  onMount(()=>{void act(refresh);return()=>{onDirtyChange(false);onBusyChange(false);};});
  async function create(){await act(async()=>{await command('content.folders.create',{path});path='';await refresh();await onChanged();message='Folder created.';});}
  async function preview(){await act(async()=>{review=await command('content.folders.preview'+operation[0].toUpperCase()+operation.slice(1),organizing?{from,to}:{path:from});});}
  async function move(){if(!review)return;const expectedSnapshot=review.expectedSnapshot;await act(async()=>{await command('content.folders.'+operation,{...(organizing?{from,to}:{path:from}),expectedSnapshot});from='';to='';review=null;await refresh();await onChanged();message=operation==='copy'?'Folder copied with new identities. The source was retained.':operation==='move'?'Folder moved. Document identities and history were retained.':operation==='archive'?'Folder archived. Canonical records remain part of gameplay.':'Reviewed folder recovery applied. Changed records were left untouched.';});}
</script>

<section aria-label="Folder manager">
  <h2>Manage folders</h2>
  <p>{gameId?'Operations affect this game only. Shared project documents keep their folders.':'Manage shared project folders.'} {#if organizing}Nested folders, archived documents and retained canonical entries are included. Choose an unused destination path. Restore archived folders before moving or copying them.{:else if operation==='archive'}Active custom documents become read-only archives. Canonical entries are hidden from this workspace only; they remain in gameplay and GM context. Previously archived documents and hidden or deleted canonical entries stay unchanged.{:else}Recover only records changed by the saved archive operation. Later edits are left untouched and listed in the preview. Review carefully before applying.{/if}</p>
  {#if operation==='copy'}<p>Copies receive new identities. Document references within this folder point to the copies; outside references keep their targets. Canonical copies retain links to original world records and do not duplicate linked tables or evidence. Player characters, merged records and deleted canonical sources block the whole copy.</p>{/if}
  <fieldset disabled={busy}>
    <label>New folder path<input aria-label="New folder path" bind:value={path} placeholder="Rules/Core" /></label>
    <button onclick={create} disabled={!path}>Create folder</button>
    <label>Folder operation<select aria-label="Folder operation" bind:value={operation} onchange={()=>{review=null;from='';to='';}}><option value="move">Move</option><option value="copy">Copy</option><option value="archive">Archive</option><option value="restore">Restore</option></select></label>
    <label>Source folder<select aria-label="Source folder" bind:value={from} onchange={()=>review=null}><option value="">Choose a folder</option>{#each sourcePaths as value}<option value={value}>{value}</option>{/each}</select></label>
    {#if organizing}<label>Destination folder path<input aria-label="Destination folder path" bind:value={to} oninput={()=>review=null} placeholder="Archive/Rules" /></label>{/if}
    <button onclick={preview} disabled={!from||(organizing&&!to)}>Preview folder {operation}</button>
    {#if review}
      <div aria-label="Folder operation preview"><h3>{operation[0].toUpperCase()+operation.slice(1)} {from}{#if organizing} to {to}{/if}</h3><p>{review.counts.folders} saved folders, {review.counts.documents} documents and {review.counts.canonical} canonical entries.</p>
        <p>{#if review.importedRecovery}No saved recovery receipt exists here. This recovery restores folder paths only. Restore archived documents individually.{/if}</p>
        {#if review.skipped?.length}<p>{review.skipped.length} changed records will be left untouched:</p><ul>{#each review.skipped as item}<li>{item.kind} {item.id}: {item.reason}</li>{/each}</ul>{/if}
        <ul>{#each review.items.slice(0,50) as item}<li>{item.name??`${item.kind} ${item.id}`}: {item.from}{#if organizing} → {item.to}{/if}</li>{/each}</ul>
        {#if review.items.length>50}<p>Showing the first 50 of {review.items.length} entries. All counted entries will be included.</p>{/if}
        <button onclick={move}>Apply folder {operation}</button>
      </div>
    {/if}
    <button onclick={()=>{path='';from='';to='';review=null;message='';}}>Discard folder edits</button>
  </fieldset>
  <p role="status">{busy?'Loading…':message}</p>
</section>

<style>
  fieldset{border:0;padding:0;display:grid;gap:1rem}label{display:grid;gap:.35rem}input,select{padding:.55rem;background:var(--bg-secondary,#17191f);color:inherit;border:1px solid var(--border-color,#454750);border-radius:.3rem}button{width:fit-content;padding:.5rem .8rem}li{overflow-wrap:anywhere}p{line-height:1.5}
</style>
