import { expect, test, vi } from 'vitest';
import { matrixNames, matrixScenario } from './fixtures/decisionMatrix';
import { actorPacket, factionDecisionOptions, validateIntentions } from './intentions';
import { chooseJevOption } from '$lib/server/turn/jev';

// Local Kev is a startup opt-in; these cases exercise the request contract with fetch stubbed.
vi.mock('$env/dynamic/private',()=>({env:process.env}));

test.each(matrixNames)('bounded decision matrix packet: %s',name=>{
 const s=matrixScenario(name);
 expect(s.options.length).toBeGreaterThanOrEqual(2);expect(s.options.length).toBeLessThanOrEqual(5);
 expect(s.options.some(o=>o.id==='wait')).toBe(true);
 expect(JSON.stringify(s.packet)).not.toMatch(/PRIVATE_RIVAL_PLAN|UNSHARED_MEMBER_SECRET/);
 for(const option of s.valid){expect(validateIntentions([option],s.packet)).toHaveLength(1);
  const description=s.options.find(o=>o.id===option.id)!.description;
  for(const field of [option.action,option.motive,option.manner,option.opposition,JSON.stringify(option.costs),JSON.stringify(option.basis)])expect(description).toContain(field);
 }
});
test('resource and knowledge counterfactuals remove unsupported choices before inference',()=>{
 const scarce=matrixScenario('scarce_grain'),promise=matrixScenario('conflicting_promise'),unknown=matrixScenario('unlearned_request');
 expect(scarce.rejected).toContainEqual({id:'offer_grain',reason:'Unsupported cost.'});
 expect(promise.packet.actor.resources[0]).toMatchObject({amount:5,reserved:95});
 expect(promise.packet.actor.obligations).toEqual([expect.objectContaining({id:'promise_refugees',status:'active'})]);
 expect(promise.rejected).toContainEqual({id:'offer_grain',reason:'Unsupported cost.'});
 expect(unknown.packet.evidence).toEqual([]);expect(unknown.valid.map(o=>o.id)).toEqual(['inspect_stores']);
 expect(unknown.options.map(o=>o.id)).toEqual(['wait','inspect_stores']);
 expect(matrixScenario('shared_rumor').packet.evidence[0].claim).toContain('unverified');
});
test('same option IDs preserve distinct motives and manners; personality need not dictate a mood',()=>{
 const warm=matrixScenario('warm_manner'),formal=matrixScenario('formal_manner'),selfish=matrixScenario('transactional_motive');
 expect(warm.options).toEqual(formal.options);expect(warm.packet.actor.decisionMaker?.personality).not.toBe(formal.packet.actor.decisionMaker?.personality);
 expect(selfish.valid.find(o=>o.id==='relief_talk')?.action).toBe(selfish.valid.find(o=>o.id==='reciprocal_talk')?.action);
 expect(selfish.valid.find(o=>o.id==='relief_talk')?.motive).not.toBe(selfish.valid.find(o=>o.id==='reciprocal_talk')?.motive);
 expect(factionDecisionOptions([],true).map(o=>o.id)).toEqual(['wait','investigate']);
});
test.each([-1,101,'95',Number.NaN])('corrupt grain reservation %s fails closed',reserved=>{
 expect(()=>actorPacket({faction:{id:'league'},goals:[],resources:[{id:'grain',factionId:'league',kind:'grain',amount:100,metadata:{reservedGrain:reserved}}],members:[],beliefs:[],links:[],events:[],obligations:[],relationships:[],plan:null})).toThrow('Unsupported resource reservation');
});
test('candidate order is preserved and low confidence remains abstention even for meaningful options',async()=>{
 const s=matrixScenario('goodwill_reordered'),fetchMock=vi.fn().mockResolvedValue(Response.json({model:'kev-latest',answers:{selection:{type:'choice',choice:'offer_grain',confidence:.5,probabilities:{offer_grain:.6,wait:.1,investigate:.1,relief_talk:.1,explanation:.1}}}}));
 vi.stubGlobal('fetch',fetchMock);vi.stubEnv('MYTHENGINE_LOCAL_KEV','true');
 try{expect(await chooseJevOption({profile:{providerType:'openai-compatible',baseUrl:'http://127.0.0.1:8008/v1',apiKey:'',customModels:[],fetchedModels:[],reasoningModels:[],hiddenModels:[],favoriteModels:[]},model:'kev-latest',evidence:s.packet,sourceIds:s.packet.sourceIds,options:s.options})).toBeNull();
  expect(Object.keys(JSON.parse(fetchMock.mock.calls[0][1].body).questions.selection.criteria)).toEqual(s.options.map(o=>o.id));
 }finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
});
