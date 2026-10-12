import fs from 'node:fs';
import {expect,test,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {getDb,closeDb} from '$lib/server/db/client';
import {resolveServiceGeneration} from '$lib/server/engine/llmSettings';
import {generateServerTextWithMetrics} from '$lib/server/turn/provider';
import {handoffFixture} from '$lib/server/factions/fixtures/handoffQualification';
import {mythPrototypeAdapters} from '../../../../experiments/pi-roleplay/src/adapters';
import {runPiComparisonArm,normalizedWireMessages,type WireText} from '../../../../experiments/pi-roleplay/src/comparisonArm';
const prepare=process.env.MYTHENGINE_PREPARE_PI_COMPARISON==='1'?test:test.skip;
const live=process.env.MYTHENGINE_APPROVED_PI_FOUR==='FOUR_CALLS_USD_0_10'?test:test.skip;
const proposalPath='.codex-run/pi-live-comparison-proposal.json',ledgerPath='.codex-run/pi-live-comparison-ledger.json';
const hash=(body:unknown)=>createHash('sha256').update(JSON.stringify(body)).digest('hex');
async function current(){
 const config=JSON.parse(fs.readFileSync('mythengine.config.json','utf8'));
 expect(config).toMatchObject({port:5174,turnJobs:false,testLocalInferenceOnly:true,isolatedTestCopy:true});
 expect((await getDb().execute(sql.raw('select current_database() as name')))[0].name).toBe('mythengine_faction_copy_20261001');
 const gm=await resolveServiceGeneration('narrative');
 expect(gm.setting).toMatchObject({providerType:'openrouter',model:'z-ai/glm-5.3-flash',reasoningEffort:'high',maxTokens:8192});expect(gm.profile?.apiKey).toBeTruthy();
 const price=JSON.parse(fs.readFileSync('.codex-run/pi-live-comparison-pricing.json','utf8'));expect(price.aggregateConservativeUsd).toBeLessThanOrEqual(.1);
 return {config,gm,price};
}
function scenes(){
 const f=handoffFixture(),prior=JSON.parse(fs.readFileSync('.codex-run/faction-handoff-six-live.json','utf8'));
 const attempt=structuredClone(prior.outcome.stages[0].attempt);attempt.reason=null;(f.ctx.story.metadata as any).factionWorkflow.attempts=[attempt];
 const action='I ask Maera what relief she has in mind. I have accepted nothing.';
 const adapted=mythPrototypeAdapters({ctx:f.ctx,actorId:f.actor,playerId:'player_elian',packet:f.packet,attempt,playerAction:action});
 const a={id:'relief_conversation',action,snapshot:adapted.snapshot};
 const b={id:'material_bandages',action,snapshot:{...structuredClone(adapted.snapshot),version:adapted.snapshot.version+1,dynamicTail:adapted.snapshot.dynamicTail+'\nNew canonical observation: Rowan requested bandages; no consent to grain.'}};
 return {a,b};
}
function legacyOptions(gm:Awaited<ReturnType<typeof current>>['gm'],scene:ReturnType<typeof scenes>['a']){
 return {profile:gm.profile!,model:gm.generation.model!,temperature:gm.generation.temperature??1,reasoningEffort:'high',maxTokens:8192,providerOutputLimit:false,maxRetries:0,timeoutMs:60000,
  system:scene.snapshot.system,systemDynamic:scene.snapshot.dynamicTail,messages:scene.snapshot.history.map(message=>({role:message.role as 'user'|'assistant',content:typeof message.content==='string'?message.content:message.content.filter(block=>block.type==='text').map(block=>block.text).join('')})),
  prompt:scene.action,contextAfterDialogue:true,cache:{key:'pi-comparison-'+scene.id},onTextDelta:async(_chunk:string)=>{}};
}
async function bodyOf(input:RequestInfo|URL,init?:RequestInit){return JSON.parse(String(init?.body??(input instanceof Request?await input.clone().text():'')));}
function syntheticResponse(){return new Response('data: '+JSON.stringify({id:'synthetic-preparation-only',model:'z-ai/glm-5.3-flash',choices:[{index:0,delta:{content:'Synthetic prepared narration.'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:5,total_tokens:105,cost:0}})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});}
prepare('freeze four matched request bodies with real adapters and no provider HTTP',async()=>{
 if(fs.existsSync(ledgerPath)||fs.existsSync(proposalPath))throw Error('Existing proposal/ledger; preserve approved inputs.');
 const policy=process.env.MYTHENGINE_TEST_LOCAL_ONLY;
 try{
  const {gm,price}=await current(),{a,b}=scenes();process.env.MYTHENGINE_TEST_LOCAL_ONLY='false';
  let captured:any;const mock=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{captured=await bodyOf(input,init);return syntheticResponse();});vi.stubGlobal('fetch',mock);
  const rows:Array<{id:string;scene:string;arm:string;body:any;wire:WireText[];bodyHash:string;bytesIncludingAllowance:number}>=[];
  for(const scene of [a,b]){
   await generateServerTextWithMetrics(legacyOptions(gm,scene));const legacy=structuredClone(captured),wire=normalizedWireMessages(legacy);
   await runPiComparisonArm({wire,apiKey:gm.profile!.apiKey!,temperature:gm.generation.temperature??1,sessionId:'pi-comparison-'+scene.id});
   const pi=structuredClone(captured);expect(normalizedWireMessages(pi)).toEqual(wire);
   for(const [arm,body] of [['legacy',legacy],['pi',pi]] as const){
    expect(body.reasoning).toEqual({effort:'high'});expect(body.model).toBe('z-ai/glm-5.3-flash');expect(body.tools??[]).toEqual([]);expect(body.max_tokens??body.max_completion_tokens).toBe(8192);
    const size=Buffer.byteLength(JSON.stringify(body),'utf8')+512;expect(size).toBeLessThanOrEqual(20000);
    rows.push({id:scene.id+'_'+arm,scene:scene.id,arm,body,wire,bodyHash:hash(body),bytesIncludingAllowance:size});
   }
  }
  const order=['relief_conversation_legacy','relief_conversation_pi','material_bandages_pi','material_bandages_legacy'];
  const proposal={preparedAt:new Date().toISOString(),authorization:'User yes please: four calls,zero retries,max0.10USD,synthetic COPY only',model:'z-ai/glm-5.3-flash',provider:'openrouter',reasoning:'high',temperature:gm.generation.temperature??1,requests:order.map(id=>rows.find(row=>row.id===id)),requestCap:4,retries:0,budgetUsd:.1,price,providerHttpRequests:0,canonWrites:0,
   scope:'Tool-free final narration only; actual legacy transport versus Pi Agent+pi-ai. Identical normalized messages/model/reasoning/temperature; no tool/extractor/Jev/background calls.'};
  fs.writeFileSync(proposalPath,JSON.stringify(proposal,null,2)+'\n');expect(mock).toHaveBeenCalledTimes(4);
 }finally{vi.unstubAllGlobals();if(policy===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=policy;await closeDb();}
},30000);
const canon=()=>getDb().execute(sql.raw('select (select count(*) from stories)::int as stories,(select coalesce(sum(server_version),0)::text from stories) as story_versions,(select count(*) from story_events)::int as events,(select coalesce(sum(server_version),0)::text from story_events) as event_versions,(select count(*) from faction_resources)::int as resources,(select coalesce(sum(amount),0)::text from faction_resources) as resource_amount,(select count(*) from agreements)::int as agreements'));
live('approved one-shot four live tool-free narration comparisons, no retries, total<=0.10USD',async()=>{
 if(fs.existsSync(ledgerPath))throw Error('Existing one-shot live ledger: never repeat.');
 const policy=process.env.MYTHENGINE_TEST_LOCAL_ONLY,actualFetch=globalThis.fetch;
 const ledger:any={startedAt:new Date().toISOString(),authorization:'User yes please forwarded2026-10-02: max4livechatrequests/no retries/0.10USDtotal',calls:[],results:[],requestCap:4,retries:0,budgetUsd:.1,campaignWrites:0,backgroundPaused:true};
 const save=()=>fs.writeFileSync(ledgerPath,JSON.stringify(ledger,null,2)+'\n');let nativeReads:Promise<void>[]=[];
 try{
  const {gm,price}=await current();expect(Date.now()-Date.parse(price.fetchedAt)).toBeLessThan(900000);
  const proposal=JSON.parse(fs.readFileSync(proposalPath,'utf8'));expect(proposal.requests.length).toBe(4);expect(proposal.temperature).toBe(gm.generation.temperature??1);
  expect(proposal.price.pricing).toEqual(price.pricing);ledger.pricing=price;
  const copy=await actualFetch('http://127.0.0.1:5174/api/app/status').then(response=>response.json()),original=await actualFetch('http://127.0.0.1:5173/api/app/status').then(response=>response.json());
  expect(copy.config.turnJobsEnabled).toBe(false);expect(copy.jobs.running).toBe(0);
  ledger.before={copyPid:copy.runtime.pid,copyBuild:copy.build,originalPid:original.runtime.pid,originalBuild:original.build,canon:await canon(),queued:copy.jobs.queued};save();
  let active:any;const seen=new Set<string>();process.env.MYTHENGINE_TEST_LOCAL_ONLY='false';
  vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
   const endpoint=input instanceof Request?input.url:String(input),body=await bodyOf(input,init);
   if(endpoint!=='https://openrouter.ai/api/v1/chat/completions'||!active||seen.has(active.id)||ledger.calls.length>=4||hash(body)!==active.bodyHash)throw Error('Unapproved endpoint/retry/body; stopped before network.');
   if(body.model!==proposal.model||body.reasoning?.effort!=='high'||(body.max_tokens??body.max_completion_tokens)!==8192||Buffer.byteLength(JSON.stringify(body),'utf8')+512>20000)throw Error('Request bounds mismatch.');
   const reserved=(ledger.calls.length+1)*price.perCallConservativeUsd;if(reserved>.1)throw Error('Budget boundary.');
   seen.add(active.id);const call:any={id:active.id,scene:active.scene,arm:active.arm,requestedAt:new Date().toISOString(),bodyHash:hash(body),reservedUsd:price.perCallConservativeUsd};ledger.calls.push(call);ledger.reservedUsd=reserved;save();
   const response=await actualFetch(input,init);call.httpStatus=response.status;
   const read=response.clone().text().then(raw=>{let responseId,returnedModel,provider,usage;for(const line of raw.split('\n'))if(line.startsWith('data: ')&&line.slice(6)!=='[DONE]'){try{const chunk=JSON.parse(line.slice(6));responseId??=chunk.id;returnedModel??=chunk.model;provider??=chunk.provider;if(chunk.usage)usage=chunk.usage;}catch{/*non-JSON SSE terminal*/}}
    call.native={responseId,returnedModel,provider,usage};save();});nativeReads.push(read);return response;
  });
  const fixtures=scenes();
  for(const request of proposal.requests){
   active=request;const started=performance.now();let result:any;
   try{
    if(request.arm==='legacy'){
     const scene=request.scene==='relief_conversation'?fixtures.a:fixtures.b;
     const response=await generateServerTextWithMetrics(legacyOptions(gm,scene));result={text:response.text,finishReason:response.finishReason,returnedModel:response.model,durationMs:response.durationMs,timeToFirstTextMs:response.timeToFirstTokenMs,
      usage:{inputTokens:response.usage.inputTokens,outputTokens:response.usage.outputTokens,reasoningTokens:response.usage.reasoningTokens,cachedInputTokens:response.usage.cachedInputTokens,providerReportedCostUsd:response.usage.providerCostUsd},retryCount:response.retryCount??0};
    }else result=await runPiComparisonArm({wire:request.wire,apiKey:gm.profile!.apiKey!,temperature:proposal.temperature,sessionId:'pi-comparison-'+request.scene});
   }catch(error){result={errorType:error instanceof Error?error.name:'unknown',failed:true,durationMs:performance.now()-started};}
   await Promise.all(nativeReads);nativeReads=[];
   const call=ledger.calls.find((call:any)=>call.id===request.id);if(!call)throw Error('Arm stopped before network; no replacement call.');
   result.id=request.id;result.scene=request.scene;result.arm=request.arm;result.visibleCharacters=result.text?.length??0;
   result.privateMarkerLeaked=['UNSPOKEN_CIDER_MOTIVE','PRIVATE_RIVAL_PLAN','UNSHARED_MEMBER_SECRET','FORECAST_NOT_CANON'].some(marker=>result.text?.includes(marker));
   result.providerReportedCostUsd=call.native?.usage?.cost??result.usage?.providerReportedCostUsd??null;
   result.catalogUsageEstimateUsd=call.native?.usage?Number(call.native.usage.prompt_tokens??0)*Number(price.pricing.prompt)+Number(call.native.usage.completion_tokens??0)*Number(price.pricing.completion):null;
   ledger.results.push(result);ledger.reportedCostUsd=ledger.results.reduce((sum:number,row:any)=>sum+(row.providerReportedCostUsd??0),0);save();
   if((call.native?.usage?.completion_tokens??result.usage?.outputTokens??0)>8192||ledger.reportedCostUsd>.1)throw Error('Provider exceeded approved output/cost boundary; stop remaining calls.');
  }
  expect(ledger.calls.length).toBe(4);expect(ledger.reservedUsd).toBeLessThanOrEqual(.1);ledger.completedAt=new Date().toISOString();save();
 }catch(error){ledger.stoppedReason=error instanceof Error?error.message:'comparison_failed';save();throw error;}
 finally{
  vi.unstubAllGlobals();if(policy===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=policy;
  await Promise.allSettled(nativeReads);
  const copy=await actualFetch('http://127.0.0.1:5174/api/app/status').then(response=>response.json()),original=await actualFetch('http://127.0.0.1:5173/api/app/status').then(response=>response.json());
  ledger.after={copyPid:copy.runtime.pid,workerPaused:copy.config.turnJobsEnabled===false,cloudPaused:JSON.parse(fs.readFileSync('mythengine.config.json','utf8')).testLocalInferenceOnly===true,runningJobs:copy.jobs.running,queued:copy.jobs.queued,processPolicyRestored:process.env.MYTHENGINE_TEST_LOCAL_ONLY===policy,canon:await canon(),originalPid:original.runtime.pid,
   originalUnchanged:!ledger.before||original.runtime.pid===ledger.before.originalPid&&JSON.stringify(original.build)===JSON.stringify(ledger.before.originalBuild)};
  ledger.after.canonUnchanged=!ledger.before||JSON.stringify(ledger.before.canon)===JSON.stringify(ledger.after.canon);ledger.finishedAt=new Date().toISOString();if(ledger.before||ledger.calls.length)save();await closeDb();
 }
},300000);
