import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import { chooseJevOption } from '$lib/server/turn/jev';
const qualify=process.env.MYTHENGINE_LOCAL_KEV_QUALIFICATION==='1'?test:test.skip;
qualify('qualifies bounded goodwill and pressure choices against already-running local Kev',async()=>{
 const receipts=[];
 const originalFetch=globalThis.fetch;
 const responses:unknown[]=[];
 const capture=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const response=await originalFetch(input,init);
  if(String(input)==='http://127.0.0.1:8008/v1/systemone')responses.push(await response.clone().json());
  return response;
 });
 try {
 for(const example of [
  {name:'goodwill',evidence:{actor:'Relief League',goal:'Return sincere kindness',knownClaim:'The neighbor sheltered our wounded without demanding payment.',availableGrain:100},options:[{id:'wait',description:'Wait if evidence is insufficient.'},{id:'aid',description:'Offer 40 grain in sincere gratitude; consent and delivery are unresolved.'}]},
  {name:'pressure',evidence:{actor:'Harbor Council',goal:'Recover a promised shipment without violence',knownClaim:'The contracted shipment missed its verified deadline; no cause is known.'},options:[{id:'wait',description:'Wait if evidence is insufficient.'},{id:'investigate',description:'Request an explanation; no betrayal or discovery is established.'},{id:'demand',description:'Request compensation under the existing contract; agreement is unresolved.'}]},
 ]){
  const result=await chooseJevOption({profile:{id:'local_kev_test',name:'Existing local Kev',providerType:'openai-compatible',baseUrl:'http://127.0.0.1:8008/v1',apiKey:'',customModels:[],fetchedModels:[],reasoningModels:[],hiddenModels:[],favoriteModels:[]},model:'kev-latest',evidence:example.evidence,sourceIds:['synthetic_known_claim'],options:example.options});
  expect(result===null || example.options.some(option=>option.id===result.optionId)).toBe(true);
  const raw=responses.at(-1) as {answers?:{selection?:{choice:string;confidence:number;probabilities:Record<string,number>}}};
  const answer=raw?.answers?.selection;
  receipts.push({example:example.name,decision:result,providerResponse:raw,abstentionReason:result===null&&answer?{confidenceBelowGuard:answer.confidence<.7,selectedProbabilityBelowGuard:(answer.probabilities[answer.choice]??0)<.7}:null,qualification:'real local decision API; synthetic evidence; no planner or campaign advancement'});
 }
 }finally{capture.mockRestore();}
 fs.mkdirSync('.codex-run',{recursive:true});fs.writeFileSync('.codex-run/faction-local-kev.json',JSON.stringify(receipts,null,2));
},70000);
