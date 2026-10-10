import {createVerificationRequest,verificationAuthoringSchema} from './verificationAuthoring';
import {initialReliefState,reliefAdapter} from './reliefAdapter';
import {and,desc,eq,inArray,notInArray,or,sql,type SQL} from 'drizzle-orm';
import {z} from 'zod';
import {getDb} from '$lib/server/db/client';
import {entities,factionGoals,factionMemberships,factionProjects,factions,npcEventLinks,relationships,stories,storyEvents} from '$lib/server/db/schema';
import {fingerprint,record,strings,worldDay} from './intentions';
import {factionKnowledgeActors,resolveDecisionAuthority} from './decisionContext';
import {isWorldSimEligibleFaction} from './autonomy';
import {boundReliefProof,confirmedOutcomeDue,objectiveFingerprint,persistentProjectSchema,reliefConfigSchema,reliefExecutionProofSchema,reliefOutcomeSchema,type PersistentProject} from './projectLifecycle';
import {evaluateVerification,personallyReceived,verificationReportSchema,verificationConditionSchema} from './verificationContract';
import {NEGOTIATION_PLANNER_PROMPT,negotiationCanonicalTerms,negotiationSandboxSchema,type NegotiationSandbox} from './negotiationPrototype';

type Db=ReturnType<typeof getDb>;
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type Row<T extends { $inferSelect: unknown }>=T['$inferSelect'];
export type ReliefConfig=z.infer<typeof reliefConfigSchema>;
export type PersistentContext={project:Row<typeof factionProjects>;plan:PersistentProject;goal:Row<typeof factionGoals>|undefined;
 factions:Row<typeof factions>[];members:Row<typeof factionMemberships>[];actors:Row<typeof entities>[];events:Row<typeof storyEvents>[];links:Row<typeof npcEventLinks>[];relationships?:Row<typeof relationships>[];relationshipsWhere?:SQL;reports?:Row<typeof storyEvents>[];reportsWhere?:SQL;
 config:ReliefConfig;state:NegotiationSandbox;proof:z.infer<typeof reliefExecutionProofSchema>|null;outcome:Row<typeof storyEvents>|undefined;outcomeWhere:SQL|undefined;contextFingerprint:string;actorIds:string[];knowledgeActorIds:string[]};
const active=(goal:Record<string,unknown>|undefined)=>!!goal&&['active','in_progress'].includes(String(goal.status));
const authored=z.object({verification:verificationAuthoringSchema.optional(),id:z.string().min(1).max(80),objectiveId:z.string().min(1).max(160),ownerEntityId:z.string().min(1).max(160),executionProofId:z.string().min(1).max(80),expectedStoryVersion:z.number().int().nonnegative(),expectedProjectVersion:z.number().int().nonnegative().optional()}).strict();

/** Load only the opt-in project. No historical project is converted or inferred. */
export async function loadPersistentProject(storyId:string,workflow:Record<string,unknown>,state:NegotiationSandbox,config:ReliefConfig):Promise<PersistentContext|{error:string}|null>{
 if(typeof workflow.negotiationProjectId!=='string')return null;
 const db=getDb(),[project]=await db.select().from(factionProjects).where(and(eq(factionProjects.storyId,storyId),eq(factionProjects.id,workflow.negotiationProjectId))).limit(1);
 const parsed=persistentProjectSchema.safeParse(record(project?.metadata).persistentProject);
 if(!project||!parsed.success)return {error:'persistent_project_missing_or_invalid'};
 const plan=parsed.data;
 const adapter=reliefAdapter(project.metadata);
 if(['persistent-relief-v2','persistent-relief-v3'].includes(state.scope)&&(!adapter.success||fingerprint(adapter.data.state)!==fingerprint(state)||fingerprint(adapter.data.config)!==fingerprint(config)))return {error:'persistent_project_binding_changed'};
 if(plan.negotiationId!==state.id||project.factionId!==config.supplierId||plan.committedMeans.resourceId!==config.supplierResourceId)return {error:'persistent_project_binding_changed'};
 const [partyRows,members,goals]=await Promise.all([
  db.select().from(factions).where(and(eq(factions.storyId,storyId),inArray(factions.id,[config.supplierId,config.recipientId]))),
  db.select().from(factionMemberships).where(and(eq(factionMemberships.storyId,storyId),inArray(factionMemberships.factionId,[config.supplierId,config.recipientId]))),
  db.select().from(factionGoals).where(and(eq(factionGoals.storyId,storyId),eq(factionGoals.id,plan.objectiveId))),
 ]);
 const eventIds=[...new Set([...plan.dependencies.map(d=>d.eventId),...(plan.verification?[plan.verification.condition.subjectEventId,...(state.agreement?[`neg_${state.id}_${state.agreement.id}`]:[])]:[]),config.routeSourceId,config.authoritySourceId,plan.executionProofId,
  ...members.map(m=>record(record(m.metadata).decisionAuthority).sourceEventId).filter((v):v is string=>typeof v==='string')])];
 const events=await db.select().from(storyEvents).where(and(eq(storyEvents.storyId,storyId),inArray(storyEvents.id,eventIds)));
 const proof=boundReliefProof(events.find(e=>e.id===plan.executionProofId)?.metadata,project.id);
 const actorIds=[...new Set([...partyRows.map(f=>f.entityId),...members.map(m=>m.entityId),...(proof?.meansEntityIds??[])].filter((v):v is string=>typeof v==='string'))];
 const actors=actorIds.length?await db.select().from(entities).where(and(eq(entities.storyId,storyId),inArray(entities.id,actorIds))):[];
 const agreementId=state.agreement?`neg_${state.id}_${state.agreement.id}`:null;
 const knownTo=(partyId:string)=>{
  const faction=partyRows.find(f=>f.id===partyId),authority=faction&&resolveDecisionAuthority(faction,members,actors,events);
  const eligible=faction&&authority?factionKnowledgeActors(faction,members,actors,authority):[partyId];
  const ids=sql`array[${sql.join(eligible.map(id=>sql`${id}`),sql`, `)}]::text[]`;
  return sql`exists(select 1 from jsonb_array_elements(case when jsonb_typeof(${storyEvents.metadata}->'actorClaims')='array' then ${storyEvents.metadata}->'actorClaims' else '[]'::jsonb end) c where c->>'kind' in ('learned','witnessed','shared') and jsonb_typeof(c->'knownBy')='array' and jsonb_typeof(c->'text')='string' and c->'knownBy' ?| ${ids})
   and (${storyEvents.metadata}->>'negotiationId' is not null or exists(select 1 from ${npcEventLinks} l where l.story_id=${storyId} and l.event_id=${storyEvents.id} and l.npc_entity_id=any(${ids}) and l.role in ('actor','witness','knower','witnessed','learned','shared')))`;
 };
 const outcomeWhere=plan.dispatchEventId&&agreementId?and(eq(storyEvents.storyId,storyId),eq(storyEvents.status,'committed'),
  sql`${storyEvents.metadata}->'reliefOutcome'->>'projectId'=${project.id}`,sql`${storyEvents.metadata}->'reliefOutcome'->>'agreementId'=${agreementId}`,sql`${storyEvents.metadata}->'reliefOutcome'->>'dispatchEventId'=${plan.dispatchEventId}`,
  knownTo(config.supplierId),knownTo(config.recipientId),...(plan.discardedConfirmationIds.length?[notInArray(storyEvents.id,plan.discardedConfirmationIds)]:[])):undefined;
 const outcomes=outcomeWhere?await db.select().from(storyEvents).where(outcomeWhere)
  .orderBy(desc(storyEvents.createdTurn),desc(storyEvents.createdAt),storyEvents.id).limit(1):[];
 const outcome=outcomes[0];if(outcome)events.push(outcome);
 const v=plan.verification;
 if((state.scope==='persistent-relief-v3')!==Boolean(v)||v&&(fingerprint(v.condition)!==fingerprint(state.verificationCondition)||v.condition.projectId!==project.id||![plan.ownerEntityId,plan.recipientOwnerEntityId].includes(v.condition.recipientEntityId)))return {error:'verification_project_binding_changed'};
 const reportsWhere=v?and(eq(storyEvents.storyId,storyId),or(and(sql`${storyEvents.metadata}->'verificationReport'->'condition'->>'projectId'=${project.id}`,sql`${storyEvents.metadata}->'verificationReport'->'condition'->>'requestId'=${v.condition.requestId}`,
  sql`exists(select 1 from jsonb_array_elements(case when jsonb_typeof(${storyEvents.metadata}->'actorClaims')='array' then ${storyEvents.metadata}->'actorClaims' else '[]'::jsonb end) c where c->>'kind' in ('learned','witnessed','shared') and c->'knownBy' ? ${v.condition.recipientEntityId})`,
  sql`exists(select 1 from ${npcEventLinks} l where l.story_id=${storyId} and l.event_id=${storyEvents.id} and l.npc_entity_id=${v.condition.recipientEntityId} and l.role in ('actor','witness','knower','witnessed','learned','shared'))`),...(v.receipt?[eq(storyEvents.id,v.receipt.eventId)]:[]))):undefined;
 const reports=reportsWhere?await db.select().from(storyEvents).where(reportsWhere).orderBy(storyEvents.id).limit(9):[];
 const ownerIds=[plan.ownerEntityId,plan.recipientOwnerEntityId],ownerSql=sql`array[${sql.join(ownerIds.map(id=>sql`${id}`),sql`, `)}]::text[]`;
 const relationshipsWhere=v?and(eq(relationships.storyId,storyId),or(inArray(relationships.sourceEntityId,ownerIds),inArray(relationships.targetEntityId,ownerIds)),sql`${relationships.metadata}->'knownBy' ?| ${ownerSql}`):undefined;
 const relations=relationshipsWhere?await db.select().from(relationships).where(relationshipsWhere).orderBy(relationships.id).limit(8):[];
 const relationshipSourceIds=[...new Set(relations.flatMap(r=>r.sourceEventIds))].slice(0,32);
 const extraIds=relationshipSourceIds.filter(id=>!events.some(e=>e.id===id));
 const extraEvents=extraIds.length?await db.select().from(storyEvents).where(and(eq(storyEvents.storyId,storyId),inArray(storyEvents.id,extraIds))):[];
 events.push(...reports.filter(e=>!events.some(prior=>prior.id===e.id)),...extraEvents);

 const knowledgeIds=[...new Set(partyRows.flatMap(f=>factionKnowledgeActors(f,members,actors,resolveDecisionAuthority(f,members,actors,events))))].sort();
 const links=await db.select().from(npcEventLinks).where(and(eq(npcEventLinks.storyId,storyId),inArray(npcEventLinks.eventId,events.map(e=>e.id)),inArray(npcEventLinks.npcEntityId,knowledgeIds)));
 return {project,plan,goal:goals[0],factions:partyRows,members,actors,events,links,config,state,proof,outcome,outcomeWhere,relationships:relations,relationshipsWhere,reports,reportsWhere,actorIds,knowledgeActorIds:knowledgeIds,contextFingerprint:''};
}
function known(ctx:PersistentContext,eventId:string,partyId:string){
 const faction=ctx.factions.find(f=>f.id===partyId);if(!faction)return false;
 const authority=resolveDecisionAuthority(faction,ctx.members,ctx.actors,ctx.events),ids=factionKnowledgeActors(faction,ctx.members,ctx.actors,authority);
 const event=ctx.events.find(e=>e.id===eventId);if(!event||event.status!=='committed')return false;
 const received=record(event.metadata).negotiationId||ctx.links.some(l=>l.eventId===eventId&&ids.includes(l.npcEntityId)&&['actor','witness','knower','witnessed','learned','shared'].includes(l.role));
 return !!received&&Array.isArray(record(event.metadata).actorClaims)&&(record(event.metadata).actorClaims as unknown[]).some(c=>typeof record(c).text==='string'&&['learned','witnessed','shared'].includes(String(record(c).kind))&&strings(record(c).knownBy).some(id=>ids.includes(id)));
}
export function projectReadiness(ctx:PersistentContext){
 const {plan,config,proof}=ctx;
 for(const [id,expected] of [[config.supplierId,plan.ownerEntityId],[config.recipientId,plan.recipientOwnerEntityId]]){
  const faction=ctx.factions.find(f=>f.id===id),authority=faction&&resolveDecisionAuthority(faction,ctx.members,ctx.actors,ctx.events);
  if(faction&&(!isWorldSimEligibleFaction(faction,ctx.actors.find(a=>a.id===faction.entityId))||record(faction.metadata).historical===true))return {phase:'blocked' as const,reason:'project_faction_ineligible'};
  if(!authority||authority.status!=='ready'||authority.ownerEntityId!==expected)return {phase:'replan' as const,reason:'project_owner_changed_or_ineligible'};
 }
 if(!active(ctx.goal)||ctx.goal?.factionId!==config.supplierId||objectiveFingerprint(ctx.goal)!==plan.objectiveFingerprint)return {phase:'replan' as const,reason:'project_objective_changed'};
 if(!proof||proof.projectId!==ctx.project.id||proof.ownerEntityId!==plan.ownerEntityId||proof.supplierId!==config.supplierId||proof.recipientId!==config.recipientId||proof.locationId!==config.locationId)return {phase:'blocked' as const,reason:'missing_scoped_execution_authority'};
 if(!known(ctx,plan.executionProofId,config.supplierId)||!known(ctx,config.routeSourceId,config.supplierId)||!known(ctx,config.authoritySourceId,config.recipientId))return {phase:'blocked' as const,reason:'project_prerequisite_not_personally_known'};
 if(proof.meansEntityIds.some(id=>!ctx.actors.some(a=>a.id===id&&a.status==='active'&&['character','item'].includes(a.type))))return {phase:'blocked' as const,reason:'project_means_unavailable'};
 const route=record(record(ctx.events.find(e=>e.id===config.routeSourceId)?.metadata).deliveryRoute);
 const authority=record(record(ctx.events.find(e=>e.id===config.authoritySourceId)?.metadata).tollAuthority);
 if(route.locationId!==config.locationId||typeof route.blocked!=='boolean'||authority.factionId!==config.recipientId||typeof authority.maxDays!=='number')return {phase:'blocked' as const,reason:'project_constraints_unavailable'};
 if(ctx.events.filter(e=>[config.routeSourceId,config.authoritySourceId,plan.executionProofId].includes(e.id)).some(e=>e.status!=='committed'))return {phase:'replan' as const,reason:'project_source_cancelled'};
 if(route.blocked)return {phase:'blocked' as const,reason:'project_route_blocked'};
 if(plan.dependencies.some(d=>fingerprint(ctx.events.find(e=>e.id===d.eventId))!==d.fingerprint))return {phase:'replan' as const,reason:'project_dependency_changed'};
 if(ctx.state.agreement&&(ctx.state.agreement.terms.grain>proof.maxGrain||ctx.state.agreement.terms.tollDays>authority.maxDays))return {phase:'replan' as const,reason:'project_terms_exceed_authority'};
 return null;
}
export type ProjectGate={command:'advance'|'dispatch'|'cancel'|'progress'|'hold';confirmedOutcome:'delivered'|'failed'|null;observedDay:number|null;plan:PersistentProject;reason:string|null};
/** Cheap readiness precedes inference. The project remains the same plan until a relevant canonical change. */
export function gatePersistentProject(ctx:PersistentContext,worldTime:string|null,inventory:Record<string,unknown>[],agreement:Record<string,unknown>|undefined,inferenceRevision:string|null=null):ProjectGate{
 const plan=structuredClone(ctx.plan),state=ctx.state,now=worldDay(worldTime);
 const agreementId=state.agreement?`neg_${state.id}_${state.agreement.id}`:null;
 plan.committedMeans={resourceId:ctx.config.supplierResourceId,amount:state.supplier.reservedGrain,agreementId};
 if(state.agreement)plan.dueWorldTime=`Day ${state.agreement.deliveryDay}`;
 ctx.contextFingerprint=fingerprint({goal:ctx.goal&&objectiveFingerprint(ctx.goal),owners:ctx.factions.map(f=>resolveDecisionAuthority(f,ctx.members,ctx.actors,ctx.events)),eligibility:ctx.factions.map(f=>({id:f.id,eligible:isWorldSimEligibleFaction(f,ctx.actors.find(a=>a.id===f.entityId)),historical:record(f.metadata).historical===true})),knowledgeActors:ctx.knowledgeActorIds,learnedLinks:[...ctx.links].sort((a,b)=>a.id.localeCompare(b.id)),sources:[...ctx.events].sort((a,b)=>a.id.localeCompare(b.id)),
  means:ctx.proof?.meansEntityIds.map(id=>{const a=ctx.actors.find(a=>a.id===id);return {id,status:a?.status};}),
  inventory:inventory.map(r=>({id:r.id,amount:r.amount,status:r.status,reserved:record(r.metadata).reservedGrain??0})).sort((a,b)=>String(a.id).localeCompare(String(b.id))),
  relationships:ctx.relationships,verification:plan.verification?{status:plan.verification.status,clock:now===null?null:{expected:now>=plan.verification.expectedDay,expired:now>plan.verification.deadlineDay}}:null,inferenceRevision,plannerContract:NEGOTIATION_PLANNER_PROMPT,agreement,offer:state.offer,phase:state.phase,clock:state.offer?now!==null&&now>=state.offer.expiresDay:state.agreement?{due:now!==null&&now>=state.agreement.deliveryDay,expiry:state.agreement.tollUntilDay!==null&&now!==null&&now>=state.agreement.tollUntilDay}:null});
 const finish=(command:ProjectGate['command'],phase:PersistentProject['phase'],reason:string|null,nextStep:string,confirmedOutcome:ProjectGate['confirmedOutcome']=null):ProjectGate=>{
  plan.phase=phase;plan.reason=reason;plan.nextStep=nextStep;plan.lastContextFingerprint=ctx.contextFingerprint;return {command,plan,reason,confirmedOutcome,observedDay:null};
 };
 if(['failed','refused','expired','cancelled','completed'].includes(state.phase))return finish('hold',state.phase==='completed'?'completed':state.phase==='failed'?'failed':'cancelled','project_terminal','No automatic replay or resource reversal.');
 const cancelling=ctx.project.status==='cancelled'||agreement&&['cancelled','deleted'].includes(String(agreement.status));
 if(cancelling&&state.phase!=='delivered')return finish('cancel','cancelled','project_cancelled','Release the existing undelivered reservation exactly once.');
 if(ctx.project.status!=='active')return finish('hold',plan.phase,'project_status_requires_review','Review the canonical project status; confirmed effects cannot be rewound.');
 for(const [id,party] of [[ctx.config.supplierResourceId,state.supplier],[ctx.config.recipientResourceId,state.recipient]] as const){
  const resource=inventory.find(r=>r.id===id);
  if(!resource||resource.factionId!==party.id||resource.kind!=='grain'||resource.status!=='available'||typeof resource.amount!=='number'||!Number.isInteger(resource.amount)||resource.amount<party.reservedGrain||(record(resource.metadata).reservedGrain??0)!==party.reservedGrain)
   return finish('progress','blocked','reservation_or_inventory_changed','Reconcile the existing inventory ledger; do not double-allocate or overwrite a changed reservation.');
 }
 if(state.agreement&&(!agreement||agreement.status!=='active'||agreement.category!=='trade'||agreement.terms!==negotiationCanonicalTerms(state.agreement)||state.agreement.condition&&(ctx.events.find(e=>e.id===agreementId)?.status!=='committed'||!strings(agreement.sourceEventIds).includes(agreementId!)||fingerprint(verificationConditionSchema.safeParse(record(ctx.events.find(e=>e.id===agreementId)?.metadata).reliefCondition).data??null)!==fingerprint(state.agreement.condition))||fingerprint([...strings(agreement.parties)].sort())!==fingerprint([state.supplier.id,state.recipient.id].sort())))
  return finish('progress','replan','agreement_changed','Preserve the undelivered reservation and obtain fresh canonical terms and consent.');
 if(state.phase==='delivered')return finish(state.agreement?.tollUntilDay!==null&&now!==null&&now>=state.agreement!.tollUntilDay!?'advance':'hold','confirmation','awaiting_concession_expiry','Preserve the confirmed delivery; expire the concession only when due.');
 const parsed=reliefOutcomeSchema.safeParse(record(ctx.outcome?.metadata).reliefOutcome);
 const observedDay=parsed.success?worldDay(parsed.data.observedWorldTime):null;
 if(observedDay!==null&&now!==null&&observedDay>now&&ctx.outcome&&!plan.discardedConfirmationIds.includes(ctx.outcome.id))
  plan.discardedConfirmationIds=[...plan.discardedConfirmationIds,ctx.outcome.id].slice(-8);
 const knownOutcome=parsed.success&&!plan.discardedConfirmationIds.includes(ctx.outcome!.id)&&known(ctx,ctx.outcome!.id,ctx.config.supplierId)&&known(ctx,ctx.outcome!.id,ctx.config.recipientId)
  &&confirmedOutcomeDue(parsed.data.observedWorldTime,worldTime,plan.dueWorldTime,parsed.data.outcome);
 // A sourced refusal or failure releases the existing undelivered reservation; changed route/means cannot turn that into a delivery.
 if(plan.dispatchEventId&&knownOutcome&&parsed.success&&parsed.data.outcome!=='delivered'){
  plan.outcomeSourceId=ctx.outcome!.id;
  const result=finish(parsed.data.outcome==='refused'?'cancel':'advance',parsed.data.outcome==='refused'?'cancelled':'failed',parsed.data.outcome==='refused'?'recipient_refused':null,'Respect the observed outcome and release undelivered inventory.',parsed.data.outcome==='failed'?'failed':null);
  result.observedDay=worldDay(parsed.data.observedWorldTime);return result;
 }
 if(plan.verification){
  plan.verification=evaluateVerification(plan.verification,ctx.events.find(e=>e.id===plan.verification!.condition.subjectEventId),ctx.reports??[],ctx.links,worldTime);
  if(plan.verification.status==='expired')return finish('cancel','cancelled','verification_deadline_expired','Release the undelivered reservation once; expiry establishes no betrayal or information.');
  if(plan.verification.status==='contradictory')return finish('progress','replan',plan.verification.reason,'Review the sourced report and condition explicitly; no automatic replacement or dispatch.');
 }
 const readiness=projectReadiness(ctx);if(readiness)return finish('progress',readiness.phase,readiness.reason,'Reconsider from fresh canonical prerequisites; no automatic replacement plan.');
 if(plan.phase==='replan')return finish('hold','replan',plan.reason,'A fresh authored project revision is required.');
 if(now===null)return finish('progress','blocked','world_time_not_numeric','Establish canonical world time; turns do not establish travel.');
 if(state.phase==='idle'||state.phase==='negotiating'){
  if(plan.lastContextFingerprint===ctx.contextFingerprint)return finish('hold',state.phase==='idle'?'preparation':'authorization','unchanged_waiting_project','Await a changed canonical source or offer expiry without inference.');
  return finish('advance',state.phase==='idle'?'preparation':'authorization',null,'Seek actual consent through the existing bounded negotiation.');
 }
 if(!plan.dispatchEventId){
  if(plan.verification&&plan.verification.status!=='received')return finish('progress','commitment',plan.verification.reason,'Await the specified actor’s sourced verification report; time cannot establish receipt.');
  if(ctx.proof!.mode==='contested'||ctx.proof!.playerConsent!=='not_required')return finish('progress','adjudication',ctx.proof!.playerConsent!=='not_required'?'player_response_required':'contested_outcome_requires_gm','GM adjudication and canonical authorization required; no automatic dispatch or player decision.');
  return finish('dispatch','commitment',null,'Record the sourced departure attempt; keep the reservation until confirmation.');
 }
 if(!state.agreement||now<state.agreement.deliveryDay)return finish('hold','dispatch','in_transit_unconfirmed','Wait for canonical world time and observed confirmation.');
 if(!parsed.success||!knownOutcome)return finish('progress','arrival','arrival_window_without_confirmation','Await an actor-scoped canonical outcome receipt; time alone proves no arrival.');
 plan.outcomeSourceId=ctx.outcome!.id;
 if(parsed.data.outcome==='refused')return finish('cancel','cancelled','recipient_refused','Respect refusal and release undelivered inventory.');
 const result=finish('advance','confirmation',null,'Settle the observed outcome through the existing grain transaction.','delivered');result.observedDay=worldDay(parsed.data.observedWorldTime);return result;
}
/** Lock and revalidate every relied-on canonical record after inference and before any inventory mutation. */
export async function lockPersistentContext(tx:Tx,ctx:PersistentContext){
 const [project]=await tx.select().from(factionProjects).where(eq(factionProjects.id,ctx.project.id)).for('update').limit(1);
 if(!project||fingerprint(project)!==fingerprint(ctx.project))return false;
 const checks:Promise<boolean>[]=[];
 const same=(a:unknown[],b:unknown[])=>fingerprint([...a].sort((a,b)=>String(record(a).id).localeCompare(String(record(b).id))))===fingerprint([...b].sort((a,b)=>String(record(a).id).localeCompare(String(record(b).id))));
 checks.push(tx.select().from(factions).where(and(eq(factions.storyId,ctx.project.storyId),inArray(factions.id,[ctx.config.supplierId,ctx.config.recipientId]))).for('update').then(r=>same(r,ctx.factions)));
 checks.push(tx.select().from(factionMemberships).where(and(eq(factionMemberships.storyId,ctx.project.storyId),inArray(factionMemberships.factionId,[ctx.config.supplierId,ctx.config.recipientId]))).for('update').then(r=>same(r,ctx.members)));
 if(ctx.actorIds.length)checks.push(tx.select().from(entities).where(and(eq(entities.storyId,ctx.project.storyId),inArray(entities.id,ctx.actorIds))).for('update').then(r=>same(r,ctx.actors)));
 checks.push(tx.select().from(factionGoals).where(and(eq(factionGoals.storyId,ctx.project.storyId),eq(factionGoals.id,ctx.plan.objectiveId))).for('update').then(r=>same(r,ctx.goal?[ctx.goal]:[])));
 checks.push(tx.select().from(storyEvents).where(and(eq(storyEvents.storyId,ctx.project.storyId),inArray(storyEvents.id,ctx.events.map(e=>e.id)))).for('update').then(r=>same(r,ctx.events)));
 if(ctx.outcomeWhere)checks.push(tx.select().from(storyEvents).where(ctx.outcomeWhere).orderBy(desc(storyEvents.createdTurn),desc(storyEvents.createdAt),storyEvents.id).limit(1).for('update').then(r=>same(r,ctx.outcome?[ctx.outcome]:[])));
 checks.push(tx.select().from(npcEventLinks).where(and(eq(npcEventLinks.storyId,ctx.project.storyId),inArray(npcEventLinks.eventId,ctx.events.map(e=>e.id)),inArray(npcEventLinks.npcEntityId,ctx.knowledgeActorIds))).for('update').then(r=>same(r,ctx.links)));
 if(ctx.reportsWhere)checks.push(tx.select().from(storyEvents).where(ctx.reportsWhere).orderBy(storyEvents.id).limit(9).for('update').then(r=>same(r,ctx.reports??[])));
 if(ctx.relationshipsWhere)checks.push(tx.select().from(relationships).where(ctx.relationshipsWhere).orderBy(relationships.id).limit(8).for('update').then(r=>same(r,ctx.relationships??[])));
 return (await Promise.all(checks)).every(Boolean);
}
export function projectAfterNegotiation(ctx:PersistentContext,gate:ProjectGate,state:NegotiationSandbox,stepId:string){
 const plan=structuredClone(gate.plan),agreementId=state.agreement?`neg_${state.id}_${state.agreement.id}`:null;
 plan.committedMeans={resourceId:ctx.config.supplierResourceId,amount:state.supplier.reservedGrain,agreementId};
 if(state.agreement)plan.dueWorldTime=`Day ${state.agreement.deliveryDay}`;
 const dispatch=state.events.find(e=>e.id===`${stepId}:dispatch`);if(dispatch){plan.dispatchEventId=`neg_${state.id}_${dispatch.id}`;plan.phase='dispatch';plan.nextStep='Wait for the arrival window and an observed canonical confirmation.';}
 else if(state.phase==='negotiating'){plan.phase='authorization';plan.nextStep='Await the counterparty response; an offer is not acceptance.';}
 else if(state.phase==='agreed'){plan.phase='commitment';plan.nextStep='Validate current dispatch authority, means, route and consent.';}
 else if(state.phase==='delivered'){plan.phase='confirmation';plan.nextStep='Confirmed delivery; await the concession expiry.';}
 else if(['failed','refused','expired','cancelled','completed'].includes(state.phase)){plan.phase=state.phase==='completed'?'completed':state.phase==='failed'?'failed':'cancelled';plan.nextStep='Terminal receipt; do not replay or reverse confirmed effects.';}
 return persistentProjectSchema.parse(plan);
}
/** The supplier's private plan never becomes the counterparty's packet. Each decision maker receives only their own persona. */
export function persistentActorContext(ctx:PersistentContext,actorId:string){
 const supplier=actorId===ctx.config.supplierId,ownerId=supplier?ctx.plan.ownerEntityId:ctx.plan.recipientOwnerEntityId;
 const owner=ctx.actors.find(a=>a.id===ownerId),state=record(owner?.state),metadata=record(ctx.goal?.metadata);
 const relationships=(ctx.relationships??[]).filter(r=>strings(record(r.metadata).knownBy).includes(ownerId)&&(r.sourceEntityId===ownerId||r.targetEntityId===ownerId)&&r.sourceEventIds.some(id=>{const e=ctx.events.find(e=>e.id===id);return e&&personallyReceived(e,ctx.links,ownerId);})).slice(0,4).map(r=>({id:r.id,sourceEntityId:r.sourceEntityId,targetEntityId:r.targetEntityId,type:r.type.slice(0,240),label:String(r.label??'').slice(0,240),strength:r.strength,sourceIds:r.sourceEventIds.filter(id=>{const e=ctx.events.find(e=>e.id===id);return e&&personallyReceived(e,ctx.links,ownerId);}).slice(0,4)}));
 const v=ctx.plan.verification,report=v?.receipt&&ctx.events.find(e=>e.id===v.receipt!.eventId),claim=report&&verificationReportSchema.safeParse(record(report.metadata).verificationReport);
 return {...(v?{relationships,verification:{status:v.condition.recipientEntityId===ownerId?v.status:'unknown' as const,expectedDay:v.expectedDay,deadlineDay:v.deadlineDay,claim:v.condition.recipientEntityId===ownerId&&claim&&claim.success&&personallyReceived(report!,ctx.links,ownerId,claim.data.claimText)?{eventId:report!.id,text:claim.data.claimText}:null}}:{}),owner:{id:ownerId,name:String(owner?.name||ownerId).slice(0,240),personality:String(state.personality??'').slice(0,240),currentGoal:String(state.currentGoal??'').slice(0,240),constraint:String(state.constraint??'').slice(0,240)},
  project:supplier?{id:ctx.project.id,objectiveId:ctx.plan.objectiveId,objective:String(ctx.goal?.goal??'').slice(0,500),priority:ctx.goal?.priority??5,
   urgency:typeof metadata.urgency==='string'?metadata.urgency.slice(0,240):null,constraints:strings(metadata.constraints).slice(0,3).map(s=>s.slice(0,240)),phase:ctx.plan.phase,nextStep:ctx.plan.nextStep,
   sourceIds:ctx.plan.dependencies.map(d=>d.eventId).filter(id=>known(ctx,id,actorId))}:null};
}
export async function writePersistentProject(tx:Tx,ctx:PersistentContext,plan:PersistentProject,version:number){
 const terminal=['completed','cancelled','failed'].includes(plan.phase);
 await tx.update(factionProjects).set({metadata:{...record(ctx.project.metadata),persistentProject:plan,...(reliefAdapter(ctx.project.metadata).success?{reliefAdapter:{...record(record(ctx.project.metadata).reliefAdapter),lastReviewSequence:Date.now()}}:{})},status:terminal?plan.phase:'active',progress:plan.phase==='completed'?1:ctx.project.progress,
  worldTime:plan.dueWorldTime,sourceEventIds:[...new Set([...ctx.project.sourceEventIds,...plan.dependencies.map(d=>d.eventId),...(plan.dispatchEventId?[plan.dispatchEventId]:[]),...(plan.outcomeSourceId?[plan.outcomeSourceId]:[])])],serverVersion:version,updatedAt:new Date().toISOString()}).where(eq(factionProjects.id,ctx.project.id));
}
export async function saveProjectProgress(story:Row<typeof stories>,ctx:PersistentContext,gate:ProjectGate){
 const unchanged=fingerprint(gate.plan)===fingerprint(ctx.plan);
 if(unchanged&&!reliefAdapter(ctx.project.metadata).success)return true;
 return getDb().transaction(async tx=>{
  const [locked]=await tx.select().from(stories).where(eq(stories.id,story.id)).for('update').limit(1);
  if(!locked||locked.serverVersion!==story.serverVersion||!await lockPersistentContext(tx,ctx))return false;
  if(unchanged)await tx.update(factionProjects).set({metadata:{...record(ctx.project.metadata),reliefAdapter:{...record(record(ctx.project.metadata).reliefAdapter),lastReviewSequence:Date.now()}},updatedAt:new Date().toISOString()}).where(eq(factionProjects.id,ctx.project.id));
  else await writePersistentProject(tx,ctx,gate.plan,locked.serverVersion+1);
  await tx.update(stories).set({serverVersion:locked.serverVersion+1,updatedAt:new Date().toISOString()}).where(eq(stories.id,story.id));return true;
 });
}
/** Explicit authoring/replanning uses existing records and expected versions; never backfills an old project. */
export async function authorReliefProject(storyId:string,raw:unknown,replan=false,newConfig?:unknown){
 const input=authored.parse(raw),db=getDb();
 return db.transaction(async tx=>{
  const [story]=await tx.select().from(stories).where(eq(stories.id,storyId)).for('update').limit(1);
  if(!story)throw new Error('Story not found.');
  const workflow=record(record(story.metadata).factionWorkflow);
  const [existing]=await tx.select().from(factionProjects).where(and(eq(factionProjects.storyId,storyId),eq(factionProjects.id,input.id))).for('update').limit(1);
  const existingAdapter=reliefAdapter(existing?.metadata),multi=newConfig!==undefined||existingAdapter.success;
  const authoringFingerprint=fingerprint({id:input.id,objectiveId:input.objectiveId,ownerEntityId:input.ownerEntityId,executionProofId:input.executionProofId,...(input.verification?{verification:input.verification}:{}),config:newConfig===undefined?undefined:reliefConfigSchema.parse(newConfig)});
  if(existing&&newConfig!==undefined&&!existingAdapter.success)throw new Error('Preserve the older project contract. Create a separate relief project; replanning cannot convert its ledger.');
  if(!replan&&existing&&multi){
   if(existingAdapter.success&&existingAdapter.data.authoringFingerprint===authoringFingerprint)return {status:'authored',projectId:input.id,phase:record(record(existing.metadata).persistentProject).phase,repeated:true};
   throw new Error('This project identifier is already used; preserve its history.');
  }
  if(story.serverVersion!==input.expectedStoryVersion)throw new Error('Project authoring story version conflict. Refresh and try again.');
  if(multi&&newConfig!==undefined&&workflow.negotiation){
   const legacy=negotiationSandboxSchema.parse(workflow.negotiation),legacyConfig=reliefConfigSchema.parse(workflow.negotiationConfig),next=reliefConfigSchema.parse(newConfig);
   if(!['completed','cancelled','failed','refused','expired'].includes(legacy.phase)&&[legacyConfig.supplierResourceId,legacyConfig.recipientResourceId].some(id=>[next.supplierResourceId,next.recipientResourceId].includes(id)))throw new Error('An older negotiation uses this inventory. Resolve or cancel that commitment before sharing its pool.');
  }
  const initialized=multi?(replan&&existingAdapter.success?{state:existingAdapter.data.state,config:newConfig===undefined?existingAdapter.data.config:reliefConfigSchema.parse(newConfig)}:await initialReliefState(tx,story,newConfig,input.id)):null;
  const state=initialized?.state??negotiationSandboxSchema.parse(workflow.negotiation),config=initialized?.config??reliefConfigSchema.parse(workflow.negotiationConfig);
  if(!replan&&!multi&&(existing||workflow.negotiationProjectId||state.phase!=='idle'))throw new Error('Preserve existing projects and negotiations; explicit opt-in is only available before negotiation starts.');
  if(replan&&(!existing||(!multi&&workflow.negotiationProjectId!==input.id)||existing.serverVersion!==input.expectedProjectVersion))throw new Error('Project replan version or binding conflict.');
  if(replan&&existingAdapter.success&&initialized){
   for(const field of ['supplierId','recipientId','supplierResourceId','recipientResourceId','locationId'] as const)if(initialized.config[field]!==existingAdapter.data.config[field])throw new Error('Replanning cannot replace the bound parties, inventories or destination. Create a separate project.');
  }
  if(replan&&input.verification)throw new Error('An accepted or existing request cannot be rewritten. Cancel the undelivered project and author a new request.');
  const old=replan?persistentProjectSchema.parse(record(existing!.metadata).persistentProject):null;
  if(old&&(['completed','cancelled','failed'].includes(old.phase)||old.dispatchEventId))throw new Error('A dispatched or terminal plan cannot be rewritten; record an outcome or cancellation instead.');
  const [goal]=await tx.select().from(factionGoals).where(and(eq(factionGoals.storyId,storyId),eq(factionGoals.id,input.objectiveId))).limit(1);
  if(!active(goal)||goal.factionId!==config.supplierId)throw new Error('An active owned normalized objective is required.');
  const deps=await tx.select().from(storyEvents).where(and(eq(storyEvents.storyId,storyId),inArray(storyEvents.id,[config.routeSourceId,config.authoritySourceId,input.executionProofId])));
  if(deps.length!==3||deps.some(e=>e.status!=='committed'))throw new Error('Current committed route, authority and execution sources are required.');
  const plan:PersistentProject={...(old?.verification?{verification:old.verification}:{}),version:1,kind:'relief',negotiationId:String(state.id),ownerEntityId:input.ownerEntityId,recipientOwnerEntityId:'unresolved',objectiveId:goal.id,objectiveFingerprint:objectiveFingerprint(goal),
   phase:state.phase==='agreed'?'commitment':'preparation',nextStep:'Validate sourced prerequisites and seek actual consent.',reason:null,dependencies:deps.map(e=>({eventId:e.id,fingerprint:fingerprint(e)})).sort((a,b)=>a.eventId.localeCompare(b.eventId)),
   committedMeans:old?.committedMeans??{resourceId:config.supplierResourceId,amount:0,agreementId:null},dueWorldTime:old?.dueWorldTime??null,executionProofId:input.executionProofId,dispatchEventId:null,outcomeSourceId:null,discardedConfirmationIds:[],
   reconsiderWhen:['owner or objective changes','source revision or cancellation','route or means unavailable','consent refused','inventory or reservation changes','canonical outcome received'],lastContextFingerprint:null};
  const project=existing??{id:input.id,storyId,factionId:config.supplierId,project:String(goal.goal),metadata:{locationId:config.locationId}};
  // Stage a row only inside this transaction; admission failure rolls back both the binding and row.
  if(!existing)await tx.insert(factionProjects).values({...project,metadata:{...record(project.metadata),persistentProject:plan},status:'active',serverVersion:story.serverVersion+1});
  else await tx.update(factionProjects).set({project:String(goal.goal),metadata:{...record(existing.metadata),persistentProject:plan},status:'active',serverVersion:story.serverVersion+1}).where(eq(factionProjects.id,input.id));
  const parties=await tx.select().from(factions).where(and(eq(factions.storyId,storyId),inArray(factions.id,[config.supplierId,config.recipientId])));
  const members=await tx.select().from(factionMemberships).where(and(eq(factionMemberships.storyId,storyId),inArray(factionMemberships.factionId,[config.supplierId,config.recipientId])));
  const actorIds=[...new Set([...parties.map(f=>f.entityId),...members.map(m=>m.entityId)].filter((v):v is string=>typeof v==='string'))];
  const actors=actorIds.length?await tx.select().from(entities).where(and(eq(entities.storyId,storyId),inArray(entities.id,actorIds))):[];
  const mandates=members.map(m=>record(record(m.metadata).decisionAuthority).sourceEventId).filter((v):v is string=>typeof v==='string');
  const authorityEvents=mandates.length?await tx.select().from(storyEvents).where(and(eq(storyEvents.storyId,storyId),inArray(storyEvents.id,mandates))):[];
  const owner=parties.find(f=>f.id===config.supplierId),recipient=parties.find(f=>f.id===config.recipientId);
  const supplierAuthority=owner&&resolveDecisionAuthority(owner,members,actors,authorityEvents),recipientAuthority=recipient&&resolveDecisionAuthority(recipient,members,actors,authorityEvents);
  if(supplierAuthority?.status!=='ready'||supplierAuthority.ownerEntityId!==input.ownerEntityId||recipientAuthority?.status!=='ready')throw new Error('Project decision owners must be current, unambiguous and active.');
  const proof=boundReliefProof(deps.find(e=>e.id===input.executionProofId)?.metadata,input.id);
  if(!proof)throw new Error('Select a supported committed execution authorization.');
  if(proof.projectId!==input.id||proof.ownerEntityId!==input.ownerEntityId||proof.supplierId!==config.supplierId||proof.recipientId!==config.recipientId||proof.locationId!==config.locationId)throw new Error('Execution authority must exactly match the project, owner and relief parties.');
  plan.recipientOwnerEntityId=recipientAuthority.ownerEntityId!;
  if(input.verification){if(!multi||replan)throw new Error('Verification requires a newly authored reusable project.');plan.verification=await createVerificationRequest(tx,story,input.id,[plan.ownerEntityId,plan.recipientOwnerEntityId],input.verification);state.scope='persistent-relief-v3';state.verificationCondition=plan.verification.condition;}
  negotiationSandboxSchema.parse(state);
  await tx.update(factionProjects).set({metadata:{...record(project.metadata),persistentProject:plan,...(multi?{reliefAdapter:{version:existingAdapter.success?existingAdapter.data.version:input.verification?3:2,kind:'relief',config,state,authoringFingerprint:existingAdapter.success?existingAdapter.data.authoringFingerprint:authoringFingerprint,lastReviewSequence:existingAdapter.success?existingAdapter.data.lastReviewSequence:0}}:{})}}).where(eq(factionProjects.id,input.id));
  await tx.update(stories).set({metadata:{...record(story.metadata),factionWorkflow:multi?{...workflow,reliefAdapterVersion:2}:{...workflow,negotiation:{...state,scope:'persistent-relief'},negotiationProjectId:input.id}},serverVersion:story.serverVersion+1,updatedAt:new Date().toISOString()}).where(eq(stories.id,storyId));
  return {status:replan?'replanned':'authored',projectId:input.id,phase:plan.phase};
 });
}
