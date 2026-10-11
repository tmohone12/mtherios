
<script lang="ts">
 import { storedStrategicFrameForStory } from '$lib/services/ai/context/strategicFramePromptCard';
 import { strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
 import type { StrategicWorldFrame } from '$lib/types';
 import { story } from '$lib/stores/story.svelte';
 import ReliefProjectManager from './ReliefProjectManager.svelte';
 import ThreadManager from './ThreadManager.svelte';
 import PlotDirectorEditor from './PlotDirectorEditor.svelte';
 import { onMount, untrack } from 'svelte';
 import { RefreshCw, ChevronRight } from 'lucide-svelte';
 import { createFactionInspectionLoader, emptyFactionInspection, factionReviewMessages, persistentProjectInspection } from '$lib/services/factionInspection';
 type Row = Record<string, any>;
 let inspection = $state(emptyFactionInspection());
 let inspectionOpen = $state(false);
 let inspectionDetails: HTMLDetailsElement;
 let inspectionSummary: HTMLElement;
 function closeInspection(event: KeyboardEvent) {
  if (event.key === 'Escape' && inspectionDetails?.open && event.target instanceof Node && inspectionDetails.contains(event.target)) { event.preventDefault(); event.stopPropagation(); inspectionDetails.open = false; inspectionOpen = false; inspectionSummary?.focus(); }
 }
 function outsideInspection(event: PointerEvent) {
  if (inspectionDetails?.open && event.target instanceof Node && !inspectionDetails.contains(event.target)) { inspectionDetails.open = false; inspectionOpen = false; }
 }
 onMount(() => {
  document.addEventListener('keydown', closeInspection, true);
  return () => document.removeEventListener('keydown', closeInspection, true);
 });
 const data = $derived(inspection.data);
 const busy = $derived(inspection.busy);
 const error = $derived(inspection.error);
 const reviewMessages = $derived(factionReviewMessages(inspection.reviewReceipt));
 const storyId = $derived(story.currentStory?.serverStoryId ?? story.currentStory?.id);
 const oldMetadata = $derived(story.campaignProjection?.story.metadata);
 const authored = $derived(storedStrategicFrameForStory(storyId, oldMetadata));
 const pending = $derived.by(() => { const parsed = strategicWorldFrameSchema.safeParse(((oldMetadata as Row | undefined)?.plotBrain as Row | undefined)?.pendingFrame); return parsed.success ? parsed.data as unknown as StrategicWorldFrame : null; });
 const workflow = $derived(data?.workflow ?? {});
 const attempts = $derived((workflow.attempts ?? []).slice().reverse().slice(0, 6) as Row[]);
 const forecasts = $derived((workflow.forecasts ?? []) as Row[]);
 const events = $derived((data?.events ?? []) as Row[]);
 const projects = $derived(persistentProjectInspection(data?.projects).filter(project=>!project.reusable));
 const lastDecision = $derived(attempts[0]);
 const loader = createFactionInspectionLoader({ currentStoryId: () => storyId, update: state => { inspection = state; } });
 function load(review = false) {
  if (storyId && !busy) void loader.load(storyId, review);
 }
 $effect(() => { const id = storyId; untrack(() => { loader.reset(); if (id) void loader.load(id); }); return () => { loader.reset(); }; });
</script>

<svelte:window onpointerdown={outsideInspection} />

<section class="faction-workflow" aria-label="Faction intentions and forecasts">
 <div class="heading"><div><p class="eyebrow">Living world</p><h3>Intentions &amp; consequences</h3></div><span class="cadence">5-turn review</span></div>
 <p class="intro">Plans can change. An intention is an attempt; an event records what happened.</p>
 <details class="inspection" bind:open={inspectionOpen} bind:this={inspectionDetails}>
  <summary bind:this={inspectionSummary}><ChevronRight size={16} /><span class="inspection-title"><strong>GM / developer inspection</strong><small>Contains private plans</small></span><span class="inspection-state">{inspectionOpen ? 'Open' : 'Inspect'}</span></summary>
  <div class="toolbar"><span>Turn {data?.currentTurn ?? '—'} · {data?.worldTime ?? 'World time unset'}</span><button onclick={() => load()} disabled={busy} aria-label="Refresh faction inspection"><RefreshCw size={13} class={busy ? 'spin' : ''} /></button></div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if data?.turnJobsEnabled === false}<p class="review-state">Automatic faction and forecast reviews are off because turn jobs are disabled. A manual review can still run.</p>{/if}
  {#each reviewMessages as message}<p class="review-state" role="status">{message}</p>{/each}
  {#if data?.inferencePolicy === 'local-only-testing'}<p class="review-state">Local-only testing is active. Normal cloud GM play and automatic planner calls are paused. A one-time model test does not enable ongoing play.</p>{/if}
  {#if lastDecision}<p class="review-state">Latest decision: <strong>{lastDecision.status}</strong> · Next review ≥ turn {lastDecision.nextReviewTurn}. Unchanged evidence keeps the current plan.</p>{:else}<p class="empty">No faction decision yet. Quiet is a valid state.</p>{/if}
  <h4>Intentions &amp; recent decisions <span>Attempts, not events</span></h4>
  {#each attempts as attempt (attempt.id)}
   <article class:held={attempt.status !== 'intended'}>
    <div class="row"><strong>{attempt.factionName}</strong><span class="status">{attempt.status}</span></div>
    <p>{attempt.intention?.action ?? attempt.reason ?? 'Held pending grounded evidence.'}</p>
    <details class="evidence"><summary>Decision &amp; basis</summary>
     {#if attempt.intention}<p><b>Motive:</b> {attempt.intention.motive}</p><p><b>Manner:</b> {attempt.intention.manner}</p><p><b>Limits:</b> {attempt.intention.limits.join(' · ')}</p><p><b>Evidence:</b> {attempt.intention.basis.join(', ')}</p>{/if}
     {#if attempt.decision}<p>{attempt.decision.model} · decision confidence {Math.round(attempt.decision.confidence * 100)}%. This is not success probability.</p>{/if}
     <p>Reviewed on turn {attempt.turn} · {attempt.worldTime ?? 'No elapsed-world-time inference'}</p>
    </details>
   </article>
  {/each}
  <ReliefProjectManager {storyId} {data} parentBusy={busy} onrefresh={() => load()} />
  {#if projects.length}<h4>Persistent projects <span>Execution and confirmation</span></h4>{/if}
  {#each projects as project (project.id)}
   <article class:held={['blocked','replan','adjudication'].includes(project.phase)}>
    <div class="row"><strong>{project.objective}</strong><span class="status">{project.label}</span></div>
    <p>{project.nextStep}</p>
    <p>Grain reserved: {project.reserved ?? 'Unknown'}. Arrival due: {project.dueWorldTime ?? 'Not committed'}.</p>
    {#if project.confirmationSourceId}<details class="evidence"><summary>Outcome receipt</summary><p>{project.confirmationSourceId}</p></details>{/if}
   </article>
  {/each}
  <h4>Established events <span>Canonical receipts</span></h4>
  {#each events as event (event.id)}<article class="event"><div class="row"><strong>{event.title}</strong><span class="status">{event.visibility}</span></div><p>{event.body}</p></article>{/each}
  {#if !events.length}<p class="empty">No established consequences.</p>{/if}
  <h4>Conditional forecasts <span>Have not happened</span></h4>
  {#each forecasts as forecast (forecast.id)}<article class="forecast"><p><b>If</b> {forecast.if}, {forecast.development}</p><p><b>Unless</b> {forecast.unless}</p><details class="evidence"><summary>Conditions &amp; sources</summary><p>Earliest: {forecast.earliest ?? 'Unknown'}</p><p>{forecast.uncertainty}</p><p>Invalidate when: {forecast.invalidateWhen}</p><p>Evidence: {forecast.evidence.join(', ')}</p></details></article>{/each}
  {#if !forecasts.length}<p class="empty">No earned forecast. {workflow.gardener?.status === 'held' ? `Gardener held: ${workflow.gardener.reason}` : 'Quiet can last.'}</p>{/if}
  {#if workflow.negotiation}<details class="evidence"><summary>Negotiation ledger · {workflow.negotiation.phase}</summary><p>Reservations, delivery and expiry follow canonical world time. A voiced offer does not settle delivery.</p><p>Revision {workflow.negotiation.revision} · {workflow.negotiation.receipts.at(-1)?.outcome ?? 'Awaiting first response'}</p></details>{/if}
  <button class="review" onclick={() => load(true)} disabled={busy}>{busy ? 'Reviewing…' : 'Review changed context'}</button>
  <details class="manual"><summary>Authored threads &amp; manual content</summary><ThreadManager /><PlotDirectorEditor applied={authored} {pending} pendingFresh={false} /></details>
 </details>
</section>

<style>
 .faction-workflow { border:1px solid var(--border-secondary); border-radius:12px; padding:18px; background:var(--bg-secondary); }
 .heading,.row,.toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; }
 .eyebrow { margin:0 0 5px; font-size:9px; text-transform:uppercase; letter-spacing:.15em; color:var(--text-accent); }
 h3 { margin:0; font-family:var(--font-display); font-size:21px; font-weight:400; letter-spacing:-.02em; }
 .intro,.review-state { font-size:12px; line-height:1.65; color:var(--text-secondary); }
 .cadence,.status { font-size:9px; white-space:nowrap; border:1px solid var(--border-secondary); border-radius:5px; padding:4px 6px; color:var(--text-muted); }
 summary { cursor:pointer; font-size:11px; color:var(--text-secondary); }
 .inspection > summary { display:flex; align-items:center; gap:10px; min-height:48px; margin-top:14px; padding:10px 12px; list-style:none; border:1px solid var(--border-secondary); border-radius:9px; background:var(--bg-primary); transition:background .15s,border-color .15s; }
 .inspection > summary::-webkit-details-marker { display:none; }
 .inspection > summary strong { font-size:12px; font-weight:500; }
 .inspection > summary:hover { background:var(--bg-tertiary); }
 .inspection > summary:focus-visible { outline:2px solid var(--text-accent); outline-offset:3px; }
 .inspection[open] > summary { border-color:color-mix(in srgb,var(--text-accent) 35%,var(--border-primary)); background:color-mix(in srgb,var(--text-accent) 7%,var(--bg-primary)); }
 .inspection > summary :global(svg) { flex-shrink:0; transition:transform .15s; }
 .inspection[open] > summary :global(svg) { transform:rotate(90deg); }
 .faction-workflow { min-width:0; } article,p { overflow-wrap:anywhere; } .heading { flex-wrap:wrap; } .evidence > summary,.manual > summary { min-height:44px; display:flex; align-items:center; }
 @media (prefers-reduced-motion:reduce) { .inspection > summary,.inspection > summary :global(svg) { transition:none; } }
 .inspection-title { display:grid; gap:3px; min-width:0; }
 .inspection-title small { font-size:10px; color:var(--text-muted); }
 .inspection-state { margin-left:auto; font-size:10px; color:var(--text-accent); border:1px solid var(--border-secondary); border-radius:5px; padding:4px 7px; }
 .toolbar { margin-top:16px; font-size:10px; color:var(--text-muted); }
 .toolbar button { padding:6px; border-radius:5px; border:1px solid var(--border-secondary); }
 h4 { display:flex; justify-content:space-between; margin:22px 0 9px; font-size:12px; font-weight:500; }
 h4 span { font-size:9px; font-weight:400; color:var(--text-muted); }
 article { margin:7px 0; padding:12px; border:1px solid var(--border-secondary); border-left:2px solid var(--text-accent); border-radius:7px; background:var(--bg-primary); }
 article.held { border-left-color:#bea772; } article.event { border-left-color:#a8e6a1; } article.forecast { border-left-color:#a9a6cd; }
 article strong { font-size:12px; font-weight:500; } article p,.evidence p { font-size:11px; line-height:1.65; margin:8px 0; }
 .evidence { margin-top:9px; color:var(--text-muted); } .evidence summary { font-size:10px; }
 .empty { font-size:11px; color:var(--text-muted); line-height:1.6; } .error { color:#e8a29c; font-size:11px; }
 .review { margin-top:16px; padding:9px 12px; border-radius:6px; border:1px solid var(--border-primary); font-size:11px; color:var(--text-accent); }
 button:disabled { opacity:.5; } .manual { margin-top:18px; border-top:1px solid var(--border-secondary); padding-top:12px; }
 :global(.spin) { animation:spin 1s linear infinite; } @keyframes spin { to { transform:rotate(360deg); } }
 @media (max-width:420px) { .inspection > summary { gap:8px; padding:10px; } .inspection-title { flex:1; } .inspection-state { padding:4px; } .cadence { display:none; } }
 @media (prefers-reduced-motion:reduce) { :global(.spin) { animation:none; } }
</style>
