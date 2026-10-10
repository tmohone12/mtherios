import fs from 'node:fs';
import {expect,test,vi} from 'vitest';
import {chooseJevOption} from '$lib/server/turn/jev';
import {orderVariant} from './fixtures/decisionOrderCases';

const prepare=process.env.MYTHENGINE_PREPARE_JEV_PROPOSAL==='1'?test:test.skip;
prepare('prepare four bounded synthetic OpenRouter requests without inference or credentials',async()=>{
 const root='.codex-run',path=root+'/openrouter-live-proposal.json';
 const cases=[{name:'goodwill',variant:'base'},{name:'goodwill',variant:'reversed'},{name:'scarce_grain',variant:'base'},{name:'witnessed_refusal',variant:'base'}];
 const catalog=JSON.parse(fs.readFileSync(root+'/openrouter-jev-catalog.json','utf8'));
 const model=catalog.models.find((row:any)=>row.id==='typesafe/jev-1.13');
 expect(Date.now()-Date.parse(catalog.fetchedAt)).toBeLessThan(3600000);
 expect(model.context_length).toBe(32000);expect(Number(model.pricing.completion)).toBe(0);
 const requests:any[]=[];let active:any;const prior=process.env.MYTHENGINE_TEST_LOCAL_ONLY;
 process.env.MYTHENGINE_TEST_LOCAL_ONLY='false';
 const mock=vi.fn(async(url:any,init:any)=>{
  expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
  const body=JSON.parse(init.body),bytes=Buffer.byteLength(init.body,'utf8');
  expect(bytes+512).toBeLessThanOrEqual(15000);expect(JSON.stringify(body)).not.toMatch(/PRIVATE_RIVAL_PLAN|UNSHARED_MEMBER_SECRET/);
  requests.push({name:active.name,variant:active.variant,labels:active.label,body,requestBytes:bytes,byteBudgetWithAllowance:bytes+512});
  return Response.json({model:'synthetic-no-inference',answers:{selection:{type:'choice',choice:'wait',confidence:.9,probabilities:{wait:.95}}}});
 });vi.stubGlobal('fetch',mock);
 try{
  for(const spec of cases){active=orderVariant(spec.name,spec.variant);await chooseJevOption({profile:{providerType:'openrouter',baseUrl:'https://openrouter.ai/api/v1',apiKey:'synthetic-proposal-key',customModels:[],fetchedModels:[],reasoningModels:[],hiddenModels:[],favoriteModels:[]},model:'typesafe/jev-1.13',evidence:{...active.packet,worldTime:'Day 0'},sourceIds:active.packet.sourceIds,options:active.options});}
  const proposal={preparedAt:new Date().toISOString(),status:'awaiting explicit budget approval',model:model.id,endpoint:'https://openrouter.ai/api/alpha/decisions',credentialReference:'env:OPENROUTER_API_KEY',requestCap:4,retries:0,concurrency:1,requestedBudgetUsd:.01,priceSource:catalog.source,priceVerifiedAt:catalog.fetchedAt,inputUsdPerToken:Number(model.pricing.prompt),outputUsdPerToken:0,conservativeFullContextEstimateUsd:4*32000*Number(model.pricing.prompt),maximumRequestBytesWithAllowance:15000,paidCalls:0,campaignWrites:0,requests,qualificationLimits:'Synthetic bounded decision transport/knowledge/resource/order checks only; no live planner, gardener, extraction or GM narration qualification. Gates stay at .7. Labels allow multiple reasonable choices; violations and abstentions are reported without retry.'};
  expect(proposal.conservativeFullContextEstimateUsd).toBeLessThan(proposal.requestedBudgetUsd);
  fs.writeFileSync(path,JSON.stringify(proposal,null,2));expect(mock).toHaveBeenCalledTimes(4);
 }finally{vi.unstubAllGlobals();if(prior===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=prior;}
});
