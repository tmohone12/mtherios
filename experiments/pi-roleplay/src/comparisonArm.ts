import {Agent} from '@earendil-works/pi-agent-core';
import {openrouterProvider} from '@earendil-works/pi-ai/providers/openrouter';
import type {Message} from '@earendil-works/pi-ai';
import {assistantMessage} from './runtime';
export type WireText={role:'system'|'user'|'assistant';content:string};
export function normalizedWireMessages(body:any):WireText[]{
 return body.messages.map((message:any)=>({role:message.role,content:typeof message.content==='string'?message.content:message.content.map((block:any)=>block.text??'').join('')}));
}
/** One tool-free Pi GM request. Only the caller's approved key is used; all app settings stay unchanged. */
export async function runPiComparisonArm(input:{wire:WireText[];apiKey:string;temperature:number;sessionId:string}){
 const provider=openrouterProvider(),model=provider.getModels().find(model=>model.id==='z-ai/glm-5.3-flash');
 if(!model)throw Error('Exact model missing in pinned Pi catalog.');
 const initial=input.wire.slice(0,-1).map((message):Message=>message.role==='assistant'?assistantMessage(model,[{type:'text',text:message.content}]):{role:message.role,content:message.content,timestamp:1});
 const last=input.wire.at(-1);if(last?.role!=='user')throw Error('Matched prompt must end with player input.');
 const started=performance.now(),native:{responseId?:string;returnedModel?:string;provider?:string;usage?:any}={};let firstTextMs:number|null=null,requests=0;
 const agent=new Agent({initialState:{model,thinkingLevel:'high',tools:[],messages:initial},sessionId:input.sessionId,
  streamFn:(selected,context,options)=>{
   if(++requests!==1)throw Error('Only one Pi comparison request authorized.');
   if(selected.id!==model.id||selected.api!==model.api)throw Error('Comparison model changed.');
   return provider.streamSimple({...selected,api:model.api},context,{...options,apiKey:input.apiKey,maxTokens:8192,temperature:input.temperature,maxRetries:0,
    onProviderStreamEvent:data=>{const event=data as any;if(event.id)native.responseId=event.id;if(event.model)native.returnedModel=event.model;if(event.provider)native.provider=event.provider;if(event.usage)native.usage=event.usage;}});
  },finishTurn:async()=>({action:'end'})});
 agent.subscribe(event=>{if(event.type==='message_update'&&event.assistantMessageEvent.type==='text_delta'&&firstTextMs===null)firstTextMs=performance.now()-started;});
 const deadline=setTimeout(()=>agent.abort(),60000);
 try{await agent.prompt({role:'user',content:last.content,timestamp:1});}
 finally{clearTimeout(deadline);agent.clearAllQueues();}
 const final=agent.state.messages.findLast(message=>message.role==='assistant');
 if(!final||final.role!=='assistant')throw Error('Pi did not return an assistant response.');
 return {text:final.content.filter(block=>block.type==='text').map(block=>block.text).join(''),finishReason:final.stopReason,returnedModel:final.responseModel??final.model,
  durationMs:performance.now()-started,timeToFirstTextMs:firstTextMs,usage:{inputTokens:final.usage.input,outputTokens:final.usage.output,reasoningTokens:final.usage.reasoning??null,cachedInputTokens:final.usage.cacheRead,
   providerReportedCostUsd:typeof native.usage?.cost==='number'?native.usage.cost:null,piCatalogEstimateUsd:final.usage.cost.total},native,requests,
  unexpectedToolCall:final.content.some(block=>block.type==='toolCall'),error:final.stopReason==='error'||final.stopReason==='aborted'?final.errorMessage??'Pi response failed':null};
}
