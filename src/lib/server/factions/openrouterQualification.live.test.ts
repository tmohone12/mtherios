import fs from 'node:fs';
import {expect,test,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {getDb,closeDb} from '$lib/server/db/client';
import {resolveServiceGeneration} from '$lib/server/engine/llmSettings';
import {chooseJevOption} from '$lib/server/turn/jev';

const live=process.env.MYTHENGINE_APPROVED_JEV_FOUR==='FOUR_REQUESTS_USD_0_01'?test:test.skip;
live('approved one-shot four synthetic Jev requests, no retries, one cent ceiling',async()=>{
 const ledgerPath='.codex-run/openrouter-four-live-20261002.json';
 if(fs.existsSync(ledgerPath))throw Error('Approved one-shot ledger already exists; never repeat');
 const config=JSON.parse(fs.readFileSync('mythengine.config.json','utf8'));
 if(config.port!==5174||config.turnJobs!==false||config.testLocalInferenceOnly!==true||config.isolatedTestCopy!==true)throw Error('Paused isolated COPY required');
 const proposal=JSON.parse(fs.readFileSync('.codex-run/openrouter-live-proposal.json','utf8'));
 if(proposal.requests.length!==4||proposal.requestCap!==4||proposal.requestedBudgetUsd!==.01||proposal.model!=='typesafe/jev-1.13')throw Error('Approved proposal mismatch');
 const actualFetch=globalThis.fetch,prior=process.env.MYTHENGINE_TEST_LOCAL_ONLY;
 const ledger:any={startedAt:new Date().toISOString(),authorization:'User yes at2026-10-02T19:29UTC: four live Jev tests, no retries, capped at0.01USD',requestCap:4,budgetUsd:.01,concurrency:1,retries:0,campaignWrites:0,model:proposal.model,requests:[],results:[],normalCloudPaused:true,backgroundPaused:true};
 const save=()=>fs.writeFileSync(ledgerPath,JSON.stringify(ledger,null,2));
 let captured:ReturnType<typeof vi.spyOn>|undefined;
 try{
  if((await getDb().execute(sql`select current_database() as name`))[0].name!=='mythengine_faction_copy_20261001')throw Error('Isolated database required');
  const copy=await(await actualFetch('http://127.0.0.1:5174/api/app/status')).json();
  if(copy.config.turnJobsEnabled!==false||copy.jobs.running!==0)throw Error('Paused COPY worker required');
  const original=await(await actualFetch('http://127.0.0.1:5173/api/app/status')).json();
  ledger.before={copyPid:copy.runtime.pid,copyBuild:copy.build,originalPid:original.runtime.pid,originalBuild:original.build,copyQueued:copy.jobs.queued};
  const catalogUrl='https://openrouter.ai/api/v1/models?output_modalities=decisions';
  const catalogResponse=await actualFetch(catalogUrl,{signal:AbortSignal.timeout(15000)});
  if(!catalogResponse.ok)throw Error('Cannot verify current public pricing');
  const catalog=await catalogResponse.json(),model=catalog.data.find((row:any)=>row.id===proposal.model);
  if(!model||model.context_length!==32000||Number(model.pricing.prompt)!==4.2e-8||Number(model.pricing.completion)!==0)throw Error('Current model price/context changed; stop before inference');
  for(const [name,value] of Object.entries(model.pricing))if(!['prompt','completion'].includes(name)&&Number(value)!==0)throw Error('Unbudgeted model fee; stop');
  const reserve=model.context_length*Number(model.pricing.prompt);
  if(reserve*4>.01)throw Error('Four full-context requests exceed approved budget');
  ledger.pricing={verifiedAt:new Date().toISOString(),source:catalogUrl,pricing:model.pricing,context:model.context_length,fullContextReservePerRequestUsd:reserve,fullBatchReserveUsd:reserve*4};
  const resolved=await resolveServiceGeneration('actorDecision');
  if(!resolved.profile?.apiKey||resolved.profile.providerType!=='openrouter'||resolved.generation.model!==proposal.model)throw Error('Saved OpenRouter Jev credential/profile unavailable');
  ledger.keyResolvable=true;save();
  let active:any;
  captured=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
   if(String(input)!==proposal.endpoint||init?.method!=='POST'||ledger.requests.length>=4)throw Error('Approved endpoint/count guard');
   const body=String(init.body),bytes=Buffer.byteLength(body,'utf8');
   if(bytes+512>15000||body!==JSON.stringify(active.body)||/PRIVATE_RIVAL_PLAN|UNSHARED_MEMBER_SECRET/.test(body))throw Error('Approved body/size/knowledge guard');
   if(ledger.requests.reduce((sum:number,row:any)=>sum+Math.max(reserve,row.reportedCostUsd??0),0)+reserve>.01)throw Error('Approved remaining budget guard');
   // Persist consumption before network: failures/timeouts count and cannot be retried.
   const call:any={case:active.name,variant:active.variant,startedAt:new Date().toISOString(),requestBytes:bytes,reservedUsd:reserve};
   ledger.requests.push(call);save();
   try{
    const response=await actualFetch(input,init);call.status=response.status;
    if(response.ok){call.raw=await response.clone().json();call.reportedCostUsd=typeof call.raw?.usage?.cost==='number'?call.raw.usage.cost:null;}
    save();return response;
   }catch(error){call.transportError=error instanceof Error?error.name:'request_failed';save();throw error;}
  });
  const first=proposal.requests[0];
  process.env.MYTHENGINE_TEST_LOCAL_ONLY='true';
  await expect(chooseJevOption({profile:resolved.profile,model:proposal.model,evidence:first.body.state.evidence,sourceIds:first.body.state.sourceIds,options:Object.entries(first.body.questions.selection.criteria).map(([id,description])=>({id,description:String(description)}))})).rejects.toThrow('local Kev decisions only');
  if(ledger.requests.length!==0)throw Error('Normal cloud guard failed');
  ledger.guardChecks={normalCloudBlocksBeforeFetch:true};save();
  process.env.MYTHENGINE_TEST_LOCAL_ONLY='false'; // Only this bounded process; server/config stay paused.
  for(const request of proposal.requests){
   active=request;let decision=null,error=null;
   try{decision=await chooseJevOption({profile:resolved.profile,model:proposal.model,evidence:request.body.state.evidence,sourceIds:request.body.state.sourceIds,options:Object.entries(request.body.questions.selection.criteria).map(([id,description])=>({id,description:String(description)}))});}
   catch(failure){error=failure instanceof Error?failure.message:'request_failed';}
   const call=ledger.requests.at(-1),answer=call?.raw?.answers?.selection;
   const row={case:request.name,variant:request.variant,rawChoice:answer?.choice??null,confidence:answer?.confidence??null,probabilities:answer?.probabilities??null,selectedProbability:answer?.probabilities?.[answer.choice]??null,returnedModel:call?.raw?.model??null,usage:call?.raw?.usage??null,decision,error,confidenceGateFailed:typeof answer?.confidence==='number'&&answer.confidence<.7,probabilityGateFailed:typeof answer?.probabilities?.[answer.choice]==='number'&&answer.probabilities[answer.choice]<.7,rawConstraintViolation:answer?request.labels.forbidden.includes(answer.choice):null,classification:error?'error':!decision?'abstained':request.labels.forbidden.includes(decision.optionId)?'constraint_violation':request.labels.acceptable.includes(decision.optionId)?'acceptable':'unlabeled'};
   ledger.results.push(row);save();
   if(error){ledger.stoppedReason='Failed request/adapter: no retry authorized';break;}
   if(call.reportedCostUsd!==null&&call.reportedCostUsd>reserve){ledger.stoppedReason='Reported cost exceeds conservative reserve';break;}
  }
  ledger.completedAt=new Date().toISOString();
  ledger.reportedCostUsd=ledger.requests.every((row:any)=>typeof row.reportedCostUsd==='number')?ledger.requests.reduce((sum:number,row:any)=>sum+row.reportedCostUsd,0):null;
  ledger.catalogUsageEstimateUsd=ledger.requests.reduce((sum:number,row:any)=>sum+(Number(row.raw?.usage?.input_tokens??0)*Number(model.pricing.prompt)),0);
  ledger.billingQualification='usage.cost is provider response attribution, not an independent account-billing receipt; catalog calculation is an estimate';
  ledger.counts=ledger.results.reduce((counts:any,row:any)=>({...counts,[row.classification]:(counts[row.classification]??0)+1}),{});save();
  if(ledger.requests.length===4){
   await expect(fetch(proposal.endpoint,{method:'POST',body:JSON.stringify(active.body)})).rejects.toThrow('endpoint/count guard');
   ledger.guardChecks.fifthRequestBlockedBeforeNetwork=true;save();
  }
  expect(ledger.requests.length).toBeLessThanOrEqual(4);
  expect(ledger.reportedCostUsd??ledger.pricing.fullBatchReserveUsd).toBeLessThanOrEqual(.01);
  // Report semantic violations/abstentions; do not retry or require model agreement with labels.
  expect(ledger.results.some((row:any)=>row.error)).toBe(false);
 }finally{
  captured?.mockRestore();if(prior===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=prior;
  const latest=JSON.parse(fs.readFileSync('mythengine.config.json','utf8'));
  ledger.after={workerPaused:latest.turnJobs===false,normalCloudPaused:latest.testLocalInferenceOnly===true,testProcessPolicyRestored:process.env.MYTHENGINE_TEST_LOCAL_ONLY===prior};
  if(ledger.before){
   const copy=await(await actualFetch('http://127.0.0.1:5174/api/app/status')).json(),original=await(await actualFetch('http://127.0.0.1:5173/api/app/status')).json();
   ledger.after.copyPid=copy.runtime.pid;ledger.after.runningJobs=copy.jobs.running;ledger.after.copyQueued=copy.jobs.queued;
   ledger.after.originalUnchanged=original.runtime.pid===ledger.before.originalPid&&JSON.stringify(original.build)===JSON.stringify(ledger.before.originalBuild);
  }
  if(ledger.requests.length||ledger.pricing){ledger.finishedAt=new Date().toISOString();save();}
  await closeDb();
 }
},60000);
