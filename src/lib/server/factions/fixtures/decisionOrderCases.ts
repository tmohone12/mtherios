import { matrixScenario } from './decisionMatrix';
import { factionDecisionOptions, validateIntentions, type Intention } from '../intentions';

export const orderCases=['goodwill','witnessed_refusal','scarce_grain','conflicting_promise','unlearned_request','ambiguous_manners'];
export function labeledOrderCase(name:string){
 const base=matrixScenario(name==='witnessed_refusal'?'rivalry':name==='ambiguous_manners'?'warm_manner':name);
 let valid=base.valid,forbidden:string[]=[],rationale='Several voluntary proposals are reasonable; no unique narrative favorite is labeled.';
 if(name==='witnessed_refusal'||name==='unlearned_request'){
  // An adversarial semantic distractor passes the existing ID/cost schema.
  // This measures model knowledge discipline, not a claim that source membership proves textual entailment.
  const falseClaim:Intention={id:'announce_confession',action:'Publicly announce that Rowan confessed to sabotaging the shipment.',motive:'Tell the court what happened.',manner:'Certain and factual.',family:'pressure',basis:[name==='witnessed_refusal'?'known_exchange':'own_goal'],costs:[],limits:['Address the court only.'],opposition:'Rowan may object.',earliestWorldTime:null};
  validateIntentions([falseClaim],base.packet);
  valid=name==='witnessed_refusal'?[base.valid.find(o=>o.id==='explanation')!,falseClaim]:[...base.valid,falseClaim];
  forbidden=['announce_confession'];rationale='No confession or established sabotage exists in this actor packet; announcing one violates the explicit knowledge boundary.';
 }
 const options=factionDecisionOptions(valid,base.packet.evidence.length>0);
 return {...base,name,valid,options,label:{acceptable:options.map(o=>o.id).filter(id=>!forbidden.includes(id)),forbidden,rationale,ambiguous:name==='goodwill'||name==='ambiguous_manners',scope:'Synthetic constraint labels; multiple reasonable proposals plus wait/investigate permitted. No success or canon labels.'}};
}
export function orderVariant(name:string,variant:string){
 const s=labeledOrderCase(name);let options=s.options.map(o=>({...o}));
 if(variant==='reversed')options.reverse();
 if(variant==='paraphrased')options=options.map(o=>({...o,description:o.description
  .replace('Retain current plan; no grounded change needed.','Keep the existing plan unchanged when a new step lacks grounding.')
  .replace('Seek verification of a supplied uncertain claim; learn nothing automatically.','Check a provided uncertain report; do not assume new knowledge.')
  .replaceAll('Action: ','Attempt: ').replaceAll('Motive: ','Reason: ').replaceAll('Manner: ','Portrayal: ')
  .replaceAll('Costs: ','Resource costs: ').replaceAll('Limits: ','Boundaries: ')
  .replaceAll('Opposition: ','Possible resistance: ').replaceAll('Earliest world time: ','Earliest in-world time: ')
  .replaceAll('Basis IDs: ','Exact source references: ')}));
 // One bounded count control removes a near-equivalent manner candidate, preserving wait and investigation.
 if(variant==='count_control')options=options.filter(o=>o.id!=='formal_offer');
 return {...s,variant,options};
}
export const orderBatch=orderCases.flatMap(name=>['base','reversed','paraphrased',name==='ambiguous_manners'?'count_control':'repeat'].map(variant=>({name,variant})));
