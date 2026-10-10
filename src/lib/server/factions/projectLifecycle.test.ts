import {createGrainNegotiationSandbox,runNegotiationStep} from './negotiationPrototype';
import {describe,it,expect} from 'vitest';
import {confirmedOutcomeDue,projectAdjudicationBrief,persistentProjectSchema} from './projectLifecycle';
const plan=persistentProjectSchema.parse({version:1,kind:'relief',negotiationId:'neg',ownerEntityId:'owner',recipientOwnerEntityId:'recipient',objectiveId:'goal',objectiveFingerprint:'hash',phase:'adjudication',nextStep:'Seek actual consent and adjudication.',reason:'player_response_required',dependencies:[{eventId:'a',fingerprint:'a'},{eventId:'b',fingerprint:'b'},{eventId:'c',fingerprint:'c'}],committedMeans:{resourceId:'grain',amount:40,agreementId:'agreement'},dueWorldTime:'Day 4',executionProofId:'proof',dispatchEventId:null,outcomeSourceId:null,discardedConfirmationIds:[],reconsiderWhen:[],lastContextFingerprint:null});
describe('persistent project boundaries',()=>{
 it('rejects a managed pure-engine wake without validated execution context before invoking an adapter',async()=>{
  let calls=0;const state={...createGrainNegotiationSandbox(),scope:'persistent-relief' as const};
  const result=await runNegotiationStep(state,{id:'unvalidated',actorId:state.supplier.id,day:state.day,expectedRevision:state.revision,enabled:true},{plan:async()=>{calls++;return [];},decide:async()=>{calls++;return null;}});
  expect(result).toMatchObject({outcome:'held',receipt:{reason:'persistent_execution_context_required'}});expect(calls).toBe(0);expect(result.state.events).toEqual([]);
 });
 it('requires an observed world time within the arrival window and rejects turns or future confirmations',()=>{
  expect(confirmedOutcomeDue('Day 4','Day 4','Day 4','delivered')).toBe(true);
  expect(confirmedOutcomeDue('Day 3','Day 4','Day 4','delivered')).toBe(false);
  expect(confirmedOutcomeDue('Day 5','Day 4','Day 4','delivered')).toBe(false);
  expect(confirmedOutcomeDue('turn 500','Day 4','Day 4','delivered')).toBe(false);
  expect(confirmedOutcomeDue('Day 3','Day 3','Day 4','failed')).toBe(true);
 });
 it('hands off one scene-relevant unresolved project while protecting player agency and private offscreen plans',()=>{
  const project={id:'project',project:'Offer relief',status:'active',serverVersion:5,metadata:{locationId:'granary',persistentProject:plan}};
  const cue=projectAdjudicationBrief([project],'granary',['owner'],[],false)!;
  expect(cue.text).toContain('player may refuse');expect(cue.text).toContain('cannot authorize or settle');expect(cue.sourceKey).toBe('project:project:5');
  expect(projectAdjudicationBrief([project],'elsewhere',['owner'],[],false)).toBeNull();
  expect(projectAdjudicationBrief([project],'granary',['outsider'],[],false)).toBeNull();
  expect(projectAdjudicationBrief([project],'granary',['owner'],[cue.sourceKey],false)).toBeNull();
  expect(projectAdjudicationBrief([project],'granary',['owner'],[],true)).toBeNull();
  expect(projectAdjudicationBrief([{...project,status:'cancelled'}],'granary',['owner'],[],false)).toBeNull();
  expect(projectAdjudicationBrief([{...project,metadata:{persistentProject:{...plan,phase:'dispatch'}}}],'granary',['owner'],[],false)).toBeNull();
 });
 it('leaves legacy and unsupported project metadata unconverted',()=>{
  expect(persistentProjectSchema.safeParse({phase:'arrival'}).success).toBe(false);
  expect(projectAdjudicationBrief([{id:'old',metadata:{}}],null,['owner'],[],false)).toBeNull();
 });
});
