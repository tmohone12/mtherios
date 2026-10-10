import {describe,it,expect} from 'vitest';
import {decisionClock,factionActorGoals,factionKnowledgeActors,resolveDecisionAuthority,selectFactionReviews} from './decisionContext';
import {actorPacket} from './intentions';
const actors=[{id:'leader',type:'character',status:'active'},{id:'delegate',type:'character',status:'active'},{id:'other',type:'character',status:'active'}];
const faction={id:'guild',entityId:'leader'};
describe('stage-one faction decision context',()=>{
 it('preserves authored priority, urgency and constraints while excluding completed normalized goals',()=>{
  const rows=[{id:'low',factionId:'guild',goal:'Trade later',priority:1,status:'active'}, {id:'high',factionId:'guild',goal:'Relief now',priority:9,status:'in_progress',metadata:{urgency:'Winter approaches',constraints:['Keep seed grain'],deadlineWorldTime:'Day 5'}}, {id:'done',factionId:'guild',goal:'Old victory',priority:100,status:'completed'}];
  expect(factionActorGoals({...faction,goals:['Fallback must not resurrect']},rows)).toEqual([
   {id:'high',goal:'Relief now',priority:9,urgency:'Winter approaches',constraints:['Keep seed grain'],deadlineWorldTime:'Day 5'},
   {id:'low',goal:'Trade later',priority:1,urgency:null,constraints:[],deadlineWorldTime:null}]);
  expect(factionActorGoals({...faction,goals:['Fallback']},[rows[2]])).toEqual([]);
  expect(factionActorGoals({...faction,goals:['Fallback']},[])[0]).toMatchObject({goal:'Fallback',priority:5});
 });
 it('uses one active character, holds missing ownership and ambiguous leadership',()=>{
  expect(resolveDecisionAuthority(faction,[],actors)).toMatchObject({status:'ready',ownerEntityId:'leader',scope:'faction_intentions'});
  expect(resolveDecisionAuthority({id:'guild'},[],actors).reason).toBe('decision_authority_missing');
  const members=['leader','other'].map(entityId=>({id:entityId+'_role',factionId:'guild',entityId,status:'active',role:'leader'}));
  expect(resolveDecisionAuthority({id:'guild'},members,actors).reason).toBe('decision_authority_ambiguous');
  expect(resolveDecisionAuthority({id:'guild',metadata:{decisionOwnerEntityId:'other'}},members,actors)).toMatchObject({status:'ready',ownerEntityId:'other'});
  expect(resolveDecisionAuthority({id:'guild',metadata:{decisionOwnerEntityId:'delegate'}},members,actors).reason).toBe('decision_authority_invalid_owner');
 });
 it('does not assign decisions to an inactive character or protagonist',()=>{
  expect(resolveDecisionAuthority(faction,[],[{...actors[0],status:'archived'}]).status).toBe('held');
  expect(resolveDecisionAuthority(faction,[],[{...actors[0],state:{isProtagonist:true}}]).status).toBe('held');
 });
 it('requires a matching committed active mandate for delegated decisions without sharing the principal mind',()=>{
  const member={id:'mandated_member',factionId:'guild',entityId:'delegate',status:'active',role:'member',metadata:{decisionAuthority:{scope:'faction_intentions',grantorEntityId:'leader',sourceEventId:'mandate'}}};
  const event={id:'mandate',status:'committed',metadata:{factionDecisionAuthority:{scope:'faction_intentions',status:'active',factionId:'guild',grantorEntityId:'leader',delegateEntityId:'delegate'}}};
  const authority=resolveDecisionAuthority(faction,[member],actors,[event]);
  expect(authority).toMatchObject({status:'ready',ownerEntityId:'delegate',sourceIds:['guild','mandate','mandated_member']});
  expect(factionKnowledgeActors(faction,[member],actors,authority)).toEqual(['delegate','guild']);
  for(const bad of [[],[{...event,status:'scheduled'}],[{...event,metadata:{factionDecisionAuthority:{...event.metadata.factionDecisionAuthority,status:'revoked'}}}]])
   expect(resolveDecisionAuthority(faction,[member],actors,bad).reason).toBe('decision_authority_invalid_delegation');
  const p=actorPacket({faction,members:[member],actors,events:[event],goals:[],resources:[],links:[],obligations:[],relationships:[],plan:null,
   beliefs:[{id:'principal_secret',believerEntityId:'leader',belief:'PRIVATE SUCCESSION SCHEME'},{id:'report',believerEntityId:'delegate',belief:'A merchant requests relief.'}]});
  expect(p.evidence.map(e=>e.id)).toEqual(['report']);expect(JSON.stringify(p)).not.toContain('PRIVATE SUCCESSION');
 });
 it('retains different personally known reports on the leading subject with their provenance',()=>{
  const p=actorPacket({faction,actors,members:[],events:[],links:[],resources:[],obligations:[],relationships:[],plan:null,goals:[{id:'relief',factionId:'guild',goal:'Deliver relief by the bridge'}],
   beliefs:[{id:'open',believerEntityId:'leader',subjectEntityId:'bridge',belief:'The bridge is open for relief.',confidence:.7,updatedAt:'2026-10-01'},
    {id:'unrelated',believerEntityId:'leader',subjectEntityId:'court',belief:'Relief court provisions and relief grain relief stocks.',updatedAt:'2026-10-02'},
    {id:'closed',believerEntityId:'leader',subjectEntityId:'bridge',belief:'The bridge is closed for relief.',confidence:.4,updatedAt:'2026-09-01'},
    {id:'secret',believerEntityId:'other',belief:'PRIVATE: destroy the bridge.'}]});
  // The packet preserves claims as claims; neither is resolved into canonical truth.
  expect(p.evidence.filter(e=>e.provenance.subjectEntityId==='bridge').map(e=>e.id).sort()).toEqual(['closed','open']);
  expect(p.evidence.find(e=>e.id==='closed')).toMatchObject({confidence:.4,kind:'belief',provenance:{sourceType:'npc_belief',learnedAt:'2026-09-01'}});
  expect(JSON.stringify(p)).not.toContain('PRIVATE');
 });
 it('gives an unreviewed peaceful faction its turn before a repeatedly changed high-pressure faction',()=>{
  const candidates=[{faction:{id:'war',pressure:100}},{faction:{id:'aid',pressure:0}}];
  expect(selectFactionReviews(candidates,{},1)[0].faction.id).toBe('war');
  expect(selectFactionReviews(candidates,{war:{lastTurn:5}},1)[0].faction.id).toBe('aid');
  expect(selectFactionReviews(candidates,{war:{lastTurn:10},aid:{lastTurn:5}},1)[0].faction.id).toBe('aid');
  expect(selectFactionReviews(candidates,{},2)).toHaveLength(2);
 });
 it('changes clock evidence only at established goal/project deadlines, never from turn counts or vague time',()=>{
  const goals=factionActorGoals(faction,[{id:'winter',factionId:'guild',goal:'Prepare relief',metadata:{deadlineWorldTime:'Day 5'}}]);
  expect(decisionClock(goals,[],'Day 1')).toEqual(decisionClock(goals,[],'Day 4'));
  expect(decisionClock(goals,[],'Day 5')).not.toEqual(decisionClock(goals,[],'Day 4'));
  expect(decisionClock([],[],'Day 5')).toEqual(decisionClock([],[],'Day 100'));
  expect(decisionClock(goals,[],'after five turns')[0].reached).toBe(false);
 });
});
