import fs from 'node:fs';
import { expect,test,vi } from 'vitest';
import { chooseJevOption } from '$lib/server/turn/jev';
import { orderBatch,orderCases,orderVariant } from './fixtures/decisionOrderCases';

const live=process.env.MYTHENGINE_LOCAL_ORDER==='1'?test:test.skip;
live('bounded labeled order/paraphrase evaluation; at most24 sequential local Kev requests',async()=>{
 const path='.codex-run/faction-decision-order-local.json';if(fs.existsSync(path))throw new Error('One bounded batch already recorded');
 const config=JSON.parse(fs.readFileSync('mythengine.config.json','utf8'));
 if(config.port!==5174||config.jobWorker!==false||!config.testLocalInferenceOnly||!config.isolatedTestCopy)throw new Error('Paused isolated COPY required');
 const ledger:any={startedAt:new Date().toISOString(),requestCap:24,concurrency:1,retries:0,paidCalls:0,labels:orderCases.map(name=>{const s=orderVariant(name,'base');return {name,...s.label,rejected:s.rejected};}),requests:[],results:[]};
 const save=()=>fs.writeFileSync(path,JSON.stringify(ledger,null,2));save();
 const original=globalThis.fetch;let active:any;
 const capture=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  if(String(input)!=='http://127.0.0.1:8008/v1/systemone'||init?.method!=='POST'||ledger.requests.length>=24)throw new Error('Bounded LOCAL request guard');
  if(/PRIVATE_RIVAL_PLAN|UNSHARED_MEMBER_SECRET/.test(String(init.body)))throw new Error('Private packet leak');
  const call:any={name:active.name,variant:active.variant,startedAt:new Date().toISOString(),body:JSON.parse(String(init.body))};ledger.requests.push(call);save();
  try{const r=await original(input,init);call.status=r.status;call.raw=await r.clone().json();save();return r;}catch(e){call.error=e instanceof Error?e.name:'request_failed';save();throw e;}
 });
 const old=process.env.MYTHENGINE_TEST_LOCAL_ONLY;process.env.MYTHENGINE_TEST_LOCAL_ONLY='true';
 try{
  for(const item of orderBatch){active=orderVariant(item.name,item.variant);const start=Date.now();let decision=null,error=null;
   try{decision=await chooseJevOption({profile:{providerType:'openai-compatible',baseUrl:'http://127.0.0.1:8008/v1',apiKey:'',customModels:[],fetchedModels:[],reasoningModels:[],hiddenModels:[],favoriteModels:[]},model:'kev-latest',evidence:{...active.packet,worldTime:'Day 0'},sourceIds:active.packet.sourceIds,options:active.options});}catch(e){error=e instanceof Error?e.message:'request_failed';}
   const call=ledger.requests.at(-1),a=call?.raw?.answers?.selection,ids=active.options.map((o:any)=>o.id),probs=a?.probabilities??{};
   const k=ids.length,sum=Object.values(probs).reduce((n:number,p:any)=>n+Number(p),0),p=a?probs[a.choice]:null;
   const keysMatch=JSON.stringify(Object.keys(probs))===JSON.stringify(ids);
   const rawArgmax=a?.choice===Object.keys(probs).reduce((best,id)=>probs[id]>probs[best]?id:best,Object.keys(probs)[0]);
   ledger.results.push({name:item.name,variant:item.variant,optionCount:k,rawChoice:a?.choice??null,probabilities:probs,topProbability:p,margin:a?Number(p)-Object.values(probs).filter((_,i)=>Object.keys(probs)[i]!==a.choice).reduce((max:number,p:any)=>Math.max(max,Number(p)),0):null,confidence:a?.confidence??null,confidenceExpected:p===null?null:(p/sum-1/k)/(1-1/k),probabilitySum:sum,keysMatch,rawArgmax,decision,error,durationMs:Date.now()-start,rawConstraintViolation:a?active.label.forbidden.includes(a.choice):null,classification:error?'error':!decision?'abstained':active.label.forbidden.includes(decision.optionId)?'constraint_violation':active.label.acceptable.includes(decision.optionId)?'acceptable':'unlabeled',confidenceGateFailed:!!a&&a.confidence<.7,probabilityGateFailed:!!a&&p<.7});save();
   if(error)break;
  }
  const counts:Record<string,number>={};for(const row of ledger.results)counts[row.classification]=(counts[row.classification]??0)+1;
  ledger.counts=counts;ledger.completedAt=new Date().toISOString();save();
  expect(ledger.requests.length).toBeLessThanOrEqual(24);expect(ledger.results.some((r:any)=>r.error)).toBe(false);
  for(const r of ledger.results){expect(r.keysMatch).toBe(true);expect(r.rawArgmax).toBe(true);expect(r.probabilitySum).toBeCloseTo(1,2);expect(r.confidence).toBeCloseTo(r.confidenceExpected,3);if(r.decision)expect(r.decision.optionId).toBe(r.rawChoice);}
  // Quality labels are measured/reported, not asserted away or retried if the model violates them.
 }finally{capture.mockRestore();if(old===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=old;save();}
},750000);
