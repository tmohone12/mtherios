<script lang="ts">
 import {onMount} from 'svelte';
 import {RECOVERY_ROUTE,RECOVERY_LIMITS,type ChapterRunnerStatus} from '$lib/contracts/chapterRunner';
 let {storyId,onPublished=async()=>{}}:{storyId:string;onPublished?:()=>Promise<void>}=$props();
 let status=$state<ChapterRunnerStatus|null>(null),busy=$state(false),error=$state(''),confirmed=$state(false);
 let maxChapters=$state(1),totalUsd=$state<number>(RECOVERY_LIMITS.usd),minIntervalMinutes=$state(60),expiresAt=$state(new Date(Date.now()+7*86400000).toISOString().slice(0,16));
 async function refresh(){
  busy=true;error='';
  try{const r=await fetch(`/api/app/chapters?storyId=${encodeURIComponent(storyId)}`);const data=await r.json();if(!r.ok)throw Error(data.error??'Could not read chapter runner status.');
   const previousNumber=status?.boundary.number;status=data;
   if(previousNumber!==undefined&&status&&status.boundary.number>previousNumber)await onPublished();
   if(status?.approval){maxChapters=status.approval.maxChapters;totalUsd=status.approval.totalUsd;minIntervalMinutes=status.approval.minIntervalMinutes;expiresAt=status.approval.expiresAt.slice(0,16);}
  }catch(e){error=e instanceof Error?e.message:'Could not read chapter runner status.';}finally{busy=false;}
 }
 async function setEnabled(enabled:boolean){
  if(!status||busy||(enabled&&!confirmed))return;busy=true;error='';
  try{const payload=enabled?{action:'enable',storyId,approval:{confirmed:true,model:RECOVERY_ROUTE.model,endpoint:RECOVERY_ROUTE.endpoint,
    afterPosition:status.approval?.afterPosition??status.boundary.endPosition,maxChapters:Number(maxChapters),totalUsd:Number(totalUsd),minIntervalMinutes:Number(minIntervalMinutes),expiresAt:new Date(expiresAt+'Z').toISOString()}}:{action:'disable',storyId};
   const r=await fetch('/api/app/chapters',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),data=await r.json();
   if(!r.ok)throw Error(data.error??'Chapter runner change failed.');status=data;confirmed=false;
  }catch(e){error=e instanceof Error?e.message:'Chapter runner change failed.';}finally{busy=false;}
 }
 onMount(()=>{void refresh();const timer=setInterval(()=>{if(!busy)void refresh();},60000);return ()=>clearInterval(timer);});
</script>

<section class="mb-3 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3" aria-label="Chapter-only automatic summaries">
 <div class="flex items-center justify-between gap-3"><h3 class="text-sm font-semibold">Automatic chapters</h3>
  <button class="rounded border px-2 py-1 text-xs" onclick={refresh} disabled={busy}>Refresh status</button></div>
 <p class="mt-1 text-xs text-[var(--text-muted)]">Summaries only. Other memory jobs and world changes keep their own controls.</p>
 {#if error}<p role="alert" class="mt-2 text-xs text-red-400">{error}</p>{/if}
 {#if status}
  <p class="mt-2 text-sm" role="status">{status.enabled?'Enabled':'Paused'} · {status.phase}</p>
  <p class="mt-1 text-xs">{status.message}</p>
  <p class="mt-1 text-xs">Chapter {status.boundary.number} ends at {status.boundary.endPosition}. Next: {status.nextRange?`chapter ${status.nextRange.number}, positions ${status.nextRange.start}–${status.nextRange.end}`:`${status.completedTurns}/20 completed turns`}.</p>
  {#if status.nextDueAt}<p class="mt-1 text-xs">Earliest next run: {status.nextDueAt}.</p>{/if}
  <p class="mt-1 text-xs">Saved in this activation: {status.completedChapters}. Reserved ceiling: ${status.reservedUsd.toFixed(3)}. Requests reserved: {status.reservedCalls}.</p>
  {#if status.activeManifestId}<details class="mt-2 text-xs"><summary>Held or active receipt</summary><p class="break-all">{status.activeManifestId}</p>
   {#each status.attempts as attempt}<p>{attempt.stage}: {attempt.status}, reserved ${attempt.reservedUsd??0}{attempt.statusCode?`, HTTP ${attempt.statusCode}`:''}{attempt.providerRequestId?`, request ${attempt.providerRequestId}`:''}</p>{/each}
   <p>Source and request/usage receipts are retained. An uncertain request is never automatically purchased again. Pause and review this receipt before a separate recovery decision.</p></details>{/if}
  <details class="mt-2" open={!status.enabled}>
   <summary class="text-xs">{status.approval?'Review activation limits':'Proposed limits — approval required'}</summary>
   <p class="mt-2 text-xs">NanoGPT model: {RECOVERY_ROUTE.model}. Provider endpoint: {RECOVERY_ROUTE.endpoint}. No fallback or transport retry; reasoning off.</p>
   <p class="mt-1 text-xs">Per chapter: ≤{RECOVERY_LIMITS.calls} calls, {RECOVERY_LIMITS.inputTokens.toLocaleString()} input / {RECOVERY_LIMITS.outputTokens.toLocaleString()} output tokens, ${RECOVERY_LIMITS.usd}. Provider price ceilings: ${RECOVERY_ROUTE.inputUsdPerMillion} input / ${RECOVERY_ROUTE.outputUsdPerMillion} output per million, including provider-selection markup. An additional 13.4% conservative allowance is reserved.</p>
   <div class="mt-2 grid grid-cols-2 gap-2 text-xs">
    <label>Maximum chapters<input class="mt-1 w-full rounded bg-[var(--bg-primary)] p-2" type="number" min="1" max="100" bind:value={maxChapters} disabled={busy||status.enabled} /></label>
    <label>Total USD ceiling<input class="mt-1 w-full rounded bg-[var(--bg-primary)] p-2" type="number" min={RECOVERY_LIMITS.usd} max="3.1" step="0.001" bind:value={totalUsd} disabled={busy||status.enabled} /></label>
    <label>Minimum minutes between chapters<input class="mt-1 w-full rounded bg-[var(--bg-primary)] p-2" type="number" min="1" max="10080" bind:value={minIntervalMinutes} disabled={busy||status.enabled} /></label>
    <label>Expires (UTC)<input class="mt-1 w-full rounded bg-[var(--bg-primary)] p-2" type="datetime-local" bind:value={expiresAt} disabled={busy||status.enabled} /></label>
   </div>
   {#if !status.enabled}<label class="mt-3 flex items-start gap-2 text-xs"><input type="checkbox" bind:checked={confirmed} disabled={busy||!status.available} />I approve these limits and this exact route for future chapters in this story. Generated summaries receive automatic source checks, not human semantic review.</label>{/if}
  </details>
  <div class="mt-3 flex gap-2">
   <button class="rounded border px-3 py-2 text-xs disabled:opacity-50" onclick={()=>setEnabled(true)} disabled={busy||!status.available||status.enabled||!confirmed||status.phase==='held'}>Enable chapter summaries</button>
   <button class="rounded border px-3 py-2 text-xs disabled:opacity-50" onclick={()=>setEnabled(false)} disabled={busy||(!status.enabled&&status.phase!=='held')}>Pause chapters</button>
  </div>
 {/if}
</section>
