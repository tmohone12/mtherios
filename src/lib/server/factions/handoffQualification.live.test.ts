import fs from 'node:fs';
import {expect,test,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {getDb,closeDb} from '$lib/server/db/client';
import {resolveServiceGeneration} from '$lib/server/engine/llmSettings';
import {runHandoffQualification,handoffCaps,type HandoffProfiles} from './fixtures/handoffQualification';

const live=process.env.MYTHENGINE_APPROVED_HANDOFF==='SIX_REQUESTS_USD_0_10'?test:test.skip;
live('approved one-shot synthetic handoff, max six requests/ten cents/no retries',async()=>{
 const path='.codex-run/faction-handoff-six-live.json';
 if(fs.existsSync(path))throw Error('Approved one-shot ledger already exists: no repeated calls');
 const c=JSON.parse(fs.readFileSync('mythengine.config.json','utf8'));
 if(c.port!==5174||c.turnJobs!==false||c.testLocalInferenceOnly!==true||c.isolatedTestCopy!==true||new URL(c.databaseUrl).pathname!=='/mythengine_faction_copy_20261001')throw Error('Paused isolated COPY required');
 const proposal=JSON.parse(fs.readFileSync('.codex-run/faction-handoff-proposal.json','utf8')),prices=JSON.parse(fs.readFileSync('.codex-run/faction-handoff-pricing.json','utf8'));
 if(proposal.requestCap!==6||proposal.budgetUsd!==.1||prices.maximumRequestedTokenCostUsd>.1||Date.now()-Date.parse(prices.fetchedAt)>900000)throw Error('Fresh bounded approved pricing required');
 const actualFetch=globalThis.fetch,prior=process.env.MYTHENGINE_TEST_LOCAL_ONLY;
 const ledger:any={startedAt:new Date().toISOString(),authorization:'User yes at2026-10-02T20:06UTC: max6calls/0.10USD/no retries',requestCap:6,budgetUsd:.1,retries:0,concurrency:1,campaignWrites:0,inMemorySyntheticState:true,prices,calls:[],outcome:null,normalCloudPaused:true,workerPaused:true};
 const save=()=>fs.writeFileSync(path,JSON.stringify(ledger,null,2));
 let capture:{mockRestore:()=>void}|undefined;
 const canon=async()=>getDb().execute(sql.raw('select (select count(*) from stories)::int as stories,(select coalesce(sum(server_version),0)::text from stories) as story_versions,(select count(*) from story_events)::int as events,(select coalesce(sum(server_version),0)::text from story_events) as event_versions,(select count(*) from faction_resources)::int as resources,(select coalesce(sum(amount),0)::text from faction_resources) as resource_amount,(select count(*) from agreements)::int as agreements'));
 try{
  if((await getDb().execute(sql.raw('select current_database() as name')))[0].name!=='mythengine_faction_copy_20261001')throw Error('COPY DB required');
  const [background,decision,gm]=await Promise.all(['strategicWorldBrain','actorDecision','narrative'].map(name=>resolveServiceGeneration(name)));
  const services=[['strategicWorldBrain',background],['actorDecision',decision],['narrative',gm]] as const;
  for(const [name,service] of services){
   const saved=prices.services.find((row:any)=>row.service_id===name);
   if(!service.profile?.apiKey||service.profile.providerType!==saved.provider_type||service.generation.model!==saved.model)throw Error('Current model/key changed: preserve and reprice');
  }
  const profiles:HandoffProfiles={background:{profile:background.profile!,model:background.generation.model!,reasoningEffort:background.generation.reasoningEffort??null},decision:{profile:decision.profile!,model:decision.generation.model!},gm:{profile:gm.profile!,model:gm.generation.model!}};
  const copy=await(await actualFetch('http://127.0.0.1:5174/api/app/status')).json(),original=await(await actualFetch('http://127.0.0.1:5173/api/app/status')).json();
  if(copy.config.turnJobsEnabled!==false||copy.jobs.running!==0)throw Error('COPY background must remain paused');
  ledger.before={copyPid:copy.runtime.pid,originalPid:original.runtime.pid,originalBuild:original.build,canon:await canon(),queued:copy.jobs.queued};
  let stage='',reserved=0;const seen=new Set<string>();
  capture=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
   const isDecision=stage.startsWith('decision'),isGM=stage==='gm',body=JSON.parse(String(init?.body??'{}'));
   const endpoint=isDecision?'https://openrouter.ai/api/alpha/decisions':isGM?'https://openrouter.ai/api/v1/chat/completions':'https://nano-gpt.com/api/v1/chat/completions';
   if(String(input)!==endpoint||init?.method!=='POST'||ledger.calls.length>=6||seen.has(stage)||!['planner','decision','gardener','gm','planner_after_material','decision_after_material'].includes(stage))throw Error('Bounded endpoint/role/count/no-retry guard');
   const expected=isDecision?profiles.decision.model:isGM?profiles.gm.model:profiles.background.model;
   if(body.model!==expected||body.tools?.length||body.stream)throw Error('Unapproved model/tools/stream');
   const requested=profiles.background.reasoningEffort??'off',effort=['off','none','minimal'].includes(requested)?'low':requested;
   if(!isDecision&&(body.max_tokens!==(isGM?8192:1600)||isGM&&body.reasoning?.effort!=='low'||!isGM&&body.reasoning_effort!==effort))throw Error('Output/reasoning caps changed');
   const wire=String(init!.body),bytes=Buffer.byteLength(wire,'utf8')+512,bound=isGM?handoffCaps.gmInputBytes:handoffCaps.backgroundInputBytes;
   if(bytes>bound||/PRIVATE_RIVAL_PLAN|UNSHARED_MEMBER_SECRET/.test(wire))throw Error('Input/knowledge guard');
   let reserve:number;
   if(isDecision)reserve=prices.jev.context_length*Number(prices.jev.pricing.prompt);
   else if(isGM)reserve=bytes*2*Number(prices.gm.pricing.prompt)+body.max_tokens*Number(prices.gm.pricing.completion);
   else{const p=prices.models[0].pricing;reserve=(bytes*2*p.prompt+body.max_tokens*p.completion)/1e6;}
   if(reserved+reserve>.1)throw Error('Total budget guard');
   seen.add(stage);reserved+=reserve;
   const call:any={stage,model:body.model,endpoint,startedAt:new Date().toISOString(),inputTokenByteUpperBound:bytes,requestedOutputCap:body.max_tokens??null,reservedUsd:reserve,requestBody:body};
   ledger.calls.push(call);ledger.reservedUsd=reserved;save(); // Before network; a timeout consumes its role/count.
   try{
    const response=await actualFetch(input,init);call.status=response.status;call.requestId=response.headers.get('x-request-id');
    if(response.ok){
     call.response=await response.clone().json();call.usage=call.response.usage;call.reportedCostUsd=typeof call.usage?.cost==='number'?call.usage.cost:null;
     const output=call.usage?.completion_tokens??call.usage?.output_tokens;
     if(!isDecision&&typeof output==='number'&&output>body.max_tokens){call.capViolation=true;save();throw Error('Provider exceeded requested output cap: stop');}
     if(call.reportedCostUsd!==null&&call.reportedCostUsd>reserve){call.capViolation=true;save();throw Error('Provider cost exceeded reserve: stop');}
    }
    save();return response;
   }catch(error){call.transportError=error instanceof Error?error.name:'provider_failure';save();throw error;}
  });
  process.env.MYTHENGINE_TEST_LOCAL_ONLY='false';
  ledger.outcome=await runHandoffQualification(profiles,value=>stage=value);
  ledger.completedAt=new Date().toISOString();
  ledger.reportedCostUsd=ledger.calls.every((row:any)=>typeof row.reportedCostUsd==='number')?ledger.calls.reduce((sum:number,row:any)=>sum+row.reportedCostUsd,0):null;
  ledger.catalogEstimateUsd=ledger.calls.reduce((sum:number,call:any)=>{
   const usage=call.usage??{};
   if(call.stage.startsWith('decision'))return sum+Number(usage.input_tokens??0)*Number(prices.jev.pricing.prompt);
   const input=Number(usage.prompt_tokens??usage.input_tokens??0),output=Number(usage.completion_tokens??usage.output_tokens??0);
   if(call.stage==='gm')return sum+input*Number(prices.gm.pricing.prompt)+output*Number(prices.gm.pricing.completion);
   return sum+(input*prices.models[0].pricing.prompt+output*prices.models[0].pricing.completion)/1e6;
  },0);
  ledger.billingQualification='Response usage.cost attribution; catalog estimate is not independent account billing';save();
  expect(ledger.calls.length).toBeLessThanOrEqual(6);expect(reserved).toBeLessThanOrEqual(.1);
  expect(ledger.outcome.canonUnchangedThroughGM).toBe(true);
  expect(ledger.outcome.handoff.forecastTextAbsent).toBe(true);
  expect(ledger.outcome.gm.privateMarkerLeaked).toBe(false);expect(ledger.outcome.gm.futureMarkerLeaked).toBe(false);
  // Model quality failures are reported, not repaired by extra paid requests.
 }catch(error){ledger.stoppedReason=error instanceof Error?error.message:'qualification_failed';if(ledger.before)save();throw error;
 }finally{
  capture?.mockRestore();if(prior===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=prior;
  ledger.finishedAt=new Date().toISOString();
  const copy=await(await actualFetch('http://127.0.0.1:5174/api/app/status')).json(),original=await(await actualFetch('http://127.0.0.1:5173/api/app/status')).json();
  const config=JSON.parse(fs.readFileSync('mythengine.config.json','utf8'));
  ledger.after={copyPid:copy.runtime.pid,workerPaused:copy.config.turnJobsEnabled===false,cloudPaused:config.testLocalInferenceOnly===true,runningJobs:copy.jobs.running,queued:copy.jobs.queued,processPolicyRestored:process.env.MYTHENGINE_TEST_LOCAL_ONLY===prior,canon:await canon(),originalPid:original.runtime.pid,originalUnchanged:!ledger.before||original.runtime.pid===ledger.before.originalPid&&JSON.stringify(original.build)===JSON.stringify(ledger.before.originalBuild)};
  ledger.after.canonUnchanged=!ledger.before||JSON.stringify(ledger.before.canon)===JSON.stringify(ledger.after.canon);
  if(ledger.calls.length||ledger.before)save();await closeDb();
 }
},360000);
