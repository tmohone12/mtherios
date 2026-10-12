import {recordVerificationReport} from './verificationAuthoring';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { applyValidatedTurnUpdate, parseTurnUpdate } from '$lib/server/turn/patchValidator';
import { enqueueFactionCadenceJob, enqueueTurnProjectionJobs, stableJobId } from '$lib/server/jobs/outbox';
import { buildServerTurnPrompt, buildStateExtractionPrompt } from '$lib/server/turn/promptPacket';
import { preserveDurableDeferredState } from '$lib/server/jobs/processor';
import { stories, entities, factions, factionGoals, factionMemberships, factionResources, npcBeliefs, npcEventLinks, relationships, agreements, storyEvents, storyThreads } from '$lib/server/db/schema';
import { actorPacket, intentionBrief, record } from './intentions';
import type { TurnContext } from '$lib/server/turn/context';
import type { RetrievedMemoryPacket } from '$lib/contracts/memory';
import { getDb, closeDb } from '$lib/server/db/client';
import { getServerMemoryConfig } from '$lib/server/env';
import { advanceNegotiation, initializeNegotiation, reviewFactionIntentions, reviewGardener, withFactionLane } from './workflow';
import { negotiationSandboxSchema,type NegotiationAdapters } from './negotiationPrototype';
import fs from 'node:fs';
import { storyEventTypeSchema } from '$lib/contracts/memory';
import { auditDueFactionProjects } from './projects';
import { reviewPatchProposal } from '$lib/server/engine/canonRepair';
import {reliefAuthoringOptions,recordReliefEvidence,requestReliefCancellation} from './reliefAuthoring';
import {grainPool} from './reliefAdapter';
import {authorReliefProject} from './persistentProjects';
import {projectAdjudicationBrief} from './projectLifecycle';

const controls=vi.hoisted(()=>({ missing:false, calls:0, decisionCalls:0, invalidForecast:false, duplicateForecast:false, abstain:false, emptyOptions:false,
 plannerModel:'mock-planner-v1', decisionModel:'kev-latest', family:"aid", plannerPackets:[] as any[], prompts:{} as Record<string,string>, loopReceipts:[] as any[],
 onGenerate:null as null | ((input:any)=>Promise<void>) }));
vi.mock('$lib/server/engine/apiCallLogs',async importOriginal=>{const actual=await importOriginal<typeof import('$lib/server/engine/apiCallLogs')>();return {...actual,recordApiCallLog:(input:Parameters<typeof actual.recordApiCallLog>[0],options?:Parameters<typeof actual.recordApiCallLog>[1])=>actual.recordApiCallLog({...input,metadata:{...input.metadata,fixture:true}},options)};});
vi.mock('$lib/server/engine/llmSettings',()=>({ resolveServiceGeneration:async(serviceId:string)=>({ profile:controls.missing?null:{providerType:'openai-compatible',name:'Mock local profile',baseUrl:'http://127.0.0.1:8008/v1'},generation:{model:serviceId==='actorDecision'?controls.decisionModel:controls.plannerModel} }), requireResolvedServiceProfile:(_id: string,r: any)=>{if(!r.profile)throw new Error('Local model unavailable');return r.profile;} }));
vi.mock('$lib/server/turn/provider',async importOriginal=>({ ...await importOriginal<typeof import('$lib/server/turn/provider')>(),parseJsonFromGeneratedText:JSON.parse, generateServerTextWithMetrics:async(input:any)=>{
 controls.calls++; const p=JSON.parse(input.prompt); controls.prompts[p.unresolved?'gardener':'planner']=input.system; if(!p.unresolved)controls.plannerPackets.push(p);
 await controls.onGenerate?.(p);
 const forecast={id:'possible_relief',if:'The request receives a response',unless:'Either party withdraws',development:'Relief may reduce tension.',earliest:null,evidence:[controls.invalidForecast?"Unsupported quotation instead of source ID":p.unresolved?.[0]?.id],uncertainty:'Consent and transport remain unresolved.',invalidateWhen:'The request is abandoned.'};
 return {text:JSON.stringify(p.unresolved?{forecasts:p.unresolved.length?(controls.duplicateForecast?[forecast,{...forecast,development:'The relief may arrive later.'}]:[forecast]):[]}:{options:controls.emptyOptions?[]:[{id:'thank_neighbor',action:controls.family==='pressure'?'Request a written explanation for the refused shipment.':'Offer relief in gratitude for past shelter.',motive:controls.family==='pressure'?'Seek accountability for an observed refusal, without assuming guilt.':'Return a kindness.',manner:controls.family==='pressure'?'Measured and firm; permit an explanation.':'Warm and lightly humorous.',family:controls.family,basis:[p.evidence[0]?.id??p.sourceIds[0]],limits:['Recipient consent required.'],costs:[],opposition:'The neighbor may refuse.',earliestWorldTime:null}]}),model:input.model,endpoint:'http://127.0.0.1/mock',durationMs:1,promptChars:input.prompt.length,responseChars:100,finishReason:'stop'};
} }));
vi.mock('$lib/server/turn/jev',()=>({isJevModel:()=>true,chooseJevOption:async(input:any)=>{controls.decisionCalls++;return controls.abstain?null:{optionId:input.options.at(-1).id,confidence:.9,sourceIds:input.sourceIds,model:input.model,memoryId:null,usage:null};}}));
const integration=process.env.MYTHENGINE_FACTION_WORKFLOW_INTEGRATION==='1'?test:test.skip;
const ids:string[]=[];
let testDatabaseVerified=false;
async function verifyTestDatabase(){
 const explicit=process.env.MYTHENGINE_FACTION_TEST_DATABASE_URL;
 const configured=getServerMemoryConfig().databaseUrl;
 if(!configured)throw new Error('An isolated faction test database must be configured.');
 const effective=new URL(configured),expected=new URL(explicit??configured);
 const local=(url:URL)=>['postgres:','postgresql:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 const database=decodeURIComponent(expected.pathname.slice(1));
 if(!local(expected)||!local(effective)||(explicit?(!/^mythengine_faction_repair_[a-z0-9_]+$/.test(database)&&database!=='mythengine_identity_candidate_20261006'&&database!=='mythengine_summary_repair_recovery_20261006_aggregate'):database!=='mythengine_faction_copy_20261001')||effective.href!==expected.href)throw new Error('Explicit local isolated faction test database required; effective configuration must match.');
 const [{name}]=await getDb().execute(sql`select current_database() as name`);
 if(name!==database)throw new Error('Connected database differs from the approved isolated test database.');
 testDatabaseVerified=true;
}
beforeAll(async()=>{if(process.env.MYTHENGINE_FACTION_WORKFLOW_INTEGRATION==='1')await verifyTestDatabase();});
beforeEach(()=>{controls.missing=false;controls.invalidForecast=false;controls.duplicateForecast=false;controls.abstain=false;controls.emptyOptions=false;controls.family='aid';controls.plannerModel='mock-planner-v1';controls.decisionModel='kev-latest';controls.onGenerate=null;});
async function fixture(blocked=false,skipInitialize=false){
 await verifyTestDatabase();const db=getDb();
 const key=`fw_${Date.now().toString(36)}_${ids.length}`; ids.push(key);
 await db.execute(sql`insert into shelves(id,name,slug) values(${key},'Faction workflow qualification',${key})`);
 await db.execute(sql`insert into stories(id,shelf_id,title,current_world_time,metadata) values(${key},${key},${blocked?'Relief — blocked road':'Relief — goodwill'},'Day 0','{"factionWorkflow":{"version":1}}'::jsonb)`);
 const supplier=key+'_league',recipient=key+'_regency',sr=key+'_grain_a',rr=key+'_grain_b',authority=key+'_authority',route=key+'_route';
 await db.execute(sql`insert into factions(id,story_id,name,goals) values(${supplier},${key},'Granary League','["Thank our neighbor with fair relief"]'::jsonb),(${recipient},${key},'Hillmarch Regency','["Receive relief within council authority"]'::jsonb)`);
 // Generic review fixtures have explicit active decision owners; negotiation mechanics remain independently scoped.
 await db.execute(sql`insert into entities(id,story_id,type,name) values(${key+'_supplier_owner'},${key},'character','League steward'),(${key+'_recipient_owner'},${key},'character','Regency steward')`);
 await db.execute(sql`update factions set entity_id=case when id=${supplier} then ${key+'_supplier_owner'} else ${key+'_recipient_owner'} end where id in (${supplier},${recipient})`);
 await db.execute(sql`insert into faction_goals(id,story_id,faction_id,goal) values(${key+'_goal'},${key},${supplier},${"Return our neighbor's kindness"})`);
 await db.execute(sql`insert into faction_resources(id,story_id,faction_id,kind,name,amount) values(${sr},${key},${supplier},'grain','Relief grain',100),(${rr},${key},${recipient},'grain','Granary stores',10)`);
 await db.execute(sql`insert into story_events(id,story_id,type,title,body,metadata) values(${authority},${key},'reveal','Council mandate','Council approves temporary toll relief.',${JSON.stringify({tollAuthority:{factionId:recipient,maxDays:20}})}::jsonb),(${route},${key},'reveal','Road report','A verified route constraint.',${JSON.stringify({deliveryRoute:{locationId:key+'_granary',blocked}})}::jsonb)`);
 await db.execute(sql`insert into story_threads(id,story_id,description) values(${key+'_thread'},${key},'An unresolved relief request after a poor harvest.')`);
 if(!skipInitialize)await initializeNegotiation(key,{supplierId:supplier,recipientId:recipient,supplierResourceId:sr,recipientResourceId:rr,locationId:key+'_granary',deliveryDays:2,maxTollDays:20,authoritySourceId:authority,routeSourceId:route,blocked});
 return {key,supplier,recipient,sr,rr};
}
const adapter:NegotiationAdapters={plan:async({actorPacket:p})=>p.phase==='idle'?[{kind:'offer',terms:{grain:40,tollDays:20},sourceIds:[p.actor.id]}]:p.actor.role==='recipient'?[{kind:'counteroffer',terms:{grain:40,tollDays:10},sourceIds:[p.pendingOffer!.id]}]:[{kind:'accept',sourceIds:[p.pendingOffer!.id]}],decide:async input=>({optionId:input.options.at(-1)!.id,confidence:.95,sourceIds:input.sourceIds,model:'fixture-decision',memoryId:null,usage:null})};
async function day(key:string,value:number){await getDb().execute(sql`update stories set current_world_time=${'Day '+value},server_version=server_version+1 where id=${key}`);}
async function persistedActorPacket(storyId:string,factionId:string){
 const db=getDb();
 return actorPacket({faction:(await db.select().from(factions).where(eq(factions.id,factionId)))[0] as any,
  goals:await db.select().from(factionGoals).where(eq(factionGoals.storyId,storyId)) as any,resources:await db.select().from(factionResources).where(eq(factionResources.storyId,storyId)) as any,
  members:await db.select().from(factionMemberships).where(eq(factionMemberships.storyId,storyId)) as any,actors:await db.select().from(entities).where(eq(entities.storyId,storyId)) as any,
  beliefs:await db.select().from(npcBeliefs).where(eq(npcBeliefs.storyId,storyId)) as any,links:await db.select().from(npcEventLinks).where(eq(npcEventLinks.storyId,storyId)) as any,
  events:await db.select().from(storyEvents).where(eq(storyEvents.storyId,storyId)) as any,
  obligations:await db.select().from(agreements).where(eq(agreements.storyId,storyId)) as any,relationships:await db.select().from(relationships).where(eq(relationships.storyId,storyId)) as any,plan:null});
}
integration('persists complete relief negotiation, holds transit, settles once, expires concession and preserves private presentation',async()=>{
 const f=await fixture();
 expect(await advanceNegotiation(f.key,'offer',adapter)).toMatchObject({status:'offer'});
 await day(f.key,1);expect(await advanceNegotiation(f.key,'counter',adapter)).toMatchObject({status:'counteroffer'});
 await day(f.key,2);expect(await advanceNegotiation(f.key,'accept',adapter)).toMatchObject({status:'agreed'});
 const inventories=async()=>getDb().execute(sql`select amount,metadata from faction_resources where id in (${f.sr},${f.rr}) order by id`);
 expect((await inventories())[0]).toMatchObject({amount:100,metadata:{reservedGrain:40}});
 await day(f.key,3);expect(await advanceNegotiation(f.key,'transit',adapter)).toMatchObject({status:'agreed'});
 await day(f.key,4);expect(await advanceNegotiation(f.key,'delivery',adapter)).toMatchObject({status:'delivered'});
 expect(await advanceNegotiation(f.key,'delivery',adapter)).toMatchObject({status:'delivered',repeated:true});
 expect((await inventories()).map(row=>row.amount)).toEqual([60,50]);
 const eventTypes=await getDb().execute(sql`select type from story_events where story_id=${f.key}`); for(const row of eventTypes) expect(storyEventTypeSchema.safeParse(row.type).success).toBe(true);
 const publicEvents=await getDb().execute(sql`select body from story_events where story_id=${f.key} and visibility='public'`);
 expect(publicEvents).toHaveLength(1);expect(JSON.stringify(publicEvents)).not.toMatch(/toll|exemption|mandate/);
 await day(f.key,14);expect(await advanceNegotiation(f.key,'expiry',adapter)).toMatchObject({status:'completed'});
 expect((await getDb().execute(sql`select status from agreements where story_id=${f.key}`))[0].status).toBe('fulfilled');
},30000);
integration('fails blocked delivery without fabricating betrayal or losing reserved inventory',async()=>{
 const f=await fixture(true);await advanceNegotiation(f.key,'offer',adapter);await day(f.key,1);await advanceNegotiation(f.key,'counter',adapter);await day(f.key,2);await advanceNegotiation(f.key,'accept',adapter);await day(f.key,4);
 expect(await advanceNegotiation(f.key,'delivery',adapter)).toMatchObject({status:'failed'});
 const rows=await getDb().execute(sql`select amount,metadata from faction_resources where id in (${f.sr},${f.rr}) order by id`);
 expect(rows.map(row=>row.amount)).toEqual([100,10]);expect(rows[0].metadata).toMatchObject({reservedGrain:0});
 expect(JSON.stringify(await getDb().execute(sql`select body from story_events where story_id=${f.key} and visibility='public'`))).not.toMatch(/betray|blocked|road|toll/);
},30000);
integration('shows the Director where the story stands now',async()=>{
 const f=await fixture();let gardenerInput:any=null;controls.onGenerate=async input=>{if(input.unresolved)gardenerInput=input;};
 await getDb().execute(sql`insert into chapters(id,story_id,number,title,scene_outcome) values(${f.key+'_ch1'},${f.key},1,'The Old Request','Older chapter.'),(${f.key+'_ch2'},${f.key},2,'Relief at the Ford','[RECENT STORY STATE =\nThe League sends grain to the ford.\nNow: the Regency weighs the offer.\n]')`);
 expect(await reviewGardener(f.key)).toMatchObject({status:'reviewed'});
 expect(gardenerInput.currentSituation.map((row:any)=>row.title)).toEqual(['The Old Request','Relief at the Ford']);
 expect(gardenerInput.currentSituation[1].summary).toBe('The League sends grain to the ford.\nNow: the Regency weighs the offer.');
 expect(controls.prompts.gardener).toContain('currentSituation is where the story stands now');
},30000);
integration('rejects stale/interrupted writes and releases the background lock',async()=>{
 const f=await fixture(); const interrupted:NegotiationAdapters={...adapter,plan:async input=>{await day(f.key,1);return adapter.plan(input);}};
 expect(await advanceNegotiation(f.key,'interrupted',interrupted)).toMatchObject({status:'held',reason:'stale_inventory_or_context'});
 const [row]=await getDb().execute(sql`select metadata from stories where id=${f.key}`);expect((row.metadata as any).factionWorkflow.negotiation.revision).toBe(0);
 await expect(withFactionLane(async()=>{throw new Error('interrupted');})).rejects.toThrow('interrupted');
 expect(await withFactionLane(async()=>({status:'released'}))).toEqual({status:'released'});
 expect(await advanceNegotiation(f.key,'recovered',adapter)).toMatchObject({status:'offer'});
 expect(await withFactionLane(async()=>await withFactionLane(async()=>({status:'should_not_run'})))).toEqual({status:'held',reason:'background_lane_busy'});
 await getDb().execute(sql`insert into sync_ops(id,story_id,type,status) values(${f.key+'_turn'},${f.key},'turn_command','running')`);
 expect(await withFactionLane(async()=>({status:'should_not_run'}))).toEqual({status:'held',reason:'interactive_turn_has_priority'});
 // A reservation abandoned by a stopped process no longer holds planning.
 await getDb().execute(sql`update sync_ops set created_at=now()-interval '2 hours' where id=${f.key+'_turn'}`);
 expect(await withFactionLane(async()=>({status:'ran'}))).toEqual({status:'ran'});
 await getDb().execute(sql`update sync_ops set status='failed' where id=${f.key+'_turn'}`);
},30000);
integration('records intentions and forecasts separately, coalesces unchanged input and holds missing models',async()=>{
 const f=await fixture();const count=async()=>Number((await getDb().execute(sql`select count(*) as n from story_events where story_id=${f.key}`))[0].n);
 const before=await count();expect(await reviewFactionIntentions(f.key,'review',[f.supplier])).toMatchObject({reviewed:1,createdEvents:0});
 const calls=controls.calls;expect(await reviewFactionIntentions(f.key,'repeat',[f.supplier])).toMatchObject({reviewed:0});expect(controls.calls).toBe(calls);
 let gardenerInput:any=null;controls.onGenerate=async input=>{if(input.unresolved)gardenerInput=input;};
 expect(await reviewGardener(f.key)).toMatchObject({forecastCount:1,eventCount:0});expect(await count()).toBe(before);
 expect(gardenerInput).toMatchObject({currentSituation:[],unresolved:[expect.objectContaining({lastUpdated:expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)})]});
 controls.onGenerate=null;
 controls.invalidForecast=true;
 await getDb().execute(sql`update story_threads set description='A changed relief request still awaiting consent.' where story_id=${f.key}`);
 expect(await reviewGardener(f.key)).toMatchObject({status:'held',reason:'Unsupported forecast evidence.',forecastCount:0,eventCount:0});
 const [rejected]=await getDb().execute(sql`select metadata from stories where id=${f.key}`);
 expect((rejected.metadata as any).factionWorkflow.forecasts).toEqual([]);expect(await count()).toBe(before);controls.invalidForecast=false;
 controls.missing=true;await getDb().execute(sql`update faction_goals set goal='Offer protection after new kindness' where story_id=${f.key}`);
 expect(await reviewFactionIntentions(f.key,'missing',[f.supplier])).toMatchObject({reviewed:1});
 const [stored]=await getDb().execute(sql`select metadata from stories where id=${f.key}`);
 expect((stored.metadata as any).factionWorkflow.attempts.at(-1)).toMatchObject({status:'held',reason:'Decision model unavailable; hold.'});controls.missing=false;
 expect(await reviewFactionIntentions(f.key,'model-recovered',[f.supplier])).toMatchObject({reviewed:1});
 expect(await reviewFactionIntentions(f.key,'unchanged-after-recovery',[f.supplier])).toMatchObject({reviewed:0});
 fs.mkdirSync('.codex-run',{recursive:true});fs.writeFileSync('.codex-run/faction-workflow-fixture.json',JSON.stringify({storyId:f.key,qualification:'real isolated database; mocked model adapters'}));
},30000);
integration.each(['aid','pressure'])('closes the actual extraction → %s intention → dynamic GM cue → observed response loop',async family=>{
 controls.family=family;controls.missing=false;controls.invalidForecast=false;
 const f=await fixture();const db=getDb(),maera=f.key+'_maera',rowan=f.key+'_rowan',corvin=f.key+'_corvin',hall=f.key+'_hall',house=f.key+'_house';
 await db.execute(sql`insert into entities(id,story_id,type,name,state) values(${house},${f.key},'faction','Granary League','{}'::jsonb),(${maera},${f.key},'character','Maera',${JSON.stringify({locationId:hall,present:true,personality:'Generous, with dry humor; firm about unkept promises.'})}::jsonb),(${rowan},${f.key},'character','Rowan','{}'::jsonb),(${corvin},${f.key},'character','Corvin','{}'::jsonb),(${hall},${f.key},'location','Council hall','{}'::jsonb)`);
 await db.execute(sql`insert into entity_aliases(id,story_id,entity_id,alias,normalized_alias) values(${f.key+'_alias'},${f.key},${maera},'The Mudlark','the mudlark')`);
 await db.execute(sql`update factions set entity_id=${house} where id=${f.supplier}`);
 await db.execute(sql`insert into faction_memberships(id,story_id,faction_id,entity_id,role) values(${f.key+'_leader'},${f.key},${f.supplier},${maera},'leader'),(${f.key+'_member'},${f.key},${f.supplier},${corvin},'member')`);
 await db.execute(sql`insert into npc_beliefs(id,story_id,believer_entity_id,belief) values(${f.key+'_secret'},${f.key},${corvin},'UNSHARED_MEMBER_SECRET: replace Maera after the council.')`);
 await db.execute(sql`update stories set current_location_id=${hall} where id=${f.key}`);
 const learned=family==='aid'?'The Mudlark hears Rowan confirm that Hillmarch sheltered the wounded freely. The Mudlark promises Rowan she will invite him to supper.':'The Mudlark hears Rowan refuse the promised shipment. The Mudlark names Rowan an opponent and promises to request a written explanation.';
 const resulting=family==='aid'?'The Mudlark invites Rowan to supper. Rowan declines politely; no grain moves.':'The Mudlark requests a written explanation from Rowan. Rowan refuses to provide it; no debt is paid and no grain moves.';
 const disposition=family==='aid'?'allied-with':'enemy-of';
 const initial={relationships:[{sourceName:'The Mudlark',targetName:'Rowan',type:disposition,label:family==='aid'?'Gratitude for shelter freely given.':'Opposition over a refused shipment.',known_by:['The Mudlark'],evidence:learned}],agreements:[{action:'create',parties:['The Mudlark','Rowan'],category:'promise',terms:family==='aid'?'Invite Rowan to supper.':'Request a written explanation.',known_by:['The Mudlark'],evidence:learned}],timeline_events:[{title:'Observed council exchange',type:'reveal',status:'committed',description:learned+' PRIVATE_RIVAL_PLAN is not known to Maera.',actor_names:['The Mudlark'],target_names:['Rowan'],faction_names:['Granary League'],location_name:'Council hall',actor_claims:[{text:learned,known_by:['The Mudlark'],kind:'learned',evidence:learned}]}]};
 const persist=async(entry:string,position:number,narration:string,update:unknown,stale=false)=>{
  await db.execute(sql`insert into story_entries(id,story_id,type,content,position) values(${entry},${f.key},'narration',${narration},${position}) on conflict do nothing`);
  const parsed=parseTurnUpdate({update});expect(parsed.warnings).toEqual([]);
  return applyValidatedTurnUpdate({storyId:f.key,playerEntryId:entry+'_player',assistantEntryId:entry,narration,update:stale?preserveDurableDeferredState(parsed.update):parsed.update,parseWarnings:[],retrievedMemoryIds:[],serverVersion:position,mode:'supplemental',timelineTurn:position,suppressCurrentNpcAgency:stale},{enqueueProjectionJobs:false});
 };
 const firstEntry=f.key+'_first';const applied=await persist(firstEntry,10,learned,initial);
 expect(applied.warnings).toEqual([]);
 const readPacket=async()=>actorPacket({faction:(await db.select().from(factions).where(eq(factions.id,f.supplier)))[0] as any,
  goals:await db.select().from(factionGoals).where(eq(factionGoals.storyId,f.key)) as any,resources:await db.select().from(factionResources).where(eq(factionResources.storyId,f.key)) as any,
  members:await db.select().from(factionMemberships).where(eq(factionMemberships.storyId,f.key)) as any,actors:await db.select().from(entities).where(eq(entities.storyId,f.key)) as any,
  beliefs:await db.select().from(npcBeliefs).where(eq(npcBeliefs.storyId,f.key)) as any,links:await db.select().from(npcEventLinks).where(eq(npcEventLinks.storyId,f.key)) as any,
  events:await db.select().from(storyEvents).where(eq(storyEvents.storyId,f.key)).orderBy(sql`created_turn desc`) as any,
  obligations:await db.select().from(agreements).where(eq(agreements.storyId,f.key)) as any,relationships:await db.select().from(relationships).where(eq(relationships.storyId,f.key)) as any,plan:null});
 const packet=await readPacket();expect(packet.actor.decisionActorIds).toEqual([maera]);expect(packet.evidence.some(e=>e.claim===learned)).toBe(true);
 const [learnedEvent]=await db.execute(sql`select id from story_events where story_id=${f.key} and title='Observed council exchange'`);
 const queueInput={storyId:f.key,eventIds:[String(learnedEvent.id)],memoryNodeIds:[],patchIds:applied.patchIds,serverVersion:10};
 await enqueueTurnProjectionJobs(queueInput);await enqueueTurnProjectionJobs(queueInput);
 const wakes=await db.execute(sql`select type,payload from backend_jobs where story_id=${f.key} and type in ('evaluate_world_sim_tick','plan_plot_brain')`);
 expect(wakes).toHaveLength(2);expect(wakes.find(row=>row.type==='evaluate_world_sim_tick')?.payload).toMatchObject({materialFactionIds:[f.supplier]});
 expect(packet.actor.relationships).toEqual([expect.objectContaining({kind:disposition})]);expect(packet.actor.obligations).toEqual([expect.objectContaining({status:'active',terms:learned.slice(0,240)})]);
 expect(JSON.stringify(packet)).not.toMatch(/PRIVATE_RIVAL_PLAN|UNSHARED_MEMBER_SECRET/);
 expect(buildStateExtractionPrompt('',learned)).toContain('timeline_events.actor_claims');
 expect(await reviewFactionIntentions(f.key,'observed-council',[f.supplier])).toMatchObject({reviewed:1,createdEvents:0});
 const latest=controls.plannerPackets.at(-1);expect(latest.evidence.some((e:any)=>e.claim===learned)).toBe(true);expect(latest.actor.decisionActorIds).toEqual([maera]);
 const [story]=await db.select().from(stories).where(eq(stories.id,f.key));const workflow=record(record(story.metadata).factionWorkflow),attempt=(workflow.attempts as any[]).at(-1);
 expect(attempt).toMatchObject({status:'intended',intention:{family},actorEntityIds:[maera],locationId:hall});
 const ctx={story,entities:await db.select().from(entities).where(eq(entities.storyId,f.key)),recentEntries:[],factions:[],factionMemberships:[],factionResources:[],factionGoals:[],factionProjects:[],agreements:[],threads:[],events:[],beliefs:[],facts:[],patchProposals:[],continuityWarnings:[],chapters:[],arcs:[],sagas:[],gmBrief:null} as unknown as TurnContext;
 const action='I let Maera speak, keeping my choice open.';const retrieved={storyId:f.key,query:action,packet:'',nodes:[],tokenEstimate:0,retrievalDebug:[],retrievalTrace:[]} as RetrievedMemoryPacket;
 const gm=buildServerTurnPrompt(ctx,retrieved,'loop',{playerAction:action,presentNpcIds:[maera]});
 expect(gm.factionCueSelection?.sourceKey).toBe('intent:'+attempt.id);expect(gm.dynamicPrompt).toContain(attempt.intention.action);expect(gm.dynamicPrompt).toContain('does not settle');expect(gm.stableContext).not.toContain(attempt.intention.action);
 expect(intentionBrief(story.metadata,hall,[maera],[gm.factionCueSelection!.sourceKey],false)).toBeNull();
 const [commitment]=await db.select().from(agreements).where(eq(agreements.storyId,f.key));
 await persist(f.key+'_result',20,resulting,{agreements:[{action:'fulfill',id:commitment.id,known_by:['The Mudlark'],evidence:resulting}],timeline_events:[{title:'Observed response',type:'reveal',status:'committed',description:resulting,actor_names:['The Mudlark'],target_names:['Rowan'],faction_names:['Granary League'],actor_claims:[{text:resulting,known_by:['The Mudlark'],kind:'witnessed',evidence:resulting}]}]});
 const refreshed=await readPacket();expect(refreshed.evidence.some(e=>e.claim===resulting)).toBe(true);expect(refreshed.actor.obligations[0].status).toBe('fulfilled');
 expect(await reviewFactionIntentions(f.key,'observed-response',[f.supplier])).toMatchObject({reviewed:1,createdEvents:0});
 const eventCount=Number((await db.execute(sql`select count(*) as n from story_events where story_id=${f.key}`))[0].n),calls=controls.calls;
 await persist(firstEntry,10,learned,initial,true);
 expect(Number((await db.execute(sql`select count(*) as n from story_events where story_id=${f.key}`))[0].n)).toBe(eventCount);
 expect((await readPacket()).actor.obligations[0].status).toBe('fulfilled');expect(await reviewFactionIntentions(f.key,'duplicate-old-source',[f.supplier])).toMatchObject({reviewed:0});expect(controls.calls).toBe(calls);
 expect((await db.select().from(factionResources).where(eq(factionResources.id,f.sr)))[0].amount).toBe(100);
 const [resolved]=await db.execute(sql`select count(*)::int as n from entities where story_id=${f.key} and name='The Mudlark'`);expect(resolved.n).toBe(0);
 controls.loopReceipts.push({family,storyId:f.key,spokesperson:maera,alias:'The Mudlark',selectedIntention:attempt.intention,firstSourceEntryId:firstEntry,resultSourceEntryId:f.key+'_result',canonicalEventCount:eventCount,unchangedAfterOldSource:true,resourceAmount:100,gmCue:gm.factionCueSelection,qualification:'actual PostgreSQL canonical/outbox/prompt adapters; deterministic mocked model outputs'});
 controls.family='aid';
},30000);
integration('coalesces repeated review after reconnect and reevaluates model or source changes while preserving intent on hold',async()=>{
 const f=await fixture();
 expect(await reviewFactionIntentions(f.key,'first',[f.supplier])).toMatchObject({status:'reviewed',reviewed:1});
 const readWorkflow=async()=>record(record((await getDb().select().from(stories).where(eq(stories.id,f.key)))[0].metadata).factionWorkflow);
 const first=(await readWorkflow()).attempts as any[];
 expect(first).toHaveLength(1);expect(first[0].status).toBe('intended');
 const before={planner:controls.calls,decision:controls.decisionCalls};
 await closeDb();await verifyTestDatabase();
 expect(await reviewFactionIntentions(f.key,'after-restart',[f.supplier])).toMatchObject({reviewed:0});
 expect({planner:controls.calls,decision:controls.decisionCalls}).toEqual(before);
 controls.plannerModel='mock-planner-v2';
 expect(await reviewFactionIntentions(f.key,'planner-model-changed',[f.supplier])).toMatchObject({reviewed:1});
 expect(controls.calls).toBe(before.planner+1);expect(controls.decisionCalls).toBe(before.decision+1);
 controls.decisionModel='kev-new-revision';
 expect(await reviewFactionIntentions(f.key,'decision-model-changed',[f.supplier])).toMatchObject({reviewed:1});
 const intended=((await readWorkflow()).attempts as any[]).find(row=>row.status==='intended');expect(intended).toBeDefined();
 controls.abstain=true;
 await getDb().execute(sql`update faction_goals set goal='Offer relief while respecting a revised council request' where faction_id=${f.supplier}`);
 expect(await reviewFactionIntentions(f.key,'new-source-held',[f.supplier])).toMatchObject({reviewed:1});
 const held=(await readWorkflow()).attempts as any[];
 expect(held.at(-1)).toMatchObject({status:'held',reason:'decision_abstained'});
 expect(held.find(row=>row.id===intended.id)).toMatchObject({status:'intended',intention:intended.intention});
 const heldCalls={planner:controls.calls,decision:controls.decisionCalls};
 expect(await reviewFactionIntentions(f.key,'duplicate-held-source',[f.supplier])).toMatchObject({reviewed:0});
 expect({planner:controls.calls,decision:controls.decisionCalls}).toEqual(heldCalls);
 expect((await getDb().execute(sql`select amount from faction_resources where id=${f.sr}`))[0].amount).toBe(100);
},30000);
integration('serializes competing review jobs without duplicate planner or decision dispatch',async()=>{
 const f=await fixture();let started!:()=>void,release!:()=>void;
 const began=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 controls.onGenerate=async()=>{started();await gate;};
 const before={planner:controls.calls,decision:controls.decisionCalls};
 const first=reviewFactionIntentions(f.key,'first-worker',[f.supplier]);
 await began;
 try{expect(await reviewFactionIntentions(f.key,'competing-worker',[f.supplier])).toEqual({status:'held',reason:'background_lane_busy'});}
 finally{release();}
 expect(await first).toMatchObject({status:'reviewed',reviewed:1});
 controls.onGenerate=null;
 expect(await reviewFactionIntentions(f.key,'competing-worker-retry',[f.supplier])).toMatchObject({reviewed:0});
 expect({planner:controls.calls,decision:controls.decisionCalls}).toEqual({planner:before.planner+1,decision:before.decision+1});
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));
 expect(record(record(story.metadata).factionWorkflow).attempts).toHaveLength(1);
},30000);
integration('does not let its generated intention rerank canonical evidence into another planner dispatch',async()=>{
 const f=await fixture(),speaker=f.key+'_speaker';
 await getDb().execute(sql`insert into entities(id,story_id,type,name) values(${speaker},${f.key},'character','League steward')`);
 await getDb().execute(sql`update factions set entity_id=${speaker} where id=${f.supplier}`);
 const beliefs=['The eastern watch changed its banner.','The river bridge has a narrow path.','The market bells now ring at dawn.','Relief caravans offered warm gratitude and past shelter.'];
 for(const [index,belief] of beliefs.entries())await getDb().execute(sql`insert into npc_beliefs(id,story_id,believer_entity_id,belief,updated_at) values(${f.key+'_belief_'+index},${f.key},${speaker},${belief},${`2026-01-0${4-index}T00:00:00Z`}::timestamptz)`);
 expect(await reviewFactionIntentions(f.key,'first-ranking',[f.supplier])).toMatchObject({reviewed:1});
 const packet=controls.plannerPackets.at(-1);expect(packet.evidence).toHaveLength(3);expect(packet.evidence.map((item:any)=>item.claim)).not.toContain(beliefs[3]);
 const before={planner:controls.calls,decision:controls.decisionCalls};
 expect(await reviewFactionIntentions(f.key,'after-generated-plan',[f.supplier])).toMatchObject({reviewed:0});
 expect({planner:controls.calls,decision:controls.decisionCalls}).toEqual(before);
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));expect(record(record(story.metadata).factionWorkflow).attempts).toHaveLength(1);
},30000);
integration('reports zero persisted forecasts when a concurrent story update rejects the save',async()=>{
 const f=await fixture();
 expect(await reviewGardener(f.key)).toMatchObject({status:'reviewed',forecastCount:1});
 const snapshot=(await getDb().select().from(stories).where(eq(stories.id,f.key)))[0];
 const previousWorkflow=record(snapshot.metadata).factionWorkflow;
 await getDb().execute(sql`update story_threads set description='The request changes while the gardener is considering it.' where story_id=${f.key}`);
 controls.onGenerate=async input=>{if(input.unresolved)await getDb().execute(sql`update stories set server_version=server_version+1 where id=${f.key}`);};
 expect(await reviewGardener(f.key)).toMatchObject({status:'held',reason:'stale_snapshot',forecastCount:0,eventCount:0});
 const after=(await getDb().select().from(stories).where(eq(stories.id,f.key)))[0];
 expect(record(after.metadata).factionWorkflow).toEqual(previousWorkflow);
 expect(after.serverVersion).toBe(snapshot.serverVersion+1);
},30000);
integration('holds duplicate forecast IDs without storing ambiguous forecasts or retrying unchanged input',async()=>{
 const f=await fixture();controls.duplicateForecast=true;
 expect(await reviewGardener(f.key)).toMatchObject({status:'held',forecastCount:0,eventCount:0});
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));
 expect(record(record(story.metadata).factionWorkflow).forecasts).toEqual([]);
 const calls=controls.calls;
 expect(await reviewGardener(f.key)).toMatchObject({status:'skipped',reason:'unchanged_context'});
 expect(controls.calls).toBe(calls);
},30000);
integration('honors authored fallback goals, normalized completion, and manual project revisions',async()=>{
 const f=await fixture();
 await getDb().execute(sql`update factions set metadata='{"worldSimEnabled":false}'::jsonb where id=${f.supplier}`);
 expect(await reviewFactionIntentions(f.key,'authored-fallback')).toMatchObject({reviewed:1});
 expect(controls.plannerPackets.at(-1).actor.goals).toEqual([expect.objectContaining({goal:'Receive relief within council authority'})]);
 await getDb().execute(sql`insert into faction_goals(id,story_id,faction_id,goal,status) values(${f.key+'_completed_goal'},${f.key},${f.recipient},'Receive relief within council authority','completed')`);
 const calls=controls.calls;
 expect(await reviewFactionIntentions(f.key,'completed-normalized-goal')).toMatchObject({reviewed:0});expect(controls.calls).toBe(calls);
 await getDb().execute(sql`update faction_goals set status='active',goal='Review a relief plan' where id=${f.key+'_completed_goal'}`);
 await getDb().execute(sql`insert into faction_projects(id,story_id,faction_id,project,status,progress) values(${f.key+'_manual'},${f.key},${f.recipient},'Discuss relief arrangements','active',0)`);
 expect(await reviewFactionIntentions(f.key,'manual-project-initial',[f.recipient])).toMatchObject({reviewed:1});
 const acceptedCalls=controls.calls;
 expect(await reviewFactionIntentions(f.key,'manual-project-repeat',[f.recipient])).toMatchObject({reviewed:0});
 await getDb().execute(sql`update faction_projects set project='Discuss consent before relief arrangements',progress=0.25,server_version=server_version+1 where id=${f.key+'_manual'}`);
 expect(await reviewFactionIntentions(f.key,'manual-project-changed',[f.recipient])).toMatchObject({reviewed:1});expect(controls.calls).toBe(acceptedCalls+1);
},30000);
integration.each(['linked_archived','merged','scratch','disabled'])('does not send %s factions to the planner',async eligibility=>{
 const f=await fixture();
 if(eligibility==='linked_archived'){
  await getDb().execute(sql`insert into entities(id,story_id,type,name,status) values(${f.key+'_archived_entity'},${f.key},'faction','Archived League','archived')`);
  await getDb().execute(sql`update factions set entity_id=${f.key+'_archived_entity'} where id=${f.supplier}`);
 }else{
  const metadata=eligibility==='merged'?{mergedInto:f.recipient}:eligibility==='scratch'?{scratchSeed:true}:{worldSimEnabled:false};
  await getDb().execute(sql`update factions set metadata=${JSON.stringify(metadata)}::jsonb where id=${f.supplier}`);
 }
 const before={planner:controls.calls,decision:controls.decisionCalls};
 expect(await reviewFactionIntentions(f.key,'excluded',[f.supplier])).toMatchObject({reviewed:0});
 expect({planner:controls.calls,decision:controls.decisionCalls}).toEqual(before);
},30000);
integration('records a quiet held review without a pointless single-choice decision request',async()=>{
 const f=await fixture();controls.emptyOptions=true;const decisionCalls=controls.decisionCalls;
 expect(await reviewFactionIntentions(f.key,'quiet',[f.supplier])).toMatchObject({reviewed:1,createdEvents:0});
 expect(controls.decisionCalls).toBe(decisionCalls);
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));
 expect((record(record(story.metadata).factionWorkflow).attempts as any[]).at(-1)).toMatchObject({status:'held',reason:'no_grounded_options'});
 const calls=controls.calls;expect(await reviewFactionIntentions(f.key,'quiet-repeat',[f.supplier])).toMatchObject({reviewed:0});expect(controls.calls).toBe(calls);
},30000);
integration.each(['cancelled','edited_terms','edited_parties'])('holds %s canonical agreements before delivery without consuming inventory',async change=>{
 const f=await fixture();await advanceNegotiation(f.key,'offer',adapter);await day(f.key,1);await advanceNegotiation(f.key,'counter',adapter);await day(f.key,2);await advanceNegotiation(f.key,'accept',adapter);
 if(change==='cancelled')await getDb().execute(sql`update agreements set status='deleted',server_version=server_version+1 where story_id=${f.key}`);
 else if(change==='edited_terms')await getDb().execute(sql`update agreements set terms='The parties have revised their agreement; await fresh consent.',server_version=server_version+1 where story_id=${f.key}`);
 else await getDb().execute(sql`update agreements set parties=${JSON.stringify([f.supplier])}::jsonb,server_version=server_version+1 where story_id=${f.key}`);
 await day(f.key,4);
 const before=(await getDb().select().from(stories).where(eq(stories.id,f.key)))[0];
 const [agreementBefore]=await getDb().select().from(agreements).where(eq(agreements.storyId,f.key));
 expect(await advanceNegotiation(f.key,'cancelled-delivery',adapter)).toMatchObject({status:'held',reason:'agreement_changed'});
 const rows=await getDb().execute(sql`select amount,metadata from faction_resources where id in (${f.sr},${f.rr}) order by id`);
 expect(rows[0]).toMatchObject({amount:100,metadata:{reservedGrain:40}});expect(rows[1].amount).toBe(10);
 const after=(await getDb().select().from(stories).where(eq(stories.id,f.key)))[0];expect(after.metadata).toEqual(before.metadata);expect(after.serverVersion).toBe(before.serverVersion);
 expect((await getDb().execute(sql`select status from agreements where story_id=${f.key}`))[0].status).toBe(change==='cancelled'?'deleted':'active');
 expect((await getDb().select().from(agreements).where(eq(agreements.storyId,f.key)))[0]).toEqual(agreementBefore);
},30000);
integration.each(['failed','fulfilled','fulfilled_jump'])('projects %s negotiation commitments only into participating actor knowledge',async outcome=>{
 const f=await fixture(outcome==='failed'),observer=f.key+'_observer',observerFaction=f.key+'_observer_faction';
 await getDb().execute(sql`insert into entities(id,story_id,type,name) values(${observer},${f.key},'character','Passing merchant')`);
 await getDb().execute(sql`insert into factions(id,story_id,name,entity_id) values(${observerFaction},${f.key},'Unaffiliated merchants',${observer})`);
 await advanceNegotiation(f.key,'offer',adapter);await day(f.key,1);await advanceNegotiation(f.key,'counter',adapter);await day(f.key,2);await advanceNegotiation(f.key,'accept',adapter);
 const [agreement]=await getDb().select().from(agreements).where(eq(agreements.storyId,f.key));
 for(const participant of [f.supplier,f.recipient])expect((await persistedActorPacket(f.key,participant)).actor.obligations).toEqual([expect.objectContaining({id:agreement.id,status:'active'})]);
 expect((await persistedActorPacket(f.key,observerFaction)).actor.obligations).toEqual([]);
 await day(f.key,outcome==='fulfilled_jump'?14:4);expect(await advanceNegotiation(f.key,'delivery',adapter)).toMatchObject({status:outcome==='failed'?'failed':outcome==='fulfilled_jump'?'completed':'delivered'});
 if(outcome==='fulfilled'){await day(f.key,14);expect(await advanceNegotiation(f.key,'expiry',adapter)).toMatchObject({status:'completed'});}
 const expected=outcome==='failed'?'broken':'fulfilled';
 for(const participant of [f.supplier,f.recipient]){
  const packet=await persistedActorPacket(f.key,participant);
  expect(packet.actor.obligations).toEqual([expect.objectContaining({id:agreement.id,status:expected})]);
  expect(packet.sourceIds).toContain(agreement.id);
 }
 const publicEvents=await getDb().select().from(storyEvents).where(eq(storyEvents.storyId,f.key));
 for(const event of publicEvents.filter(row=>row.visibility==='public'))await getDb().execute(sql`insert into npc_event_links(id,story_id,event_id,npc_entity_id,role,visibility) values(${f.key+'_witness_'+event.id},${f.key},${event.id},${observer},'witness','public')`);
 const outsider=await persistedActorPacket(f.key,observerFaction);
 expect(outsider.actor.obligations).toEqual([]);expect(outsider.sourceIds).not.toContain(agreement.id);
 expect(JSON.stringify(outsider)).not.toContain('grain for');expect(JSON.stringify(outsider)).not.toContain('toll exemption');
 const [canonical]=await getDb().select().from(agreements).where(eq(agreements.id,agreement.id));expect(canonical.status).toBe(expected);
},30000);
integration.each(['cancelled','revised_cost'])('rejects a %s due project after audit without a canonical outcome',async revision=>{
 const f=await fixture(),projectId=f.key+'_due';
 await getDb().execute(sql`insert into faction_projects(id,story_id,faction_id,project,status,progress,due_turn,costs) values(${projectId},${f.key},${f.supplier},'Offer a modest relief shipment','active',1,0,'{}'::jsonb)`);
 const audit=await auditDueFactionProjects({storyId:f.key});expect(audit.proposalIds).toHaveLength(1);
 expect(await auditDueFactionProjects({storyId:f.key})).toMatchObject({proposalCount:0,proposalIds:[]});
 const beforeCount=(await getDb().execute(sql`select count(*)::int as n from story_events where story_id=${f.key}`))[0].n;
 if(revision==='cancelled')await getDb().execute(sql`update faction_projects set status='cancelled',server_version=server_version+1 where id=${projectId}`);
 else await getDb().execute(sql`update faction_projects set costs='{"grain":4}'::jsonb,server_version=server_version+1 where id=${projectId}`);
 const [before]=await getDb().select().from(stories).where(eq(stories.id,f.key));
 await expect(reviewPatchProposal({storyId:f.key,proposalId:audit.proposalIds[0],decision:'approved',reviewer:'fixture-human'})).rejects.toThrow(/changed.*audit/i);
 expect((await getDb().execute(sql`select count(*)::int as n from story_events where story_id=${f.key}`))[0].n).toBe(beforeCount);
 expect((await getDb().execute(sql`select status from patch_proposals where id=${audit.proposalIds[0]}`))[0].status).toBe('pending');
 expect((await getDb().select().from(stories).where(eq(stories.id,f.key)))[0].serverVersion).toBe(before.serverVersion);
 expect((await getDb().execute(sql`select amount from faction_resources where id=${f.sr}`))[0].amount).toBe(100);
},30000);
integration('does not partly reserve supplier inventory when recipient inventory changes during acceptance',async()=>{
 const f=await fixture();await advanceNegotiation(f.key,'offer',adapter);await day(f.key,1);await advanceNegotiation(f.key,'counter',adapter);await day(f.key,2);
 const before=(await getDb().select().from(stories).where(eq(stories.id,f.key)))[0];
 const countBefore=(await getDb().execute(sql`select count(*)::int as n from story_events where story_id=${f.key}`))[0].n;
 const racing:NegotiationAdapters={...adapter,plan:async input=>{
  await getDb().execute(sql`update faction_resources set amount=amount+3 where id=${f.rr}`);
  return adapter.plan(input);
 }};
 expect(await advanceNegotiation(f.key,'accept-race',racing)).toMatchObject({status:'held',reason:'stale_inventory_or_context'});
 const rows=await getDb().execute(sql`select amount,metadata from faction_resources where id in (${f.sr},${f.rr}) order by id`);
 expect(rows[0]).toMatchObject({amount:100,metadata:{reservedGrain:0}});expect(rows[1].amount).toBe(13);
 expect((await getDb().execute(sql`select count(*)::int as n from agreements where story_id=${f.key}`))[0].n).toBe(0);
 expect((await getDb().execute(sql`select count(*)::int as n from story_events where story_id=${f.key}`))[0].n).toBe(countBefore);
 const after=(await getDb().select().from(stories).where(eq(stories.id,f.key)))[0];expect(after.metadata).toEqual(before.metadata);expect(after.serverVersion).toBe(before.serverVersion);
 expect(await advanceNegotiation(f.key,'accept-after-race',adapter)).toMatchObject({status:'agreed'});
 expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.sr}`))[0]).toMatchObject({amount:100,metadata:{reservedGrain:40}});
},30000);
integration.each(['cancelled_route','changed_authority'])('rejects %s evidence changed during acceptance without reserving inventory',async change=>{
 const f=await fixture();await advanceNegotiation(f.key,'offer',adapter);await day(f.key,1);await advanceNegotiation(f.key,'counter',adapter);await day(f.key,2);
 const before=(await getDb().select().from(stories).where(eq(stories.id,f.key)))[0];
 const racing:NegotiationAdapters={...adapter,plan:async input=>{
  if(change==='cancelled_route')await getDb().execute(sql`update story_events set status='cancelled',server_version=server_version+1 where id=${f.key+'_route'}`);
  else await getDb().execute(sql`update story_events set metadata=jsonb_set(metadata,'{tollAuthority,factionId}',to_jsonb(${f.supplier}::text)),server_version=server_version+1 where id=${f.key+'_authority'}`);
  return adapter.plan(input);
 }};
 expect(await advanceNegotiation(f.key,'accept-race',racing)).toMatchObject({status:'held',reason:'stale_inventory_or_context'});
 expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.sr}`))[0]).toMatchObject({amount:100,metadata:{reservedGrain:0}});
 expect((await getDb().execute(sql`select count(*)::int as n from agreements where story_id=${f.key}`))[0].n).toBe(0);
 const after=(await getDb().select().from(stories).where(eq(stories.id,f.key)))[0];expect(after.metadata).toEqual(before.metadata);expect(after.serverVersion).toBe(before.serverVersion);
},30000);
integration('commits the fifth-turn wake atomically and queues a deferred clock change without advancing the turn',async()=>{
 const f=await fixture(),db=getDb();
 await db.execute(sql`update stories set current_turn=4 where id=${f.key}`);
 const input={storyId:f.key,playerEntryId:f.key+'_player',assistantEntryId:f.key+'_fifth',narration:'The council remains quiet.',update:parseTurnUpdate({update:{}}).update,parseWarnings:[],retrievedMemoryIds:[],serverVersion:10,mode:'turn' as const};
 await db.execute(sql`insert into story_entries(id,story_id,type,content,position) values(${input.assistantEntryId},${f.key},'narration',${input.narration},10)`);
 await expect(db.transaction(async tx=>{
  await applyValidatedTurnUpdate(input,{transaction:tx,enqueueProjectionJobs:false});
  expect((await tx.execute(sql`select current_turn from stories where id=${f.key}`))[0].current_turn).toBe(5);
  expect((await tx.execute(sql`select count(*)::int as n from backend_jobs where story_id=${f.key} and type='evaluate_world_sim_tick'`))[0].n).toBe(1);
  throw new Error('fixture rollback after cadence insert');
 })).rejects.toThrow('fixture rollback');
 expect((await db.execute(sql`select current_turn from stories where id=${f.key}`))[0].current_turn).toBe(4);
 expect((await db.execute(sql`select count(*)::int as n from backend_jobs where story_id=${f.key}`))[0].n).toBe(0);
 await applyValidatedTurnUpdate(input,{enqueueProjectionJobs:false});
 await enqueueFactionCadenceJob({storyId:f.key,currentTurn:5});
 const fifthJobs=await db.execute(sql`select id,status from backend_jobs where story_id=${f.key} and type='evaluate_world_sim_tick'`);
 expect(fifthJobs).toHaveLength(1);expect(fifthJobs[0].id).toBe(stableJobId(f.key,'evaluate_world_sim_tick','world-sim-turn-5'));
 await db.execute(sql`update backend_jobs set status='succeeded' where id=${fifthJobs[0].id}`);
 await closeDb();await verifyTestDatabase();
 await enqueueFactionCadenceJob({storyId:f.key,currentTurn:5});
 expect((await getDb().execute(sql`select status from backend_jobs where id=${fifthJobs[0].id}`))[0].status).toBe('succeeded');
 const deferred={...input,assistantEntryId:f.key+'_elapsed',narration:'[Time: Noon | Day: 1 | Location: Unknown]\nThe council waits for the next report.',mode:'supplemental' as const,serverVersion:11};
 await getDb().execute(sql`insert into story_entries(id,story_id,type,content,position) values(${deferred.assistantEntryId},${f.key},'narration',${deferred.narration},11)`);
 await applyValidatedTurnUpdate(deferred,{enqueueProjectionJobs:false});
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));
 expect(story.currentTurn).toBe(5);expect(story.currentWorldTime).toBe('Day 1 | Noon');
 const clocks=await getDb().execute(sql`select id,payload from backend_jobs where story_id=${f.key} and type='evaluate_world_sim_tick'`);
 expect(clocks).toHaveLength(2);expect(clocks).toContainEqual(expect.objectContaining({id:stableJobId(f.key,'evaluate_world_sim_tick','faction-world-time-Day 1 | Noon'),payload:expect.objectContaining({scheduledForTurn:5})}));
 await applyValidatedTurnUpdate(deferred,{enqueueProjectionJobs:false});
 expect((await getDb().execute(sql`select count(*)::int as n from backend_jobs where story_id=${f.key} and type='evaluate_world_sim_tick'`))[0].n).toBe(2);
},30000);
integration('withholds ambiguous identities, unquoted claims, OOC evidence and scheduled outcomes',async()=>{
 const f=await fixture(),db=getDb(),a=f.key+'_a',b=f.key+'_b';
 await db.execute(sql`insert into entities(id,story_id,type,name) values(${a},${f.key},'character','Maera'),(${b},${f.key},'character','Merra')`);
 await db.execute(sql`insert into entity_aliases(id,story_id,entity_id,alias,normalized_alias) values(${f.key+'_aa'},${f.key},${a},'The Mudlark','the mudlark'),(${f.key+'_ab'},${f.key},${b},'The Mudlark','the mudlark')`);
 const evidence='The Mudlark heard that the road was closed. Unknown Person heard a rumor. Maera will bring grain tomorrow.';
 for(const [suffix,metadata,status] of [['canon',{},'committed'],['ooc',{nonCanon:true},'committed'],['future',{},'scheduled']] as const){
  const entry=f.key+'_'+suffix;
  await db.execute(sql`insert into story_entries(id,story_id,type,content,position,metadata) values(${entry},${f.key},'narration',${evidence},${suffix==='canon'?10:suffix==='ooc'?20:30},${JSON.stringify(metadata)}::jsonb)`);
  const update=parseTurnUpdate({timeline_events:[{title:suffix,type:'reveal',status,description:evidence,actor_claims:[{text:'The Mudlark heard that the road was closed.',known_by:['The Mudlark'],kind:'learned',evidence},{text:'Unknown Person heard a rumor.',known_by:['Unknown Person'],kind:'learned',evidence},{text:'A secret nobody said.',known_by:['Maera'],kind:'shared',evidence}]}]}).update;
  await applyValidatedTurnUpdate({storyId:f.key,playerEntryId:entry+'_player',assistantEntryId:entry,narration:evidence,update,parseWarnings:[],retrievedMemoryIds:[],serverVersion:30,mode:'supplemental'},{enqueueProjectionJobs:false});
  const [saved]=await db.execute(sql`select metadata from story_events where story_id=${f.key} and title=${suffix}`);
  expect((saved.metadata as any).actorClaims).toEqual([]);
 }
 expect((await db.execute(sql`select count(*)::int as n from entities where story_id=${f.key}`))[0].n).toBe(4);
},30000);
afterAll(async()=>{if(process.env.MYTHENGINE_FACTION_WORKFLOW_INTEGRATION==='1'&&testDatabaseVerified){
 await verifyTestDatabase();fs.mkdirSync('.codex-run',{recursive:true});
 fs.writeFileSync('.codex-run/faction-loop-evidence.json',JSON.stringify({createdAt:new Date().toISOString(),paidCalls:0,modelAdapters:'mocked',prompts:controls.prompts,loops:controls.loopReceipts},null,2));
 // Leave evidence recoverable without permitting future workers to consume synthetic wakes.
 for(const storyId of ids)await getDb().execute(sql`update backend_jobs set status='cancelled',metadata=metadata||'{"fixture":true,"qualificationHeld":true,"testPreviousStatus":"queued"}'::jsonb where story_id=${storyId} and status='queued'`);
 await closeDb();
}});

integration('stage one retains goal priorities and constraints, and reviews only meaningful clock changes',async()=>{
 const f=await fixture(),db=getDb();
 await db.execute(sql`update faction_goals set priority=1 where faction_id=${f.supplier}`);
 await db.execute(sql`insert into faction_goals(id,story_id,faction_id,goal,priority,metadata) values(${f.key+'_winter'},${f.key},${f.supplier},'Prepare winter relief',9,'{"urgency":"Winter approaches","constraints":["Keep seed grain"],"deadlineWorldTime":"Day 5"}'::jsonb),(${f.key+'_done'},${f.key},${f.supplier},'Already completed',100,'{}'::jsonb)`);
 await db.execute(sql`update faction_goals set status='completed' where id=${f.key+'_done'}`);
 expect(await reviewFactionIntentions(f.key,'goals',[f.supplier])).toMatchObject({reviewed:1});
 const p=controls.plannerPackets.at(-1);expect(p.actor.goals[0]).toMatchObject({priority:9,urgency:'Winter approaches',constraints:['Keep seed grain']});expect(JSON.stringify(p)).not.toContain('Already completed');
 const before=controls.calls;await day(f.key,4);
 expect(await reviewFactionIntentions(f.key,'clock-no-deadline',[f.supplier])).toMatchObject({reviewed:0});expect(controls.calls).toBe(before);
 await day(f.key,5);expect(await reviewFactionIntentions(f.key,'clock-deadline',[f.supplier])).toMatchObject({reviewed:1});
 expect(await reviewFactionIntentions(f.key,'clock-restart-repeat',[f.supplier])).toMatchObject({reviewed:0});
},30000);
integration('stage one retrieves old actor knowledge and newest learned commitment without rival/public leakage',async()=>{
 const f=await fixture(),db=getDb(),owner=f.key+'_supplier_owner',rival=f.key+'_rival';
 await db.execute(sql`insert into entities(id,story_id,type,name) values(${rival},${f.key},'character','Rival')`);
 await db.execute(sql`update faction_goals set goal='Deliver relief across the bridge' where faction_id=${f.supplier}`);
 await db.execute(sql`insert into npc_beliefs(id,story_id,believer_entity_id,subject_entity_id,belief,confidence,updated_at) values(${f.key+'_old_report'},${f.key},${owner},'bridge','The bridge is open for relief',0.7,'2020-01-01'),(${f.key+'_contrary'},${f.key},${owner},'bridge','The bridge is closed for relief',0.4,'2020-01-02')`);
 for(let i=0;i<305;i++)await db.execute(sql`insert into npc_beliefs(id,story_id,believer_entity_id,belief) values(${f.key+'_noise_'+i},${f.key},${rival},'PRIVATE_RIVAL: intercept relief')`);
 for(const [id,turn,status] of [['old_promise',1,'active'],['known_completion',2,'fulfilled'],['unseen_breach',3,'broken']] as const){
  await db.execute(sql`insert into story_events(id,story_id,type,title,body,created_turn,metadata) values(${f.key+'_'+id},${f.key},'reveal','Promise record','PRIVATE BODY NEVER SENT',${turn},${JSON.stringify({actorClaims:[{text:status==='fulfilled'?'The escort promise was fulfilled.':status==='broken'?'PRIVATE: the escort secretly withdrew.':'The escort promised relief.',knownBy:[status==='broken'?rival:owner],kind:'learned'}],currentAgreement:{id:f.key+'_promise',status}})}::jsonb)`);
  await db.execute(sql`insert into npc_event_links(id,story_id,event_id,npc_entity_id,role) values(${f.key+'_link_'+id},${f.key},${f.key+'_'+id},${owner},'knower')`);
 }
 for(let i=0;i<155;i++)await db.execute(sql`insert into story_events(id,story_id,type,title,body,created_turn,visibility) values(${f.key+'_public_'+i},${f.key},'reveal','Public noise','UNHEARD_PUBLIC_REPORT',${i+10},'public')`);
 expect(await reviewFactionIntentions(f.key,'old-knowledge',[f.supplier])).toMatchObject({reviewed:1});
 const p=controls.plannerPackets.at(-1);expect(p.evidence.map((e:any)=>e.id)).toEqual(expect.arrayContaining([f.key+'_old_report',f.key+'_contrary']));
 expect(p.actor.obligations).toEqual([expect.objectContaining({id:f.key+'_promise',status:'fulfilled',terms:'The escort promise was fulfilled.'})]);
 expect(JSON.stringify(p)).not.toMatch(/PRIVATE_RIVAL|PRIVATE BODY|secretly withdrew|UNHEARD_PUBLIC/);
 expect(p.evidence.find((e:any)=>e.id===f.key+'_contrary')).toMatchObject({confidence:.4,provenance:{sourceType:'npc_belief',subjectEntityId:'bridge'}});
},30000);
integration('stage one holds missing/ambiguous ownership without model calls or obsolete GM cues',async()=>{
 const f=await fixture(),db=getDb();await reviewFactionIntentions(f.key,'valid-owner',[f.supplier]);
 await db.execute(sql`update factions set entity_id=null where id=${f.supplier}`);
 const calls={planner:controls.calls,decision:controls.decisionCalls};
 expect(await reviewFactionIntentions(f.key,'missing-owner',[f.supplier])).toMatchObject({reviewed:1});
 let story=(await db.select().from(stories).where(eq(stories.id,f.key)))[0];
 let w=record(record(story.metadata).factionWorkflow);expect((w.attempts as any[]).at(-1).reason).toBe('decision_authority_missing');
 expect(intentionBrief(story.metadata,null,[f.key+'_supplier_owner'],[],false)).toBeNull();
 expect({planner:controls.calls,decision:controls.decisionCalls}).toEqual(calls);
 expect(await reviewFactionIntentions(f.key,'missing-owner-restart',[f.supplier])).toMatchObject({reviewed:0});
 await db.execute(sql`insert into faction_memberships(id,story_id,faction_id,entity_id,role,status) values(${f.key+'_owner_a'},${f.key},${f.supplier},${f.key+'_supplier_owner'},'leader','active'),(${f.key+'_owner_b'},${f.key},${f.supplier},${f.key+'_recipient_owner'},'leader','active')`);
 await reviewFactionIntentions(f.key,'ambiguous-owner',[f.supplier]);
 story=(await db.select().from(stories).where(eq(stories.id,f.key)))[0];w=record(record(story.metadata).factionWorkflow);
 expect((w.attempts as any[]).at(-1).reason).toBe('decision_authority_ambiguous');expect({planner:controls.calls,decision:controls.decisionCalls}).toEqual(calls);
 await db.execute(sql`update factions set metadata=${JSON.stringify({decisionOwnerEntityId:f.key+'_supplier_owner'})}::jsonb where id=${f.supplier}`);
 expect(await reviewFactionIntentions(f.key,'restored-owner',[f.supplier])).toMatchObject({reviewed:1});expect(controls.calls).toBe(calls.planner+1);
},30000);
integration('stage one fairly reviews a peaceful changed faction within one-call budget and retains restart deduplication',async()=>{
 const f=await fixture(),db=getDb();await db.execute(sql`update factions set pressure=100 where id=${f.supplier}`);
 const before={planner:controls.calls,decision:controls.decisionCalls};
 expect(await reviewFactionIntentions(f.key,'first-budget')).toMatchObject({reviewed:1});
 expect(controls.plannerPackets.at(-1).actor.id).toBe(f.supplier);expect(controls.calls).toBe(before.planner+1);
 await db.execute(sql`update faction_goals set goal='A newly changed relief objective' where faction_id=${f.supplier}`);
 await db.execute(sql`update stories set current_turn=5 where id=${f.key}`);
 expect(await reviewFactionIntentions(f.key,'fair-budget')).toMatchObject({reviewed:1});expect(controls.plannerPackets.at(-1).actor.id).toBe(f.recipient);
 const second=controls.calls;expect(await reviewFactionIntentions(f.key,'pending-changed')).toMatchObject({reviewed:1});expect(controls.calls).toBe(second+1);
 const final=controls.calls;expect(await reviewFactionIntentions(f.key,'restart-same')).toMatchObject({reviewed:0});expect(controls.calls).toBe(final);
},30000);
integration('stage one uses only a canonically scoped delegate and holds a revoked mandate without settling anything',async()=>{
 const f=await fixture(),db=getDb(),principal=f.key+'_supplier_owner',delegate=f.key+'_delegate',mandate=f.key+'_decision_mandate';
 await db.execute(sql`insert into entities(id,story_id,type,name) values(${delegate},${f.key},'character','Relief delegate')`);
 await db.execute(sql`insert into npc_beliefs(id,story_id,believer_entity_id,belief) values(${f.key+'_principal_private'},${f.key},${principal},'PRINCIPAL_PRIVATE: relief concealed in the cellar'),(${f.key+'_delegate_known'},${f.key},${delegate},'Relief was requested by our neighbor')`);
 await db.execute(sql`insert into story_events(id,story_id,type,title,body,metadata) values(${mandate},${f.key},'reveal','Council delegation','PRIVATE MANDATE BODY',${JSON.stringify({factionDecisionAuthority:{scope:'faction_intentions',status:'active',factionId:f.supplier,grantorEntityId:principal,delegateEntityId:delegate}})}::jsonb)`);
 await db.execute(sql`insert into faction_memberships(id,story_id,faction_id,entity_id,role,status,metadata) values(${f.key+'_delegate_member'},${f.key},${f.supplier},${delegate},'member','active',${JSON.stringify({decisionAuthority:{scope:'faction_intentions',grantorEntityId:principal,sourceEventId:mandate}})}::jsonb)`);
 const beforeEvents=(await db.execute(sql`select count(*)::int as n from story_events where story_id=${f.key}`))[0].n;
 expect(await reviewFactionIntentions(f.key,'delegated',[f.supplier])).toMatchObject({reviewed:1,createdEvents:0});
 const p=controls.plannerPackets.at(-1);expect(p.actor.decisionActorIds).toEqual([delegate]);expect(p.sourceIds).toContain(mandate);
 expect(p.evidence.map((e:any)=>e.id)).toContain(f.key+'_delegate_known');expect(JSON.stringify(p)).not.toMatch(/PRINCIPAL_PRIVATE|PRIVATE MANDATE BODY/);
 const calls={planner:controls.calls,decision:controls.decisionCalls};
 await db.execute(sql`update story_events set metadata=jsonb_set(metadata,'{factionDecisionAuthority,status}','"revoked"'::jsonb),server_version=server_version+1 where id=${mandate}`);
 expect(await reviewFactionIntentions(f.key,'delegation-revoked',[f.supplier])).toMatchObject({reviewed:1,createdEvents:0});
 const [story]=await db.select().from(stories).where(eq(stories.id,f.key));
 expect((record(record(story.metadata).factionWorkflow).attempts as any[]).at(-1)).toMatchObject({status:'held',reason:'decision_authority_invalid_delegation'});
 expect(intentionBrief(story.metadata,null,[delegate],[],false)).toBeNull();expect({planner:controls.calls,decision:controls.decisionCalls}).toEqual(calls);
 expect(await reviewFactionIntentions(f.key,'delegation-restart',[f.supplier])).toMatchObject({reviewed:0});
 expect((await db.execute(sql`select count(*)::int as n from story_events where story_id=${f.key}`))[0].n).toBe(beforeEvents);
 expect((await db.execute(sql`select amount from faction_resources where id=${f.sr}`))[0].amount).toBe(100);
},30000);
integration('stage one rotates beyond a sixteen-faction read frontier while retaining the material two-review cap',async()=>{
 const f=await fixture(),db=getDb(),others:string[]=[];
 for(let i=0;i<18;i++){
  const id=f.key+'_a_'+String(i).padStart(2,'0');others.push(id);
  await db.execute(sql`insert into factions(id,story_id,name,entity_id,goals,pressure) values(${id},${f.key},${'Council '+i},${f.key+'_supplier_owner'},'["Offer cooperative relief"]'::jsonb,100)`);
 }
 const calls=controls.calls;expect(await reviewFactionIntentions(f.key,'large-world-first')).toMatchObject({reviewed:1});expect(controls.calls).toBe(calls+1);
 const [first]=await db.select().from(stories).where(eq(stories.id,f.key));expect(record(record(record(first.metadata).factionWorkflow).scheduler).scanAfter).toBe(others[15]);
 let reached=false;
 for(let i=1;i<20;i++){
  const before=controls.calls;expect(await reviewFactionIntentions(f.key,'large-world-next-'+i)).toMatchObject({reviewed:1});expect(controls.calls).toBe(before+1);
  if(controls.plannerPackets.at(-1).actor.id===others[16]){reached=true;break;}
 }
 expect(reached).toBe(true);
 expect(await reviewFactionIntentions(f.key,'material-budget',[f.supplier,f.recipient])).toMatchObject({reviewed:2});
 const final=controls.calls;expect(await reviewFactionIntentions(f.key,'material-restart',[f.supplier,f.recipient])).toMatchObject({reviewed:0});expect(controls.calls).toBe(final);
},30000);
integration('stage one does not resurrect an old active commitment when the bounded latest-commitment page is full',async()=>{
 const f=await fixture(),db=getDb(),owner=f.key+'_supplier_owner';
 await db.execute(sql`update faction_goals set goal='Escort relief across the bridge' where faction_id=${f.supplier}`);
 for(const [id,turn,status,text] of [['old_active',1,'active','Escort relief across the bridge'],['new_fulfilled',2,'fulfilled','Escort promise fulfilled']] as const){
  await db.execute(sql`insert into story_events(id,story_id,type,title,body,created_turn,metadata) values(${f.key+'_'+id},${f.key},'reveal','Learned promise','',${turn},${JSON.stringify({negotiationId:f.key+'_known',actorClaims:[{text,knownBy:[owner],kind:'learned'}],currentAgreement:{id:f.key+'_promise',status}})}::jsonb)`);
 }
 for(let i=0;i<17;i++)await db.execute(sql`insert into story_events(id,story_id,type,title,body,created_turn,metadata) values(${f.key+'_other_promise_'+i},${f.key},'reveal','Other promise','',${i+10},${JSON.stringify({negotiationId:f.key+'_known',actorClaims:[{text:'Another personally known promise remains active',knownBy:[owner],kind:'learned'}],currentAgreement:{id:f.key+'_other_'+i,status:'active'}})}::jsonb)`);
 expect(await reviewFactionIntentions(f.key,'full-commitment-page',[f.supplier])).toMatchObject({reviewed:1});
 const p=controls.plannerPackets.at(-1);expect(p.evidence.map((e:any)=>e.id)).not.toContain(f.key+'_old_active');
 expect(p.actor.obligations).not.toEqual(expect.arrayContaining([expect.objectContaining({id:f.key+'_promise',status:'active'})]));
},30000);

async function persistentFixture(options:{blocked?:boolean;mode?:'routine'|'contested';playerConsent?:'not_required'|'confirmed'|'pending'}={}){
 const f=await fixture(options.blocked??false),db=getDb(),projectId=f.key+'_persistent',executionProofId=f.key+'_execution',owner=f.key+'_supplier_owner',recipientOwner=f.key+'_recipient_owner',means=f.key+'_means';
 await db.execute(sql`insert into entities(id,story_id,type,name) values(${means},${f.key},'item','Established relief transport')`);
 const proof={scope:'relief_execution',projectId,ownerEntityId:owner,supplierId:f.supplier,recipientId:f.recipient,locationId:f.key+'_granary',meansEntityIds:[means],maxGrain:100,mode:options.mode??'routine',playerConsent:options.playerConsent??'not_required'};
 await db.execute(sql`insert into story_events(id,story_id,type,title,body,metadata) values(${executionProofId},${f.key},'reveal','Sourced execution authority','PRIVATE EXECUTION BODY',${JSON.stringify({reliefExecution:proof,actorClaims:[{text:'The steward receives authority to dispatch relief using established transport, subject to actual agreement and confirmation.',knownBy:[owner],kind:'learned'}]})}::jsonb)`);
 for(const [source,learner,text] of [[f.key+'_route',owner,'The steward learns the current route constraint.'],[f.key+'_authority',recipientOwner,'The regency steward learns the current toll mandate.'],[executionProofId,owner,'The supplier receives execution authority.']]){
  if(source!==executionProofId)await db.execute(sql`update story_events set metadata=jsonb_set(metadata,'{actorClaims}',${JSON.stringify([{text,knownBy:[learner],kind:'learned'}])}::jsonb),server_version=server_version+1 where id=${source}`);
  await db.execute(sql`insert into npc_event_links(id,story_id,event_id,npc_entity_id,role) values(${f.key+'_known_'+source},${f.key},${source},${learner},'knower')`);
 }
 const [story]=await db.select().from(stories).where(eq(stories.id,f.key));
 expect(await authorReliefProject(f.key,{id:projectId,objectiveId:f.key+'_goal',ownerEntityId:owner,executionProofId,expectedStoryVersion:story.serverVersion})).toMatchObject({status:'authored',phase:'preparation'});
 return {...f,projectId,executionProofId,owner,recipientOwner,means,proof};
}
async function readPersistent(f:Awaited<ReturnType<typeof persistentFixture>>){
 const [project]=await getDb().execute(sql`select * from faction_projects where id=${f.projectId}`);
 return {project,plan:record(record(project.metadata).persistentProject)};
}
function trackedAdapter(onPlan?:()=>Promise<void>){
 const counts={plan:0,decide:0};const wrapped:NegotiationAdapters={plan:async input=>{counts.plan++;await onPlan?.();return adapter.plan(input);},decide:async input=>{counts.decide++;return adapter.decide(input);}};
 return {counts,adapter:wrapped};
}
async function commitPersistent(f:Awaited<ReturnType<typeof persistentFixture>>,a:NegotiationAdapters=adapter){
 expect(await advanceNegotiation(f.key,'p_offer',a)).toMatchObject({status:'offer'});
 expect((await readPersistent(f)).plan.phase).toBe('authorization');
 await day(f.key,1);expect(await advanceNegotiation(f.key,'p_counter',a)).toMatchObject({status:'counteroffer'});
 await day(f.key,2);expect(await advanceNegotiation(f.key,'p_accept',a)).toMatchObject({status:'agreed'});
 expect((await readPersistent(f)).plan).toMatchObject({phase:'commitment',committedMeans:{resourceId:f.sr,amount:40},dueWorldTime:'Day 4'});
}
async function observePersistent(f:Awaited<ReturnType<typeof persistentFixture>>,name:string,outcome:'delivered'|'failed'|'refused',at=4,known=true){
 const {plan}=await readPersistent(f),id=f.key+'_'+name;
 await getDb().execute(sql`insert into story_events(id,story_id,type,title,body,world_time,metadata) values(${id},${f.key},'reveal','Observed relief outcome','No private motives in the scoped report.',${'Day '+at},${JSON.stringify({reliefOutcome:{projectId:f.projectId,agreementId:record(plan.committedMeans).agreementId,dispatchEventId:plan.dispatchEventId,outcome,observedWorldTime:'Day '+at},actorClaims:[{text:outcome==='delivered'?'The relief recipient confirms the observed shipment.':outcome==='failed'?'The participants confirm that the shipment failed.':'The recipient refuses receipt; no grain is delivered.',knownBy:known?[f.supplier,f.recipient]:['unrelated_actor'],kind:'witnessed'}]})}::jsonb)`);
 for(const owner of [f.owner,f.recipientOwner])await getDb().execute(sql`insert into npc_event_links(id,story_id,event_id,npc_entity_id,role) values(${id+'_'+owner},${f.key},${id},${owner},'witness')`);
 return id;
}
async function refreshPersistent(f:Awaited<ReturnType<typeof persistentFixture>>,proof=f.proof){
 const proofId=f.key+'_execution_revised';
 await getDb().execute(sql`insert into story_events(id,story_id,type,title,body,metadata) values(${proofId},${f.key},'reveal','Revised sourced authorization','',${JSON.stringify({reliefExecution:proof,actorClaims:[{text:'The steward receives revised scoped authority for the same relief objective.',knownBy:[proof.ownerEntityId],kind:'learned'}]})}::jsonb)`);
 await getDb().execute(sql`insert into npc_event_links(id,story_id,event_id,npc_entity_id,role) values(${proofId+'_known'},${f.key},${proofId},${proof.ownerEntityId},'knower')`);
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));const {project}=await readPersistent(f);
 return authorReliefProject(f.key,{id:f.projectId,objectiveId:f.key+'_goal',ownerEntityId:proof.ownerEntityId,executionProofId:proofId,expectedStoryVersion:story.serverVersion,expectedProjectVersion:project.server_version as number},true);
}
integration('stage two persists authorization, reservation, dispatch and confirmation without inferring arrival from turns or time',async()=>{
 const f=await persistentFixture(),t=trackedAdapter();await commitPersistent(f,t.adapter);expect(t.counts).toEqual({plan:3,decide:3});
 expect(await advanceNegotiation(f.key,'p_depart',t.adapter)).toMatchObject({status:'dispatched'});expect((await readPersistent(f)).plan).toMatchObject({phase:'dispatch',committedMeans:{amount:40}});
 await getDb().execute(sql`update stories set current_turn=1000 where id=${f.key}`);
 expect(await advanceNegotiation(f.key,'turns_are_not_time',t.adapter)).toMatchObject({status:'held',reason:'in_transit_unconfirmed'});
 expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.sr}`))[0]).toMatchObject({amount:100,metadata:{reservedGrain:40}});
 await day(f.key,4);expect(await advanceNegotiation(f.key,'arrival_window',t.adapter)).toMatchObject({status:'held',reason:'arrival_window_without_confirmation',project:{phase:'arrival'}});
 const counts={...t.counts};await closeDb();await verifyTestDatabase();
 expect(await advanceNegotiation(f.key,'waiting_after_restart',t.adapter)).toMatchObject({status:'held',reason:'arrival_window_without_confirmation'});expect(t.counts).toEqual(counts);
 const version=(await readPersistent(f)).project.server_version;
 await advanceNegotiation(f.key,'same_wait_again',t.adapter);expect((await readPersistent(f)).project.server_version).toBe(version);
 const calls=controls.calls;expect(await reviewFactionIntentions(f.key,'preserve_managed_plan',[f.supplier])).toMatchObject({reviewed:0});expect(controls.calls).toBe(calls);
 const source=await observePersistent(f,'confirmed','delivered');expect(await advanceNegotiation(f.key,'p_confirm',t.adapter)).toMatchObject({status:'delivered'});
 expect((await readPersistent(f)).plan).toMatchObject({phase:'confirmation',outcomeSourceId:source,committedMeans:{amount:0}});
 const resources=await getDb().execute(sql`select amount,metadata from faction_resources where id in (${f.sr},${f.rr}) order by id`);expect(resources.map(r=>r.amount)).toEqual([60,50]);expect(resources[0].metadata).toMatchObject({reservedGrain:0});
 expect(await advanceNegotiation(f.key,'p_confirm',t.adapter)).toMatchObject({status:'delivered',repeated:true});
 expect((await getDb().execute(sql`select count(*)::int n from story_events where story_id=${f.key} and metadata->>'negotiationKind'='delivery'`))[0].n).toBe(1);expect(t.counts).toEqual(counts);
 await day(f.key,14);expect(await advanceNegotiation(f.key,'p_expire',t.adapter)).toMatchObject({status:'completed'});expect((await readPersistent(f)).plan.phase).toBe('completed');
},30000);
integration('stage two coalesces an unchanged Jev hold without repeated planning or conversion of legacy projects',async()=>{
 const f=await persistentFixture(),t=trackedAdapter();const held:NegotiationAdapters={...t.adapter,decide:async input=>{const decision=await t.adapter.decide(input);return decision?{...decision,confidence:.5}:null;}};
 expect(await advanceNegotiation(f.key,'advisory_hold',held)).toMatchObject({status:'held',reason:'decision_abstained'});
 const before={...t.counts};await closeDb();await verifyTestDatabase();
 expect(await advanceNegotiation(f.key,'unchanged_hold',held)).toMatchObject({status:'held',reason:'unchanged_waiting_project'});expect(t.counts).toEqual(before);
 await getDb().execute(sql`insert into faction_projects(id,story_id,faction_id,project,status) values(${f.key+'_legacy'},${f.key},${f.supplier},'Authored legacy project','active')`);
 await advanceNegotiation(f.key,'unrelated_legacy_project',held);expect(t.counts).toEqual(before);
 expect((await getDb().execute(sql`select metadata from faction_projects where id=${f.key+'_legacy'}`))[0].metadata).toEqual({});
 controls.plannerModel='restored-planner-revision';expect(await advanceNegotiation(f.key,'restored_model_settings',held)).toMatchObject({status:'held',reason:'decision_abstained'});expect(t.counts.plan).toBe(before.plan+1);
},30000);
integration('stage two blocks a known closed route, holds a source revision, and explicitly replans the same project without new inference',async()=>{
 const f=await persistentFixture({blocked:true}),t=trackedAdapter();
 expect(await advanceNegotiation(f.key,'blocked_prepare',t.adapter)).toMatchObject({status:'blocked',reason:'project_route_blocked'});expect(t.counts.plan).toBe(0);
 await getDb().execute(sql`update story_events set metadata=jsonb_set(metadata,'{deliveryRoute,blocked}','false'::jsonb),server_version=server_version+1 where id=${f.key+'_route'}`);
 expect(await advanceNegotiation(f.key,'route_revised',t.adapter)).toMatchObject({status:'replan',reason:'project_dependency_changed'});
 expect(await refreshPersistent(f)).toMatchObject({status:'replanned',projectId:f.projectId});
 expect(await advanceNegotiation(f.key,'after_replan',t.adapter)).toMatchObject({status:'offer'});expect(t.counts.plan).toBe(1);
 expect((await getDb().execute(sql`select count(*)::int n from faction_projects where story_id=${f.key}`))[0].n).toBe(1);
},30000);
integration.each(['project','agreement','revoked_route'])('stage two cancels %s before delivery and releases its reservation once',async change=>{
 const f=await persistentFixture(),t=trackedAdapter();await commitPersistent(f,t.adapter);await advanceNegotiation(f.key,'cancel_dispatch',t.adapter);
 if(change==='agreement')await getDb().execute(sql`update agreements set status='deleted',server_version=server_version+1 where story_id=${f.key}`);
 else await getDb().execute(sql`update faction_projects set status='cancelled',server_version=server_version+1 where id=${f.projectId}`);
 if(change==='revoked_route')await getDb().execute(sql`update story_events set status='cancelled',server_version=server_version+1 where id=${f.key+'_route'}`);
 const count={...t.counts};expect(await advanceNegotiation(f.key,'cancel_once',t.adapter)).toMatchObject({status:'cancelled'});
 expect((await readPersistent(f)).plan).toMatchObject({phase:'cancelled',committedMeans:{amount:0}});
 expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.sr}`))[0]).toMatchObject({amount:100,metadata:{reservedGrain:0}});
 expect((await getDb().execute(sql`select amount from faction_resources where id=${f.rr}`))[0].amount).toBe(10);
 await advanceNegotiation(f.key,'cancel_again',t.adapter);await advanceNegotiation(f.key,'cancel_once',t.adapter);expect(t.counts).toEqual(count);
 expect((await getDb().execute(sql`select count(*)::int n from story_events where story_id=${f.key} and metadata->>'negotiationKind'='cancelled'`))[0].n).toBe(1);
 expect((await getDb().execute(sql`select status from agreements where story_id=${f.key}`))[0].status).toBe(change==='agreement'?'deleted':'cancelled');
},30000);
integration.each(['failed','refused'])('stage two settles a scoped observed %s without consuming undelivered inventory',async outcome=>{
 const f=await persistentFixture(),t=trackedAdapter();await commitPersistent(f,t.adapter);await advanceNegotiation(f.key,'outcome_dispatch',t.adapter);await day(f.key,3);
 await observePersistent(f,'actual_outcome',outcome as 'failed'|'refused',3);
 if(outcome==='failed')await getDb().execute(sql`update story_events set metadata=jsonb_set(metadata,'{deliveryRoute,blocked}','true'::jsonb),server_version=server_version+1 where id=${f.key+'_route'}`);
 expect(await advanceNegotiation(f.key,'observed_outcome',t.adapter)).toMatchObject({status:outcome==='failed'?'failed':'cancelled'});
 expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.sr}`))[0]).toMatchObject({amount:100,metadata:{reservedGrain:0}});
 expect((await getDb().execute(sql`select amount from faction_resources where id=${f.rr}`))[0].amount).toBe(10);expect(t.counts.plan).toBe(3);
},30000);
integration.each(['contested','pending','confirmed'])('stage two hands %s execution to the GM without choosing for the player or dispatching',async mode=>{
 const f=await persistentFixture({mode:mode==='contested'?'contested':'routine',playerConsent:mode==='contested'?'not_required':mode as 'pending'|'confirmed'}),t=trackedAdapter();await commitPersistent(f,t.adapter);
 expect(await advanceNegotiation(f.key,'gm_handoff',t.adapter)).toMatchObject({status:'adjudication',project:{phase:'adjudication'}});
 const {project,plan}=await readPersistent(f);expect(plan.dispatchEventId).toBeNull();expect(t.counts.plan).toBe(3);
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));
 const ctx={story,entities:await getDb().select().from(entities).where(eq(entities.storyId,f.key)),recentEntries:[],factions:[],factionMemberships:[],factionResources:[],factionGoals:[],factionProjects:[{...project,serverVersion:project.server_version}],agreements:[],threads:[],events:[],beliefs:[],facts:[],patchProposals:[],continuityWarnings:[],chapters:[],arcs:[],sagas:[],gmBrief:null,sceneLocationId:f.key+'_granary'} as unknown as TurnContext;
 const retrieved={storyId:f.key,query:'Let the steward explain, without promising anything.',packet:'',nodes:[],tokenEstimate:0,retrievalDebug:[],retrievalTrace:[]} as RetrievedMemoryPacket;
 const gm=buildServerTurnPrompt(ctx,retrieved,'project_handoff',{playerAction:retrieved.query,presentNpcIds:[f.owner]});
 expect(gm.factionCueSelection?.sourceKey).toMatch(/^project:/);expect(gm.dynamicPrompt).toContain('player may refuse');expect(gm.dynamicPrompt).toContain('cannot authorize or settle');
 expect(projectAdjudicationBrief(ctx.factionProjects,f.key+'_granary',[f.owner],[gm.factionCueSelection!.sourceKey],false)).toBeNull();
 await day(f.key,20);await advanceNegotiation(f.key,'still_contested',t.adapter);expect(t.counts.plan).toBe(3);
 expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.sr}`))[0]).toMatchObject({amount:100,metadata:{reservedGrain:40}});
},30000);
integration('stage two accepts a fresh canonical routine authorization after GM adjudication without replacing the objective or reservation',async()=>{
 const f=await persistentFixture({mode:'contested'}),t=trackedAdapter();await commitPersistent(f,t.adapter);await advanceNegotiation(f.key,'adjudication',t.adapter);
 expect(await refreshPersistent(f,{...f.proof,mode:'routine'})).toMatchObject({status:'replanned'});
 expect(await advanceNegotiation(f.key,'gm_authorized_departure',t.adapter)).toMatchObject({status:'dispatched'});expect(t.counts.plan).toBe(3);
 expect((await readPersistent(f)).plan).toMatchObject({objectiveId:f.key+'_goal',committedMeans:{amount:40}});
},30000);
integration.each(['private','future','before_due'])('stage two rejects a %s confirmation as delivery evidence',async kind=>{
 const f=await persistentFixture(),t=trackedAdapter();await commitPersistent(f,t.adapter);await advanceNegotiation(f.key,'proof_dispatch',t.adapter);await day(f.key,4);
 await observePersistent(f,'unusable_confirmation','delivered',kind==='future'?5:kind==='before_due'?3:4,kind!=='private');
 expect(await advanceNegotiation(f.key,'invalid_confirmation',t.adapter)).toMatchObject({status:'held',reason:'arrival_window_without_confirmation'});
 expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.sr}`))[0]).toMatchObject({amount:100,metadata:{reservedGrain:40}});
 expect((await getDb().execute(sql`select count(*)::int n from story_events where story_id=${f.key} and metadata->>'negotiationKind'='delivery'`))[0].n).toBe(0);
 if(kind==='future'){await day(f.key,5);expect(await advanceNegotiation(f.key,'forecast_does_not_mature',t.adapter)).toMatchObject({status:'held',reason:'arrival_window_without_confirmation'});await observePersistent(f,'fresh_actual_confirmation','delivered',5);expect(await advanceNegotiation(f.key,'fresh_observed_receipt',t.adapter)).toMatchObject({status:'delivered'});}
},30000);
integration('stage two dates a late observed arrival and its concession from the actual receipt rather than the scheduled due day',async()=>{
 const f=await persistentFixture();await commitPersistent(f);await advanceNegotiation(f.key,'late_depart');await day(f.key,5);await observePersistent(f,'late_arrival','delivered',5);
 expect(await advanceNegotiation(f.key,'late_confirm')).toMatchObject({status:'delivered'});
 expect((await getDb().execute(sql`select world_time from story_events where story_id=${f.key} and metadata->>'negotiationKind'='delivery'`))[0].world_time).toBe('Day 5');
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));expect(record(record(record(story.metadata).factionWorkflow).negotiation).agreement).toMatchObject({tollUntilDay:15});
 await day(f.key,14);expect(await advanceNegotiation(f.key,'too_early_expiry')).toMatchObject({status:'held'});await day(f.key,15);expect(await advanceNegotiation(f.key,'actual_expiry')).toMatchObject({status:'completed'});
},30000);
integration.each(['owner','objective','means','unknown_source','disabled_faction'])('stage two holds changed %s before dispatch without new model calls',async change=>{
 const f=await persistentFixture(),t=trackedAdapter();await commitPersistent(f,t.adapter);
 if(change==='owner')await getDb().execute(sql`update factions set entity_id=${f.recipientOwner} where id=${f.supplier}`);
 if(change==='objective')await getDb().execute(sql`update faction_goals set goal='A materially revised objective',server_version=server_version+1 where id=${f.key+'_goal'}`);
 if(change==='means')await getDb().execute(sql`update entities set status='archived' where id=${f.means}`);
 if(change==='unknown_source')await getDb().execute(sql`update story_events set metadata=jsonb_set(metadata,'{actorClaims}','[]'::jsonb),server_version=server_version+1 where id=${f.key+'_route'}`);
 if(change==='disabled_faction')await getDb().execute(sql`update factions set metadata='{"worldSimEnabled":false}'::jsonb where id=${f.supplier}`);
 const result=await advanceNegotiation(f.key,'changed_prerequisite',t.adapter);expect(['replan','blocked']).toContain(result.status);expect(t.counts.plan).toBe(3);
 expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.sr}`))[0]).toMatchObject({amount:100,metadata:{reservedGrain:40}});
},30000);
integration('stage two rejects stale ownership changed during acceptance without partial allocation or a canonical agreement',async()=>{
 const f=await persistentFixture();await advanceNegotiation(f.key,'race_offer',adapter);await day(f.key,1);await advanceNegotiation(f.key,'race_counter',adapter);await day(f.key,2);
 const racing=trackedAdapter(async()=>{await getDb().execute(sql`update factions set entity_id=${f.recipientOwner} where id=${f.supplier}`);});
 expect(await advanceNegotiation(f.key,'owner_race_accept',racing.adapter)).toMatchObject({status:'held',reason:'stale_inventory_or_context'});
 expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.sr}`))[0]).toMatchObject({amount:100,metadata:{reservedGrain:0}});
 expect((await getDb().execute(sql`select count(*)::int n from agreements where story_id=${f.key}`))[0].n).toBe(0);expect((await readPersistent(f)).plan.phase).toBe('authorization');
},30000);
integration('stage two preserves changed reservations, prevents a second binding, and excludes managed projects from generic completion audits',async()=>{
 const f=await persistentFixture();await commitPersistent(f);const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));
 await expect(authorReliefProject(f.key,{id:f.key+'_second',objectiveId:f.key+'_goal',ownerEntityId:f.owner,executionProofId:f.executionProofId,expectedStoryVersion:story.serverVersion})).rejects.toThrow(/Preserve existing/);
 await getDb().execute(sql`update faction_resources set metadata=jsonb_set(metadata,'{reservedGrain}','60'::jsonb) where id=${f.sr}`);
 expect(await advanceNegotiation(f.key,'no_double_allocation')).toMatchObject({status:'blocked',reason:'reservation_or_inventory_changed'});
 expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.sr}`))[0]).toMatchObject({amount:100,metadata:{reservedGrain:60}});
 await getDb().execute(sql`update faction_projects set due_turn=0,progress=1 where id=${f.projectId}`);
 expect(await auditDueFactionProjects({storyId:f.key})).toMatchObject({dueProjectCount:0,proposalCount:0});
},30000);

integration('stage two supplies the actual decision owner and persistent objective only to their scoped planner',async()=>{
 const f=await persistentFixture(),packets:any[]=[];
 await getDb().execute(sql`update entities set state=${JSON.stringify({personality:'OWNER_PRIVATE_PERSONA',constraint:'Preserve seed grain'})}::jsonb where id=${f.owner}`);
 const a:NegotiationAdapters={...adapter,plan:async input=>{packets.push(input.actorPacket);return adapter.plan(input);}};
 await advanceNegotiation(f.key,'scoped_project_offer',a);await day(f.key,1);await advanceNegotiation(f.key,'scoped_project_counter',a);
 expect(packets[0]).toMatchObject({decisionMaker:{id:f.owner,personality:'OWNER_PRIVATE_PERSONA'},project:{id:f.projectId,objectiveId:f.key+'_goal',priority:5}});
 expect(packets[0].sourceIds).toEqual(expect.arrayContaining([f.owner,f.projectId,f.key+'_goal',f.executionProofId]));
 expect(packets[1]).toMatchObject({decisionMaker:{id:f.recipientOwner},project:null});expect(JSON.stringify(packets[1])).not.toContain('OWNER_PRIVATE_PERSONA');expect(packets[1].sourceIds).not.toContain(f.projectId);
},30000);
integration('stage two filters confirmation knowledge before recency so an unheard rival receipt cannot evict the known confirmation',async()=>{
 const f=await persistentFixture();await commitPersistent(f);await advanceNegotiation(f.key,'knowledge_depart');await day(f.key,4);
 const known=await observePersistent(f,'personally_confirmed','delivered',4,true);await observePersistent(f,'unheard_rival_report','refused',4,false);
 expect(await advanceNegotiation(f.key,'known_receipt_wins')).toMatchObject({status:'delivered'});expect((await readPersistent(f)).plan.outcomeSourceId).toBe(known);
 expect((await getDb().execute(sql`select amount from faction_resources where id=${f.sr}`))[0].amount).toBe(60);
},30000);

integration('stage two fails closed when a managed binding is removed instead of falling back to legacy automatic delivery',async()=>{
 const f=await persistentFixture(),t=trackedAdapter();await commitPersistent(f,t.adapter);await day(f.key,20);
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));expect(record(record(record(story.metadata).factionWorkflow).negotiation).scope).toBe('persistent-relief');
 await getDb().execute(sql`update stories set metadata=metadata #- '{factionWorkflow,negotiationProjectId}' where id=${f.key}`);
 expect(await advanceNegotiation(f.key,'missing_binding',t.adapter)).toMatchObject({status:'held',reason:'persistent_project_binding_missing'});
 expect(t.counts.plan).toBe(3);expect((await getDb().execute(sql`select amount,metadata from faction_resources where id=${f.sr}`))[0]).toMatchObject({amount:100,metadata:{reservedGrain:40}});
},30000);


async function reusableFixture(){
 const f=await fixture(false,true),db=getDb(),owner=f.key+'_supplier_owner',recipientOwner=f.key+'_recipient_owner',means=f.key+'_transport',location=f.key+'_granary',proofId=f.key+'_grant';
 await db.execute(sql`insert into entities(id,story_id,type,name) values(${means},${f.key},'item','Relief wagon'),(${location},${f.key},'location','Hillmarch granary')`);
 const grant={scope:'relief_authority',version:2,ownerEntityId:owner,supplierId:f.supplier,recipientId:f.recipient,locationId:location,meansEntityIds:[means],maxGrain:100,mode:'routine',playerConsent:'not_required'};
 await db.execute(sql`insert into story_events(id,story_id,type,title,body,metadata) values(${proofId},${f.key},'reveal','Relief dispatch mandate','The League steward authorizes the Granary League to dispatch up to 100 grain per shipment to the Hillmarch Regency at Hillmarch granary using the Relief wagon.',${JSON.stringify({reliefExecutionGrant:grant,actorClaims:[{text:'The League steward receives the dispatch mandate.',knownBy:[owner],kind:'learned'}]})}::jsonb)`);
 for(const [source,learner] of [[f.key+'_route',owner],[f.key+'_authority',recipientOwner],[proofId,owner]]){
  if(source!==proofId)await db.execute(sql`update story_events set metadata=jsonb_set(metadata,'{actorClaims}',${JSON.stringify([{text:'The steward receives this prerequisite.',knownBy:[learner],kind:'learned'}])}::jsonb) where id=${source}`);
  await db.execute(sql`insert into npc_event_links(id,story_id,event_id,npc_entity_id,role) values(${source+'_link'},${f.key},${source},${learner},'knower')`);
 }
 return {...f,owner,recipientOwner,means,location,proofId,grant,config:{supplierId:f.supplier,recipientId:f.recipient,supplierResourceId:f.sr,recipientResourceId:f.rr,locationId:location,deliveryDays:2,maxTollDays:20,authoritySourceId:f.key+'_authority',routeSourceId:f.key+'_route',blocked:false}};
}
async function createReusable(f:Awaited<ReturnType<typeof reusableFixture>>,suffix:string,objectiveId=f.key+'_goal'){
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));
 const input={id:f.key+'_'+suffix,objectiveId,ownerEntityId:f.owner,executionProofId:f.proofId,expectedStoryVersion:story.serverVersion};
 const receipt=await authorReliefProject(f.key,input,false,f.config);return {id:input.id,input,receipt};
}
async function reusableRead(id:string){const [row]=await getDb().execute(sql`select * from faction_projects where id=${id}`);const metadata=row.metadata as any;return {row,state:metadata.reliefAdapter.state,plan:metadata.persistentProject};}
async function reusableCommit(f:Awaited<ReturnType<typeof reusableFixture>>,id:string,chosen:NegotiationAdapters=adapter){
 expect(await advanceNegotiation(f.key,'offer',chosen,id)).toMatchObject({status:'offer'});
 expect(await advanceNegotiation(f.key,'counter',chosen,id)).toMatchObject({status:'counteroffer'});
 expect(await advanceNegotiation(f.key,'accept',chosen,id)).toMatchObject({status:'agreed'});
}
async function reusableObserve(f:Awaited<ReturnType<typeof reusableFixture>>,id:string,outcome='delivered',observed=2,override:Record<string,unknown>={}){
 const {state,plan}=await reusableRead(id),eventId=id+'_observed_'+outcome;
 await getDb().execute(sql`insert into story_events(id,story_id,type,title,body,metadata) values(${eventId},${f.key},'reveal','Observed relief outcome','An actual outcome is reported to both stewards.',${JSON.stringify({reliefOutcome:{projectId:id,agreementId:`neg_${state.id}_${state.agreement.id}`,dispatchEventId:plan.dispatchEventId,outcome,observedWorldTime:'Day '+observed,...override},actorClaims:[{text:'An actual relief outcome is received.',knownBy:[f.owner,f.recipientOwner],kind:'learned'}]})}::jsonb)`);
 for(const actor of [f.owner,f.recipientOwner])await getDb().execute(sql`insert into npc_event_links(id,story_id,event_id,npc_entity_id,role) values(${eventId+'_'+actor},${f.key},${eventId},${actor},'knower')`);
 return eventId;
}
integration('reusable relief completes one project then creates another without clearing retained history',async()=>{
 const f=await reusableFixture(),a=await createReusable(f,'first');await reusableCommit(f,a.id);expect(await advanceNegotiation(f.key,'depart',adapter,a.id)).toMatchObject({status:'dispatched'});
 await day(f.key,2);await reusableObserve(f,a.id);expect(await advanceNegotiation(f.key,'settle',adapter,a.id)).toMatchObject({status:'delivered'});
 await day(f.key,12);expect(await advanceNegotiation(f.key,'expiry',adapter,a.id)).toMatchObject({status:'completed'});
 const b=await createReusable(f,'second');expect(b.receipt).toMatchObject({status:'authored'});await reusableCommit(f,b.id);
 expect((await reusableRead(a.id)).state.phase).toBe('completed');expect((await reusableRead(b.id)).state.phase).toBe('agreed');
 expect((await getDb().execute(sql`select count(*)::int as n from agreements where story_id=${f.key}`))[0].n).toBe(2);
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));expect(record(record(story.metadata).factionWorkflow).negotiation).toBeUndefined();
},30000);
integration('reusable relief isolates same step IDs and exact outcome receipts while conserving a shared pool',async()=>{
 const f=await reusableFixture(),a=await createReusable(f,'a'),b=await createReusable(f,'b');await reusableCommit(f,a.id);await reusableCommit(f,b.id);
 let [resource]=await getDb().execute(sql`select * from faction_resources where id=${f.sr}`);expect(grainPool(resource).total).toBe(80);expect(grainPool(resource).reservations).toMatchObject({[a.id]:40,[b.id]:40});
 await advanceNegotiation(f.key,'depart',adapter,a.id);await advanceNegotiation(f.key,'depart',adapter,b.id);await day(f.key,2);
 const ap=await reusableRead(a.id);await reusableObserve(f,b.id,'delivered',2,{agreementId:`neg_${ap.state.id}_${ap.state.agreement.id}`,dispatchEventId:ap.plan.dispatchEventId});
 expect(await advanceNegotiation(f.key,'wrong-receipt',adapter,b.id)).toMatchObject({status:'held',reason:'arrival_window_without_confirmation'});
 await reusableObserve(f,a.id);expect(await advanceNegotiation(f.key,'settle',adapter,a.id)).toMatchObject({status:'delivered'});
 expect(await advanceNegotiation(f.key,'settle',adapter,a.id)).toMatchObject({status:'delivered',repeated:true});
 [resource]=await getDb().execute(sql`select * from faction_resources where id=${f.sr}`);expect(resource.amount).toBe(60);expect(grainPool(resource).reservations).toEqual({[b.id]:40});
 await getDb().execute(sql`delete from story_events where id=${b.id+'_observed_delivered'}`);await reusableObserve(f,b.id);
 expect(await advanceNegotiation(f.key,'settle',adapter,b.id)).toMatchObject({status:'delivered'});
 [resource]=await getDb().execute(sql`select * from faction_resources where id=${f.sr}`);expect(resource.amount).toBe(20);expect(grainPool(resource).total).toBe(0);
 expect((await getDb().execute(sql`select amount from faction_resources where id=${f.rr}`))[0].amount).toBe(90);
},30000);
integration('reusable relief cannot overspend another project reservation and cancellation releases only its own share',async()=>{
 const f=await reusableFixture(),a=await createReusable(f,'large'),b=await createReusable(f,'competing');
 const large:NegotiationAdapters={...adapter,plan:async input=>(await adapter.plan(input) as any[]).map(p=>p.terms?{...p,terms:{...p.terms,grain:70}}:p)};
 await reusableCommit(f,a.id,large);
 expect(await advanceNegotiation(f.key,'unaffordable',adapter,b.id)).toMatchObject({status:'held',reason:'insufficient_grain'});
 let [resource]=await getDb().execute(sql`select * from faction_resources where id=${f.sr}`);expect(grainPool(resource).total).toBe(70);expect(resource.amount).toBe(100);
 const small:NegotiationAdapters={...adapter,plan:async input=>(await adapter.plan(input) as any[]).map(p=>p.terms?{...p,terms:{...p.terms,grain:20}}:p)};
 // A fresh authored revision permits reconsideration after the intentionally rejected plan.
 const [st]=await getDb().select().from(stories).where(eq(stories.id,f.key));const br=await reusableRead(b.id);
 await authorReliefProject(f.key,{...b.input,expectedStoryVersion:st.serverVersion,expectedProjectVersion:br.row.server_version},true);
 await reusableCommit(f,b.id,small);const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));const ar=await reusableRead(a.id);
 const cancel={id:a.id,expectedStoryVersion:story.serverVersion,expectedProjectVersion:ar.row.server_version};
 await requestReliefCancellation(f.key,cancel);expect(await advanceNegotiation(f.key,'cancel',adapter,a.id)).toMatchObject({status:'cancelled'});expect(await requestReliefCancellation(f.key,cancel)).toMatchObject({repeated:true});
 [resource]=await getDb().execute(sql`select * from faction_resources where id=${f.sr}`);expect(grainPool(resource).reservations).toEqual({[b.id]:20});expect(resource.amount).toBe(100);
},30000);
integration('reusable relief repeated creation is idempotent across a stale browser version and rejects changed submissions',async()=>{
 const f=await reusableFixture(),a=await createReusable(f,'repeat');
 expect(await authorReliefProject(f.key,a.input,false,f.config)).toMatchObject({repeated:true});
 await expect(authorReliefProject(f.key,{...a.input,ownerEntityId:f.recipientOwner},false,f.config)).rejects.toThrow(/already used/);
 expect((await getDb().execute(sql`select count(*)::int as n from faction_projects where story_id=${f.key}`))[0].n).toBe(1);
},30000);
integration('reusable relief ready selection skips blocked projects and preserves a single negotiation call budget',async()=>{
 const f=await reusableFixture(),a=await createReusable(f,'a_blocked');
 await getDb().execute(sql`insert into faction_goals(id,story_id,faction_id,goal) values(${f.key+'_goal_b'},${f.key},${f.supplier},'A second fair relief commitment')`);
 const b=await createReusable(f,'b_ready',f.key+'_goal_b');await getDb().execute(sql`update faction_goals set status='completed' where id=${f.key+'_goal'}`);
 let calls=0;const counted:NegotiationAdapters={...adapter,plan:async input=>{calls++;return adapter.plan(input);}};
 expect(await advanceNegotiation(f.key,'scheduled',counted)).toMatchObject({status:'offer',projectId:b.id});expect(calls).toBe(1);expect((await reusableRead(a.id)).state.phase).toBe('idle');
 expect(await advanceNegotiation(f.key,'next',counted)).toMatchObject({status:'counteroffer',projectId:b.id});expect(calls).toBe(2);
},30000);
integration('reusable relief rejects stale owner writes without partial reservation and preserves independent reservation damage',async()=>{
 const f=await reusableFixture(),a=await createReusable(f,'owner_race');await advanceNegotiation(f.key,'offer',adapter,a.id);await advanceNegotiation(f.key,'counter',adapter,a.id);
 const race:NegotiationAdapters={...adapter,plan:async input=>{await getDb().execute(sql`update entities set status='inactive',server_version=server_version+1 where id=${f.owner}`);return adapter.plan(input);}};
 expect(await advanceNegotiation(f.key,'stale_accept',race,a.id)).toMatchObject({status:'held',reason:'stale_inventory_or_context'});
 expect((await reusableRead(a.id)).state.phase).toBe('negotiating');expect((await getDb().execute(sql`select metadata from faction_resources where id=${f.sr}`))[0].metadata).toMatchObject({reservedGrain:0,reliefReservations:{}});
 await getDb().execute(sql`update entities set status='active' where id=${f.owner}`);await advanceNegotiation(f.key,'fresh_accept',adapter,a.id);
 await getDb().execute(sql`update faction_resources set metadata=jsonb_set(metadata,'{reservedGrain}','90'::jsonb) where id=${f.sr}`);
 expect(await advanceNegotiation(f.key,'damaged_pool',adapter,a.id)).toMatchObject({status:'held',reason:'reservation_or_inventory_changed'});
 expect(((await getDb().execute(sql`select metadata from faction_resources where id=${f.sr}`))[0].metadata as any).reservedGrain).toBe(90);
},30000);
integration('reusable relief evidence authoring uses quoted existing canon and cannot manufacture actor knowledge',async()=>{
 const f=await reusableFixture(),[event]=await getDb().select().from(storyEvents).where(eq(storyEvents.id,f.proofId));
 const input={eventId:f.proofId,expectedVersion:event.serverVersion,evidence:event.body,reviewedCanonicalEvidence:true,projection:{kind:'execution',value:f.grant}};
 expect(await recordReliefEvidence(f.key,input)).toMatchObject({status:'recorded'});
 expect(await recordReliefEvidence(f.key,input)).toMatchObject({status:'recorded',repeated:true});
 await expect(recordReliefEvidence(f.key,{...input,evidence:'Fabricated authority that never occurred.'})).rejects.toThrow(/Quote an actual/);
 const opts=await reliefAuthoringOptions(f.key);expect(opts.events.find(e=>e.id===f.proofId)?.metadata).toMatchObject({reliefEvidenceReview:{reviewedBy:'human'}});
 expect((await getDb().execute(sql`select count(*)::int as n from npc_event_links where event_id=${f.proofId}`))[0].n).toBe(1);
 const a=await createReusable(f,'unheard');await getDb().execute(sql`delete from npc_event_links where event_id=${f.proofId}`);
 expect(await advanceNegotiation(f.key,'unknown_proof',adapter,a.id)).toMatchObject({status:'blocked',reason:'project_prerequisite_not_personally_known'});
},30000);

integration('reusable relief rotates a bounded frontier so seventeen blocked projects cannot starve a ready one',async()=>{
 const f=await reusableFixture();
 await getDb().execute(sql`insert into faction_goals(id,story_id,faction_id,goal) values(${f.key+'_ready_goal'},${f.key},${f.supplier},'A ready cooperative relief objective')`);
 for(let i=0;i<17;i++)await createReusable(f,'blocked_'+String(i).padStart(2,'0'));
 const ready=await createReusable(f,'ready_last',f.key+'_ready_goal');await getDb().execute(sql`update faction_goals set status='completed' where id=${f.key+'_goal'}`);
 let calls=0;const counted:NegotiationAdapters={...adapter,plan:async input=>{calls++;return adapter.plan(input);}};
 expect(await advanceNegotiation(f.key,'frontier_first',counted)).toMatchObject({status:'replan'});expect(calls).toBe(0);
 expect(await advanceNegotiation(f.key,'frontier_second',counted)).toMatchObject({status:'replan'});expect(calls).toBe(0);
 expect(await advanceNegotiation(f.key,'frontier_third',counted)).toMatchObject({status:'offer',projectId:ready.id});expect(calls).toBe(1);
},30000);
integration('reusable relief HTTP authoring, inspection and cancellation use stable project identities',async()=>{
 const f=await reusableFixture();const {POST,GET}=await import('../../../routes/api/factions/[storyId]/+server');
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));const id=f.key+'_api';
 const body={operation:'create-relief-project',project:{id,objectiveId:f.key+'_goal',ownerEntityId:f.owner,executionProofId:f.proofId,expectedStoryVersion:story.serverVersion},config:f.config};
 const post=(data:unknown)=>POST({params:{storyId:f.key},request:new Request('http://127.0.0.1/api/factions/'+f.key,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})} as Parameters<typeof POST>[0]);
 expect(await (await post(body)).json()).toMatchObject({status:'authored'});expect(await (await post(body)).json()).toMatchObject({repeated:true});
 const inspection=await (await GET({params:{storyId:f.key}} as Parameters<typeof GET>[0])).json();expect(inspection.projects).toHaveLength(1);expect(inspection.authoring.events.find((e:any)=>e.id===f.proofId).knownByFaction).toContain(f.supplier);
 expect(await (await post({operation:'create-relief-project',project:body.project})).json()).toMatchObject({error:'Supported relief configuration is required.'});
 const cancellation={operation:'cancel-relief-project',project:{id,expectedStoryVersion:inspection.serverVersion,expectedProjectVersion:inspection.projects[0].serverVersion}};
 expect(await (await post(cancellation)).json()).toMatchObject({settlement:{status:'cancelled'}});
 expect(await (await post(cancellation)).json()).toMatchObject({request:{repeated:true}});
 expect((await reusableRead(id)).state.phase).toBe('cancelled');
},30000);

integration('reusable relief authoring keeps one-off consent bound and requires explicit repeat authority',async()=>{
 const f=await reusableFixture(),db=getDb(),[original]=await db.select().from(storyEvents).where(eq(storyEvents.id,f.proofId));
 const body=original.body.replace(' per shipment','');await db.execute(sql`update story_events set body=${body} where id=${f.proofId}`);
 const input={eventId:f.proofId,expectedVersion:original.serverVersion,evidence:body,reviewedCanonicalEvidence:true,projection:{kind:'execution',value:f.grant}};
 await expect(recordReliefEvidence(f.key,input)).rejects.toThrow(/explicit per-shipment permission/);
 const {scope,version,...fields}=f.grant;
 const proof={...fields,scope:'relief_execution',projectId:f.key+'_one_off'};
 await recordReliefEvidence(f.key,{...input,projection:{kind:'execution',value:proof}});
 const a=await createReusable(f,'one_off');expect(a.receipt).toMatchObject({status:'authored'});
 await expect(createReusable(f,'another_one_off')).rejects.toThrow(/exactly match/);
 const [event]=await db.select().from(storyEvents).where(eq(storyEvents.id,f.proofId));
 await expect(recordReliefEvidence(f.key,{...input,expectedVersion:event.serverVersion,projection:{kind:'execution',value:{...proof,projectId:f.key+'_different'}}})).rejects.toThrow(/already bound/);
 expect(record(event.metadata).reliefExecutionGrant).toBeNull();
},30000);

integration('reusable relief preserves the older singleton until its concession ends, then permits a new instance',async()=>{
 const f=await reusableFixture();await initializeNegotiation(f.key,f.config);
 await expect(createReusable(f,'too_early')).rejects.toThrow(/older negotiation uses this inventory/);
 await advanceNegotiation(f.key,'old_offer',adapter);await advanceNegotiation(f.key,'old_counter',adapter);await advanceNegotiation(f.key,'old_accept',adapter);
 await day(f.key,2);expect(await advanceNegotiation(f.key,'old_arrival',adapter)).toMatchObject({status:'delivered'});
 await expect(createReusable(f,'during_concession')).rejects.toThrow(/older negotiation uses this inventory/);
 await day(f.key,12);expect(await advanceNegotiation(f.key,'old_expiry',adapter)).toMatchObject({status:'completed'});
 const a=await createReusable(f,'after_legacy');expect(await advanceNegotiation(f.key,'new_offer',adapter,a.id)).toMatchObject({status:'offer'});
 const [story]=await getDb().select().from(stories).where(eq(stories.id,f.key));expect((record(record(story.metadata).factionWorkflow).negotiation as any).phase).toBe('completed');
},30000);
integration('reusable relief cannot convert an older managed ledger through the replan API',async()=>{
 const f=await persistentFixture(),[story]=await getDb().select().from(stories).where(eq(stories.id,f.key)),config=record(record(story.metadata).factionWorkflow).negotiationConfig,old=await readPersistent(f);
 await expect(authorReliefProject(f.key,{id:f.projectId,objectiveId:f.key+'_goal',ownerEntityId:f.owner,executionProofId:f.executionProofId,expectedStoryVersion:story.serverVersion,expectedProjectVersion:Number(old.project.server_version)},true,config)).rejects.toThrow(/older project contract/);
 expect((await readPersistent(f)).plan).toEqual(old.plan);
},30000);

integration('reusable relief mechanical fairness holds do not create a fresh adjudication cue revision',async()=>{
 const f=await reusableFixture();await getDb().execute(sql`update story_events set metadata=jsonb_set(metadata,'{reliefExecutionGrant,mode}','"contested"'::jsonb) where id=${f.proofId}`);
 const a=await createReusable(f,'contested');await reusableCommit(f,a.id);expect(await advanceNegotiation(f.key,'adjudicate',adapter,a.id)).toMatchObject({status:'adjudication'});
 const before=await reusableRead(a.id);const cue=projectAdjudicationBrief([{...before.row,id:a.id,status:before.row.status,project:before.row.project,serverVersion:before.row.server_version}],f.location,[f.owner],[],false);
 expect(cue).not.toBeNull();await advanceNegotiation(f.key,'unchanged_hold',adapter,a.id);const after=await reusableRead(a.id);
 expect(after.row.server_version).toBe(before.row.server_version);expect(projectAdjudicationBrief([{...after.row,id:a.id,status:after.row.status,project:after.row.project,serverVersion:after.row.server_version}],f.location,[f.owner],[cue!.sourceKey],false)).toBeNull();
},30000);
integration('reusable relief source choices retain older supported records and can search old unprojected evidence',async()=>{
 const f=await reusableFixture();
 await getDb().execute(sql`insert into story_events(id,story_id,type,title,body,created_turn) values(${f.key+'_old_fact'},${f.key},'reveal','A historically known road','An older established road supports this investigation.',0)`);
 for(let i=0;i<105;i++)await getDb().execute(sql`insert into story_events(id,story_id,type,title,body,created_turn) values(${f.key+'_recent_'+i},${f.key},'reveal','Recent unrelated fact','A recent unrelated canonical fact.',${i+1})`);
 const initial=await reliefAuthoringOptions(f.key);expect(initial.events.map(e=>e.id)).toEqual(expect.arrayContaining([f.proofId,f.key+'_route',f.key+'_authority']));
 expect(initial.events.map(e=>e.id)).not.toContain(f.key+'_old_fact');
 expect((await reliefAuthoringOptions(f.key,'historically known road')).events.map(e=>e.id)).toContain(f.key+'_old_fact');
},30000);

integration('reusable relief pins a repeated wake to its original shipment across queue rotation and interrupted receipt finalization',async()=>{
 const f=await reusableFixture(),a=await createReusable(f,'a'),b=await createReusable(f,'b');let calls=0;
 const counted:NegotiationAdapters={...adapter,plan:async input=>{calls++;return adapter.plan(input);}};
 expect(await advanceNegotiation(f.key,'wake_same',counted)).toMatchObject({status:'offer',projectId:a.id});
 expect(await advanceNegotiation(f.key,'wake_same',counted)).toMatchObject({status:'offer',projectId:a.id,repeated:true});expect(calls).toBe(1);
 await getDb().execute(sql`update sync_ops set status='selected',payload=payload-'result' where story_id=${f.key} and type='faction_relief_wake'`);
 expect(await advanceNegotiation(f.key,'wake_same',counted)).toMatchObject({status:'offer',repeated:true});expect(calls).toBe(1);expect((await reusableRead(b.id)).state.phase).toBe('idle');
 expect(await advanceNegotiation(f.key,'wake_next',counted)).toMatchObject({status:'offer',projectId:b.id});expect(calls).toBe(2);
},30000);
integration('reusable relief gives a retained older negotiation a fair wake when its inventories are independent',async()=>{
 const f=await reusableFixture();await initializeNegotiation(f.key,f.config);
 const sr=f.key+'_new_sr',rr=f.key+'_new_rr';await getDb().execute(sql`insert into faction_resources(id,story_id,faction_id,kind,name,amount) values(${sr},${f.key},${f.supplier},'grain','Second relief pool',100),(${rr},${f.key},${f.recipient},'grain','Second granary',10)`);
 const next={...f,config:{...f.config,supplierResourceId:sr,recipientResourceId:rr}},a=await createReusable(next,'new');
 expect(await advanceNegotiation(f.key,'fair_new',adapter)).toMatchObject({status:'offer',projectId:a.id});
 const old=await advanceNegotiation(f.key,'fair_old',adapter);expect(old).toMatchObject({status:'offer'});expect(old).not.toHaveProperty('projectId');
 expect(await advanceNegotiation(f.key,'fair_new_again',adapter)).toMatchObject({status:'counteroffer',projectId:a.id});
},30000);


async function verificationFixture(options:{recipient?:'supplier'|'recipient';deadline?:number;expected?:number;mode?:'routine'|'contested';consent?:'not_required'|'pending'|'confirmed'}={}){
 const f=await reusableFixture(),db=getDb(),subjectId=f.key+'_harvest';
 await db.execute(sql`insert into story_events(id,story_id,type,title,body,world_time,metadata) values(${subjectId},${f.key},'reveal','Known harvest estimate','Both stewards receive the sourced harvest estimate; it still needs verification.','Day 0',${JSON.stringify({actorClaims:[{text:'The harvest estimate requires verification.',knownBy:[f.owner,f.recipientOwner],kind:'learned'}]})}::jsonb)`);
 for(const actor of [f.owner,f.recipientOwner])await db.execute(sql`insert into npc_event_links(id,story_id,event_id,npc_entity_id,role) values(${subjectId+'_'+actor},${f.key},${subjectId},${actor},'knower')`);
 if(options.mode||options.consent)await db.execute(sql`update story_events set metadata=jsonb_set(jsonb_set(metadata,'{reliefExecutionGrant,mode}',${JSON.stringify(options.mode??'routine')}::jsonb),'{reliefExecutionGrant,playerConsent}',${JSON.stringify(options.consent??'not_required')}::jsonb) where id=${f.proofId}`);
 const [story]=await db.select().from(stories).where(eq(stories.id,f.key)),projectId=f.key+'_verification';
 const input={id:projectId,objectiveId:f.key+'_goal',ownerEntityId:f.owner,executionProofId:f.proofId,expectedStoryVersion:story.serverVersion,
  verification:{recipientEntityId:options.recipient==='supplier'?f.owner:f.recipientOwner,subjectEventId:subjectId,expectedDay:options.expected??1,deadlineDay:options.deadline??3}};
 const receipt=await authorReliefProject(f.key,input,false,f.config);
 return {...f,projectId,subjectId,input,receipt};
}
function verificationAdapter(packets:any[]=[],kind:'normal'|'investigate'='normal'){
 const counts={plan:0,decide:0};
 const result:NegotiationAdapters={plan:async input=>{counts.plan++;packets.push(input.actorPacket);const proposals=await adapter.plan(input) as any[];return proposals.map(p=>({...p,condition:input.actorPacket.verificationCondition,sourceIds:[...p.sourceIds,input.actorPacket.verificationCondition!.requestId]}));},
  decide:async input=>{counts.decide++;return kind==='investigate'?{optionId:'investigate',confidence:.95,sourceIds:input.sourceIds,model:'mock-investigator',memoryId:null,usage:null}:adapter.decide(input);}};
 return {adapter:result,counts};
}
async function receivedReport(f:Awaited<ReturnType<typeof verificationFixture>>,suffix='report',options:{by?:string;result?:'verified'|'contradictory'|'revoked';at?:number;quote?:string;annotate?:boolean}={}){
 const db=getDb(),eventId=f.key+'_'+suffix,by=options.by??f.input.verification.recipientEntityId;
 const text=options.quote??'The observer reports that the harvest estimate is supported.';
 await db.execute(sql`insert into story_events(id,story_id,type,title,body,world_time,metadata) values(${eventId},${f.key},'reveal','Received harvest verification',${text},${'Day '+(options.at??1)},${JSON.stringify({actorClaims:[{text,knownBy:[by],kind:'learned'}]})}::jsonb)`);
 await db.execute(sql`insert into npc_event_links(id,story_id,event_id,npc_entity_id,role) values(${eventId+'_link'},${f.key},${eventId},${by},'knower')`);
 const [event]=await db.select().from(storyEvents).where(eq(storyEvents.id,eventId)),p=await reusableRead(f.projectId);
 const input={projectId:f.projectId,eventId,expectedVersion:event.serverVersion,expectedProjectVersion:p.row.server_version,claimText:text,evidence:text,result:options.result??'verified',reviewedSourcedReceipt:true};
 if(options.annotate!==false)await recordVerificationReport(f.key,input);
 return {eventId,input};
}
integration('stage three persists exact conditional counteroffer/accept, waits without models, receives private claim and still needs physical outcome',async()=>{
 const f=await verificationFixture(),packets:any[]=[],a=verificationAdapter(packets);
 expect(f.receipt).toMatchObject({status:'authored'});expect(await authorReliefProject(f.key,f.input,false,f.config)).toMatchObject({repeated:true});
 await reusableCommit(f,f.projectId,a.adapter);const committed=await reusableRead(f.projectId);
 expect(committed.state.agreement.condition).toEqual(committed.plan.verification.condition);expect(committed.state.supplier.reservedGrain).toBe(40);
 const [agreement]=await getDb().select().from(agreements).where(eq(agreements.storyId,f.key));expect(agreement.terms).toContain(f.projectId+':verify');
 expect(await advanceNegotiation(f.key,'wait_for_report',a.adapter,f.projectId)).toMatchObject({status:'held',reason:'verification_report_pending'});
 await day(f.key,1);expect(await advanceNegotiation(f.key,'expected_is_not_receipt',a.adapter,f.projectId)).toMatchObject({status:'held',reason:'verification_report_overdue'});expect(a.counts).toEqual({plan:3,decide:3});
 await closeDb();await verifyTestDatabase();const r=await receivedReport(f);
 expect(await recordVerificationReport(f.key,r.input)).toMatchObject({repeated:true});
 expect(await advanceNegotiation(f.key,'departure',a.adapter,f.projectId)).toMatchObject({status:'dispatched'});
 expect((await reusableRead(f.projectId)).plan.verification).toMatchObject({status:'received',receipt:{eventId:r.eventId}});
 expect((await getDb().select().from(factionResources).where(eq(factionResources.id,f.sr)))[0]).toMatchObject({amount:100,metadata:{reservedGrain:40}});
 await day(f.key,2);expect(await advanceNegotiation(f.key,'departure_starts_travel',a.adapter,f.projectId)).toMatchObject({status:'held',reason:'in_transit_unconfirmed'});
 await day(f.key,3);expect(await advanceNegotiation(f.key,'report_does_not_deliver',a.adapter,f.projectId)).toMatchObject({status:'held',reason:'arrival_window_without_confirmation'});
 await reusableObserve(f,f.projectId,'delivered',3);expect(await advanceNegotiation(f.key,'observed_delivery',a.adapter,f.projectId)).toMatchObject({status:'delivered'});
 expect(await advanceNegotiation(f.key,'observed_delivery',a.adapter,f.projectId)).toMatchObject({repeated:true});expect(a.counts).toEqual({plan:3,decide:3});
 expect((await getDb().select().from(factionResources).where(eq(factionResources.id,f.sr)))[0].amount).toBe(60);
 expect(JSON.stringify(packets.filter(p=>p.actor.id===f.supplier))).not.toContain('observer reports');
},30000);
integration('stage three investigation request and wake receipt survive restart without duplicated requests or new information',async()=>{
 const f=await verificationFixture(),a=verificationAdapter([],'investigate');
 expect(await advanceNegotiation(f.key,'investigate_once',a.adapter)).toMatchObject({status:'investigating',projectId:f.projectId});
 const first=await reusableRead(f.projectId);expect(first.plan.verification).toMatchObject({status:'pending',receipt:null});
 await closeDb();await verifyTestDatabase();expect(await advanceNegotiation(f.key,'investigate_once',a.adapter)).toMatchObject({status:'investigating',repeated:true});
 expect(await advanceNegotiation(f.key,'unchanged_investigation',a.adapter,f.projectId)).toMatchObject({status:'held',reason:'unchanged_waiting_project'});expect(a.counts).toEqual({plan:1,decide:1});
 expect((await getDb().execute(sql`select count(*)::int n from story_events where story_id=${f.key} and metadata->>'negotiationKind'='investigation'`))[0].n).toBe(1);
 expect((await reusableRead(f.projectId)).plan.verification.condition.requestId).toBe(first.plan.verification.condition.requestId);
},30000);
integration('stage three canonical world-time expiry releases exactly its own reservation with no hostility or paid call',async()=>{
 const f=await verificationFixture(),a=verificationAdapter(),other=await createReusable(f,'ordinary');await reusableCommit(f,f.projectId,a.adapter);await reusableCommit(f,other.id);
 await getDb().execute(sql`update stories set current_turn=1000 where id=${f.key}`);
 expect(await advanceNegotiation(f.key,'turns_not_report',a.adapter,f.projectId)).toMatchObject({status:'held'});
 await day(f.key,4);expect(await advanceNegotiation(f.key,'expiry',a.adapter,f.projectId)).toMatchObject({status:'cancelled',reason:null});
 expect((await reusableRead(f.projectId)).plan).toMatchObject({verification:{status:'expired'},committedMeans:{amount:0}});
 const resource=(await getDb().select().from(factionResources).where(eq(factionResources.id,f.sr)))[0];expect(grainPool(resource)).toMatchObject({physical:100,total:40,reservations:{[other.id]:40}});
 await closeDb();await verifyTestDatabase();expect(await advanceNegotiation(f.key,'expiry',a.adapter,f.projectId)).toMatchObject({repeated:true});await advanceNegotiation(f.key,'expiry_again',a.adapter,f.projectId);
 expect(a.counts).toEqual({plan:3,decide:3});expect((await getDb().select().from(relationships).where(eq(relationships.storyId,f.key)))).toHaveLength(0);
 expect((await getDb().select().from(factionResources).where(eq(factionResources.id,f.rr)))[0].amount).toBe(10);
},30000);
integration.each(['contradictory','revoked','late','subject_revision','receipt_revision','receipt_revocation'])('stage three %s holds accepted dispatch; no resource/relationship effect',async change=>{
 const f=await verificationFixture(),a=verificationAdapter();await reusableCommit(f,f.projectId,a.adapter);await day(f.key,change==='late'?4:1);
 const r=await receivedReport(f,'report',{result:change==='contradictory'?'contradictory':change==='revoked'?'revoked':'verified',at:change==='late'?4:1});
 if(change==='subject_revision')await getDb().execute(sql`update story_events set body=body||' A revised estimate.',server_version=server_version+1 where id=${f.subjectId}`);
 if(['receipt_revision','receipt_revocation'].includes(change)){
  // Learn the claim under the project owner, then mutate the canonical source before any departure.
  const {loadPersistentProject,gatePersistentProject,saveProjectProgress}=await import('./persistentProjects');
  const p=await reusableRead(f.projectId),[story]=await getDb().select().from(stories).where(eq(stories.id,f.key));
  const ctx=await loadPersistentProject(f.key,{negotiationProjectId:f.projectId},negotiationSandboxSchema.parse(p.state),f.config);if(!ctx||'error' in ctx)throw new Error('missing context');
  const inv=await getDb().select().from(factionResources).where(eq(factionResources.storyId,f.key));const [agreement]=await getDb().select().from(agreements).where(eq(agreements.storyId,f.key));
  const {projectInventory}=await import('./reliefAdapter');const gate=gatePersistentProject(ctx,story.currentWorldTime,inv.map(r=>projectInventory(r,f.projectId)),agreement);expect(gate.plan.verification?.status).toBe('received');await saveProjectProgress(story,ctx,gate);
  await getDb().execute(sql`update story_events set status=${change==='receipt_revocation'?'cancelled':'committed'},server_version=server_version+1 where id=${r.eventId}`);
 }
 expect(await advanceNegotiation(f.key,'changed_report',a.adapter,f.projectId)).toMatchObject({status:'replan'});
 expect((await reusableRead(f.projectId)).plan.verification.status).toBe('contradictory');expect(a.counts).toEqual({plan:3,decide:3});
 expect((await getDb().select().from(factionResources).where(eq(factionResources.id,f.sr)))[0]).toMatchObject({amount:100,metadata:{reservedGrain:40}});
 expect(await advanceNegotiation(f.key,'no_auto_heal',a.adapter,f.projectId)).toMatchObject({status:'replan'});expect((await getDb().select().from(relationships).where(eq(relationships.storyId,f.key)))).toHaveLength(0);
},30000);
integration('stage three rejects report annotation for wrong actor, private/unrelated project, fabricated quote, future time and stale source revision',async()=>{
 const f=await verificationFixture(),db=getDb();await day(f.key,1);
 const other=await receivedReport(f,'other_actor',{by:f.owner,annotate:false});await expect(recordVerificationReport(f.key,other.input)).rejects.toThrow(/personally received/);
 const r=await receivedReport(f);await expect(recordVerificationReport(f.key,{...r.input,evidence:'A fabricated report that was never received.'})).rejects.toThrow(/actual committed/);
 const privateReport=await receivedReport(f,'future',{at:3,annotate:false});await expect(recordVerificationReport(f.key,privateReport.input)).rejects.toThrow(/receipt world time/);
 const otherProject=await createReusable(f,'unrelated');await expect(recordVerificationReport(f.key,{...r.input,projectId:otherProject.id})).rejects.toThrow(/explicitly authored/);
 const stale=await receivedReport(f,'stale',{annotate:false});await db.execute(sql`update story_events set server_version=server_version+1 where id=${stale.eventId}`);await expect(recordVerificationReport(f.key,stale.input)).rejects.toThrow(/changed since/i);
 expect((await db.select().from(storyEvents).where(eq(storyEvents.id,privateReport.eventId)))[0].metadata).not.toHaveProperty('verificationReport');
},30000);
integration.each([{mode:'contested',consent:'not_required'},{mode:'routine',consent:'pending'},{mode:'routine',consent:'confirmed'}] as const)('stage three received verification retains player/contested adjudication: %j',async options=>{
 const f=await verificationFixture(options),a=verificationAdapter();await reusableCommit(f,f.projectId,a.adapter);await day(f.key,1);await receivedReport(f);
 expect(await advanceNegotiation(f.key,'adjudication',a.adapter,f.projectId)).toMatchObject({status:'adjudication'});expect((await reusableRead(f.projectId)).plan.dispatchEventId).toBeNull();
},30000);
integration('stage three packet keeps sourced actor-known relationships scoped, and concurrent relationship revision cannot write a stale agreement',async()=>{
 const f=await verificationFixture(),db=getDb(),packets:any[]=[],a=verificationAdapter(packets),relationId=f.key+'_thanks';
 await db.execute(sql`insert into relationships(id,story_id,source_entity_id,target_entity_id,type,label,strength,metadata,source_event_ids) values(${relationId},${f.key},${f.owner},${f.recipientOwner},'allied-with','Gratitude for past shelter',0.8,${JSON.stringify({knownBy:[f.owner]})}::jsonb,${JSON.stringify([f.subjectId])}::jsonb),(${f.key+'_secret_relation'},${f.key},${f.recipientOwner},${f.owner},'enemy-of','PRIVATE_RECIPIENT_SUSPICION',-0.7,${JSON.stringify({knownBy:[f.recipientOwner]})}::jsonb,${JSON.stringify([f.subjectId])}::jsonb)`);
 const interrupted:NegotiationAdapters={...a.adapter,plan:async input=>{const p=await a.adapter.plan(input);await db.execute(sql`update relationships set strength=0.6,server_version=server_version+1 where id=${relationId}`);return p;}};
 expect(await advanceNegotiation(f.key,'stale_relationship',interrupted,f.projectId)).toMatchObject({status:'held',reason:'stale_inventory_or_context'});expect((await reusableRead(f.projectId)).state.phase).toBe('idle');
 expect(packets[0].relationships).toMatchObject([{id:relationId,label:'Gratitude for past shelter'}]);expect(JSON.stringify(packets[0])).not.toContain('PRIVATE_RECIPIENT_SUSPICION');
 await reusableCommit(f,f.projectId,a.adapter);const recipient=packets.find(p=>p.actor.id===f.recipient);expect(recipient.project).toBeNull();expect(JSON.stringify(recipient.relationships)).not.toContain('Gratitude for past shelter');expect(JSON.stringify(recipient.relationships)).toContain('PRIVATE_RECIPIENT_SUSPICION');
},30000);
integration('stage three request admission rollback preserves v2 history and rejects knowledge backfill, changed owner and oversized world window',async()=>{
 const f=await reusableFixture(),db=getDb(),subject=f.key+'_private';
 await db.execute(sql`insert into story_events(id,story_id,type,title,body,world_time,metadata) values(${subject},${f.key},'reveal','Private source','Only the supplier learns this estimate.','Day 0',${JSON.stringify({actorClaims:[{text:'Only the supplier learns this estimate.',knownBy:[f.owner],kind:'learned'}]})}::jsonb)`);
 await db.execute(sql`insert into npc_event_links(id,story_id,event_id,npc_entity_id,role) values(${subject+'_link'},${f.key},${subject},${f.owner},'knower')`);
 const ordinary=await createReusable(f,'existing'),[story]=await db.select().from(stories).where(eq(stories.id,f.key));
 const input={id:f.key+'_invalid',objectiveId:f.key+'_goal',ownerEntityId:f.owner,executionProofId:f.proofId,expectedStoryVersion:story.serverVersion,verification:{recipientEntityId:f.recipientOwner,subjectEventId:subject,expectedDay:1,deadlineDay:3}};
 await expect(authorReliefProject(f.key,input,false,f.config)).rejects.toThrow(/personally known to both/);
 await expect(authorReliefProject(f.key,{...input,verification:{...input.verification,recipientEntityId:'unrelated'}},false,f.config)).rejects.toThrow(/authorized decision owner/);
 expect((await db.execute(sql`select count(*)::int n from faction_projects where story_id=${f.key}`))[0].n).toBe(1);expect((await reusableRead(ordinary.id)).state.scope).toBe('persistent-relief-v2');
},30000);
integration('stage three actual API authoring/inspection exposes pending and received receipts without raw metadata edits',async()=>{
 const f=await verificationFixture(),{POST,GET}=await import('../../../routes/api/factions/[storyId]/+server');await day(f.key,1);const r=await receivedReport(f,'api_report',{annotate:false});
 const response=await POST({params:{storyId:f.key},request:new Request('http://127.0.0.1/api/factions/'+f.key,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'record-verification-report',report:r.input})})} as Parameters<typeof POST>[0]);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:'recorded'});
 const data=await (await GET({params:{storyId:f.key}} as Parameters<typeof GET>[0])).json();expect(data.projects[0].metadata.persistentProject.verification.status).toBe('pending');expect(data.authoring.events.find((e:any)=>e.id===r.eventId).knownByActor).toEqual([f.recipientOwner]);
 const a=verificationAdapter();await reusableCommit(f,f.projectId,a.adapter);expect(await advanceNegotiation(f.key,'api_dispatch',a.adapter,f.projectId)).toMatchObject({status:'dispatched'});
},30000);


integration('stage three a received report cannot cross project/request boundaries or be rebound to another shipment',async()=>{
 const f=await verificationFixture(),db=getDb(),[story]=await db.select().from(stories).where(eq(stories.id,f.key)),id=f.key+'_second_verify';
 await authorReliefProject(f.key,{...f.input,id,expectedStoryVersion:story.serverVersion},false,f.config);
 const a=verificationAdapter();await reusableCommit(f,f.projectId,a.adapter);await reusableCommit(f,id,a.adapter);await day(f.key,1);const r=await receivedReport(f);
 expect(await advanceNegotiation(f.key,'unrelated_wait',a.adapter,id)).toMatchObject({status:'held',reason:'verification_report_overdue'});
 const second=await reusableRead(id);await expect(recordVerificationReport(f.key,{...r.input,projectId:id,expectedProjectVersion:second.row.server_version})).rejects.toThrow(/another request/);
 expect(await advanceNegotiation(f.key,'first_departure',a.adapter,f.projectId)).toMatchObject({status:'dispatched'});expect((await reusableRead(id)).plan.dispatchEventId).toBeNull();expect((await reusableRead(id)).plan.verification.receipt).toBeNull();
},30000);
integration.each(['failed','refused'])('stage three sourced %s after verification/dispatch settles only the undelivered reservation once',async outcome=>{
 const f=await verificationFixture(),a=verificationAdapter();await reusableCommit(f,f.projectId,a.adapter);await day(f.key,1);await receivedReport(f);await advanceNegotiation(f.key,'depart',a.adapter,f.projectId);
 await reusableObserve(f,f.projectId,outcome,1);expect(await advanceNegotiation(f.key,'observed_non_delivery',a.adapter,f.projectId)).toMatchObject({status:outcome==='failed'?'failed':'cancelled'});
 expect(await advanceNegotiation(f.key,'observed_non_delivery',a.adapter,f.projectId)).toMatchObject({repeated:true});await advanceNegotiation(f.key,'later_non_delivery',a.adapter,f.projectId);
 expect((await getDb().select().from(factionResources).where(eq(factionResources.id,f.sr)))[0]).toMatchObject({amount:100,metadata:{reservedGrain:0}});expect((await getDb().select().from(factionResources).where(eq(factionResources.id,f.rr)))[0].amount).toBe(10);expect(a.counts).toEqual({plan:3,decide:3});
},30000);
integration('stage three early private report enters only the named actor packet, and stale extraction cannot overwrite a newer relationship',async()=>{
 const f=await verificationFixture(),db=getDb(),a=verificationAdapter(),relation=f.key+'_canon_relation',packets:any[]=[];await day(f.key,1);const r=await receivedReport(f);
 const scoped=verificationAdapter(packets);await reusableCommit(f,f.projectId,scoped.adapter);
 expect(JSON.stringify(packets.find(p=>p.actor.id===f.supplier))).not.toContain('observer reports');expect(packets.find(p=>p.actor.id===f.supplier).verification.status).toBe('unknown');expect(packets.find(p=>p.actor.id===f.recipient).verification.claim).toMatchObject({eventId:r.eventId,text:r.input.claimText});
 await db.execute(sql`insert into relationships(id,story_id,source_entity_id,target_entity_id,type,label,strength,metadata,source_event_ids) values(${relation},${f.key},${f.owner},${f.recipientOwner},'allied-with','Reviewed newer gratitude',0.8,${JSON.stringify({knownBy:[f.owner]})}::jsonb,${JSON.stringify([f.subjectId])}::jsonb)`);
 const narration='League steward and Regency steward review an earlier harvest estimate.';
 const stale=preserveDurableDeferredState(parseTurnUpdate({update:{relationships:[{sourceName:'League steward',targetName:'Regency steward',type:'allied-with',label:'Obsolete earlier suspicion',strength:-50,bidirectional:false,known_by:['League steward'],evidence:narration}]}}).update);expect(stale.relationships).toEqual([]);
 const entry=f.key+'_stale_report';await db.execute(sql`insert into story_entries(id,story_id,type,content,position) values(${entry},${f.key},'narration',${narration},10)`);
 await applyValidatedTurnUpdate({storyId:f.key,playerEntryId:entry+'_player',assistantEntryId:entry,narration,update:stale,parseWarnings:[],retrievedMemoryIds:[],serverVersion:10,mode:'supplemental',timelineTurn:0,suppressCurrentNpcAgency:true},{enqueueProjectionJobs:false});
 expect((await db.select().from(relationships).where(eq(relationships.id,relation)))[0]).toMatchObject({label:'Reviewed newer gratitude',strength:.8});
},30000);
integration('stage three new sourced contradiction during acceptance rejects all agreement/reservation mutations',async()=>{
 const f=await verificationFixture(),a=verificationAdapter();await advanceNegotiation(f.key,'offer',a.adapter,f.projectId);await advanceNegotiation(f.key,'counter',a.adapter,f.projectId);await day(f.key,1);
 const racing:NegotiationAdapters={...a.adapter,plan:async input=>{const p=await a.adapter.plan(input);await receivedReport(f,'race_report',{result:'contradictory'});return p;}};
 expect(await advanceNegotiation(f.key,'accept_race',racing,f.projectId)).toMatchObject({status:'held',reason:'stale_inventory_or_context'});
 expect((await reusableRead(f.projectId)).state.agreement).toBeNull();expect((await getDb().select().from(factionResources).where(eq(factionResources.id,f.sr)))[0]).toMatchObject({amount:100,metadata:{reservedGrain:0}});
 expect(await advanceNegotiation(f.key,'after_report_race',a.adapter,f.projectId)).toMatchObject({status:'replan'});
},30000);
