/** Separate chapter-only workflow. Never imports/claims backend_jobs or calls the
 * broad chapter processor. Activation and reservations are durable in Postgres. */
import type {Sql} from 'postgres';
import {randomUUID} from 'node:crypto';
import {chapterRunnerApprovalSchema,RECOVERY_ROUTE,RECOVERY_LIMITS,LEGACY_NANO_RECOVERY_ROUTE,type ChapterRunnerApproval,type ChapterRunnerStatus} from '$lib/contracts/chapterRunner';
import {selectCompletedChapterTurns,type ChapterSourceEntry} from '$lib/services/chapterCadence';
import {planSummaryRecovery,previewRecoveryCalls,readRecoveryRun,recoveryHash,generateRecoveryDraft,reviewRecoveryDraft,commitRecoveryDraft,verifyRecoveryCommit,type RecoveryManifest} from './summaryRecovery';
import type {ServerGenerationOptions} from '$lib/server/turn/provider';
import {EVIDENCE_REFERENCE_PROTOCOL} from './summaryEvidenceReferences';
import {recordReviewedChapterWindow,reviewedChapterWindowBlocked,setReviewedChapterWindowState} from './chapterWindows';
type Query=Pick<Sql,'unsafe'>;
type State={enabled:boolean;approval:ChapterRunnerApproval;phase:ChapterRunnerStatus['phase'];message:string;nextDueAt:string|null;
 active?:{manifest:RecoveryManifest;owner:string;leaseUntil:string};
 allocations:Array<{manifestId:string;usd:number;incrementOf?:string}>;reservations:Array<{manifestId:string;stage:string;requestHash:string;usd:number;inputTokens:number;outputTokens:number}>;
 completed:Array<{manifestId:string;number:number;at:string}>;
 reconciliations?:Array<{manifestId:string;draftHash:string;runHash:string;runnerHash:string;approvedBy:string;at:string;lastPaidStageEndedAt:string;nextDueAt:string}>;
 backfills?:Array<{priorManifestId:string;priorRunHash:string;runnerHash:string;manifestIds:string[];reviewedBy:string;at:string}>};
export type ChapterRunnerGate={enabled:boolean;storyId:string};
export type ChapterRunnerDependencies={profile:()=>Promise<ServerGenerationOptions['profile']>;generate?:Parameters<typeof generateRecoveryDraft>[4];verifyEndpoint?:()=>Promise<void>;now?:()=>Date};
const nowDate=(deps?:ChapterRunnerDependencies)=>deps?.now?.()??new Date();
const allowed=(sid:string,gate:ChapterRunnerGate)=>gate.enabled&&gate.storyId===sid;
const chapterAllocations=(d:State)=>d.allocations.filter(a=>!a.incrementOf).length;
async function readState(db:Query,sid:string) {
 const [exists]=await db.unsafe("select to_regclass('public.chapter_summary_runners') as name");
 if(!exists.name)return null;
 const [row]=await db.unsafe('select document from chapter_summary_runners where story_id=$1',[sid]);
 return (row?.document??null) as State|null;
}
async function writeState(db:Query,sid:string,d:State) {
 await db.unsafe('insert into chapter_summary_runners(story_id,document) values($1,$2::text::jsonb) on conflict(story_id) do update set document=excluded.document,updated_at=now()',[sid,JSON.stringify(d)]);
}
/** Runner document access under its advisory lock, for local recovery tooling. */
export type ChapterRunnerState=State;
export const chapterRunnerAllowed=(sid:string,gate:ChapterRunnerGate)=>allowed(sid,gate);
export const saveChapterRunnerState=(db:Query,sid:string,d:State)=>writeState(db,sid,d);
export const lockedChapterRunnerState=<T>(db:Sql,sid:string,fn:(tx:Query,d:State|null)=>Promise<T>)=>locked(db,sid,fn);
async function locked<T>(db:Sql,sid:string,fn:(tx:Query,d:State|null)=>Promise<T>) {
 return db.begin(async tx=>{
  await tx.unsafe('select pg_advisory_xact_lock(hashtextextended($1,0))',['chapter-summary-runner:'+sid]);
  const [row]=await tx.unsafe('select document from chapter_summary_runners where story_id=$1 for update',[sid]);
  return fn(tx as unknown as Query,row?.document??null);
 });
}
async function eligibility(db:Query,sid:string) {
 const [story]=await db.unsafe('select id from stories where id=$1',[sid]);if(!story)throw Error('Story not found');
 const [last]=await db.unsafe('select number,metadata,source_entry_ids from chapters where story_id=$1 order by number desc limit 1',[sid]);
 const [range]=last?await db.unsafe('select max(position)::int as end from story_entries where story_id=$1 and id = any($2::text[])',[sid,last.source_entry_ids]):[{end:-1}];
 const boundary={number:Number(last?.number??0),endPosition:Math.max(-1,Number(last?.metadata?.endPosition??-1),Number(range?.end??-1))};
 const rows=await db.unsafe('select id,type,content,position,parent_id,branch_id,metadata from story_entries where story_id=$1 and position>$2 order by position,id',[sid,boundary.endPosition]);
 const turns=selectCompletedChapterTurns(rows.map(r=>({...r,parentId:r.parent_id,branchId:r.branch_id})) as unknown as ChapterSourceEntry[]);
 let manifest:RecoveryManifest|null=null;
 if(turns.length>=20)manifest=await planSummaryRecovery(db,sid,'chapter');
 return {boundary,completedTurns:turns.length,manifest};
}
export async function getChapterRunnerStatus(db:Sql,sid:string,gate:ChapterRunnerGate):Promise<ChapterRunnerStatus> {
 return db.begin('isolation level repeatable read read only',async tx=>{
  const q=tx as unknown as Query,d=await readState(q,sid),e=await eligibility(q,sid),available=allowed(sid,gate);
  const run=d?.active?await readRecoveryRun(q,d.active.manifest):null;
  return {storyId:sid,available,enabled:available&&!!d?.enabled,phase:d?.phase??'paused',
   message:!available?'Chapter-only dispatch is unavailable until this story is explicitly enabled in the launcher.':d?.message??'Paused. Set and approve the limits to enable future chapters.',
   boundary:e.boundary,completedTurns:e.completedTurns,nextRange:e.manifest?{number:e.manifest.number,start:e.manifest.startPosition,end:e.manifest.endPosition,sourceIds:e.manifest.sourceIds}:null,
   nextDueAt:d?.nextDueAt??null,approval:d?.approval??null,completedChapters:d?.completed.length??0,
   reservedUsd:Math.round((d?.allocations.reduce((n,a)=>n+a.usd,0)??0)*1e9)/1e9,reservedCalls:d?.reservations.length??0,
   activeManifestId:d?.active?.manifest.id??null,attempts:run?.attempts.map(a=>{const receipt=a.receipt as Record<string,unknown>|undefined;
    return {stage:a.stage,status:a.status,reservedUsd:a.reservedUsd??null,providerRequestId:typeof receipt?.providerRequestId==='string'?receipt.providerRequestId:null,statusCode:typeof receipt?.statusCode==='number'?receipt.statusCode:null};})??[],limits:{...RECOVERY_LIMITS,...(d?.active?.manifest.replacement?.limits??{})},route:RECOVERY_ROUTE};
 });
}
/** Explicit recovery closure, not uncertain-call retry. A local reviewed save
 * consumes no new paid cadence interval; retain the latest paid-stage interval. */
export async function reconcileCommittedChapterRunner(db:Sql,sid:string,gate:ChapterRunnerGate,
 a:{manifestId:string;draftHash:string;runnerHash:string;runHash:string;approvedBy:string},now=new Date()) {
 if(!allowed(sid,gate)||!a.approvedBy.trim())throw Error('Explicit committed chapter reconciliation required');
 await locked(db,sid,async(tx,d)=>{
  if(!d||d.enabled||d.phase!=='held'||!d.active||d.active.manifest.id!==a.manifestId||recoveryHash(d)!==a.runnerHash)throw Error('Exact held activation required');
  const m=d.active.manifest,run=await verifyRecoveryCommit(tx,m,a.draftHash);if(recoveryHash(run)!==a.runHash)throw Error('Reviewed run changed');
  if(run.attempts.some(r=>r.status!=='complete')||!run.draftOrigin||Date.parse(d.approval.expiresAt)<=now.getTime())throw Error('Held reviewed external completion required');
  const times:number[]=[];
  for(const reservation of d.reservations){const [row]=await tx.unsafe('select document from summary_recovery_runs where id=$1',[reservation.manifestId]);const attempt=row?.document.attempts?.find((r:{stage:string;requestHash:string})=>r.stage===reservation.stage&&r.requestHash===reservation.requestHash),receipt=attempt?.receipt;
   if(!receipt||!Number.isFinite(Date.parse(receipt.startedAt))||!Number.isFinite(receipt.durationMs)||receipt.durationMs<0)throw Error('Reserved paid timing evidence required');times.push(Date.parse(receipt.startedAt)+receipt.durationMs);
  }
  if(!times.length)throw Error('Retained paid cadence evidence required');
  if(!d.completed.some(c=>c.manifestId===m.id))d.completed.push({manifestId:m.id,number:m.number,at:run.commit!.at});
  await setReviewedChapterWindowState(tx,{storyId:sid,number:m.number,manifestId:m.id,state:'committed',commit:reviewedCommit(run.commit!),
   from:['generating','validated','retryable_failure','uncertain_dispatch']});
  delete d.active;
  const previousDue=d.nextDueAt?Date.parse(d.nextDueAt):0;if(!Number.isFinite(previousDue))throw Error('Existing paid cadence changed');
  d.nextDueAt=new Date(Math.max(previousDue,Math.max(...times)+(d.approval.minIntervalMinutes*60000))).toISOString();
  d.reconciliations??=[];d.reconciliations.push({...a,at:now.toISOString(),lastPaidStageEndedAt:new Date(Math.max(...times)).toISOString(),nextDueAt:d.nextDueAt});
  const exhausted=chapterAllocations(d)>=d.approval.maxChapters||d.allocations.reduce((n,a)=>n+a.usd,0)+RECOVERY_LIMITS.usd>d.approval.totalUsd||d.reservations.length+3>30;
  d.enabled=!exhausted;d.phase=exhausted?'complete':'waiting';d.message=exhausted?'Reviewed chapter saved; approved capacity exhausted.':`Reviewed chapter ${m.number} saved; future chapters enabled under retained limits.`;
  await writeState(tx,sid,d);
 });
 return getChapterRunnerStatus(db,sid,gate);
}
/** Close an obsolete paused attempt only after reviewed source-bound backfill
 * commits cover every original source. Retains receipts, reservations and spend;
 * does not enable dispatch or replay the failed request. Local operator only. */
export async function reconcileBackfilledChapterRunner(db:Sql,sid:string,
 a:{runnerHash:string;priorRunHash:string;commits:Array<{manifest:RecoveryManifest;draftHash:string}>;reviewedBy:string},now=new Date()) {
 if(!a.reviewedBy.trim()||!a.commits.length)throw Error('Reviewed backfill commits required');
 return locked(db,sid,async(tx,d)=>{
  if(!d||d.enabled||!['paused','held'].includes(d.phase)||!d.active||recoveryHash(d)!==a.runnerHash
   ||Date.parse(d.active.leaseUntil)>now.getTime())throw Error('Exact idle paused attempt required');
  const old=d.active.manifest,prior=await readRecoveryRun(tx,old);
  if(!prior||recoveryHash(prior)!==a.priorRunHash||prior.commit)throw Error('Retained failed run changed');
  const covered=new Set<string>();let previousEnd:number|undefined;
  for(const c of a.commits){
   const m=c.manifest;
   if(m.kind!=='chapter'||m.storyId!==sid||m.coverage?.mode!=='explicit-backfill'
    ||(previousEnd!==undefined&&m.startPosition!==previousEnd+1))throw Error('Consecutive same-story backfill required');
   await verifyRecoveryCommit(tx,m,c.draftHash);
   m.sourceIds.forEach(id=>covered.add(id));previousEnd=m.endPosition;
  }
  if(a.commits[0].manifest.startPosition>old.startPosition||previousEnd!<old.endPosition
   ||old.sourceIds.some(id=>!covered.has(id)))throw Error('Backfill does not cover retained attempt');
  d.backfills??=[];d.backfills.push({priorManifestId:old.id,priorRunHash:a.priorRunHash,runnerHash:a.runnerHash,
   manifestIds:a.commits.map(c=>c.manifest.id),reviewedBy:a.reviewedBy,at:now.toISOString()});
  await setReviewedChapterWindowState(tx,{storyId:sid,number:old.number,manifestId:old.id,state:'invalidated',
   invalidation:{reason:'operator',detail:`Reviewed backfill through chapter ${a.commits.at(-1)!.manifest.number}.`}});
  delete d.active;d.phase='paused';
  d.message=`Reviewed catch-up through chapter ${a.commits.at(-1)!.manifest.number} saved. Previous attempt retained for audit; automatic chapters remain paused.`;
  await writeState(tx,sid,d);
  return {closedManifestId:old.id,throughChapter:a.commits.at(-1)!.manifest.number,providerCalls:0,enabled:false};
 });
}
export async function configureChapterRunner(db:Sql,sid:string,gate:ChapterRunnerGate,raw?:unknown,now=new Date()) {
 if(raw===undefined) {
  await locked(db,sid,async(tx,d)=>{if(d){d.enabled=false;d.phase='paused';d.message='Paused. No new requests or publishing; any in-flight response may be retained.';await writeState(tx,sid,d);}});
  return getChapterRunnerStatus(db,sid,gate);
 }
 if(!allowed(sid,gate))throw Error('Chapter-only launcher gate is disabled or belongs to a different story.');
 const approval=chapterRunnerApprovalSchema.parse(raw),expiry=Date.parse(approval.expiresAt);
 if(expiry<=now.getTime()||expiry>now.getTime()+90*86400000)throw Error('Choose an expiry within the next 90 days.');
 if(approval.totalUsd<RECOVERY_LIMITS.usd)throw Error('Total budget must reserve at least one bounded chapter ($0.033).');
 await locked(db,sid,async(tx,old)=>{
  const e=await eligibility(tx,sid);
  if(!old&&approval.afterPosition!==e.boundary.endPosition)throw Error('Chapter boundary changed. Refresh and approve the current boundary.');
  if(old&&approval.afterPosition!==old.approval.afterPosition)throw Error('The activation source floor cannot change.');
  const d:State=old??{enabled:false,approval,phase:'paused',message:'',nextDueAt:null,allocations:[],reservations:[],completed:[]};
  if(d.phase==='held')throw Error('Attempt held. Inspect the retained recovery receipt; automatic retry is forbidden.');
  if(chapterAllocations(d)>approval.maxChapters||(!d.active&&chapterAllocations(d)>=approval.maxChapters)||d.allocations.reduce((n,a)=>n+a.usd,0)+(!d.active?RECOVERY_LIMITS.usd:0)>approval.totalUsd)throw Error('Approved chapter count or remaining budget is exhausted; choose explicit higher limits.');
  d.approval=approval;d.enabled=true;d.phase=d.active?'generating':'waiting';d.message=d.active?'Resuming the retained attempt; uncertain requests will not be replayed.':'Enabled for future chapter summaries only. Waiting for 20 completed turns.';
  await writeState(tx,sid,d);
 });
 return getChapterRunnerStatus(db,sid,gate);
}
/** Public metadata preflight; no authorization headers, key probes or inference. */
export async function verifyChapterEndpoint() {
 const catalog=await fetch(`${RECOVERY_ROUTE.baseUrl}/models?detailed=true`,{signal:AbortSignal.timeout(10000)});
 if(!catalog.ok||(await catalog.json()).data?.some((m:{id:string})=>m.id===RECOVERY_ROUTE.model)!==true)throw Error('Pinned direct-host model is unavailable. No inference was sent.');
 const response=await fetch(`${LEGACY_NANO_RECOVERY_ROUTE.baseUrl.replace(/\/api\/v1$/,'')}/api/models/${encodeURIComponent(RECOVERY_ROUTE.model)}/providers`,{signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('Pinned provider metadata is unavailable. No inference was sent.');
 const data=await response.json(),endpoint=data.providers?.find((e:{provider:string})=>e.provider===RECOVERY_ROUTE.endpoint);
 const price=endpoint?.pricing;
 if(data.canonicalId!==RECOVERY_ROUTE.model||data.supportsProviderSelection!==true||!endpoint?.available||endpoint.quantization!=='fp8'
  ||endpoint.effectivePricing?.currency!=='USD'||endpoint.effectivePricing?.unit!=='per_1k_tokens'||endpoint.effectivePricing?.is_fresh!==true
  ||!Number.isFinite(Number(price?.inputPer1kTokens))||!Number.isFinite(Number(price?.outputPer1kTokens))
  ||Number(price.inputPer1kTokens)<0||Number(price.outputPer1kTokens)<0
  ||Number(price.inputPer1kTokens)*1000>RECOVERY_ROUTE.inputUsdPerMillion||Number(price.outputPer1kTokens)*1000>RECOVERY_ROUTE.outputUsdPerMillion
  ||Number(price.cacheReadInputPer1kTokens??0)*1000>RECOVERY_ROUTE.inputUsdPerMillion||Number(price.cacheWriteInputPer1kTokens??0)>0)throw Error('Pinned Xiaomi endpoint is unavailable or exceeds the approved prices. Review routing before enabling again.');
}
export async function tickChapterRunner(db:Sql,sid:string,gate:ChapterRunnerGate,deps:ChapterRunnerDependencies) {
 if(!allowed(sid,gate))return getChapterRunnerStatus(db,sid,gate);
 const owner=randomUUID(),now=nowDate(deps);
 const selected=await locked(db,sid,async(tx,d)=>{
  if(!d?.enabled||d.phase==='held')return null;
  if(Date.parse(d.approval.expiresAt)<=now.getTime()){d.enabled=false;d.phase='paused';d.message='Approval expired. Review the limits before resuming.';await writeState(tx,sid,d);return null;}
  if(d.active&&Date.parse(d.active.leaseUntil)>now.getTime())return null;
  if(!d.active) {
   if(d.nextDueAt&&Date.parse(d.nextDueAt)>now.getTime())return null;
   const e=await eligibility(tx,sid);
   if(!e.manifest){d.phase='waiting';d.message=`Waiting: ${e.completedTurns}/20 completed turns after position ${e.boundary.endPosition}.`;await writeState(tx,sid,d);return null;}
   if(e.manifest.startPosition<=d.approval.afterPosition)throw Error('Candidate overlaps the approved source floor.');
   const blocked=await reviewedChapterWindowBlocked(tx,sid,e.manifest.number);
   if(blocked){d.phase='waiting';d.message=`Waiting: ${blocked}`;await writeState(tx,sid,d);return null;}
   if(chapterAllocations(d)>=d.approval.maxChapters||d.allocations.reduce((n,a)=>n+a.usd,0)+RECOVERY_LIMITS.usd>d.approval.totalUsd||d.reservations.length+3>30) {
    d.enabled=false;d.phase='complete';d.message='Approved count or budget exhausted. Review new limits to continue.';await writeState(tx,sid,d);return null;
   }
   d.allocations.push({manifestId:e.manifest.id,usd:RECOVERY_LIMITS.usd});
   d.active={manifest:e.manifest,owner,leaseUntil:new Date(now.getTime()+10*60000).toISOString()};
  }else d.active={...d.active,owner,leaseUntil:new Date(now.getTime()+10*60000).toISOString()};
  d.phase='generating';d.message='Generating one source-bound chapter. Reserved requests will never be replayed after an uncertain outcome.';
  const am=d.active.manifest;
  await recordReviewedChapterWindow(tx,{storyId:sid,number:am.number,manifestId:am.id,startPosition:am.startPosition,endPosition:am.endPosition,
   sourceEntryIds:am.sourceIds,owner,compiler:am.version,summarizerRevision:`${am.route.model}@${recoveryHash(am.route).slice(0,12)}`});
  await writeState(tx,sid,d);return d.active.manifest;
 });
 if(!selected)return getChapterRunnerStatus(db,sid,gate);
 const m=selected;
 try {
  const run=await readRecoveryRun(db,m);
  if(run?.attempts.some(a=>a.status!=='complete'))throw Error('Prior request is blocked or uncertain. Inspect the retained receipt; no automatic retry.');
  let result=run?.draft&&run.draftHash?{draft:run.draft,draftHash:run.draftHash}:null;
  if(!result) {
   await (deps.verifyEndpoint??verifyChapterEndpoint)();
   const savedProfile=await deps.profile();
   const savedBase=(savedProfile.baseUrl??'').replace(/\/$/,'');
   if(savedProfile.providerType!==RECOVERY_ROUTE.providerType||(savedBase!==RECOVERY_ROUTE.baseUrl&&savedBase!==LEGACY_NANO_RECOVERY_ROUTE.baseUrl))throw Error('Pinned NanoGPT connection differs');
   const profile={...savedProfile,baseUrl:RECOVERY_ROUTE.baseUrl};
   const plan=previewRecoveryCalls(m,EVIDENCE_REFERENCE_PROTOCOL);
   if(plan.stages.some(s=>s.conservativeInputReservation>RECOVERY_LIMITS.inputPerCall))throw Error('Source window exceeds the approved per-call input cap. Use reviewed recovery; do not increase limits silently.');
   result=await generateRecoveryDraft(db,m,{manifestId:m.id,routeHash:recoveryHash(m.route),limitsHash:recoveryHash(m.limits)},profile,deps.generate,async r=>{
    await locked(db,sid,async(tx,d)=>{
     if(!d?.enabled||d.active?.owner!==owner||d.active.manifest.id!==m.id||Date.parse(d.approval.expiresAt)<=nowDate(deps).getTime())throw Error('Activation paused or expired before dispatch.');
     if(d.reservations.some(a=>a.manifestId===m.id&&a.stage===r.stage))throw Error('Duplicate runner request reservation.');
     if(d.reservations.length>=30||d.allocations.reduce((n,a)=>n+a.usd,0)>d.approval.totalUsd||Date.parse(d.active.leaseUntil)<=nowDate(deps).getTime())throw Error('Budget aggregate cap or owner lease exhausted.');
     d.reservations.push({manifestId:m.id,...r});await writeState(tx,sid,d);
    });
   },EVIDENCE_REFERENCE_PROTOCOL);
  }
  // Automatic exact-reference/attribution/order validation, explicitly labelled;
  // this does not claim a human read the generated prose or semantic certainty.
  await reviewRecoveryDraft(db,m,result.draftHash,'Automatic exact-source quote, attribution and account-order validation under approved chapter-only activation',
   {quotesChecked:true,uncertaintyChecked:true,chronologyChecked:true});
  await setReviewedChapterWindowState(db,{storyId:sid,number:m.number,manifestId:m.id,state:'validated',draftHash:result.draftHash});
  await commitRecoveryDraft(db,m,result.draftHash,async(tx,commit)=>{
   await tx.unsafe('select pg_advisory_xact_lock(hashtextextended($1,0))',['chapter-summary-runner:'+sid]);
   const [row]=await tx.unsafe('select document from chapter_summary_runners where story_id=$1 for update',[sid]),d=row?.document as State;
   if(!d?.enabled||d.active?.owner!==owner||d.active.manifest.id!==m.id||Date.parse(d.approval.expiresAt)<=nowDate(deps).getTime()||Date.parse(d.active.leaseUntil)<=nowDate(deps).getTime())throw Error('Activation paused or expired before publishing. The draft is retained.');
   if(!d.completed.some(c=>c.manifestId===m.id))d.completed.push({manifestId:m.id,number:m.number,at:commit.at});
   // The window commits with the chapter; index and arc consumers are enqueued by the lifecycle owner.
   await setReviewedChapterWindowState(tx,{storyId:sid,number:m.number,manifestId:m.id,state:'committed',commit:reviewedCommit(commit)});
   delete d.active;d.nextDueAt=new Date(nowDate(deps).getTime()+d.approval.minIntervalMinutes*60000).toISOString();
   const exhausted=chapterAllocations(d)>=d.approval.maxChapters||d.allocations.reduce((n,a)=>n+a.usd,0)+RECOVERY_LIMITS.usd>d.approval.totalUsd||d.reservations.length+3>30;
   d.enabled=!exhausted;d.phase=exhausted?'complete':'waiting';d.message=exhausted?'Chapter saved. Approved count or budget exhausted; paused.':`Chapter ${m.number} saved. Waiting for the next complete source window and approved interval.`;
   await writeState(tx,sid,d);
  });
 }catch(error) {
  // Never persist raw transport errors, which may contain credential-bearing URLs.
  const safe=error instanceof Error&&/^(Prior request|Source window|Pinned|Activation|Candidate|Stale|Budget|Incomplete|Quote|Reported|No complete|Reviewed)/.test(error.message)
   ?error.message:'Summary attempt held. Inspect the source and retained request/usage receipts; check configured provider availability. No automatic retry.';
  await locked(db,sid,async(tx,d)=>{
   if(!d||d.active?.owner!==owner)return;
   const run=await readRecoveryRun(tx,m),uncertain=run?.attempts.some(a=>a.status!=='complete');
   const codes=run?.attempts.map(a=>(a.receipt as {statusCode?:number}|undefined)?.statusCode)??[];
   d.phase=uncertain||d.enabled?'held':'paused';d.enabled=false;
   d.message=codes.includes(402)?'NanoGPT rejected the request for insufficient credit. Review the retained receipt and account balance; automatic retry is forbidden.':codes.includes(429)?'NanoGPT quota or rate limit rejected the request. Review the retained receipt and quota; automatic retry is forbidden.':safe;
   if(d.active)d.active.leaseUntil=new Date(0).toISOString();await writeState(tx,sid,d);
   await setReviewedChapterWindowState(tx,{storyId:sid,number:m.number,manifestId:m.id,state:uncertain?'uncertain_dispatch':'retryable_failure',
    failure:{code:uncertain?'runner_uncertain_dispatch':'runner_held',message:d.message,retryable:false}});
  });
 }
 return getChapterRunnerStatus(db,sid,gate);
}
function reviewedCommit(commit:{projection:Record<string,any>;node:Record<string,any>;at:string}) {
 return {chapterId:String(commit.projection.id),committedAt:commit.at,chapterServerVersion:Number(commit.projection.server_version),
  projectionFingerprint:String(commit.projection.metadata?.projectionFingerprint??''),memoryNodeId:String(commit.node.id)};
}
