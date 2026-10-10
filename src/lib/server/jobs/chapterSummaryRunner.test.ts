import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import postgres,{type Sql} from 'postgres';
import {randomUUID,createHash} from 'node:crypto';
import {getChapterRunnerStatus,configureChapterRunner,tickChapterRunner,verifyChapterEndpoint,authorizeChapterReplacement,reconcileCommittedChapterRunner,reconcileBackfilledChapterRunner,type ChapterRunnerDependencies} from './chapterSummaryRunner';
import {planSummaryRecovery,readRecoveryRun,recoveryHash,reviewRecoveryDraft,commitRecoveryDraft,importRecoveryDraft,RECOVERY_PROVIDER} from './summaryRecovery';
import {RECOVERY_ROUTE,type ChapterRunnerApproval} from '$lib/contracts/chapterRunner';
import type {ServerGenerationOptions,ServerGenerationResult} from '$lib/server/turn/provider';
import {sourceEvidenceCatalog} from './summaryEvidenceReferences';
const url=process.env.RECOVERY_TEST_DATABASE_URL,tests=url?describe:describe.skip;
let db:Sql;
beforeAll(()=>{if(!url)return;const u=new URL(url);if(u.hostname!=='127.0.0.1'||u.port!=='5433'||!/^\/mythengine_summary_repair_recovery_\d+$/.test(u.pathname))throw Error('Disposable DB required');
 db=postgres(url,{max:4,prepare:false,onnotice:()=>{}});vi.stubGlobal('fetch',()=>{throw Error('Network forbidden');});});
afterAll(async()=>{if(db)await db.end();vi.unstubAllGlobals();});
const profile={providerType:'nanogpt',baseUrl:'https://nano-gpt.com/api/v1',apiKey:'fixture-not-a-key'} as ServerGenerationOptions['profile'];
async function addTurns(sid:string,start:number,count:number,long=false){for(let i=start;i<start+count;i++){
 await db`insert into story_entries(id,story_id,type,content,position) values(${sid+'_p'+i},${sid},'user_action','Ask the envoy',${i*2+1})`;
 await db`insert into story_entries(id,story_id,type,content,position,parent_id) values(${sid+'_n'+i},${sid},'narration',${'The envoy reports a rumor. '+(long?'Reported recollection. '.repeat(180):'')},${i*2+2},${sid+'_p'+i})`;
}}
async function fixture(turns=20,long=false){const sid='chapter_runner_'+randomUUID(),shelf='shelf_'+sid;
 await db`insert into shelves(id,name,slug) values(${shelf},'Runner fixture',${shelf})`;
 await db`insert into stories(id,shelf_id,title) values(${sid},${shelf},'Runner fixture')`;
 await db`insert into entities(id,story_id,type,name,state) values(${sid+'_npc'},${sid},'character','Envoy','{"identity":"preserved"}')`;
 await db`insert into factions(id,story_id,name,resources) values(${sid+'_faction'},${sid},'Council','{"wealth":12}')`;
 await db`insert into backend_jobs(id,project_id,story_id,type,status) values(${sid+'_old'},${shelf},${sid},'summarize_chapter','queued')`;
 await db`insert into backend_jobs(id,project_id,story_id,type,status,locked_at,locked_by) values(${sid+'_stale'},${shelf},${sid},'extract_turn_state','running','2026-10-05T00:00:00Z','abandoned')`;
 await addTurns(sid,0,turns,long);
 const gate={enabled:true,storyId:sid},now=new Date('2026-10-06T21:30:00Z');
 const approval:ChapterRunnerApproval={confirmed:true,model:RECOVERY_ROUTE.model,endpoint:RECOVERY_ROUTE.endpoint,afterPosition:-1,maxChapters:1,totalUsd:0.033,minIntervalMinutes:60,expiresAt:'2026-10-10T00:00:00Z'};
 return {sid,gate,now,approval};
}
function mock(sid:string,mode='success'){
 let calls=0;const catalog=vi.fn(async()=>{}),profileFn=vi.fn(async()=>profile);
 const generate=vi.fn(async(o:ServerGenerationOptions):Promise<ServerGenerationResult>=>{
  const m=await planSummaryRecovery(db,sid,'chapter'),body={model:m.route.model,max_tokens:12000,include_usage:true,provider:structuredClone(RECOVERY_PROVIDER)},serializedBody=JSON.stringify(body),requestHash=createHash('sha256').update(serializedBody).digest('hex');
  await o.onBeforeRequest!({body,serializedBody,inputTokens:1000,reservedOutputTokens:12000,contextWindowTokens:1048576});calls++;
  if(mode==='timeout')throw Error('Timeout after dispatch');
  const ids=[...o.prompt.matchAll(/^SOURCE (.+)$/gm)].map(x=>x[1]),sources=ids.length?m.sources.filter(s=>ids.includes(s.id)):m.sources;
  const accounts=sources.map(s=>({sourceId:s.id,evidenceRefs:Object.keys(s.evidence).map((_,i)=>sourceEvidenceCatalog(s).find(e=>e.recordIndex===i)!.ref)}));if(mode==='partial')accounts.pop();
  const text=JSON.stringify({accounts}),usage={inputTokens:1000,outputTokens:500,providerCostUsd:0.00028,requestTokens:1000,responseTokens:500,totalTokens:1500,cachedInputTokens:0,cacheWriteTokens:0,reasoningTokens:0,estimatedCostUsd:0.00028};
  const receipt={attemptId:randomUUID(),providerRequestId:'fixture-request',requestHash,attempt:0,startedAt:new Date().toISOString(),model:m.route.model,endpoint:'https://nano-gpt.com/api/v1/chat/completions',status:'success' as const,statusCode:200,durationMs:1,promptChars:o.prompt.length,responseChars:text.length,finishReason:'stop',usage,error:null};
  await o.onAttempt!(receipt);return {text,model:m.route.model,endpoint:receipt.endpoint,finishReason:'stop',durationMs:1,promptChars:o.prompt.length,responseChars:text.length,usage,attempts:[receipt]};
 });
 return {generate,catalog,profileFn,get calls(){return calls;},deps(now:Date):ChapterRunnerDependencies{return {profile:profileFn,generate,verifyEndpoint:catalog,now:()=>now};}};
}
async function protectedHash(){const result:Record<string,unknown>={};for(const table of ['stories','story_entries','entities','factions','backend_jobs','story_threads','story_events','agreements','canonical_content','canonical_content_history','arcs','sagas','llm_service_settings']){
 result[table]=await db.unsafe(`select ${table==='stories'?"to_jsonb(t)-'server_version' as row":'*'} from ${table} t order by ${table==='stories'?'t.id':'1'}`);
 }return recoveryHash(result);}
tests('isolated chapter-only runner',()=>{
 it('refuses altered prior receipts and exhausted cumulative execution limits without a new dispatch',async()=>{
  const f=await fixture(),old=mock(f.sid,'timeout');await configureChapterRunner(db,f.sid,f.gate,{...f.approval,maxChapters:10,totalUsd:0.31},f.now);await tickChapterRunner(db,f.sid,f.gate,old.deps(f.now));
  const [state]=await db`select document from chapter_summary_runners where story_id=${f.sid}`,original=state.document.active.manifest,prior=await readRecoveryRun(db,original);
  const a={priorManifestId:original.id,priorDocumentHash:recoveryHash(prior),approvedBy:'fixture-approved',approvedAt:f.now.toISOString(),number:original.number,start:original.startPosition,end:original.endPosition,calls:4 as const,inputTokens:153697 as const,outputTokens:48000 as const,usd:0.043 as const};
  const backup=structuredClone(state.document);state.document.reservations.push(...Array.from({length:27},(_,i)=>({manifestId:'other',stage:'stage'+i,usd:0,inputTokens:0,outputTokens:0,requestHash:'fixture'+i})));
  await db`update chapter_summary_runners set document=${db.json(state.document)} where story_id=${f.sid}`;await expect(authorizeChapterReplacement(db,f.sid,f.gate,a,f.now)).rejects.toThrow('Budget');
  await db`update chapter_summary_runners set document=${db.json(backup)} where story_id=${f.sid}`;await authorizeChapterReplacement(db,f.sid,f.gate,a,f.now);
  await db`update summary_recovery_runs set document=jsonb_set(document,'{attempts,0,requestHash}','"altered"'::jsonb) where id=${original.id}`;
  const fresh=mock(f.sid);const status=await tickChapterRunner(db,f.sid,f.gate,fresh.deps(f.now));expect(status.phase).toBe('held');expect(fresh.calls).toBe(0);
 });
 it.each(['success','timeout'])('explicit replacement counts the old call and allocation, preserves its receipt, and prevents another recovery after %s',async mode=>{
  const f=await fixture(20,true),old=mock(f.sid,'timeout'),approval={...f.approval,maxChapters:10,totalUsd:0.31};
  await configureChapterRunner(db,f.sid,f.gate,approval,f.now);await tickChapterRunner(db,f.sid,f.gate,old.deps(f.now));
  const [saved]=await db`select document from chapter_summary_runners where story_id=${f.sid}`;
  const original=saved.document.active.manifest,prior=await readRecoveryRun(db,original),priorHash=recoveryHash(prior);
  const a={priorManifestId:original.id,priorDocumentHash:priorHash,approvedBy:'fixture-exact-approval',approvedAt:f.now.toISOString(),number:original.number,start:original.startPosition,end:original.endPosition,calls:4 as const,inputTokens:153697 as const,outputTokens:48000 as const,usd:0.043 as const};
  await expect(authorizeChapterReplacement(db,f.sid,f.gate,{...a,priorDocumentHash:'wrong'},f.now)).rejects.toThrow('differs');
  const authorized=await authorizeChapterReplacement(db,f.sid,f.gate,a,f.now);expect(authorized.reservedUsd).toBe(0.043);expect(authorized.reservedCalls).toBe(1);
  await expect(authorizeChapterReplacement(db,f.sid,f.gate,a,f.now)).rejects.toThrow('replacement');
  const replacement=mock(f.sid,mode),status=await tickChapterRunner(db,f.sid,f.gate,replacement.deps(f.now));
  expect(recoveryHash(await readRecoveryRun(db,original))).toBe(priorHash);
  expect(status.reservedCalls).toBe(mode==='success'?3:2);expect(status.reservedUsd).toBe(0.043);expect(status.completedChapters).toBe(mode==='success'?1:0);
  expect(status.phase).toBe(mode==='success'?'waiting':'held');expect(replacement.calls).toBe(mode==='success'?2:1);
  expect(replacement.generate.mock.calls[0][0].profile.baseUrl).toBe(RECOVERY_ROUTE.baseUrl);expect(replacement.generate.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(180000);
  await tickChapterRunner(db,f.sid,f.gate,replacement.deps(f.now));expect(replacement.calls).toBe(mode==='success'?2:1);
 });
 it('requires explicit story gate/approval and leaves paused work, old queue and stale locks alone',async()=>{
  const f=await fixture(),m=mock(f.sid),before=await protectedHash();
  expect((await getChapterRunnerStatus(db,f.sid,f.gate)).enabled).toBe(false);
  await tickChapterRunner(db,f.sid,f.gate,m.deps(f.now));expect(m.calls).toBe(0);expect(await protectedHash()).toBe(before);
  await expect(configureChapterRunner(db,f.sid,{enabled:false,storyId:f.sid},f.approval,f.now)).rejects.toThrow('gate');
  await expect(configureChapterRunner(db,f.sid,{enabled:true,storyId:'other'},f.approval,f.now)).rejects.toThrow('gate');
  await expect(configureChapterRunner(db,f.sid,f.gate,{...f.approval,confirmed:false},f.now)).rejects.toThrow();
  await expect(configureChapterRunner(db,f.sid,f.gate,{...f.approval,afterPosition:0},f.now)).rejects.toThrow('boundary');
  expect(m.profileFn).not.toHaveBeenCalled();
 });
 it('waits through 19 turns, selects the twentieth completed pair and publishes one visible summary without forbidden effects',async()=>{
  const f=await fixture(19),m=mock(f.sid),before=await protectedHash();
  await configureChapterRunner(db,f.sid,f.gate,f.approval,f.now);let s=await tickChapterRunner(db,f.sid,f.gate,m.deps(f.now));
  expect(s.completedTurns).toBe(19);expect(s.nextRange).toBeNull();expect(m.calls).toBe(0);expect(await protectedHash()).toBe(before);
  await addTurns(f.sid,19,1);const protectedBefore=await protectedHash();
  s=await tickChapterRunner(db,f.sid,f.gate,m.deps(f.now));expect(s.phase).toBe('complete');expect(s.enabled).toBe(false);expect(s.completedChapters).toBe(1);expect(m.calls).toBe(1);
  expect(await protectedHash()).toBe(protectedBefore);
  const [story]=await db`select server_version from stories where id=${f.sid}`;expect(story.server_version).toBe(2);
  expect((await db`select source_entry_ids,server_version from chapters where story_id=${f.sid}`)[0]).toMatchObject({server_version:2});
  expect((await db`select id from chapters where story_id=${f.sid} and server_version>1`)).toHaveLength(1);
  expect((await db`select id from memory_nodes where story_id=${f.sid} and server_version>1`)).toHaveLength(1);
  await tickChapterRunner(db,f.sid,f.gate,m.deps(f.now));expect(m.calls).toBe(1);
 });
 it('concurrent ticks and process restart cannot duplicate dispatch or commit',async()=>{
  const f=await fixture(),m=mock(f.sid);await configureChapterRunner(db,f.sid,f.gate,f.approval,f.now);
  await Promise.all([tickChapterRunner(db,f.sid,f.gate,m.deps(f.now)),tickChapterRunner(db,f.sid,f.gate,m.deps(f.now))]);expect(m.calls).toBe(1);
  await tickChapterRunner(db,f.sid,f.gate,m.deps(new Date(f.now.getTime()+86400000)));expect(m.calls).toBe(1);
  expect((await db`select id from chapters where story_id=${f.sid}`)).toHaveLength(1);
 });
 it.each(['partial','timeout'])('retains %s attempt and refuses replay after lease expiry/restart',async mode=>{
  const f=await fixture(),m=mock(f.sid,mode),before=await protectedHash();await configureChapterRunner(db,f.sid,f.gate,f.approval,f.now);
  const status=await tickChapterRunner(db,f.sid,f.gate,m.deps(f.now));expect(status.phase).toBe('held');expect(status.attempts[0].status).toBe('blocked');expect(m.calls).toBe(1);
  await tickChapterRunner(db,f.sid,f.gate,m.deps(new Date(f.now.getTime()+86400000)));expect(m.calls).toBe(1);expect(await protectedHash()).toBe(before);
  await expect(configureChapterRunner(db,f.sid,f.gate,f.approval,f.now)).rejects.toThrow('held');
 });
 it('pause during an in-flight response retains the validated draft and resumes publishing without another request',async()=>{
  const f=await fixture(),m=mock(f.sid),deps=m.deps(f.now),generate=deps.generate!;
  deps.generate=async o=>{const r=await generate(o);await configureChapterRunner(db,f.sid,f.gate);return r;};
  await configureChapterRunner(db,f.sid,f.gate,f.approval,f.now);let s=await tickChapterRunner(db,f.sid,f.gate,deps);
  expect(s.phase).toBe('paused');expect(m.calls).toBe(1);expect((await db`select id from chapters where story_id=${f.sid}`)).toHaveLength(0);
  await configureChapterRunner(db,f.sid,f.gate,f.approval,f.now);s=await tickChapterRunner(db,f.sid,f.gate,m.deps(f.now));expect(s.completedChapters).toBe(1);expect(m.calls).toBe(1);
 });
 it('enforces aggregate budget, expiry and configurable interval across future windows',async()=>{
  const f=await fixture(40),m=mock(f.sid),approval={...f.approval,maxChapters:3,totalUsd:0.066,minIntervalMinutes:90};
  await configureChapterRunner(db,f.sid,f.gate,approval,f.now);await tickChapterRunner(db,f.sid,f.gate,m.deps(f.now));expect(m.calls).toBe(1);
  await tickChapterRunner(db,f.sid,f.gate,m.deps(new Date(f.now.getTime()+60*60000)));expect(m.calls).toBe(1);
  const s=await tickChapterRunner(db,f.sid,f.gate,m.deps(new Date(f.now.getTime()+91*60000)));expect(m.calls).toBe(2);expect(s.reservedUsd).toBe(0.066);expect(s.enabled).toBe(false);
  const expired=await fixture(),x=mock(expired.sid);await configureChapterRunner(db,expired.sid,expired.gate,expired.approval,expired.now);
  expect((await tickChapterRunner(db,expired.sid,expired.gate,x.deps(new Date('2026-10-11T00:00:00Z')))).enabled).toBe(false);expect(x.calls).toBe(0);
 });
 it('held endpoint/capacity failures dispatch nothing and expose an actionable status',async()=>{
  const f=await fixture(),m=mock(f.sid);await configureChapterRunner(db,f.sid,f.gate,f.approval,f.now);
  const deps=m.deps(f.now);deps.verifyEndpoint=async()=>{throw Error('Pinned provider metadata is unavailable. No inference was sent.');};
  const s=await tickChapterRunner(db,f.sid,f.gate,deps);expect(s.phase).toBe('held');expect(s.message).toContain('Pinned');expect(m.calls).toBe(0);expect(m.profileFn).not.toHaveBeenCalled();
 });
 it('a dead owner with a reserved/uncertain attempt is held, while saved complete drafts survive restart',async()=>{
  const f=await fixture(),m=mock(f.sid);await configureChapterRunner(db,f.sid,f.gate,f.approval,f.now);
  const manifest=await planSummaryRecovery(db,f.sid,'chapter');
  const [row]=await db`select document from chapter_summary_runners where story_id=${f.sid}`;
  row.document.active={manifest,owner:'dead',leaseUntil:'2026-10-06T21:00:00Z'};row.document.allocations=[{manifestId:manifest.id,usd:0.033}];row.document.phase='generating';
  await db`update chapter_summary_runners set document=${db.json(row.document)} where story_id=${f.sid}`;
  await db`insert into summary_recovery_runs(id,story_id,document) values(${manifest.id},${f.sid},${db.json({manifest,attempts:[{stage:'sources-1',status:'reserved',reservedInput:1000,reservedOutput:12000,reservedUsd:0.004,requestHash:'unknown'}]})})`;
  const s=await tickChapterRunner(db,f.sid,f.gate,m.deps(f.now));expect(s.phase).toBe('held');expect(s.message).toContain('uncertain');expect(m.calls).toBe(0);
 });
});
tests('reviewed held chapter reconciliation',()=>{
 it.each(['past-due','recent-paid','stale-hash','changed-source','changed-node','uncertain'])('settles only exact reviewed commits and preserves accounting for %s',async mode=>{
  const f=await fixture(40),m=mock(f.sid),a={...f.approval,maxChapters:2,totalUsd:0.066};await configureChapterRunner(db,f.sid,f.gate,a,f.now);
  const deps=m.deps(f.now),originalGenerate=deps.generate!;deps.generate=async o=>{const r=await originalGenerate(o);await configureChapterRunner(db,f.sid,f.gate);return r;};await tickChapterRunner(db,f.sid,f.gate,deps);
  const [state]=await db`select document from chapter_summary_runners where story_id=${f.sid}`,manifest=state.document.active.manifest,[row]=await db`select document from summary_recovery_runs where id=${manifest.id}`;
  row.document.draftOrigin={kind:'external',approvedBy:'Fixture local source review',importedAt:f.now.toISOString()};row.document.attempts[0].receipt.startedAt=new Date(f.now.getTime()-(mode==='recent-paid'?0:2*60*60000)).toISOString();
  await db`update summary_recovery_runs set document=${db.json(row.document)} where id=${manifest.id}`;
  await reviewRecoveryDraft(db,manifest,row.document.draftHash,'Fixture source review',{quotesChecked:true,uncertaintyChecked:true,chronologyChecked:true});const committed=await commitRecoveryDraft(db,manifest,row.document.draftHash);
  state.document.phase='held';state.document.enabled=false;await db`update chapter_summary_runners set document=${db.json(state.document)} where story_id=${f.sid}`;
  const [savedRun]=await db`select document from summary_recovery_runs where id=${manifest.id}`,[held]=await db`select document from chapter_summary_runners where story_id=${f.sid}`;
  const approval={manifestId:manifest.id,draftHash:row.document.draftHash,runnerHash:recoveryHash(held.document),runHash:recoveryHash(savedRun.document),approvedBy:'Fixture explicit recovery approval'};
  if(mode==='stale-hash')approval.runHash='stale';if(mode==='changed-source')await db`update story_entries set content=content||' altered' where story_id=${f.sid} and position=1`;
  if(mode==='changed-node')await db`update memory_nodes set content=content||' altered' where id=${committed.node.id}`;
  if(mode==='uncertain'){savedRun.document.attempts[0].status='blocked';await db`update summary_recovery_runs set document=${db.json(savedRun.document)} where id=${manifest.id}`;approval.runHash=recoveryHash(savedRun.document);}
  const protectedBefore=await protectedHash();
  if(['past-due','recent-paid'].includes(mode)){
   const status=await reconcileCommittedChapterRunner(db,f.sid,f.gate,approval,f.now);expect(status.enabled).toBe(true);expect(status.activeManifestId).toBeNull();expect(status.completedChapters).toBe(1);expect(status.reservedCalls).toBe(1);expect(status.reservedUsd).toBe(0.033);expect(status.nextRange?.number).toBe(2);
   expect(recoveryHash((await db`select document from summary_recovery_runs where id=${manifest.id}`)[0].document)).toBe(approval.runHash);expect(await protectedHash()).toBe(protectedBefore);
   await tickChapterRunner(db,f.sid,f.gate,m.deps(f.now));expect(m.calls).toBe(mode==='recent-paid'?1:2);
  }else {await expect(reconcileCommittedChapterRunner(db,f.sid,f.gate,approval,f.now)).rejects.toThrow();expect(recoveryHash((await db`select document from chapter_summary_runners where story_id=${f.sid}`)[0].document)).toBe(approval.runnerHash);expect(await protectedHash()).toBe(protectedBefore);}
 });
});
tests('reviewed backfill supersedes a failed chapter without replay',()=>{
 it.each(['valid','stale','altered-source','foreign-story'])('preserves paid receipts and requires intact coverage: %s',async mode=>{
  const f=await fixture(40),failed=mock(f.sid,'partial');
  await configureChapterRunner(db,f.sid,f.gate,{...f.approval,maxChapters:3,totalUsd:0.1},f.now);
  await tickChapterRunner(db,f.sid,f.gate,failed.deps(f.now));
  const [row]=await db`select document from chapter_summary_runners where story_id=${f.sid}`;
  const prior=await readRecoveryRun(db,row.document.active.manifest),priorHash=recoveryHash(prior);
  const m=await planSummaryRecovery(db,f.sid,'chapter',{start:0,end:80},{snapshotEndPosition:80,canonEntityIds:[]});
  const draft={title:'Reviewed catch-up',narrative:'The envoy answered the forty recorded questions. Each response remained an uncertain attributed report, not an established change to the world.',accounts:m.sources.map(s=>({sourceId:s.id,summary:'The envoy reports an uncertain rumor in response to the player question.',evidence:[{sourceId:s.id,quote:'The envoy reports a rumor.',status:'reported' as const,speaker:'Envoy'}]}))};
  const hash=recoveryHash(draft);await importRecoveryDraft(db,m,draft,hash,'Fixture authorized review');
  await reviewRecoveryDraft(db,m,hash,'Fixture review',{quotesChecked:true,uncertaintyChecked:true,chronologyChecked:true});await commitRecoveryDraft(db,m,hash);
  const a={runnerHash:recoveryHash(row.document),priorRunHash:priorHash,commits:[{manifest:m,draftHash:hash}],reviewedBy:'Fixture catch-up review'};
  if(mode==='stale')a.runnerHash='stale';
  if(mode==='altered-source')await db`update story_entries set content=content||' changed' where story_id=${f.sid} and position=1`;
  if(mode==='foreign-story')a.commits[0].manifest={...m,storyId:'other'};
  if(mode==='valid'){
   expect((await reconcileBackfilledChapterRunner(db,f.sid,a,f.now)).enabled).toBe(false);
   const status=await getChapterRunnerStatus(db,f.sid,f.gate);expect(status.activeManifestId).toBeNull();expect(status.boundary.endPosition).toBe(80);expect(status.reservedCalls).toBe(1);expect(status.reservedUsd).toBe(0.033);
   await tickChapterRunner(db,f.sid,f.gate,failed.deps(f.now));expect(failed.calls).toBe(1);
  }else await expect(reconcileBackfilledChapterRunner(db,f.sid,a,f.now)).rejects.toThrow();
  expect(recoveryHash(await readRecoveryRun(db,row.document.active.manifest))).toBe(priorHash);
 });
});

describe('public pinned endpoint preflight',()=>{
 it('checks exact model/endpoint, rejects unavailable or higher priced routes before inference',async()=>{
  const e={provider:RECOVERY_ROUTE.endpoint as string,available:true,quantization:'fp8',effectivePricing:{currency:'USD',unit:'per_1k_tokens',is_fresh:true},pricing:{inputPer1kTokens:0.000147,outputPer1kTokens:0.000294,cacheWriteInputPer1kTokens:0}};
  const fetch=vi.fn(async(_url:string)=>new Response(JSON.stringify(_url.includes('?detailed=')?{data:[{id:RECOVERY_ROUTE.model}]}:{canonicalId:RECOVERY_ROUTE.model,supportsProviderSelection:true,providers:[e]})));vi.stubGlobal('fetch',fetch);await verifyChapterEndpoint();
  expect(fetch.mock.calls[0][0]).toBe('https://api.nano-gpt.com/api/v1/models?detailed=true');expect(fetch.mock.calls[1][0]).toBe('https://nano-gpt.com/api/models/xiaomi%2Fmimo-v2.6-flash/providers');
  e.pricing.inputPer1kTokens=0.00015;await expect(verifyChapterEndpoint()).rejects.toThrow('prices');e.pricing.inputPer1kTokens=0.000147;e.provider='other';await expect(verifyChapterEndpoint()).rejects.toThrow('Pinned');
  e.provider=RECOVERY_ROUTE.endpoint;e.pricing.cacheWriteInputPer1kTokens=0.001;await expect(verifyChapterEndpoint()).rejects.toThrow('Pinned');
  e.pricing.cacheWriteInputPer1kTokens=0;e.effectivePricing.currency='NANO';await expect(verifyChapterEndpoint()).rejects.toThrow('Pinned');
 });
});
