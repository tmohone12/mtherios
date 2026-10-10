import fs from 'node:fs';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '$lib/server/db/client';
import { reviewFactionIntentions } from './workflow';
import { intentionBrief, record } from './intentions';

// Exercise the actual workflow, actor projection, Jev transport/parser and canonical
// attempt writes. Only configuration and external model transports are fixtures.
const controls=vi.hoisted(()=>({missing:false,key:true,family:'aid',plannerCalls:0,packets:[] as any[]}));
vi.mock('$lib/server/engine/llmSettings',()=>({
 resolveServiceGeneration:async(service:string)=>({profile:controls.missing?null:{providerType:service==='actorDecision'?'openrouter':'openai-compatible',name:'Synthetic qualification',baseUrl:service==='actorDecision'?'https://openrouter.ai/api/v1':'http://127.0.0.1/mock',apiKey:controls.key?'synthetic-contract-key':''},generation:{model:service==='actorDecision'?'typesafe/jev-1.13':'mock-planner'}}),
 requireResolvedServiceProfile:(_id:string,value:any)=>{if(!value.profile)throw Error('Fixture profile unavailable');return value.profile;}
}));
vi.mock('$lib/server/turn/provider',()=>({parseJsonFromGeneratedText:JSON.parse,generateServerTextWithMetrics:async(input:any)=>{
 controls.plannerCalls++;const packet=JSON.parse(input.prompt);controls.packets.push(packet);
 return {text:JSON.stringify({options:[{id:'grounded_attempt',action:controls.family==='pressure'?'Request an explanation for the witnessed refusal.':'Offer a meal in gratitude for shelter.',motive:controls.family==='pressure'?'Seek accountability without assuming guilt.':'Return freely given kindness.',manner:'Warm, measured; allow a refusal.',family:controls.family,basis:[packet.evidence[0].id],costs:[{resourceId:packet.actor.resources[0].id,amount:5}],limits:['Consent is required.'],opposition:'The recipient can decline.',earliestWorldTime:'Day 2'}]}),model:'mock-planner',endpoint:'http://127.0.0.1/mock',durationMs:1,promptChars:input.prompt.length,responseChars:100,finishReason:'stop'};
}}));
vi.mock('$lib/server/engine/apiCallLogs',async original=>{const actual=await original<typeof import('$lib/server/engine/apiCallLogs')>();return {...actual,recordApiCallLog:(input:Parameters<typeof actual.recordApiCallLog>[0])=>actual.recordApiCallLog({...input,metadata:{...input.metadata,fixture:true,qualification:'mocked OpenRouter transport'}})};});
const integration=process.env.MYTHENGINE_OPENROUTER_WORKFLOW_INTEGRATION==='1'?test:test.skip;
const receipts:any[]=[];
let originalPolicy:string|undefined;
async function fixture(){
 const config=JSON.parse(fs.readFileSync('mythengine.config.json','utf8'));
 expect(config).toMatchObject({port:5174,jobWorker:false,testLocalInferenceOnly:true,isolatedTestCopy:true});
 expect((await getDb().execute(sql`select current_database() as name`))[0].name).toBe('mythengine_faction_copy_20261001');
 originalPolicy=process.env.MYTHENGINE_TEST_LOCAL_ONLY;process.env.MYTHENGINE_TEST_LOCAL_ONLY='false';
 controls.missing=false;controls.key=true;controls.plannerCalls=0;controls.packets=[];
 const id=`orwf_${Date.now().toString(36)}_${receipts.length}`,faction=id+'_f',actor=id+'_a',rival=id+'_r',resource=id+'_grain',event=id+'_event';
 const db=getDb();
 await db.execute(sql`insert into shelves(id,name,slug) values(${id},'Mocked OpenRouter qualification',${id})`);
 await db.execute(sql`insert into stories(id,shelf_id,title,current_world_time,metadata) values(${id},${id},'Isolated adapter fixture','Day 2','{"fixture":true,"factionWorkflow":{"version":1}}'::jsonb)`);
 await db.execute(sql`insert into entities(id,story_id,type,name,state) values(${actor},${id},'character','Maera','{"personality":"Generous with dry humor"}'::jsonb),(${rival},${id},'character','Corvin','{}'::jsonb)`);
 await db.execute(sql`insert into factions(id,story_id,entity_id,name) values(${faction},${id},${actor},'Granary League')`);
 await db.execute(sql`insert into faction_goals(id,story_id,faction_id,goal) values(${id+'_goal'},${id},${faction},'Return kindness while respecting consent')`);
 await db.execute(sql`insert into faction_resources(id,story_id,faction_id,kind,name,amount,metadata) values(${resource},${id},${faction},'grain','Available stores',40,'{"reservedGrain":10}'::jsonb)`);
 const claim=controls.family==='pressure'?'Maera witnessed Rowan refuse the promised shipment.':'Maera heard Rowan confirm that Hillmarch sheltered the wounded freely.';
 await db.execute(sql`insert into story_events(id,story_id,type,title,body,metadata) values(${event},${id},'reveal','Observed exchange','RAW_EVENT_PRIVATE_MOTIVE',${JSON.stringify({actorClaims:[{text:claim,knownBy:[actor],kind:'witnessed'}]})}::jsonb),(${id+'_unlearned'},${id},'reveal','Public but unlearned','PUBLIC_UNLEARNED_SECRET','{}'::jsonb)`);
 await db.execute(sql`insert into npc_event_links(id,story_id,event_id,npc_entity_id,role) values(${id+'_link'},${id},${event},${actor},'witness')`);
 await db.execute(sql`insert into npc_beliefs(id,story_id,believer_entity_id,belief) values(${id+'_belief'},${id},${rival},'RIVAL_PRIVATE_PLAN')`);
 return {id,faction,actor,resource,event,claim};
}
async function snapshot(id:string){const [row]=await getDb().execute(sql`select metadata,server_version from stories where id=${id}`);return {workflow:record(record(row.metadata).factionWorkflow),version:row.server_version};}
function transport(mode='valid'){
 const mock=vi.fn(async(url:unknown,init:any)=>{
  expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
  const body=JSON.parse(init.body);expect(body.model).toBe('typesafe/jev-1.13');expect(init.headers.Authorization).toBe('Bearer synthetic-contract-key');
  expect(JSON.stringify(body)).not.toMatch(/RAW_EVENT_PRIVATE_MOTIVE|PUBLIC_UNLEARNED_SECRET|RIVAL_PRIVATE_PLAN/);
  expect(body.state.evidence.actor.resources[0]).toMatchObject({amount:30,reserved:10});
  expect(body.questions.selection.criteria.grounded_attempt).toContain('"amount":5');
  expect(body.questions.selection.criteria.grounded_attempt).toContain('Day 2');
  expect(body.questions.selection.criteria.grounded_attempt).toContain('The recipient can decline.');
  if(mode==='http_error')return Response.json({error:{message:'Synthetic outage'}},{status:503});
  const answer:any={type:'choice',choice:mode==='unknown'?'invented_success':mode==='wait'?'wait':'grounded_attempt',confidence:mode==='low_confidence'?.69:.91,probabilities:{wait:mode==='wait'?.95:.02,investigate:.03,grounded_attempt:mode==='low_probability'?.69:.95}};
  if(mode==='missing_confidence')delete answer.confidence;
  if(mode==='missing_probabilities')delete answer.probabilities;
  return Response.json({model:'typesafe/jev-1.13-20260917',answers:{selection:answer},usage:{input_tokens:500,output_tokens:50,cost:0}});
 });vi.stubGlobal('fetch',mock);return mock;
}
integration.each(['aid','pressure'])('real adapter persists a grounded %s intention without settling canon or revealing private knowledge',async family=>{
 controls.family=family;const f=await fixture(),mock=transport();
 expect(await reviewFactionIntentions(f.id,'initial',[f.faction])).toMatchObject({reviewed:1,createdEvents:0});
 const first=await snapshot(f.id),attempt=(first.workflow.attempts as any[]).at(-1);
 expect(attempt).toMatchObject({status:'intended',intention:{family,basis:[f.event]},decision:{model:'typesafe/jev-1.13-20260917',confidence:.91,sourceIds:expect.arrayContaining([f.event])}});
 expect(controls.packets[0].evidence).toEqual([expect.objectContaining({claim:f.claim})]);
 const brief=intentionBrief({factionWorkflow:first.workflow},null,[f.actor],[],false)?.text;
 expect(brief).toContain('GM ONLY');expect(brief).toContain('Private motive (do not automatically voice)');expect(brief).toContain('does not settle');
 const calls=controls.plannerCalls;expect(await reviewFactionIntentions(f.id,'repeat',[f.faction])).toMatchObject({reviewed:0});
 expect(controls.plannerCalls).toBe(calls);expect(mock).toHaveBeenCalledTimes(1);expect((await snapshot(f.id)).version).toBe(first.version);
 expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.resource}`))[0]).toMatchObject({amount:40,metadata:{reservedGrain:10}});
 expect((await getDb().execute(sql`select count(*)::int as n from story_events where story_id=${f.id}`))[0].n).toBe(2);
 receipts.push({storyId:f.id,family,status:'intended',duplicateCoalesced:true,createdEvents:0,transportCalls:1});
},30000);
integration('all abstention, invalid, unavailable and paused paths retain the existing intention; availability recovery retries once',async()=>{
 controls.family='aid';const f=await fixture();transport();await reviewFactionIntentions(f.id,'initial',[f.faction]);
 const original=(await snapshot(f.id)).workflow.attempts as any[],initialId=original[0].id;
 const modes=['low_confidence','low_probability','missing_confidence','missing_probabilities','unknown','http_error','wait','missing_key','missing_profile','paused'];
 for(const mode of modes){
  controls.key=mode!=='missing_key';controls.missing=mode==='missing_profile';process.env.MYTHENGINE_TEST_LOCAL_ONLY=mode==='paused'?'true':'false';
  await getDb().execute(sql`update faction_goals set goal=${'Material changed constraint: '+mode} where story_id=${f.id}`);
  const mock=transport(mode),calls=controls.plannerCalls;
  expect(await reviewFactionIntentions(f.id,mode,[f.faction])).toMatchObject({reviewed:1,createdEvents:0});
  const saved=await snapshot(f.id),attempts=saved.workflow.attempts as any[],held=attempts.at(-1);
  expect(held.status).toBe('held');expect(held.intention).toBeNull();expect(held.reason).toBeTruthy();expect(attempts.find(row=>row.id===initialId).status).toBe('intended');
  expect(mock).toHaveBeenCalledTimes(['missing_key','missing_profile','paused'].includes(mode)?0:1);
  expect(await reviewFactionIntentions(f.id,mode+'_repeat',[f.faction])).toMatchObject({reviewed:0});expect(controls.plannerCalls).toBe(calls+(mode==='missing_profile'?0:1));
  expect((await snapshot(f.id)).version).toBe(saved.version);
  receipts.push({storyId:f.id,mode,status:held.status,reason:held.reason,retainedIntention:initialId,duplicateCoalesced:true,transportCalls:mock.mock.calls.length});
 }
 // Policy/profile availability is in the dirty fingerprint; no new evidence or
 // arbitrary gate adjustment is needed to recover the last paused attempt.
 controls.key=true;controls.missing=false;process.env.MYTHENGINE_TEST_LOCAL_ONLY='false';const recovered=transport();
 expect(await reviewFactionIntentions(f.id,'resume',[f.faction])).toMatchObject({reviewed:1,createdEvents:0});
 const attempts=(await snapshot(f.id)).workflow.attempts as any[];expect(attempts.at(-1).status).toBe('intended');expect(attempts.find(row=>row.id===initialId).status).toBe('superseded');expect(recovered).toHaveBeenCalledTimes(1);
 expect((await getDb().execute(sql`select count(*)::int as n from story_events where story_id=${f.id}`))[0].n).toBe(2);
 expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.resource}`))[0]).toMatchObject({amount:40,metadata:{reservedGrain:10}});
 receipts.push({storyId:f.id,mode:'policy_recovery',status:'intended',createdEvents:0,transportCalls:1});
},30000);
afterEach(()=>{vi.unstubAllGlobals();if(originalPolicy===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=originalPolicy;});
afterAll(async()=>{if(process.env.MYTHENGINE_OPENROUTER_WORKFLOW_INTEGRATION==='1'){
 fs.writeFileSync('.codex-run/openrouter-workflow-resume-evidence.json',JSON.stringify({verifiedAt:new Date().toISOString(),paidCalls:0,modelTransports:'mocked; actual workflow/actor projection/Jev adapter/PostgreSQL writes',receipts},null,2));await closeDb();
}});
