<script lang="ts">
 import {persistentProjectInspection} from '$lib/services/factionInspection';
 type Row=Record<string,any>;
 let {storyId,data,parentBusy=false,onrefresh}:{storyId:string|undefined;data:Row|null;parentBusy?:boolean;onrefresh:()=>void}=$props();
 let generation=0;
 let search=$state(''),extraEvents=$state<Row[]>([]);
 let saving=$state(false),message=$state(''),error=$state('');
 const empty=()=>({id:`relief_${crypto.randomUUID()}`,grant:'',route:'',authority:'',goal:'',supplierResource:'',recipientResource:'',deliveryDays:2,verification:false,verificationActor:'',verificationSubject:'',verificationExpected:0,verificationDeadline:0});
 let form=$state(empty());
 const blankEvidence=()=>({kind:'route',event:'',quote:'',location:'',faction:'',supplier:'',recipient:'',owner:'',means:'',limit:20,blocked:false,mode:'routine',consent:'not_required',reusable:false,reviewed:false});
 let evidence=$state(blankEvidence());
 const blankReport=()=>({project:'',event:'',claim:'',quote:'',result:'verified',reviewed:false});
 let report=$state(blankReport());
 const options=$derived(data?.authoring??{}),events=$derived([...new Map([...(options.events??[]),...extraEvents].map((e:Row)=>[e.id,e])).values()] as Row[]),actors=$derived((options.actors??[]) as Row[]),factions=$derived((options.factions??[]) as Row[]);
 const grants=$derived(events.filter(e=>e.metadata?.reliefExecutionGrant?.version===2||e.metadata?.reliefExecution?.projectId===form.id));
 const grant=$derived(grants.find(e=>e.id===form.grant)?.metadata.reliefExecutionGrant??grants.find(e=>e.id===form.grant)?.metadata.reliefExecution);
 const routes=$derived(events.filter(e=>grant&&e.metadata?.deliveryRoute&&e.metadata.deliveryRoute.locationId===grant.locationId));
 const authorities=$derived(events.filter(e=>grant&&e.metadata?.tollAuthority&&e.metadata.tollAuthority.factionId===grant.recipientId));
 const goals=$derived((options.goals??[]).filter((g:Row)=>g.factionId===grant?.supplierId));
 const inventories=$derived((options.resources??[]).filter((r:Row)=>r.status==='available'&&!r.issue));
 const projects=$derived(persistentProjectInspection(data?.projects).filter(p=>p.reusable));
 const decisionOwners=$derived(grant?[grant.ownerEntityId,factions.find(f=>f.id===grant.recipientId)?.authority?.ownerEntityId].filter(Boolean) as string[]:[]);
 const verificationSubjects=$derived(events.filter(e=>decisionOwners.length===2&&decisionOwners.every(id=>e.knownByActor?.includes(id))&&!['rumor','scheme'].includes(e.type)));
 const reportProject=$derived(projects.find(p=>p.id===report.project));
 const reportSources=$derived(events.filter(e=>e.knownByActor?.includes(reportProject?.verification?.recipientEntityId)&&e.worldTime&&(!e.metadata?.verificationReport||e.metadata.verificationReport.condition?.projectId===report.project)));
 const reportClaims=$derived((reportSources.find(e=>e.id===report.event)?.metadata?.actorClaims??[]).filter((c:Row)=>['learned','witnessed','shared'].includes(c.kind)&&c.knownBy?.includes(reportProject?.verification?.recipientEntityId)));
 const missing=$derived.by(()=>{
  const items:string[]=[];
  if(!grant)items.push('Select a reviewed execution authorization.');
  if(grant&&!factions.some(f=>f.id===grant.supplierId&&f.authority?.status==='ready'&&f.authority.ownerEntityId===grant.ownerEntityId))items.push('The recorded supplier owner is no longer authorized.');
  if(grant&&!factions.some(f=>f.id===grant.recipientId&&f.authority?.status==='ready'))items.push('The recipient needs an active, unambiguous decision owner.');
  if(!form.goal)items.push('Select an active objective owned by the supplier.');
  if(!form.supplierResource||!form.recipientResource)items.push('Select both available grain inventories.');
  if(!form.route)items.push('Select a matching committed route record.');
  if(!form.authority)items.push('Select the recipient’s committed toll authority.');
  if(form.grant&&grant&&!grants.find(e=>e.id===form.grant)?.knownByFaction?.includes(grant.supplierId))items.push('The supplier has not personally received the selected execution authority.');
  if(form.route&&grant&&!routes.find(e=>e.id===form.route)?.knownByFaction?.includes(grant.supplierId))items.push('The supplier has not personally learned the selected route.');
  if(form.authority&&grant&&!authorities.find(e=>e.id===form.authority)?.knownByFaction?.includes(grant.recipientId))items.push('The recipient has not personally learned the selected toll mandate.');
  if(grant&&[grant.supplierId,grant.recipientId].some(id=>factions.find(f=>f.id===id)?.eligible!==true))items.push('Both factions must be eligible for autonomous relief.');
  if(grant&&grant.meansEntityIds.some((id:string)=>!actors.some(a=>a.id===id&&['character','item'].includes(a.type))))items.push('The recorded execution means are unavailable.');
  if(typeof data?.reliefWorldDay!=='number')items.push('Establish canonical world time.');
  if(form.verification){
   if(!decisionOwners.includes(form.verificationActor))items.push('Select the authorized actor who must receive the report.');
   if(!verificationSubjects.some(e=>e.id===form.verificationSubject))items.push('Select a committed verification subject personally known to both owners.');
   if(typeof data?.reliefWorldDay==='number'&&!(form.verificationExpected>=data.reliefWorldDay&&form.verificationDeadline>=form.verificationExpected&&form.verificationDeadline<=data.reliefWorldDay+30))items.push('Set an ordered expected day and deadline within thirty world days.');
  }
  return items;
 });
 $effect(()=>{const id=storyId;generation++;search='';extraEvents=[];form=empty();evidence=blankEvidence();report=blankReport();message='';error='';saving=false;});
 function resetSources(){form.verificationActor='';form.verificationSubject='';form.verificationExpected=Number(data?.reliefWorldDay??0)+1;form.verificationDeadline=Number(data?.reliefWorldDay??0)+3;form.route='';form.authority='';form.goal='';form.supplierResource='';form.recipientResource='';}
 async function submit(operation:string,payload:Row){
  if(!storyId||saving||parentBusy)return;
  const ownStory=storyId,ownGeneration=generation;saving=true;error='';message='';
  try{
   const response=await fetch(`/api/factions/${encodeURIComponent(ownStory)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,...payload})});
   const receipt=await response.json();if(storyId!==ownStory||generation!==ownGeneration)return;
   if(!response.ok)throw new Error(receipt.error??'Unable to save relief project.');
   const result=receipt.settlement??receipt;
   message=operation==='create-relief-project'?(receipt.repeated?'This project was already created.':'Relief project created. Its prerequisites will be checked before any negotiation or dispatch.'):operation==='record-verification-report'?'Sourced report recorded for this request. Review this project to check receipt; delivery remains unconfirmed.':operation==='record-relief-evidence'?'Existing evidence recorded. Actor knowledge was not changed.':`Project review: ${result.status}${result.reason?` (${result.reason})`:''}.`;
   if(['record-relief-evidence','record-verification-report'].includes(operation))extraEvents=[];
   onrefresh();
  }catch(e){if(storyId===ownStory&&generation===ownGeneration)error=e instanceof Error?e.message:'Unable to save relief project.';}
  finally{if(storyId===ownStory&&generation===ownGeneration)saving=false;}
 }
 async function findEvidence(){
  if(!storyId||saving||parentBusy||!search.trim())return;
  const ownStory=storyId,ownGeneration=generation;saving=true;error='';
  try{const response=await fetch(`/api/factions/${encodeURIComponent(ownStory)}?evidenceQuery=${encodeURIComponent(search)}`);const receipt=await response.json();if(storyId!==ownStory||generation!==ownGeneration)return;if(!response.ok)throw new Error(receipt.error??'Evidence search failed.');extraEvents=receipt.authoring?.events??[];message='Canonical evidence search updated the source choices.';}
  catch(e){if(storyId===ownStory&&generation===ownGeneration)error=e instanceof Error?e.message:'Evidence search failed.';}
  finally{if(storyId===ownStory&&generation===ownGeneration)saving=false;}
 }
 function create(replanId?:string){
  if(missing.length||!grant)return;
  const route=routes.find(e=>e.id===form.route)?.metadata.deliveryRoute,authority=authorities.find(e=>e.id===form.authority)?.metadata.tollAuthority;
  void submit(replanId?'replan-relief-project':'create-relief-project',{project:{id:replanId??form.id,objectiveId:form.goal,ownerEntityId:grant.ownerEntityId,executionProofId:form.grant,expectedStoryVersion:data?.serverVersion,...(!replanId&&form.verification?{verification:{recipientEntityId:form.verificationActor,subjectEventId:form.verificationSubject,expectedDay:Number(form.verificationExpected),deadlineDay:Number(form.verificationDeadline)}}:{}),...(replanId?{expectedProjectVersion:projects.find(p=>p.id===replanId)?.serverVersion}:{})},
   config:{supplierId:grant.supplierId,recipientId:grant.recipientId,supplierResourceId:form.supplierResource,recipientResourceId:form.recipientResource,locationId:grant.locationId,deliveryDays:Number(form.deliveryDays),maxTollDays:authority.maxDays,authoritySourceId:form.authority,routeSourceId:form.route,blocked:route.blocked}});
 }
 function recordEvidence(){
  const event=events.find(e=>e.id===evidence.event);if(!event||!evidence.reviewed)return;
  const value=evidence.kind==='route'?{locationId:evidence.location,blocked:evidence.blocked}:evidence.kind==='authority'?{factionId:evidence.faction,maxDays:Number(evidence.limit)}:{...(evidence.reusable?{scope:'relief_authority',version:2}:{scope:'relief_execution',projectId:form.id}),ownerEntityId:evidence.owner,supplierId:evidence.supplier,recipientId:evidence.recipient,locationId:evidence.location,meansEntityIds:[evidence.means],maxGrain:Number(evidence.limit),mode:evidence.mode,playerConsent:evidence.consent};
  void submit('record-relief-evidence',{evidence:{eventId:evidence.event,expectedVersion:event.serverVersion,evidence:evidence.quote,reviewedCanonicalEvidence:true,projection:{kind:evidence.kind,value}}});
 }
 function recordReport(){
  const event=reportSources.find(e=>e.id===report.event);if(!event||!reportProject||!report.reviewed||!report.claim)return;
  void submit('record-verification-report',{report:{projectId:report.project,eventId:event.id,expectedVersion:event.serverVersion,expectedProjectVersion:reportProject.serverVersion,claimText:report.claim,evidence:report.quote,result:report.result,reviewedSourcedReceipt:true}});
 }
</script>

<div class="relief-manager">
 <h4>Relief projects</h4><p>Each shipment keeps its own agreement, reservation and observed outcome. Existing projects remain in the ledger.</p>
 {#if error}<p class="error" role="alert">{error}</p>{/if}{#if message}<p role="status">{message}</p>{/if}
 <label>Find canonical evidence<input aria-label="Find canonical evidence" bind:value={search} placeholder="Source title or quoted words"/></label><button onclick={findEvidence} disabled={saving||parentBusy||!search.trim()}>Find evidence</button>
 <details class="create"><summary>Create relief project</summary>
  <p>Choose committed records. You can require one sourced verification report before dispatch. Reports never supply execution authority or physical delivery evidence.</p>
  <div class="fields">
   <label>Execution authorization<select aria-label="Execution authorization" bind:value={form.grant} onchange={resetSources}><option value="">Select authorization</option>{#each grants as e}<option value={e.id}>{e.title}</option>{/each}</select></label>
   <label>Supplier objective<select aria-label="Supplier objective" bind:value={form.goal}><option value="">Select objective</option>{#each goals as g}<option value={g.id}>{g.label}</option>{/each}</select></label>
   <label>Supplier grain<select aria-label="Supplier grain" bind:value={form.supplierResource}><option value="">Select inventory</option>{#each inventories.filter((r:Row)=>r.factionId===grant?.supplierId) as r}<option value={r.id}>{r.name} — {r.available} available; {r.reserved} reserved</option>{/each}</select></label>
   <label>Recipient grain<select aria-label="Recipient grain" bind:value={form.recipientResource}><option value="">Select inventory</option>{#each inventories.filter((r:Row)=>r.factionId===grant?.recipientId) as r}<option value={r.id}>{r.name} — {r.available} available</option>{/each}</select></label>
   <label>Route record<select aria-label="Route record" bind:value={form.route}><option value="">Select route</option>{#each routes as e}<option value={e.id}>{e.title}{e.metadata.deliveryRoute.blocked?' (blocked)':''}</option>{/each}</select></label>
   <label>Toll authority<select aria-label="Toll authority" bind:value={form.authority}><option value="">Select authority</option>{#each authorities as e}<option value={e.id}>{e.title} — up to {e.metadata.tollAuthority.maxDays} days</option>{/each}</select></label>
   <label class="check"><input type="checkbox" bind:checked={form.verification}/> Require verification before dispatch</label>
   {#if form.verification}
    <label>Report recipient<select aria-label="Report recipient" bind:value={form.verificationActor}><option value="">Select authorized actor</option>{#each actors.filter(a=>decisionOwners.includes(a.id)) as actor}<option value={actor.id}>{actor.name}</option>{/each}</select></label>
    <label>Verification subject<select aria-label="Verification subject" bind:value={form.verificationSubject}><option value="">Select known source</option>{#each verificationSubjects as event}<option value={event.id}>{event.title}</option>{/each}</select></label>
    <label>Expected report world day<input aria-label="Expected report world day" type="number" min={data?.reliefWorldDay??0} bind:value={form.verificationExpected}/></label>
    <label>Report deadline world day<input aria-label="Report deadline world day" type="number" min={form.verificationExpected} max={(data?.reliefWorldDay??0)+30} bind:value={form.verificationDeadline}/></label>
    <p>The named actor must receive a sourced claim about this exact source revision. Travel starts at recorded departure after verification. A missed deadline releases an undelivered reservation; it changes no relationship.</p>
   {/if}
   <label>Delivery interval in world days<input type="number" min="1" max="5" bind:value={form.deliveryDays}/></label>
  </div>
  {#if form.supplierResource}<p>Shared supplier pool: {inventories.find((r:Row)=>r.id===form.supplierResource)?.available??'Unknown'} grain available; {inventories.find((r:Row)=>r.id===form.supplierResource)?.reserved??'Unknown'} reserved across projects.</p>{/if}
  {#if missing.length}<ul aria-label="Missing relief prerequisites">{#each missing as item}<li>{item}</li>{/each}</ul>{/if}
  {#if grant}<p>{factions.find(f=>f.id===grant.supplierId)?.name} → {factions.find(f=>f.id===grant.recipientId)?.name}. Owner: {actors.find(a=>a.id===grant.ownerEntityId)?.name}.</p><p>Maximum per shipment: {grant.maxGrain} grain. Contested or player-dependent execution waits for adjudication.</p>{/if}
  <button onclick={()=>create()} disabled={saving||parentBusy||missing.length>0}>Create project</button>
  <button onclick={()=>{form.id=`relief_${crypto.randomUUID()}`;form.grant='';resetSources();message='Ready to author another shipment.';}} disabled={saving||parentBusy}>Start another shipment</button>
 </details>
 <details class="evidence"><summary>Review existing relief evidence</summary>
  <p>Use this only when a committed event explicitly establishes every selected fact. Quote that event and review the fields. This records existing canon; it creates no event, knowledge, transport or consent. Uncertain reports cannot authorize execution.</p>
  <div class="fields">
   <label>Record kind<select aria-label="Record kind" bind:value={evidence.kind}><option value="route">Route</option><option value="authority">Toll authority</option><option value="execution">Execution authorization</option></select></label>
   <label>Committed source<select aria-label="Committed source" bind:value={evidence.event} onchange={()=>{evidence.quote='';evidence.reviewed=false;}}><option value="">Select source</option>{#each events.filter(e=>!['rumor','scheme'].includes(e.type)) as e}<option value={e.id}>{e.title}</option>{/each}</select></label>
   {#if evidence.kind!=='authority'}<label>Location<select aria-label="Location" bind:value={evidence.location}><option value="">Select location</option>{#each actors.filter(a=>a.type==='location') as a}<option value={a.id}>{a.name}</option>{/each}</select></label>{/if}
   {#if evidence.kind==='route'}<label class="check"><input type="checkbox" bind:checked={evidence.blocked}/> Route is blocked</label>{/if}
   {#if evidence.kind==='authority'}<label>Recipient faction<select aria-label="Recipient faction" bind:value={evidence.faction}><option value="">Select faction</option>{#each factions as f}<option value={f.id}>{f.name}</option>{/each}</select></label>{/if}
   {#if evidence.kind==='execution'}
    <label>Supplier<select aria-label="Supplier" bind:value={evidence.supplier}><option value="">Select supplier</option>{#each factions as f}<option value={f.id}>{f.name}</option>{/each}</select></label>
    <label>Recipient<select aria-label="Recipient" bind:value={evidence.recipient}><option value="">Select recipient</option>{#each factions as f}<option value={f.id}>{f.name}</option>{/each}</select></label>
    <label>Authorized decision owner<select aria-label="Authorized decision owner" bind:value={evidence.owner}><option value="">Select owner</option>{#each actors.filter(a=>a.type==='character') as a}<option value={a.id}>{a.name}</option>{/each}</select></label>
    <label>Established means<select aria-label="Established means" bind:value={evidence.means}><option value="">Select means</option>{#each actors.filter(a=>['character','item'].includes(a.type)) as a}<option value={a.id}>{a.name}</option>{/each}</select></label>
    <label>Execution mode<select aria-label="Execution mode" bind:value={evidence.mode}><option value="routine">Routine authority</option><option value="contested">Contested; GM adjudication</option></select></label>
    <label>Player dependency<select aria-label="Player dependency" bind:value={evidence.consent}><option value="not_required">Player choice not required</option><option value="pending">Player response pending</option><option value="confirmed">Consent recorded; still requires GM adjudication</option></select></label>
   <label class="check"><input type="checkbox" bind:checked={evidence.reusable}/> Source explicitly permits repeated shipments (otherwise one-off).</label>
   {/if}
   {#if evidence.kind!=='route'}<label>{evidence.kind==='authority'?'Maximum toll days':'Maximum grain per shipment'}<input type="number" min="1" max={evidence.kind==='authority'?30:undefined} bind:value={evidence.limit}/></label>{/if}
  </div>
  {#if evidence.event}<blockquote>{events.find(e=>e.id===evidence.event)?.body}</blockquote>{/if}
  <label>Exact supporting quote<textarea aria-label="Exact supporting quote" bind:value={evidence.quote} rows="3"></textarea></label>
  <label class="check"><input type="checkbox" bind:checked={evidence.reviewed}/> I reviewed the source: it explicitly establishes these canonical facts and limits.</label>
  <button onclick={recordEvidence} disabled={saving||parentBusy||!evidence.reviewed||!evidence.event||!evidence.quote.trim()}>Record reviewed evidence</button>
  <p>Up to {options.sourceLimit??200} recent and supported committed sources are shown. Use Find evidence for older records.</p>
 </details>
 <details class="verification"><summary>Review verification report</summary>
  <p>Choose an actual committed report already received by the named actor. Quote its sourced claim. This records a learned claim; it establishes no physical delivery or relationship change.</p>
  <div class="fields">
   <label>Verification project<select aria-label="Verification project" bind:value={report.project} onchange={()=>{report.event='';report.claim='';report.quote='';report.reviewed=false;}}><option value="">Select shipment request</option>{#each projects.filter(p=>p.verification) as project}<option value={project.id}>{project.objective} · {project.id.slice(-8)}</option>{/each}</select></label>
   <label>Received report source<select aria-label="Received report source" bind:value={report.event} onchange={()=>{report.claim='';report.quote='';report.reviewed=false;}}><option value="">Select personally received source</option>{#each reportSources as event}<option value={event.id}>{event.title} · {event.worldTime}</option>{/each}</select></label>
   <label>Established actor claim<select aria-label="Established actor claim" bind:value={report.claim}><option value="">Select exact received claim</option>{#each reportClaims as claim}<option value={claim.text}>{claim.text}</option>{/each}</select></label>
   <label>Report disposition<select aria-label="Report disposition" bind:value={report.result}><option value="verified">Supports verification</option><option value="contradictory">Contradicts verification</option><option value="revoked">Revokes verification</option></select></label>
  </div>
  {#if reportProject}<p>Receipt required by {actors.find(a=>a.id===reportProject.verification?.recipientEntityId)?.name??'the specified actor'}. Expected day {reportProject.verification?.expectedDay}; deadline day {reportProject.verification?.deadlineDay}.</p>{/if}
  {#if report.event}<blockquote>{reportSources.find(e=>e.id===report.event)?.body}</blockquote>{/if}
  <label>Report supporting quote<textarea aria-label="Report supporting quote" rows="3" bind:value={report.quote}></textarea></label>
  <label class="check"><input type="checkbox" bind:checked={report.reviewed}/> I reviewed this exact request, source revision and personally received claim.</label>
  <button onclick={recordReport} disabled={saving||parentBusy||!report.reviewed||!reportProject||!report.event||!report.claim||!report.quote.trim()}>Record sourced report</button>
  {#if reportProject&&!reportSources.length}<p>No personally received source with canonical world time is available. Use Find evidence for older records. Waiting creates no report.</p>{/if}
 </details>
 {#each projects as project (project.id)}
  <article><strong>{project.objective}</strong><p>Shipment {project.id.slice(-8)}</p><p>{project.label}. {project.nextStep}</p><p>{project.reserved??0} grain reserved for this project. Arrival due: {project.dueWorldTime??'Not committed'}.</p>{#if project.confirmationSourceId}<p>Outcome receipt: {project.confirmationSourceId}</p>{/if}
   {#if project.verification}<p class="verification-status">Verification: {project.verification.status}. Report recipient: {actors.find(a=>a.id===project.verification?.recipientEntityId)?.name??'the specified actor'}. Expected day {project.verification.expectedDay}; deadline day {project.verification.deadlineDay}.</p>{#if project.verification.receipt}<p>Learned report receipt: {project.verification.receipt.eventId}. Physical delivery requires a separate observed outcome.</p>{/if}{#if ['contradictory','expired'].includes(project.verification.status)}<p>Review the source and cancel any remaining undelivered commitment before authoring a new request. An accepted condition cannot be silently replaced.</p>{/if}{/if}
   {#if ['replan','blocked','adjudication'].includes(project.phase)&&!['contradictory','expired'].includes(project.verification?.status)}<button onclick={()=>create(project.id)} disabled={saving||parentBusy||missing.length>0}>Reconsider with selected records</button>{/if}
   <button onclick={()=>void submit('negotiation-step',{projectId:project.id,stepId:`manual:${crypto.randomUUID()}`})} disabled={saving||parentBusy}>Review this project</button>
   {#if !['completed','failed','cancelled'].includes(project.phase)&&project.negotiationPhase!=='delivered'}<button onclick={()=>void submit('cancel-relief-project',{project:{id:project.id,expectedStoryVersion:data?.serverVersion,expectedProjectVersion:project.serverVersion}})} disabled={saving||parentBusy}>Cancel project</button>{/if}
  </article>
 {/each}
</div>

<style>
 .relief-manager{margin-top:18px;border-top:1px solid var(--border-secondary);padding-top:12px;min-width:0}h4{font-size:13px}p,li,label,summary,button{font-size:11px;line-height:1.65}p,li{color:var(--text-secondary)}details{margin:12px 0}summary{cursor:pointer}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}label{display:flex;flex-direction:column;gap:4px;min-width:0}select,input,textarea{width:100%;min-width:0;box-sizing:border-box;background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border-secondary);border-radius:5px;padding:7px}select{overflow:hidden}button{border:1px solid var(--border-primary);border-radius:5px;padding:7px 9px;margin:6px 6px 0 0;color:var(--text-accent)}button:disabled{opacity:.5}.check{flex-direction:row;align-items:start;margin:10px 0}.check input{width:auto;flex-shrink:0}blockquote{margin:10px 0;padding:10px;border-left:2px solid var(--border-primary);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}article{padding:10px;border:1px solid var(--border-secondary);border-radius:6px;margin:8px 0;overflow-wrap:anywhere}strong{font-size:12px}.error{color:#e8a29c}ul{padding-left:18px}textarea{resize:vertical}@media(max-width:520px){.fields{grid-template-columns:minmax(0,1fr)}}
</style>
