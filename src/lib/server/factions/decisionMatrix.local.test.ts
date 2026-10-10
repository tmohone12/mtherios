import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { matrixNames, matrixScenario } from './fixtures/decisionMatrix';
import { chooseJevOption } from '$lib/server/turn/jev';

const live=process.env.MYTHENGINE_LOCAL_MATRIX==='1'?test:test.skip;
live('small sequential real local Kev decision matrix; no planner, cloud or campaign writes',async()=>{
 const path='.codex-run/faction-decision-matrix-local.json';
 if(fs.existsSync(path))throw new Error('Matrix batch already recorded; no uncontrolled repeats');
 const config=JSON.parse(fs.readFileSync('mythengine.config.json','utf8'));
 if(config.port!==5174||config.jobWorker!==false||!config.testLocalInferenceOnly||!config.isolatedTestCopy)throw new Error('Paused isolated COPY required');
 const ledger:any={startedAt:new Date().toISOString(),requestCap:12,concurrency:1,retries:0,paidCalls:0,thresholds:{confidence:.7,selectedProbability:.7},scenarios:[],requests:[]};
 const save=()=>fs.writeFileSync(path,JSON.stringify(ledger,null,2));save();
 const nativeFetch=globalThis.fetch;let scenario='';
 const capture=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  if(String(input)!=='http://127.0.0.1:8008/v1/systemone'||init?.method!=='POST'||ledger.requests.length>=12)throw new Error('Local matrix request boundary');
  const body=JSON.parse(String(init.body));if(/PRIVATE_RIVAL_PLAN|UNSHARED_MEMBER_SECRET/.test(String(init.body)))throw new Error('Private knowledge leak');
  const call:any={scenario,startedAt:new Date().toISOString(),body};ledger.requests.push(call);save();
  try{const r=await nativeFetch(input,init);call.status=r.status;call.raw=await r.clone().json();save();return r;}catch(error){call.error=error instanceof Error?error.name:'request_failed';save();throw error;}
 });
 const old=process.env.MYTHENGINE_TEST_LOCAL_ONLY;process.env.MYTHENGINE_TEST_LOCAL_ONLY='true';
 try{
  for(scenario of matrixNames){
   const s=matrixScenario(scenario),start=Date.now();let result=null,error=null;
   try{result=await chooseJevOption({profile:{id:'existing_local_kev',name:'Existing local Kev',providerType:'openai-compatible',baseUrl:'http://127.0.0.1:8008/v1',apiKey:'',customModels:[],fetchedModels:[],reasoningModels:[],hiddenModels:[],favoriteModels:[]},model:'kev-latest',evidence:{...s.packet,worldTime:s.worldTime},sourceIds:s.packet.sourceIds,options:s.options});}catch(e){error=e instanceof Error?e.message:'failed';}
   const a=ledger.requests.at(-1)?.raw?.answers?.selection,p=a?.probabilities[a.choice];
   const k=Object.keys(a?.probabilities??{}).length,sum=Object.values(a?.probabilities??{}).reduce((n:number,v:any)=>n+Number(v),0);
   ledger.scenarios.push({name:scenario,options:s.options.map(o=>o.id),rejected:s.rejected,decision:result,error,rawChoice:a?.choice??null,topProbability:p??null,confidence:a?.confidence??null,confidenceFormulaExpected:k>1?(p/sum-1/k)/(1-1/k):1,probabilitySum:sum,confidenceGateFailed:!!a&&a.confidence<.7,probabilityGateFailed:!!a&&p<.7,durationMs:Date.now()-start});save();
   if(error)break;
  }
  const distribution:Record<string,number>={},rawDistribution:Record<string,number>={};
  for(const s of ledger.scenarios){const id=s.error?'error':s.decision?.optionId??'abstained';distribution[id]=(distribution[id]??0)+1;const raw=s.rawChoice??'error';rawDistribution[raw]=(rawDistribution[raw]??0)+1;}
  ledger.distribution=distribution;ledger.rawDistribution=rawDistribution;ledger.completedAt=new Date().toISOString();save();
  expect(ledger.requests.length).toBeLessThanOrEqual(12);expect(ledger.scenarios.some((s:any)=>s.error)).toBe(false);
  for(const s of ledger.scenarios){expect(s.probabilitySum).toBeCloseTo(1,2);expect(s.confidence).toBeCloseTo(s.confidenceFormulaExpected,3);if(s.decision)expect(s.options).toContain(s.decision.optionId);}
 }finally{capture.mockRestore();if(old===undefined)delete process.env.MYTHENGINE_TEST_LOCAL_ONLY;else process.env.MYTHENGINE_TEST_LOCAL_ONLY=old;save();}
},390000);
