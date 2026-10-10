import { describe, expect, it } from 'vitest';
import { actorPacket, factionActorGoals, factionPlannerPrompt, fingerprint, forecastsSchema, intentionBrief, validateIntentions, worldDay, type Attempt } from './intentions';
import { actorScopedMemoryNodes, withAuthoritativeStoryAnchor } from '$lib/server/memory/retrieval';
import { memoryRetrieveRequestSchema } from '$lib/contracts/memory';
import { countTokens } from '$lib/utils/tokens';
import observed from './fixtures/planner-paraphrased-basis.json';
// Historical synthetic request predates the richer context. Add neutral fixture defaults without changing its source IDs or claims.
const observedPacket: ReturnType<typeof actorPacket>={...observed.actorPacket,actor:{...observed.actorPacket.actor,
 authority:{status:'ready',reason:null,ownerEntityId:observed.actorPacket.actor.decisionActorIds[0],principalEntityId:observed.actorPacket.actor.decisionActorIds[0],sourceIds:[],scope:'faction_intentions'},
 goals:observed.actorPacket.actor.goals.map(goal=>({...goal,priority:5,urgency:null,constraints:[],deadlineWorldTime:null})),
 resources:observed.actorPacket.actor.resources.map(resource=>({...resource,reserved:0}))},
 evidence:observed.actorPacket.evidence.map(claim=>({...claim,provenance:{sourceType:'story_event',subjectEntityId:null,learnedAt:null}}))};

const packet = () => actorPacket({ faction: { id: 'league', name: 'League', entityId: 'envoy', metadata: { personality: ['generous', 'wry'] } },
 goals: [{ id: 'relief_goal', factionId: 'league', goal: 'Thank a neighbor for past protection.' }], resources: [{ id: 'grain', factionId: 'league', amount: 100, name: 'Grain', status: 'available' }],
 members: [{ entityId: 'courtier', factionId: 'rival', status: 'active', metadata: {sharesKnowledgeWithFaction:true} }], beliefs: [{ id: 'kindness', believerEntityId: 'envoy', belief: 'The neighbor sheltered our wounded.' }, { id: 'rival_secret', believerEntityId: 'courtier', belief: 'Private assassination plan.' }],
 links: [{ eventId: 'public', npcEntityId: 'envoy', role: 'affected' }, { eventId: 'shared', npcEntityId: 'envoy', role: 'shared' }],
 events: [{ id: 'public', body: 'An unheard public scandal.', visibility: 'public', metadata: {} }, { id: 'shared', body: 'Private thoughts must stay out.', metadata: { actorClaims: [{ text: 'The envoy received a request for aid.', knownBy: ['envoy'], kind: 'learned' }, { text: 'A private motive.', knownBy: ['envoy'], kind: 'private_thought' }] } }],
 obligations: [], relationships: [], plan: null });
const intention = { id: 'offer_aid', action: 'Offer relief grain to the neighbor.', motive: 'Gratitude for sheltering our wounded.', manner: 'Warm, with a dry joke about muddy wagons.', family: 'aid', basis: ['kindness'], limits: ['The neighbor may decline.'], costs: [{ resourceId: 'grain', amount: 40 }], opposition: 'Travel and recipient consent remain unresolved.', earliestWorldTime: null };
describe('bounded faction intentions', () => {
 it('rejects the observed paid paraphrases; accepts only explicitly supplied exact IDs without manufacturing a mapping', () => {
  const p=observedPacket;
  expect(()=>validateIntentions(observed.options,p)).toThrow('Unknown evidence basis');
  for(const option of observed.options){
   // This fixture explicitly authors a source reference; production never rewrites model bases.
   const supported={...option,basis:[p.evidence[0].id]};
   expect(validateIntentions([supported],p)[0].motive).toBe(option.motive);
   for(const invalid of [option.basis[0],p.evidence[0].id+' ',p.evidence[0].id.toUpperCase(),'PRIVATE_RIVAL_PLAN','UNSHARED_MEMBER_SECRET','rival_private_event'])
    expect(()=>validateIntentions([{...supported,basis:[invalid]}],p)).toThrow('Unknown evidence basis');
  }
 });
 it('enumerates only scoped exact IDs in the full options-object response schema and separates prose rationale', () => {
  const p=observedPacket,prompt=factionPlannerPrompt(p);
  const schema=JSON.parse(prompt.split('Return the complete object matching ')[1]);
  expect(schema.type).toBe('object');expect(schema.required).toEqual(['options']);
  expect(schema.properties.options.maxItems).toBe(3);
  expect(schema.properties.options.items.properties.basis.items.enum).toEqual(p.sourceIds);
  expect(schema.properties.options.items.properties.basis).toMatchObject({minItems:1,maxItems:3});
  expect(prompt).toContain('byte for byte');expect(prompt).toContain('prose rationale in motive');
  expect(prompt).not.toMatch(/PRIVATE_RIVAL_PLAN|UNSHARED_MEMBER_SECRET|rival_private_event/);
  expect(()=>factionPlannerPrompt({...p,sourceIds:[]})).toThrow('No allowed planner evidence IDs');
 });
 it('projects only personally learned claims, never public visibility, provenance or private thoughts', () => {
  const p = packet(); expect(p.evidence.map(row => row.id)).toEqual(['kindness','shared']);
  expect(JSON.stringify(p)).not.toMatch(/assassination|unheard|Private thoughts|private motive/);
  expect(countTokens(JSON.stringify(p))).toBeLessThan(3000);
 });
 it('retains distinct learned claims from the same event with exact shared source IDs', () => {
  const p=actorPacket({faction:{id:'league',entityId:'envoy',goals:['Relief grain for a grateful neighbor.']},goals:[],resources:[],members:[],beliefs:[],obligations:[],relationships:[],plan:null,
   links:[{eventId:'exchange',npcEntityId:'envoy',role:'knower'}],events:[{id:'exchange',status:'committed',metadata:{actorClaims:[
    {text:'The neighbor needs relief grain.',knownBy:['envoy'],kind:'learned'},
    {text:'The neighbor declines an armed escort.',knownBy:['envoy'],kind:'witnessed'},
    {text:'The neighbor needs relief grain.',knownBy:['envoy'],kind:'learned'},
    {text:'PRIVATE_RIVAL_PLAN',knownBy:['rival'],kind:'learned'},
   ]}}]});
  expect(p.evidence.map(row=>row.claim)).toEqual(['The neighbor needs relief grain.','The neighbor declines an armed escort.']);
  expect(p.sourceIds).toEqual(['league','exchange']);
  expect(validateIntentions([{...intention,basis:['exchange'],costs:[]}],p)).toHaveLength(1);
  expect(JSON.stringify(p)).not.toContain('PRIVATE_RIVAL_PLAN');
 });
 it('selects the newest learned commitment regardless of row order without learning an unseen breach', () => {
  const events=[
   {id:'older',createdTurn:5,createdAt:'2026-10-01T01:00:00Z',metadata:{actorClaims:[{text:'The envoy promised relief.',knownBy:['envoy'],kind:'learned'}],currentAgreement:{id:'promise',status:'active'}}},
   {id:'newer',createdTurn:5,createdAt:'2026-10-01T02:00:00Z',metadata:{actorClaims:[{text:'The envoy witnessed the promise fulfilled.',knownBy:['envoy'],kind:'witnessed'}],currentAgreement:{id:'promise',status:'fulfilled'}}},
   {id:'unseen',createdTurn:6,metadata:{actorClaims:[{text:'The relief is secretly reclaimed.',knownBy:['rival'],kind:'learned'}],currentAgreement:{id:'promise',status:'broken'}}},
  ];
  const input={faction:{id:'league',entityId:'envoy'},goals:[],resources:[],members:[],beliefs:[],obligations:[],relationships:[],plan:null,
   links:events.map(event=>({eventId:event.id,npcEntityId:'envoy',role:'knower'})),events};
  const p=actorPacket(input);
  expect(p.actor.obligations).toEqual([{id:'promise',terms:'The envoy witnessed the promise fulfilled.',status:'fulfilled'}]);
  expect(actorPacket({...input,events:[...events].reverse()}).actor.obligations).toEqual(p.actor.obligations);
  expect(JSON.stringify(p)).not.toContain('secretly reclaimed');
 });
 it('uses authored fallback goals only until normalized rows own the field', () => {
  const faction={id:'league',goals:['Offer relief without coercion.']};
  expect(factionActorGoals(faction,[])).toEqual([expect.objectContaining({id:'league',goal:'Offer relief without coercion.',priority:5})]);
  expect(factionActorGoals(faction,[{id:'done',factionId:'league',goal:'Old objective',status:'completed'}])).toEqual([]);
  expect(factionActorGoals(faction,[{id:'current',factionId:'league',goal:'Respect the refusal.',status:'active'}])).toEqual([expect.objectContaining({id:'current',goal:'Respect the refusal.',priority:5})]);
 });
 it('does not let its generated intention reshuffle bounded evidence and trigger itself again', () => {
  const input={faction:{id:'league',entityId:'envoy'},goals:[],resources:[],members:[],links:[],events:[],obligations:[],relationships:[],
   beliefs:['Harvest report.','Neighbor report.','Weather report.','Repair the granary.'].map((belief,index)=>({id:`belief_${index}`,believerEntityId:'envoy',belief})),
   evidencePlan:[],plan:null as unknown};
  const before=actorPacket(input),after=actorPacket({...input,plan:{action:'Repair the granary.',motive:'Recovery for the grain stores.'}});
  expect(before.evidence.map(row=>row.id)).toEqual(['belief_0','belief_1','belief_2']);
  expect(after.evidence).toEqual(before.evidence);
  const hash=(p:ReturnType<typeof actorPacket>)=>fingerprint({...p,actor:{...p.actor,currentPlan:null}});
  expect(hash(after)).toBe(hash(before));
  expect(after.actor.currentPlan).toEqual({action:'Repair the granary.',motive:'Recovery for the grain stores.'});
  expect(actorPacket({...input,evidencePlan:[{project:'Repair the granary.'}]}).evidence[0].id).toBe('belief_3');
 });
 it('validates grounded sincere aid and conflict without enforcing a scheming mood', () => {
  expect(validateIntentions([intention], packet())[0].family).toBe('aid');
  expect(validateIntentions([{ ...intention, id: 'press_claim', family: 'pressure', action: 'Request compensation for the missed shipment.' }], packet())[0].family).toBe('pressure');
 });
 it('rejects missing evidence, duplicate costs beyond inventory, reserved options and oversized sets', () => {
  expect(() => validateIntentions([{...intention,basis:['rival_secret']}],packet())).toThrow('basis');
  expect(() => validateIntentions([{...intention,costs:[{resourceId:'grain',amount:60},{resourceId:'grain',amount:60}]}],packet())).toThrow('cost');
  expect(() => validateIntentions([{...intention,id:'wait'}],packet())).toThrow('Duplicate');
  expect(() => validateIntentions(Array(4).fill(intention),packet())).toThrow();
  expect(() => validateIntentions([{...intention,earliestWorldTime:'after five turns'}],packet())).toThrow('world time');
 });
 it('keeps actor location independent of the canonical player location', () => {
  const request = memoryRetrieveRequestSchema.parse({storyId:'story',anchor:'actor',locationId:'distant_court',sceneEntityIds:['envoy']});
  expect(withAuthoritativeStoryAnchor(request,{currentTurn:20,currentLocationId:'player_home'})).toMatchObject({locationId:'distant_court',sceneEntityIds:['envoy'],currentTurn:20});
 });
 it('filters actor retrieval beyond includeSecret:false without returning rival thoughts or raw public narration', () => {
  const rows = [{ id:'public',type:'episodic',title:'SECRET TITLE',content:'RIVAL THOUGHTS',summary:'RIVAL THOUGHTS',metadata:{actorClaims:[{kind:'learned',knownBy:['envoy'],text:'Received a request for relief.'},{kind:'private_thought',knownBy:['envoy'],text:'PRIVATE MOTIVE'}]} },{id:'rival',type:'npc_belief',content:'Rival knowledge',metadata:{believerEntityId:'rival'}},{id:'unlearned',type:'episodic',visibility:'public',metadata:{}}] as any;
  const filtered=actorScopedMemoryNodes(rows,'envoy');expect(filtered).toHaveLength(1);expect(JSON.stringify(filtered)).not.toMatch(/SECRET TITLE|RIVAL THOUGHTS|PRIVATE MOTIVE|Rival knowledge/);
  expect(actorScopedMemoryNodes(rows,undefined)).toEqual([]);
 });
 it('never advances world time from turn cadence', () => {
  expect(worldDay('Day 4')).toBe(4); expect(worldDay('afternoon')).toBeNull(); expect(worldDay(null)).toBeNull();
  expect(worldDay('2026-10-01T23:59:00Z')).toBe(worldDay('2026-10-01T00:00:00Z'));
 });
 it('delivers at most one dynamic cue, keeps private motive private and does not settle canon', () => {
  const attempt = { id:'attempt',factionName:'League',status:'intended',intention,actorEntityIds:['envoy'],locationId:'court' } as unknown as Attempt;
  const metadata = {factionWorkflow:{attempts:[attempt],forecasts:[{development:'FAKE FUTURE CANON'}]}};
  const cue=intentionBrief(metadata,'court',['envoy'],[],false)!;
  expect(cue.text).toContain('Private motive (do not automatically voice)'); expect(cue.text).toContain('does not settle');
  expect(cue.text).not.toContain('FAKE FUTURE'); expect(countTokens(cue.text)).toBeLessThan(500);
  expect(intentionBrief(metadata,'elsewhere',['envoy'],[],false)).toBeNull();
  expect(intentionBrief(metadata,'court',['envoy'],[cue.sourceKey],false)).toBeNull();
  expect(intentionBrief(metadata,'court',['envoy'],[],true)).toBeNull();
 });
 it('bounds forecasts to conditional sourced records and uses stable context hashes', () => {
  const forecast={id:'relief',if:'Grain arrives',unless:'The road closes',development:'The shortage may ease.',earliest:'Day 4',evidence:['shared'],uncertainty:'Delivery remains uncertain.',invalidateWhen:'The bargain ends.'};
  expect(forecastsSchema.parse([forecast])).toHaveLength(1);
  expect(()=>forecastsSchema.parse(Array(3).fill(forecast))).toThrow(); expect(fingerprint(packet())).toBe(fingerprint(packet()));
 });
});
