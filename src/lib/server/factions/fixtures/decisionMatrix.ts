import { actorPacket, factionDecisionOptions, validateIntentions, type Intention } from '../intentions';

export function matrixScenario(name: string) {
 const rivalry=name==='rivalry',scarce=name==='scarce_grain',reserved=name==='conflicting_promise';
 const unknown=name==='unlearned_request',rumor=name==='shared_rumor',formal=name==='formal_manner',selfish=name==='transactional_motive',faith=name==='faith_recovery';
 const source='known_exchange';
 const claim=rivalry?'Maera personally heard Rowan refuse the promised grain shipment without giving a reason.'
  :rumor?'Rowan shared an unverified rumor with Maera that Hillmarch needs grain; neither has checked the storehouse.'
  :faith?'Maera and Rowan witnessed the wounded recover after Hillmarch sheltered them freely; Maera is exhausted.'
  :'Maera personally heard Rowan thank her and welcome voluntary relief discussion after Hillmarch sheltered the wounded freely. No agreement exists.';
 const personality=selfish?'Pragmatic and status-conscious; prefers reciprocal alliances, can still show sincere gratitude.'
  :formal?'Considerate but formal; dislikes joking during relief negotiations.'
  :faith?'Devout and patient, generous but exhausted; prayer and rest are welcome, aid remains possible.'
  :'Generous and wry; appreciates dry humor, firm about witnessed broken promises.';
 const events:any[]=[{id:source,status:'committed',body:claim+' PRIVATE_RIVAL_PLAN: assassinate the envoy.',metadata:{actorClaims:[{text:claim,knownBy:['maera'],kind:rumor?'shared':'learned'},{text:'PRIVATE_RIVAL_PLAN',knownBy:['rival'],kind:'private_thought'}]}}];
 if(reserved)events.unshift({id:'known_promise',status:'committed',metadata:{actorClaims:[{text:'Maera promised 95 grain to the flood refugees by Day 1; it is reserved and has not been delivered.',knownBy:['maera'],kind:'witnessed'}],currentAgreement:{id:'promise_refugees',status:'active'}}});
 const packet=actorPacket({faction:{id:'league',name:'Granary League',entityId:'maera',metadata:{}},
  goals:[{id:'own_goal',factionId:'league',goal:rivalry?'Seek accountability for a witnessed refusal without assuming betrayal.':selfish?'Build a reciprocal relief alliance without coercion.':faith?'Recover and honor shelter freely given without exhausting our stores.':'Return the neighbor’s kindness with voluntary relief.'}],
  resources:[{id:'grain',factionId:'league',kind:'grain',name:'Relief grain',amount:scarce?10:100,status:'available',metadata:{reservedGrain:reserved?95:0}}],
  actors:[{id:'maera',type:'character',name:'Maera',state:{personality}}],
  members:[{entityId:'rival',factionId:'league',status:'active',role:'member'}],
  beliefs:[{id:'unshared_belief',believerEntityId:'rival',belief:'UNSHARED_MEMBER_SECRET: replace Maera.'}],
  links:[{eventId:source,npcEntityId:'maera',role:unknown?'affected':'knower'},...(reserved?[{eventId:'known_promise',npcEntityId:'maera',role:'witness'}]:[])],events,
  obligations:[],relationships:[{id:'known_relationship',sourceEntityId:'maera',targetEntityId:'rowan',type:rivalry?'enemy-of':'allied-with',label:rivalry?'Distrust over the witnessed missed shipment.':'Gratitude for shelter freely given.',metadata:{knownBy:['maera']}}],plan:null});
 const common={basis:[source],limits:['Consent and actual delivery remain unresolved; preserve prior commitments.'],opposition:'Rowan may refuse or be unavailable.',earliestWorldTime:null};
 let proposed:Intention[]=[
  {...common,id:'offer_grain',action:'Offer 20 grain as voluntary relief; nothing has moved.',motive:'Sincere gratitude for freely given shelter.',manner:'Warm, with a gentle joke about muddy boots.',family:'gift',costs:[{resourceId:'grain',amount:20}]},
  {...common,id:'relief_talk',action:'Ask Rowan what relief would help before committing resources.',motive:'Respect uncertainty and existing obligations while returning kindness.',manner:'Considerate and formal, without a joke.',family:'diplomacy',costs:[]},
  {...common,id:'explanation',action:'Request a written explanation for the missed shipment.',motive:'Accountability for the personally witnessed refusal without assuming guilt.',manner:'Measured and firm; allow an explanation.',family:'pressure',costs:[]},
 ];
 if(!rivalry)proposed[2]={...common,id:'alliance_talk',action:'Ask permission to visit Hillmarch and discuss future relief cooperation.',motive:'Preserve a friendly relationship without creating any binding obligation.',manner:'Respectful and practical.',family:'alliance',costs:[]};
 if(scarce||reserved)proposed[2]={...common,id:'small_aid',action:'Offer only 5 unreserved grain, subject to consent.',motive:'Return a kindness while protecting existing commitments.',manner:'Warm and practical.',family:'aid',costs:[{resourceId:'grain',amount:5}]};
 if(unknown)proposed[1]={...proposed[1],id:'inspect_stores',basis:['own_goal','grain'],action:'Review our own stores before proposing any offer.',motive:'We have not learned what the neighbor needs.',family:'investigate',manner:'Patient and factual.'};
 if(selfish)proposed[2]={...common,id:'reciprocal_talk',action:'Ask Rowan what relief would help before committing resources.',motive:'Build a reciprocal alliance and public standing; no obligation is assumed.',manner:'Considerate and formal, without a joke.',family:'alliance',costs:[]};
 if(name==='warm_manner'||formal)proposed=[{...proposed[0],id:'warm_offer'},{...proposed[0],id:'formal_offer',manner:'Considerate and formal, without a joke.'},proposed[1]];
 if(faith)proposed=[proposed[0],{...common,id:'pray_together',action:'Invite Rowan to a quiet prayer for the recovering wounded.',motive:'Gratitude and faith after freely given shelter.',manner:'Gentle, without pressure to share our faith.',family:'faith',costs:[]},{...common,id:'rest_then_review',action:'Rest briefly and review relief needs on Day 1.',motive:'Maera is exhausted; recovery will protect her ability to help.',manner:'Candid and lightly humorous.',family:'recovery',costs:[],earliestWorldTime:'Day 1'}];
 const rejected:Array<{id:string;reason:string}>=[],valid:Intention[]=[];
 for(const option of proposed){try{valid.push(...validateIntentions([option],packet));}catch(error){rejected.push({id:option.id,reason:error instanceof Error?error.message:'invalid'});}}
 const options=factionDecisionOptions(valid,packet.evidence.length>0);
 if(name==='goodwill_reordered')options.reverse();
 return {name,packet,valid,rejected,options,worldTime:'Day 0'};
}
export const matrixNames=['goodwill','goodwill_reordered','goodwill_repeated','rivalry','scarce_grain','conflicting_promise','unlearned_request','shared_rumor','warm_manner','formal_manner','transactional_motive','faith_recovery'];
