import {normalizeContext,type Message} from '@earendil-works/pi-ai';
import {openrouterProvider} from '@earendil-works/pi-ai/providers/openrouter';
/** Inspect the actual Pi serializer, intentionally stop before HTTP; never resolves real credentials. */
export async function probePiOpenRouter(input:{system:string;history:Message[];tail:string;thinking:'high'|'low'|'off'}){
 const provider=openrouterProvider();
 const model=provider.getModels().find(model=>model.id==='z-ai/glm-5.3-flash');
 if(!model)throw Error('Current reply model missing in pinned Pi catalog.');
 let payload:unknown;
 const stream=provider.streamSimple(model,normalizeContext({systemPrompt:input.system,messages:[...input.history,{role:'user',content:input.tail,timestamp:1}]}),{
  apiKey:'synthetic-no-inference',reasoning:input.thinking==='off'?undefined:input.thinking,maxRetries:0,onPayload:request=>{payload=structuredClone(request);throw Error('Synthetic probe stops before network.');}
 });
 const result=await stream.result();
 const classifier=provider.getAllModels?.().find(model=>model.id==='typesafe/jev-1.13'&&model.type==='classifier');
 return {payload,stopReason:result.stopReason,errorMessage:result.errorMessage,model:{id:model.id,api:model.api,thinkingLevelMap:model.thinkingLevelMap,promptCache:model.promptCache},
  classifier:classifier?{id:classifier.id,api:classifier.api}:null,providerRequests:0};
}
