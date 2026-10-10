import { expect,test,vi } from 'vitest';
import { chooseJevOption } from '$lib/server/turn/jev';
import { labeledOrderCase,orderBatch,orderVariant } from './fixtures/decisionOrderCases';

test.each(orderBatch)('labeled local order control $name / $variant',({name,variant})=>{
 const s=orderVariant(name,variant);expect(s.options.length).toBeGreaterThanOrEqual(2);expect(s.options.length).toBeLessThanOrEqual(5);
 expect(s.options.some(o=>o.id==='wait')).toBe(true);
 expect(JSON.stringify(s.packet)).not.toMatch(/PRIVATE_RIVAL_PLAN|UNSHARED_MEMBER_SECRET/);
 expect(s.label.acceptable.length).toBeGreaterThanOrEqual(2);
 expect(s.label.forbidden.every(id=>!s.label.acceptable.includes(id))).toBe(true);
 const base=labeledOrderCase(name);
 if(variant==='reversed')expect(s.options).toEqual([...base.options].reverse());
 if(variant==='repeat')expect(s.options).toEqual(base.options);
 if(variant==='paraphrased'){
  expect(s.options.map(o=>o.id)).toEqual(base.options.map(o=>o.id));expect(s.packet).toEqual(base.packet);
  for(const choice of s.valid){const description=s.options.find(o=>o.id===choice.id)!.description;
   for(const field of [choice.action,choice.motive,choice.manner,choice.opposition,JSON.stringify(choice.costs),JSON.stringify(choice.basis)])expect(description).toContain(field);
  }
 }
});
test('raw source membership is not semantic entailment; adversarial labels preserve this distinction',()=>{
 for(const name of ['witnessed_refusal','unlearned_request']){
  const s=labeledOrderCase(name);expect(s.label.forbidden).toEqual(['announce_confession']);expect(JSON.stringify(s.packet)).not.toContain('confessed');
 }
 expect(labeledOrderCase('scarce_grain').rejected).toContainEqual({id:'offer_grain',reason:'Unsupported cost.'});
 expect(labeledOrderCase('conflicting_promise').packet.actor.resources[0].amount).toBe(5);
});
test('the integration consumes probability keys by candidate ID after reversal, never by array position',async()=>{
 const s=orderVariant('goodwill','reversed');
 const probabilities=Object.fromEntries(s.options.map(o=>[o.id,o.id==='offer_grain'?.9:.025]));
 const fetchMock=vi.fn().mockResolvedValue(Response.json({model:'kev-latest',answers:{selection:{type:'choice',choice:'offer_grain',confidence:.875,probabilities}}}));
 vi.stubGlobal('fetch',fetchMock);
 try{const result=await chooseJevOption({profile:{providerType:'openai-compatible',baseUrl:'http://127.0.0.1:8008/v1',apiKey:'',customModels:[],fetchedModels:[],reasoningModels:[],hiddenModels:[],favoriteModels:[]},model:'kev-latest',evidence:s.packet,sourceIds:s.packet.sourceIds,options:s.options});
  expect(result?.optionId).toBe('offer_grain');expect(Object.keys(JSON.parse(fetchMock.mock.calls[0][1].body).questions.selection.criteria)).toEqual(s.options.map(o=>o.id));
 }finally{vi.unstubAllGlobals();}
});
test('option count affects normalized confidence even at the same top probability',()=>{
 const confidence=(p:number,k:number)=>(p-1/k)/(1-1/k);
 expect(confidence(.8,2)).toBeCloseTo(.6);expect(confidence(.8,3)).toBeCloseTo(.7);expect(confidence(.8,5)).toBeCloseTo(.75);
});
