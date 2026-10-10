import {createAssistantMessageEventStream,type AssistantMessage,type Model,type Api} from '@earendil-works/pi-ai';
import type {StreamFn} from '@earendil-works/pi-agent-core';
import {assistantMessage} from './runtime';
export const syntheticModel:Model<Api>={id:'synthetic-gm-no-inference',name:'Synthetic GM',api:'openai-completions',provider:'openrouter',baseUrl:'https://example.invalid/v1',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:8192};
export type ScriptStep={content:AssistantMessage['content'];stopReason?:AssistantMessage['stopReason'];waitForAbort?:boolean};
export function scriptedStream(steps:ScriptStep[]){
 const contexts:unknown[]=[];let calls=0;
 const streamFn:StreamFn=(model,context,options)=>{
  contexts.push(structuredClone(context));const step=steps[calls++];if(!step)throw Error('Unexpected synthetic request.');
  const stream=createAssistantMessageEventStream();
  const message=assistantMessage(model,structuredClone(step.content),step.stopReason??(step.content.some(block=>block.type==='toolCall')?'toolUse':'stop'));
  if(step.waitForAbort){const finish=()=>{message.stopReason='aborted';message.errorMessage='Synthetic cancellation.';stream.push({type:'error',reason:'aborted',error:message});};
   if(options?.signal?.aborted)finish();else options?.signal?.addEventListener('abort',finish,{once:true});return stream;}
  stream.push({type:'start',partial:message});
  message.content.forEach((block,index)=>{if(block.type==='text'){
   stream.push({type:'text_start',contentIndex:index,partial:message});
   for(const delta of block.text.match(/.{1,18}/gs)??[])stream.push({type:'text_delta',contentIndex:index,delta,partial:message});
   stream.push({type:'text_end',contentIndex:index,content:block.text,partial:message});
  }});
  if(message.stopReason==='error'||message.stopReason==='aborted')stream.push({type:'error',reason:message.stopReason,error:message});
  else stream.push({type:'done',reason:message.stopReason as 'stop'|'length'|'toolUse',message});
  return stream;
 };
 return {streamFn,contexts,get calls(){return calls;}};
}
