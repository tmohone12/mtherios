import type { ServerGenerationMessage,ServerGenerationOptions,ServerGenerationResult } from '$lib/server/turn/provider';
import { countTokens } from '$lib/utils/tokens';
import { generateChatgptPlanResponse,ChatgptPlanError } from '$lib/server/engine/chatgptPlanAdapter';
import { chatgptSessions,assertCurrentChatgptBinding } from './owner';
import type { ChatgptBinding } from './session';

function planUsage(raw:unknown){
 const usage=raw as {input_tokens?:number;output_tokens?:number;total_tokens?:number;input_tokens_details?:{cached_tokens?:number};output_tokens_details?:{reasoning_tokens?:number}}|null;
 const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
 const input=number(usage?.input_tokens),output=number(usage?.output_tokens);
 return {requestTokens:input,responseTokens:output,totalTokens:number(usage?.total_tokens)??(input!==null&&output!==null?input+output:null),inputTokens:input,cachedInputTokens:number(usage?.input_tokens_details?.cached_tokens),cacheWriteTokens:null,outputTokens:output,reasoningTokens:number(usage?.output_tokens_details?.reasoning_tokens),estimatedCostUsd:null,providerCostUsd:null};
}

export function chatgptInput(messages:ServerGenerationMessage[]){
 const input:Record<string,unknown>[]=[];
 for(const message of messages){
  if(message.role==='tool'){input.push({type:'function_call_output',call_id:message.toolCallId,output:message.content});continue;}
  if(message.role==='assistant'){
   const continuation=message.providerContinuation?.chatgptOutput;
   if(Array.isArray(continuation)){input.push(...continuation as Record<string,unknown>[]);continue;}
   if(message.content)input.push({role:'assistant',content:message.content});
   for(const call of message.toolCalls??[])input.push({type:'function_call',call_id:call.id,name:'storyContent',namespace:'mythengine',arguments:JSON.stringify(call.arguments)});
  }else input.push({role:'user',content:message.content});
 }
 return input;
}
export function createChatgptPlanTransport(binding:ChatgptBinding){return async(options:ServerGenerationOptions):Promise<ServerGenerationResult>=>{
 await assertCurrentChatgptBinding(binding);
 if(options.tools?.some(tool=>tool.name!=='storyContent'))throw Error('ChatGPT assistant tools must be selected-story reads and reviewed proposals only.');
 const input=chatgptInput(options.messages??[]),start=Date.now(),instructions=[options.system,options.systemDynamic].filter(Boolean).join('\n\n');
 try {
  const value=await chatgptSessions().run(binding,options.signal,(session,signal)=>generateChatgptPlanResponse(session,{model:binding.model,instructions,input},signal,async body=>{
   const serializedBody=JSON.stringify(body),inputTokens=countTokens(serializedBody);
   await options.onBeforeRequest?.({body,serializedBody,inputTokens,reservedOutputTokens:options.maxTokens??4096,contextWindowTokens:32000});
  }));
  const text=value.output.filter(item=>item.type==='message').flatMap(item=>Array.isArray(item.content)?item.content:[]).filter(item=>item.type==='output_text').map(item=>String(item.text??'')).join('');
  const toolCalls=value.toolCalls.map(call=>({id:call.callId,name:'storyContent',arguments:call.args as Record<string,unknown>}));
  return {text,toolCalls,message:{role:'assistant',content:text,...(toolCalls.length?{toolCalls}:{}),providerContinuation:{chatgptOutput:value.output,chatgptDiagnostics:value.diagnostic}},model:binding.model,endpoint:'https://api.openai.com/v1/responses',finishReason:toolCalls.length?'tool_calls':'stop',durationMs:Date.now()-start,retryCount:0,promptChars:JSON.stringify(input).length+instructions.length,responseChars:JSON.stringify(value.output).length,
   usage:planUsage(value.usage)};
 }catch(error){
  if(error instanceof ChatgptPlanError){
   await chatgptSessions().failure(binding,error.kind);
   // A globally completed but unusable response still consumed plan tokens.
   // Pi records its usage, then stops on this error before any tool execution.
   if(error.completedUsage!==undefined)return {text:'',toolCalls:[],message:{role:'assistant',content:'',providerContinuation:{chatgptOutput:[],chatgptDiagnostics:error.diagnostic,chatgptError:error.message}},model:binding.model,endpoint:'https://api.openai.com/v1/responses',finishReason:'error',durationMs:Date.now()-start,retryCount:0,promptChars:JSON.stringify(input).length+instructions.length,responseChars:0,usage:planUsage(error.completedUsage)};
  }
  throw error;
 }
};}
