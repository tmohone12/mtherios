import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, closeDb } from '$lib/server/db/client';
import { stories, entities, factions, factionGoals, factionResources, npcEventLinks, storyEvents, storyThreads } from '$lib/server/db/schema';
import { reviewFactionIntentions, reviewGardener } from './workflow';
import { record, actorPacket, validateIntentions, type Attempt } from './intentions';
import { resolveServiceGeneration, requireResolvedServiceProfile } from '$lib/server/engine/llmSettings';
import { generateServerTextWithMetrics, parseJsonFromGeneratedText } from '$lib/server/turn/provider';
import { buildServerTurnPrompt } from '$lib/server/turn/promptPacket';
import type { TurnContext } from '$lib/server/turn/context';
import type { RetrievedMemoryPacket } from '$lib/contracts/memory';

const live=process.env.MYTHENGINE_LIVE_FACTION_QUALIFICATION==='1'?test:test.skip;
live('one-time approved real planner, gardener and GM qualification; hard three-request/$1 cap',async()=>{
 if(process.env.MYTHENGINE_LIVE_QUALIFICATION_CAP_USD!=='1')throw new Error('Explicit approved cap required');
 const ledgerPath='.codex-run/faction-live-qualification.json';
 if(fs.existsSync(ledgerPath))throw new Error('One-time ledger already exists: do not repeat paid calls');
 const config=JSON.parse(fs.readFileSync('mythengine.config.json','utf8'));
 if(config.port!==5174||config.jobWorker!==false||config.testLocalInferenceOnly!==true)throw new Error('Paused isolated copy required');
 const db=getDb();if((await db.execute(sql`select current_database() as name`))[0].name!=='mythengine_faction_copy_20261001')throw new Error('Copy DB required');
 const prices=JSON.parse(fs.readFileSync('.codex-run/faction-live-pricing.json','utf8'));
 if(!prices.authenticatedUsingCopyOnly||Date.now()-Date.parse(prices.fetchedAt)>3600000)throw new Error('Fresh authenticated pricing required');
 const models=new Map<string,any>(prices.models.map((m:any)=>[m.id,m]));
 for(const m of models.values())if(m.pricing.currency!=='USD'||m.pricing.unit!=='per_million_tokens'||!(m.max_output_tokens>0))throw new Error('Unbounded pricing');
 const worst=(model:string,input=25000)=>{const m=models.get(model);return (input*2*m.pricing.prompt+m.max_output_tokens*m.pricing.completion)/1e6;};
 const maximum=worst('z-ai/glm-5.3')*2+worst('z-ai/glm-5.3-flash');
 if(maximum>1)throw new Error('Worst-case cap cannot be guaranteed');
 const background=await resolveServiceGeneration('strategicWorldBrain'),gm=await resolveServiceGeneration('narrative');
 if(background.profile?.providerType!=='nanogpt'||background.generation.model!=='z-ai/glm-5.3'||gm.profile?.providerType!=='nanogpt'||gm.generation.model!=='z-ai/glm-5.3-flash')throw new Error('Configured provider/model changed; reprice first');
 const ledger:any={approvedCapUsd:1,requestCap:3,outputCap:1600,inputTokenConservativeCap:25000,worstCaseUsd:maximum,pricing:prices.models,calls:[],localDecisions:[],outcomes:{},scope:'synthetic isolated campaign only; no full interactive turn',workerPaused:true};
 const save=()=>fs.writeFileSync(ledgerPath,JSON.stringify(ledger,null,2));save();
 const key='liveq_20261002',envoy=key+'_envoy',rival=key+'_rival',location=key+'_court',league=key+'_league',grain=key+'_grain',known=key+'_rescue',goal=key+'_goal';
 const privateMotive='KEEP_DRY_CIDER_PRIVATE';
 const prior:Attempt={id:'authored_relief',factionId:league,factionName:'Relief League',turn:0,worldTime:'Day 0',status:'intended',reason:null,
  intention:{id:'offer_supper',action:'Invite the Hillmarch envoy to supper to discuss relief.',motive:privateMotive+': privately fears seeming ungrateful.',manner:'Warm, with a gentle joke about muddy boots.',family:'aid',basis:[known],limits:['Invitation only; the envoy may decline.','Keep the private motive unspoken.'],costs:[],opposition:'Acceptance is unresolved.',earliestWorldTime:null},decision:null,fingerprint:'authored-fixture',nextReviewTurn:5,actorEntityIds:[envoy],locationId:location};
 await db.execute(sql`insert into shelves(id,name,slug) values(${key},'LIVE qualification - synthetic - one-time budget',${key})`);
 await db.execute(sql`insert into stories(id,shelf_id,title,current_world_time,current_location_id,metadata) values(${key},${key},'Synthetic gratitude at the council courtyard','Day 0',${location},${JSON.stringify({factionWorkflow:{version:1,attempts:[prior]},qualification:'authored baseline intention; not a prior model decision'})}::jsonb)`);
 await db.execute(sql`insert into entities(id,story_id,type,name,description,state) values(${location},${key},'location','Council courtyard','A quiet courtyard.', '{}'::jsonb),(${envoy},${key},'character','Maera','A generous, wry envoy.',${JSON.stringify({locationId:location,present:true})}::jsonb),(${rival},${key},'character','Remote rival','An absent rival.','{}'::jsonb)`);
 await db.execute(sql`insert into factions(id,story_id,entity_id,name,goals,metadata) values(${league},${key},${envoy},'Relief League','["Offer sincere relief in gratitude without assuming consent"]'::jsonb,'{"personality":["generous","wry"],"actorKnownSummary":"Hillmarch sheltered our wounded; no bargain or delivery has occurred."}'::jsonb)`);
 await db.execute(sql`insert into faction_goals(id,story_id,faction_id,goal) values(${goal},${key},${league},'Offer sincere relief in gratitude for sheltering our wounded')`);
 await db.execute(sql`insert into faction_resources(id,story_id,faction_id,kind,name,amount,status) values(${grain},${key},${league},'grain','Available relief grain',100,'available')`);
 await db.execute(sql`insert into story_events(id,story_id,type,title,body,actor_entity_ids,visibility,metadata) values(${known},${key},'reveal','Shelter freely given','Hillmarch sheltered the wounded without demanding payment.',${JSON.stringify([envoy])}::jsonb,'player_known',${JSON.stringify({actorClaims:[{text:'Hillmarch sheltered our wounded without demanding payment.',knownBy:[envoy],kind:'learned'},{text:'PRIVATE_RIVAL_PLAN',knownBy:[rival],kind:'private_thought'}]})}::jsonb)`);
 await db.execute(sql`insert into npc_event_links(id,story_id,event_id,npc_entity_id,role) values(${key+'_link'},${key},${known},${envoy},'witness')`);
 await db.execute(sql`insert into story_threads(id,story_id,description) values(${key+'_thread'},${key},'An unresolved request for voluntary relief after the harvest. Consent is pending.')`);
 ledger.storyId=key;save();
 const nativeFetch=globalThis.fetch;let purpose='planner';let reserved=0;
 const capture=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=new URL(String(input));
  if(['localhost','127.0.0.1','[::1]'].includes(url.hostname)){
   const r=await nativeFetch(input,init);if(url.pathname==='/v1/systemone')ledger.localDecisions.push(await r.clone().json());save();return r;
  }
  if(url.origin!=='https://nano-gpt.com'||url.pathname!=='/api/v1/chat/completions'||init?.method!=='POST')throw new Error('External request outside approved scope');
  const body=JSON.parse(String(init.body));
  if(ledger.abort||ledger.calls.length>=3||ledger.calls.some((c:any)=>c.purpose===purpose)||body.max_tokens!==1600||body.tools?.length)throw new Error('Paid request blocked by one-time guard');
  const expected=purpose==='gm'?'z-ai/glm-5.3-flash':'z-ai/glm-5.3';
  if(body.model!==expected)throw new Error('Unpriced model');
  // Budget-only routing guard. The real adapter's model, prompts and generated output are unchanged.
  body.stickyProvider=true;
  const serialized=JSON.stringify(body),inputBound=Buffer.byteLength(serialized,'utf8')+512;
  if(inputBound>25000||serialized.includes('PRIVATE_RIVAL_PLAN'))throw new Error('Input/knowledge guard');
  const reserve=worst(body.model,inputBound);if(reserved+reserve>1)throw new Error('Spend ceiling');reserved+=reserve;
  const call:any={purpose,model:body.model,inputTokenUpperBound:inputBound,maxOutputTokens:1600,reservedWorstCaseUsd:reserve,startedAt:new Date().toISOString(),requestBody:body};ledger.calls.push(call);save();
  try{const r=await nativeFetch(input,{...init,body:serialized});call.status=r.status;call.requestId=r.headers.get('x-request-id');
   if(r.ok){const raw=await r.clone().json();call.response=raw;call.usage=raw.usage;call.meteredPricing=raw.x_nanogpt_pricing;}
   else ledger.abort=true;
   save();return r;
  }catch(error){call.transportError=error instanceof Error?error.name:'transport_error';ledger.abort=true;save();throw error;}
 });
 const oldPolicy=process.env.MYTHENGINE_TEST_LOCAL_ONLY;process.env.MYTHENGINE_TEST_LOCAL_ONLY='false';
 try{
  ledger.outcomes.planner=await reviewFactionIntentions(key,'one_time_live');save();
  purpose='gardener';ledger.outcomes.gardener=await reviewGardener(key);save();
  const [story]=await db.select().from(stories).where(eq(stories.id,key));
  const workflow=record(record(story.metadata).factionWorkflow);ledger.attempts=workflow.attempts;ledger.forecasts=workflow.forecasts;
  const rows=await db.select().from(entities).where(eq(entities.storyId,key));
  const ctx={story,entities:rows.filter(row=>row.id!==rival),recentEntries:[],factions:await db.select().from(factions).where(eq(factions.storyId,key)),factionMemberships:[],factionResources:await db.select().from(factionResources).where(eq(factionResources.storyId,key)),factionGoals:await db.select().from(factionGoals).where(eq(factionGoals.storyId,key)),factionProjects:[],agreements:[],threads:await db.select().from(storyThreads).where(eq(storyThreads.storyId,key)),events:await db.select().from(storyEvents).where(eq(storyEvents.storyId,key)),beliefs:[],facts:[],patchProposals:[],continuityWarnings:[],chapters:[],arcs:[],sagas:[],gmBrief:null} as unknown as TurnContext;
  const action='I ask Maera what she wishes to offer. I have not accepted anything.';
  const retrieved={storyId:key,query:action,packet:'',nodes:[],tokenEstimate:0,retrievalDebug:[],retrievalTrace:[]} as RetrievedMemoryPacket;
  const packet=buildServerTurnPrompt(ctx,retrieved,'live_action',{playerAction:action,presentNpcIds:[envoy]});
  ledger.handoff={cue:packet.factionCueSelection,stableContainsPrivateMotive:packet.stableContext.includes(privateMotive),dynamicContainsPrivateMotive:packet.dynamicPrompt.includes(privateMotive),dynamicIncludesForecast:(workflow.forecasts as any[]??[]).some(f=>packet.dynamicPrompt.includes(f.development)),qualification:'retains authored baseline if local decision abstains; not forced model selection'};
  purpose='gm';
  try{const generated=await generateServerTextWithMetrics({profile:requireResolvedServiceProfile('narrative',gm),model:gm.generation.model,
   system:packet.system+'\n'+packet.stableContext,systemDynamic:packet.dynamicPrompt,messages:packet.messages,prompt:action,contextAfterDialogue:true,temperature:.5,maxTokens:1600,maxRetries:0,timeoutMs:60000,reasoningEffort:'low'});
   ledger.outcomes.gm={text:generated.text,finishReason:generated.finishReason,usage:generated.usage,privateMarkerLeaked:generated.text.includes(privateMotive),retryCount:generated.retryCount};
  }catch(error){ledger.outcomes.gm={error:error instanceof Error?error.name:'generation_failed'};}
  ledger.canonicalEventCount=Number((await db.execute(sql`select count(*) as n from story_events where story_id=${key}`))[0].n);
  const plannerCall=ledger.calls.find((c:any)=>c.purpose==='planner');
  if(plannerCall?.response){try{const raw=record(parseJsonFromGeneratedText(plannerCall.response.choices[0].message.content));
   const actor=actorPacket({faction:ctx.factions[0] as any,goals:ctx.factionGoals as any,resources:ctx.factionResources as any,members:[],beliefs:[],links:await db.select().from(npcEventLinks).where(eq(npcEventLinks.storyId,key)) as any,events:ctx.events as any,obligations:[],relationships:[],plan:prior.intention});
   ledger.plannerCandidates=validateIntentions(raw.options,actor);ledger.plannerValidation='passed';
  }catch{ledger.plannerValidation='invalid_or_truncated_output';}}
  ledger.reservedWorstCaseUsd=reserved;ledger.completedAt=new Date().toISOString();save();
  expect(ledger.calls.length).toBeLessThanOrEqual(3);expect(reserved).toBeLessThanOrEqual(1);expect(ledger.canonicalEventCount).toBe(1);
  expect(ledger.handoff.stableContainsPrivateMotive).toBe(false);expect(ledger.handoff.dynamicIncludesForecast).toBe(false);
  if(ledger.outcomes.gm.text)expect(ledger.outcomes.gm.privateMarkerLeaked).toBe(false);
 }finally{capture.mockRestore();if(oldPolicy===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=oldPolicy;save();await closeDb();}
},210000);
