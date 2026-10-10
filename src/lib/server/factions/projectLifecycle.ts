import {z} from 'zod';
import {verificationRequestSchema} from './verificationContract';
import {fingerprint,record,worldDay} from './intentions';

const id=z.string().trim().min(1).max(160);
export const reliefConfigSchema=z.object({supplierId:z.string(),recipientId:z.string(),supplierResourceId:z.string(),recipientResourceId:z.string(),
 locationId:z.string(),deliveryDays:z.number().int().min(1).max(5),maxTollDays:z.number().int().min(1).max(30),authoritySourceId:z.string(),routeSourceId:z.string(),blocked:z.boolean()}).strict()
 .refine(c=>c.supplierId!==c.recipientId&&c.supplierResourceId!==c.recipientResourceId,'Negotiation requires distinct parties and inventories.');
export const persistentProjectSchema=z.object({
 verification:verificationRequestSchema.optional(),version:z.literal(1),kind:z.literal('relief'),negotiationId:id,ownerEntityId:id,recipientOwnerEntityId:id,objectiveId:id,objectiveFingerprint:id,
 phase:z.enum(['preparation','authorization','commitment','dispatch','arrival','confirmation','completed','blocked','replan','failed','cancelled','adjudication']),
 nextStep:z.string().max(240),reason:z.string().max(240).nullable(),
 dependencies:z.array(z.object({eventId:id,fingerprint:id}).strict()).min(3).max(8),
 committedMeans:z.object({resourceId:id,amount:z.number().int().nonnegative(),agreementId:id.nullable()}).strict(),
 dueWorldTime:z.string().max(120).nullable(),executionProofId:id,dispatchEventId:id.nullable(),outcomeSourceId:id.nullable(),
 discardedConfirmationIds:z.array(id).max(8),
 reconsiderWhen:z.array(z.string().max(120)).max(8),lastContextFingerprint:id.nullable(),
}).strict();
export type PersistentProject=z.infer<typeof persistentProjectSchema>;
export const reliefExecutionProofSchema=z.object({
 scope:z.literal('relief_execution'),projectId:id,ownerEntityId:id,supplierId:id,recipientId:id,locationId:id,
 meansEntityIds:z.array(id).min(1).max(4),maxGrain:z.number().int().positive(),
 mode:z.enum(['routine','contested']),playerConsent:z.enum(['not_required','confirmed','pending']),
}).strict();
// An explicitly reviewed, reusable per-shipment authority. Binding it never establishes departure.
export const reliefExecutionGrantSchema=reliefExecutionProofSchema.omit({projectId:true,scope:true}).extend({scope:z.literal('relief_authority'),version:z.literal(2)}).strict();
export function boundReliefProof(metadata:unknown,projectId:string){
 const direct=reliefExecutionProofSchema.safeParse(record(metadata).reliefExecution);if(direct.success)return direct.data;
 const grant=reliefExecutionGrantSchema.safeParse(record(metadata).reliefExecutionGrant);
 if(!grant.success)return null;
 const {version,scope,...fields}=grant.data;
 return reliefExecutionProofSchema.parse({...fields,scope:'relief_execution',projectId});
}
export const reliefOutcomeSchema=z.object({
 projectId:id,agreementId:id,dispatchEventId:id,outcome:z.enum(['delivered','failed','refused']),observedWorldTime:z.string().min(1).max(120),
}).strict();
export function objectiveFingerprint(goal:Record<string,unknown>){return fingerprint({id:goal.id,factionId:goal.factionId,goal:goal.goal,status:goal.status,priority:goal.priority,metadata:goal.metadata,serverVersion:goal.serverVersion});}
/** A presentation of unresolved adjudication, never permission to settle or choose for the player. */
export function projectAdjudicationBrief(projects:Record<string,unknown>[],locationId:string|null,presentActorIds:string[],used:string[],sceneAlreadyUsed:boolean){
 if(sceneAlreadyUsed)return null;
 for(const project of projects){
  const parsed=persistentProjectSchema.safeParse(record(project.metadata).persistentProject);if(!parsed.success)continue;
  const plan=parsed.data,sourceKey=`project:${String(project.id)}:${String(project.serverVersion)}`;
  if(plan.phase!=='adjudication'||project.status!=='active'||!presentActorIds.includes(plan.ownerEntityId)||used.includes(sourceKey)||typeof record(project.metadata).locationId==='string'&&record(project.metadata).locationId!==locationId)continue;
  return {id:String(project.id),sourceKey,text:`GM ONLY — unresolved faction project adjudication.\nProject ${String(project.id)}: ${String(project.project).slice(0,300)}.\nReason: ${plan.reason}. Next step: ${plan.nextStep}.\nNo dispatch, arrival, victory, delivery or resource transfer is established by this request. Resolve only the present contested situation using canonical evidence, opposition and player agency; the player may refuse, intervene or leave. This briefing cannot authorize or settle an outcome. An actual canonical authorization and subsequently observed confirmation are required; keep private motives private. Do not invent transport, acceptance or supplies.`};
 }
 return null;
}
/** Exact world days retain the established relief clock; elapsed turns never qualify. */
export function confirmedOutcomeDue(observed:string,current:string|null,due:string|null,outcome:string){
 const at=worldDay(observed),now=worldDay(current),deadline=worldDay(due);
 return at!==null&&now!==null&&at<=now&&(outcome!=='delivered'||deadline!==null&&at>=deadline);
}
