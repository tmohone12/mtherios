<script lang="ts">
  import {onMount} from 'svelte';
  let {projectId,gameId,projects,onDirtyChange,onBusyChange,onMoved}:{projectId:string;gameId:string;projects:{id:string;name?:string}[];onDirtyChange:(dirty:boolean)=>void;onBusyChange:(busy:boolean)=>void;onMoved:(destination:string)=>Promise<void>}=$props();
  type Shared={id:string;title:string;folder:string};
  type Review={expectedSnapshot:string;compatible:boolean;conflicts:string[];counts:{gameDocuments:number;sharedDocuments:number;types:number;folders:number;canonical:number};dependencies:Shared[];availableShared:Shared[];notice:string};
  let destination=$state(''),selected=$state<string[]>([]),available=$state<Shared[]>([]),review=$state<Review|null>(null),busy=$state(false),message=$state('');
  $effect(()=>onDirtyChange(Boolean(destination||selected.length||review)));$effect(()=>onBusyChange(busy));
  onMount(()=>()=>{onDirtyChange(false);onBusyChange(false);});
  async function call(apply=false){busy=true;message='';try{
    const response=await fetch('/api/engine/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storyId:'__app__',command:apply?'content.games.move':'content.games.previewMove',args:{projectId,gameId,destinationProjectId:destination,sharedItemIds:selected,...(apply?{expectedSnapshot:review?.expectedSnapshot}:{})}})});
    const body=await response.json();if(!response.ok||body.status!=='succeeded')throw new Error(body.error??'Game migration failed.');
    if(apply){const movedTo=destination;destination='';selected=[];review=null;await onMoved(movedTo);}else{review=body.result;available=body.result.availableShared;}
  }catch(error){review=null;message=String(error);}finally{busy=false;}}
</script>
<section aria-label="Game project migration"><h2>Move game to another project</h2>
  <p>Keep this game's identities, canon and history. Referenced shared documents are copied automatically. Use the preview to choose additional shared rules or lore to bring along. Other shared content stays in this project; the destination project's settings and shared content apply after the move.</p>
  <fieldset disabled={busy}>
    <label>Destination project<select bind:value={destination} onchange={()=>review=null}><option value="">Choose a project</option>{#each projects.filter(p=>p.id!==projectId) as project}<option value={project.id}>{project.name??project.id}</option>{/each}</select></label>
    {#if available.length}<h3>Additional shared documents</h3>{#each available as item}<label><input type="checkbox" value={item.id} bind:group={selected} onchange={()=>review=null}/>{item.title} · {item.folder||'Root'}</label>{/each}{/if}
    <button disabled={!destination} onclick={()=>call()}>Preview game move</button>
    {#if review}<div aria-label="Game migration preview"><p>{review.counts.gameDocuments} game documents, {review.counts.sharedDocuments} shared copies, {review.counts.types} types, {review.counts.folders} saved folders and {review.counts.canonical} canonical entries.</p><p>{review.notice}</p>
      {#if review.dependencies.length}<h3>Shared documents to copy</h3><ul>{#each review.dependencies as item}<li>{item.title} · {item.folder||'Root'}</li>{/each}</ul>{/if}
      {#if review.conflicts.length}<p>Resolve these conflicts and preview again:</p><ul>{#each review.conflicts as conflict}<li>{conflict}</li>{/each}</ul>{/if}
      <button disabled={!review.compatible} onclick={()=>call(true)}>Apply game move</button></div>{/if}
    <button onclick={()=>{destination='';selected=[];review=null;message='';}}>Discard game move</button>
  </fieldset><p role="status">{busy?'Checking game dependencies…':message}</p>
</section>
<style>fieldset{border:0;padding:0;display:grid;gap:1rem}label{display:flex;gap:.5rem;align-items:center}select,button{padding:.55rem;background:var(--bg-secondary);color:inherit;border:1px solid var(--border-primary);border-radius:.3rem}button{width:fit-content}p{line-height:1.5}li{overflow-wrap:anywhere}</style>
