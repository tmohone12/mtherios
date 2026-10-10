import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { entities, factions, factionGoals, factionMemberships, factionResources, factionProjects, npcEventLinks, stories, storyEvents } from '$lib/server/db/schema';
import { patchWorldRecord } from '$lib/server/engine/worldRecords';
import { record, fingerprint } from './intentions';
import {isWorldSimEligibleFaction} from './autonomy';
import { resolveDecisionAuthority, factionKnowledgeActors } from './decisionContext';
import { reliefAdapter, grainPool } from './reliefAdapter';
import { reliefExecutionGrantSchema, reliefExecutionProofSchema } from './projectLifecycle';

const route = z.object({ locationId: z.string().min(1), blocked: z.boolean() }).strict();
const authority = z.object({ factionId: z.string().min(1), maxDays: z.number().int().min(1).max(30) }).strict();
const evidenceInput = z.object({ eventId: z.string().min(1), expectedVersion: z.number().int().nonnegative(),
 evidence: z.string().trim().min(12).max(1200), reviewedCanonicalEvidence: z.literal(true),
 projection: z.discriminatedUnion('kind', [
  z.object({kind:z.literal('route'),value:route}).strict(),
  z.object({kind:z.literal('authority'),value:authority}).strict(),
  z.object({kind:z.literal('execution'),value:z.union([reliefExecutionGrantSchema,reliefExecutionProofSchema])}).strict(),
 ]) }).strict();

/** Human review annotates an existing committed source through the canonical record writer.
 * It neither generates evidence nor creates audiences or inferred actor knowledge. */
export async function recordReliefEvidence(storyId:string,raw:unknown){
 const input=evidenceInput.parse(raw);
 return getDb().transaction(async tx=>{
  const [story]=await tx.select().from(stories).where(eq(stories.id,storyId)).for('update').limit(1);
  const [event]=await tx.select().from(storyEvents).where(and(eq(storyEvents.storyId,storyId),eq(storyEvents.id,input.eventId))).for('update').limit(1);
  if(!story||!event||event.status!=='committed'||['rumor','scheme'].includes(event.type)||!event.body.includes(input.evidence))throw new Error('Quote an actual committed canonical event. Rumors and future schemes cannot authorize relief.');
  const p=input.projection,value=p.value;
  const ids=p.kind==='route'?[p.value.locationId]:p.kind==='authority'?[p.value.factionId]:[p.value.ownerEntityId,p.value.supplierId,p.value.recipientId,p.value.locationId,...p.value.meansEntityIds];
  const entityRows=await tx.select().from(entities).where(and(eq(entities.storyId,storyId),inArray(entities.id,ids)));
  const factionRows=await tx.select().from(factions).where(and(eq(factions.storyId,storyId),inArray(factions.id,ids)));
  const nameFor=(id:string)=>entityRows.find(e=>e.id===id)?.name??factionRows.find(f=>f.id===id)?.name;
  if(ids.some(id=>!nameFor(id)||!input.evidence.includes(nameFor(id)!)))throw new Error('The quoted evidence must explicitly name the selected location, parties, owner and means. Choose another source if these are not established.');
  if(p.kind==='route'&&!entityRows.some(e=>e.id===p.value.locationId&&e.type==='location'&&e.status==='active'))throw new Error('Select an active canonical location.');
  if(p.kind==='execution'&&(p.value.meansEntityIds.some(id=>!entityRows.some(e=>e.id===id&&e.status==='active'&&['character','item'].includes(e.type)))||!entityRows.some(e=>e.id===p.value.ownerEntityId&&e.type==='character'&&e.status==='active')))throw new Error('Execution requires an active decision owner and established means.');
  if(p.kind!=='route'&&!input.evidence.includes(String(p.kind==='authority'?p.value.maxDays:p.value.maxGrain)))throw new Error('The quoted authority must state the selected numeric limit.');
  if(p.kind==='execution'&&p.value.scope==='relief_authority'&&!/\b(?:per|each)\s+(?:shipment|delivery)\b/i.test(input.evidence))throw new Error('Reusable authority requires explicit per-shipment permission in the quoted canon. Otherwise record one-off authority.');
  if(p.kind==='execution'&&p.value.scope==='relief_execution'&&record(record(event.metadata).reliefExecution).projectId&&record(record(event.metadata).reliefExecution).projectId!==p.value.projectId)throw new Error('One-off authority is already bound to another project. Select a new canonical authorization.');
  const key=p.kind==='route'?'deliveryRoute':p.kind==='authority'?'tollAuthority':p.value.scope==='relief_authority'?'reliefExecutionGrant':'reliefExecution';
  const metadata=record(event.metadata),audit=record(metadata.reliefEvidenceReview);
  if(fingerprint(Object.entries(record(metadata[key])).sort(([a],[b])=>a.localeCompare(b)))===fingerprint(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)))&&audit.evidence===input.evidence)return {status:'recorded',eventId:event.id,repeated:true};
  const result=await patchWorldRecord(storyId,'events',event.id,{updates:{metadata:{[key]:value,...(p.kind==='execution'?{[key==='reliefExecution'?'reliefExecutionGrant':'reliefExecution']:null}:{}),reliefEvidenceReview:{kind:p.kind,evidence:input.evidence,reviewedBy:'human'}}},expectedVersion:input.expectedVersion,jsonMode:'merge',reason:'Explicit human review of existing canonical relief evidence.'},{role:'human',id:'local-human'},tx);
  return {status:'recorded',eventId:event.id,serverVersion:result.serverVersion};
 });
}

export async function reliefAuthoringOptions(storyId:string,query=''){
 const db=getDb();
 const [partyRows,goals,resources,actors,members,recentEvents]=await Promise.all([
  db.select().from(factions).where(eq(factions.storyId,storyId)),db.select().from(factionGoals).where(and(eq(factionGoals.storyId,storyId),inArray(factionGoals.status,['active','in_progress']))),
  db.select().from(factionResources).where(and(eq(factionResources.storyId,storyId),eq(factionResources.kind,'grain'))),
  db.select().from(entities).where(eq(entities.storyId,storyId)),db.select().from(factionMemberships).where(eq(factionMemberships.storyId,storyId)),
  db.select().from(storyEvents).where(and(eq(storyEvents.storyId,storyId),eq(storyEvents.status,'committed'))).orderBy(desc(storyEvents.createdTurn),desc(storyEvents.createdAt),storyEvents.id).limit(100),
 ]);
 const supported=await db.select().from(storyEvents).where(and(eq(storyEvents.storyId,storyId),eq(storyEvents.status,'committed'),query.trim()?sql`concat(${storyEvents.title},' ',${storyEvents.body}) ilike ${'%'+query.trim().slice(0,240)+'%'}`:sql`${storyEvents.metadata} ?| array['deliveryRoute','tollAuthority','reliefExecution','reliefExecutionGrant','verificationReport']`)).orderBy(desc(storyEvents.createdTurn),desc(storyEvents.createdAt),storyEvents.id).limit(100);
 const events=[...new Map([...recentEvents,...supported].map(e=>[e.id,e])).values()];
 // Authority resolution needs linked mandate sources even if they precede the evidence browser page.
 const mandateIds=members.map(m=>record(record(m.metadata).decisionAuthority).sourceEventId).filter((v):v is string=>typeof v==='string');
 const mandates=mandateIds.length?await db.select().from(storyEvents).where(and(eq(storyEvents.storyId,storyId),inArray(storyEvents.id,mandateIds))):[];
 const links=events.length?await db.select().from(npcEventLinks).where(and(eq(npcEventLinks.storyId,storyId),inArray(npcEventLinks.eventId,events.map(e=>e.id)))):[];
 const knowledgeActors=partyRows.map(f=>({id:f.id,actors:factionKnowledgeActors(f,members,actors,resolveDecisionAuthority(f,members,actors,mandates))}));
 return { factions:partyRows.map(f=>({id:f.id,name:f.name,eligible:isWorldSimEligibleFaction(f,actors.find(a=>a.id===f.entityId))&&record(f.metadata).historical!==true,authority:resolveDecisionAuthority(f,members,actors,mandates)})),goals:goals.map(g=>({id:g.id,factionId:g.factionId,label:g.goal})),
  resources:resources.map(r=>{try{const pool=grainPool(r);return {id:r.id,factionId:r.factionId,name:r.name,status:r.status,amount:r.amount,reserved:pool.total,available:pool.physical-pool.total,issue:null};}catch{return {id:r.id,factionId:r.factionId,name:r.name,status:r.status,amount:r.amount,available:null,issue:'Reservation ledger needs reconciliation.'};}}),
  actors:actors.filter(e=>e.status==='active').map(e=>({id:e.id,name:e.name,type:e.type})),
  events:events.map(e=>({id:e.id,title:e.title,body:e.body,type:e.type,serverVersion:e.serverVersion,metadata:e.metadata,knownByActor:links.filter(l=>l.eventId===e.id&&['actor','witness','knower','witnessed','learned','shared'].includes(l.role)&&Array.isArray(record(e.metadata).actorClaims)&&(record(e.metadata).actorClaims as unknown[]).some(c=>['learned','witnessed','shared'].includes(String(record(c).kind))&&Array.isArray(record(c).knownBy)&&(record(c).knownBy as string[]).includes(l.npcEntityId))).map(l=>l.npcEntityId),worldTime:e.worldTime,knownByFaction:knowledgeActors.filter(k=>Array.isArray(record(e.metadata).actorClaims)&&(record(e.metadata).actorClaims as unknown[]).some(c=>typeof record(c).text==='string'&&['learned','witnessed','shared'].includes(String(record(c).kind))&&Array.isArray(record(c).knownBy)&&(record(c).knownBy as string[]).some(id=>k.actors.includes(id)))&&(record(e.metadata).negotiationId||links.some(l=>l.eventId===e.id&&k.actors.includes(l.npcEntityId)&&['actor','witness','knower','witnessed','learned','shared'].includes(l.role)))).map(k=>k.id)})),
  sourceLimit:200,required:['An active owned objective and current decision owners','Two available grain inventories','Committed route, toll authority and execution authorization personally known to the appropriate actors'],
  optional:['Reports can clarify uncertainty; a suggested report is not a prerequisite or an established outcome.'] };
}

export async function requestReliefCancellation(storyId:string,raw:unknown){
 const input=z.object({id:z.string().min(1),expectedStoryVersion:z.number().int().nonnegative(),expectedProjectVersion:z.number().int().nonnegative()}).strict().parse(raw);
 return getDb().transaction(async tx=>{
  const [story]=await tx.select().from(stories).where(eq(stories.id,storyId)).for('update').limit(1);
  const [project]=await tx.select().from(factionProjects).where(and(eq(factionProjects.storyId,storyId),eq(factionProjects.id,input.id))).for('update').limit(1);
  const adapter=reliefAdapter(project?.metadata);
  if(!story||!project||!adapter.success)throw new Error('Select a supported reusable relief project.');
  if(project.status==='cancelled'||['cancelled','completed','failed','refused','expired'].includes(adapter.data.state.phase))return {status:'unchanged',projectId:project.id,repeated:true};
  if(adapter.data.state.phase==='delivered')throw new Error('Confirmed delivery cannot be reversed by cancellation.');
  if(story.serverVersion!==input.expectedStoryVersion||project.serverVersion!==input.expectedProjectVersion)throw new Error('Project changed. Refresh before cancelling.');
  await tx.update(factionProjects).set({status:'cancelled',serverVersion:story.serverVersion+1,updatedAt:new Date().toISOString()}).where(eq(factionProjects.id,project.id));
  await tx.update(stories).set({serverVersion:story.serverVersion+1,updatedAt:new Date().toISOString()}).where(eq(stories.id,storyId));
  return {status:'cancellation_requested',projectId:project.id};
 });
}
