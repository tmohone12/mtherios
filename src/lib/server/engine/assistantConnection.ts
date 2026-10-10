import { AsyncLocalStorage } from 'node:async_hooks';
import { assistantConnectionSchema,type AssistantConnection } from '$lib/contracts/assistantConnection';
import { currentChatgptBinding } from '$lib/server/chatgpt/owner';
import type { ChatgptBinding } from '$lib/server/chatgpt/session';
import { resolveServiceGeneration,requireResolvedServiceProfile } from './llmSettings';
import { agentRunHash } from './agentRunHash';
export const assistantConnectionContext=new AsyncLocalStorage<AssistantConnection>();
export const assistantConnectionCommands=new Set(['assistant.conversation.create','assistant.message.send','assistant.run.resume','assistant.question.answer','assistant.approval.review']);
export function publicProviderEndpoint(value:string){try{const url=new URL(value);return url.origin+url.pathname.replace(/\/$/,'');}catch{return '';}}
export async function readAssistantConnection(projectId:string,gameId:string):Promise<AssistantConnection>{
 const binding=gameId?await currentChatgptBinding(projectId,gameId):null;
 if(binding)return {kind:'chatgpt',projectId,gameId,accountKey:binding.accountKey,epoch:binding.epoch,model:binding.model};
 const service=await resolveServiceGeneration('assistant');const profile=requireResolvedServiceProfile('assistant',service);
 const connection={kind:'configured' as const,projectId,gameId,provider:profile.providerType,model:service.generation.model!,endpoint:publicProviderEndpoint(profile.baseUrl??'')};
 return {...connection,settingsHash:agentRunHash({connection,generation:service.generation,systemPromptOverride:service.systemPromptOverride,setting:service.setting?{enabled:service.setting.enabled,metadata:service.setting.metadata}:null})};
}
export function assertConnectionMatches(expected:AssistantConnection,actual:AssistantConnection){
 if(agentRunHash(expected)!==agentRunHash(actual))throw Error('Assistant connection changed or is unavailable. Reload the connection and explicitly select the provider/model before sending. No other provider was called.');
}
export async function assertAssistantConnection(projectId:string,gameId:string){
 const expected=assistantConnectionContext.getStore();
 if(expected){const actual=await readAssistantConnection(projectId,gameId);assertConnectionMatches(expected,actual);}
}
export function assertRunConnection(saved:ChatgptBinding|null,current:ChatgptBinding|null){
 if(agentRunHash(saved)!==agentRunHash(current))throw Error('The saved run uses a different Assistant connection. Start a new request with the active connection; this run cannot switch providers or accounts.');
}
export function parseAssistantConnection(input:unknown,projectId:unknown,gameId:unknown){
 const result=assistantConnectionSchema.safeParse(input);
 if(!result.success)throw Error('Choose the Assistant connection before sending. Reload the app if this request came from an older tab. No provider was called.');
 if(result.data.projectId!==projectId||result.data.gameId!==(gameId??''))throw Error('Assistant connection belongs to another selected story. No provider was called.');
 return result.data;
}
export function safeAssistantError(error:unknown){
 const raw=error instanceof Error?error.message:String(error);
 return raw.replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [redacted]').replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,'$1[redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g,'[redacted]').slice(0,8000);
}
