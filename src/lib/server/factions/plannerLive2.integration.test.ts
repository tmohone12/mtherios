import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, closeDb } from '$lib/server/db/client';
import { stories, entities } from '$lib/server/db/schema';
import { applyValidatedTurnUpdate, parseTurnUpdate } from '$lib/server/turn/patchValidator';
import { resolveServiceGeneration } from '$lib/server/engine/llmSettings';
import { parseJsonFromGeneratedText } from '$lib/server/turn/provider';
import { buildServerTurnPrompt } from '$lib/server/turn/promptPacket';
import { reviewFactionIntentions } from './workflow';
import { record, validateIntentions } from './intentions';

const live=process.env.MYTHENGINE_LIVE_PLANNER2==='1'?test:test.skip;
live('one additional authorized paid planner request; real actor history and local Kev; no retries',async()=>{
 const path='.codex-run/faction-planner-live2.json';
 if(process.env.MYTHENGINE_LIVE_QUALIFICATION_CAP_USD!=='1'||fs.existsSync(path))throw new Error('One-time authorization/ledger guard');
 const config=JSON.parse(fs.readFileSync('mythengine.config.json','utf8'));
 if(config.port!==5174||config.jobWorker!==false||config.testLocalInferenceOnly!==true||!config.isolatedTestCopy)throw new Error('Paused isolated copy required');
 const db=getDb();if((await db.execute(sql`select current_database() as name`))[0].name!=='mythengine_faction_copy_20261001')throw new Error('Isolated database required');
 const prices=JSON.parse(fs.readFileSync('.codex-run/faction-planner-live2-pricing.json','utf8'));
 if(!prices.authenticatedUsingCopyOnly||Date.now()-Date.parse(prices.fetchedAt)>3600000||prices.maximumUsd>1)throw new Error('Fresh bounded pricing required');
 const profile=await resolveServiceGeneration('strategicWorldBrain');
 if(profile.profile?.providerType!=='nanogpt'||profile.generation.model!=='z-ai/glm-5.3')throw new Error('Unpriced configured model');
 const fixture=JSON.parse(fs.readFileSync('.codex-run/faction-loop-evidence.json','utf8')).loops.find((row:any)=>row.family==='aid');
 const key=fixture.storyId,league=key+'_league',source=key+'_paid2_observed';
 const ledger:any={authorization:'User: Try a paid call run; parent bounded one additional planner request, $1, zero retries',approvedCapUsd:1,requestCap:1,pricing:prices.models,storyId:key,calls:[],localDecisions:[],workerPaused:true,modelAdapters:'real NanoGPT planner and local Kev; no GM/gardener inference'};
 const save=()=>fs.writeFileSync(path,JSON.stringify(ledger,null,2));save();
 const narration='The Mudlark hears Rowan explain that he declined supper because he is tending the wounded. Rowan thanks The Mudlark for remembering Hillmarch and welcomes a discussion of relief, while promising no agreement.';
 await db.execute(sql`insert into story_entries(id,story_id,type,content,position) values(${source},${key},'narration',${narration},30)`);
 const parsed=parseTurnUpdate({timeline_events:[{title:'Observed reason for declined supper',type:'reveal',status:'committed',description:narration+' PRIVATE_RIVAL_PLAN remains unspoken.',actor_names:['The Mudlark'],target_names:['Rowan'],faction_names:['Granary League'],actor_claims:[{text:narration,known_by:['The Mudlark'],kind:'learned',evidence:narration}]}]});
 expect(parsed.warnings).toEqual([]);
 ledger.extraction=await applyValidatedTurnUpdate({storyId:key,playerEntryId:source+'_player',assistantEntryId:source,narration,update:parsed.update,parseWarnings:[],retrievedMemoryIds:[],serverVersion:30,mode:'supplemental',timelineTurn:30},{enqueueProjectionJobs:false});
 const count=async()=>Number((await db.execute(sql`select count(*) as n from story_events where story_id=${key}`))[0].n);
 ledger.canonicalBefore=await count();save();
 const nativeFetch=globalThis.fetch;
 const capture=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=new URL(String(input));
  if(['localhost','127.0.0.1','[::1]'].includes(url.hostname)){
   const r=await nativeFetch(input,init);if(url.pathname==='/v1/systemone'){ledger.localDecisions.push(await r.clone().json());save();}return r;
  }
  if(url.origin!=='https://nano-gpt.com'||url.pathname!=='/api/v1/chat/completions'||init?.method!=='POST'||ledger.calls.length>=1)throw new Error('Request outside one paid planner authorization');
  const body=JSON.parse(String(init.body));
  if(body.model!=='z-ai/glm-5.3'||body.max_tokens!==1600||body.tools?.length)throw new Error('Unpriced or unsupported request');
  body.stickyProvider=true;
  const serialized=JSON.stringify(body),inputBound=Buffer.byteLength(serialized,'utf8')+512;
  if(inputBound>25000||/PRIVATE_RIVAL_PLAN|UNSHARED_MEMBER_SECRET/.test(serialized))throw new Error('Knowledge/budget guard');
  const p=prices.models[0],reserve=(inputBound*2*p.pricing.prompt+p.max_output_tokens*p.pricing.completion)/1e6;
  if(reserve>1)throw new Error('Spend ceiling');
  const call:any={purpose:'updated-faction-planner',model:body.model,startedAt:new Date().toISOString(),inputTokenUpperBound:inputBound,reservedWorstCaseUsd:reserve,requestBody:body};
  ledger.calls.push(call);save();
  try{const r=await nativeFetch(input,{...init,body:serialized});call.status=r.status;call.requestId=r.headers.get('x-request-id');
   if(r.ok){call.response=await r.clone().json();call.usage=call.response.usage;}save();return r;
  }catch(error){call.transportError=error instanceof Error?error.name:'transport_error';save();throw error;}
 });
 const old=process.env.MYTHENGINE_TEST_LOCAL_ONLY;process.env.MYTHENGINE_TEST_LOCAL_ONLY='false';
 try{
  ledger.outcome=await reviewFactionIntentions(key,'paid2-observed-reason',[league]);save();
  ledger.canonicalAfter=await count();
  const [story]=await db.select().from(stories).where(eq(stories.id,key));ledger.attempt=(record(record(story.metadata).factionWorkflow).attempts as any[]).at(-1);
  const call=ledger.calls[0];
  if(call){
   const user=call.requestBody.messages.findLast((m:any)=>m.role==='user');ledger.actorPacket=JSON.parse(user.content);
   ledger.knowledgeChecks={privateMarkersAbsent:!/PRIVATE_RIVAL_PLAN|UNSHARED_MEMBER_SECRET/.test(JSON.stringify(ledger.actorPacket)),identifiedLeader:ledger.actorPacket.actor.decisionActorIds.includes(fixture.spokesperson),knownRelationship:ledger.actorPacket.actor.relationships.length>0,knownCommitment:ledger.actorPacket.actor.obligations,observedExplanationIncluded:ledger.actorPacket.evidence.some((e:any)=>e.claim.includes('tending the wounded'))};
   try{ledger.candidates=validateIntentions(record(parseJsonFromGeneratedText(call.response.choices[0].message.content)).options,ledger.actorPacket);ledger.validation='passed';}catch{ledger.validation='held_invalid_failed_or_truncated';}
  }
  const rows=await db.select().from(entities).where(eq(entities.storyId,key));
  const ctx={story,entities:rows,recentEntries:[],factions:[],factionMemberships:[],factionResources:[],factionGoals:[],factionProjects:[],agreements:[],threads:[],events:[],beliefs:[],facts:[],patchProposals:[],continuityWarnings:[],chapters:[],arcs:[],sagas:[],gmBrief:null} as any;
  const action='I listen to Maera, keeping my choice open.';
  const gm=buildServerTurnPrompt(ctx,{storyId:key,query:action,packet:'',nodes:[],tokenEstimate:0,retrievalDebug:[],retrievalTrace:[]} as any,'paid2-local-assembly',{playerAction:action,presentNpcIds:[fixture.spokesperson]});
  ledger.gmHandoff={modelCall:false,cue:gm.factionCueSelection,stableContainsChosenAction:!!ledger.attempt.intention&&gm.stableContext.includes(ledger.attempt.intention.action),dynamicContainsChosenAction:!!ledger.attempt.intention&&gm.dynamicPrompt.includes(ledger.attempt.intention.action),settlementWarning:gm.dynamicPrompt.includes('does not settle')};
  ledger.completedAt=new Date().toISOString();save();
  expect(ledger.calls).toHaveLength(1);expect(ledger.canonicalAfter).toBe(ledger.canonicalBefore);
  expect(ledger.knowledgeChecks).toMatchObject({privateMarkersAbsent:true,identifiedLeader:true,knownRelationship:true,observedExplanationIncluded:true});
  expect(ledger.gmHandoff.stableContainsChosenAction).toBe(false);
 }finally{capture.mockRestore();if(old===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=old;save();await closeDb();}
},90000);
