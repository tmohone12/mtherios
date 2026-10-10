import path from 'node:path';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { createChatgptFileStore,windowsCredentialProtection } from './storage';
import { ChatgptSessions,browserOwnerContext,type ChatgptBinding } from './session';
let sessions:ChatgptSessions|undefined;
export function chatgptSessions(){return sessions??=new ChatgptSessions({store:createChatgptFileStore(path.join(getMtheriosAppConfig().dataRoot,'private','chatgpt'),process.platform==='win32'?windowsCredentialProtection():undefined)});}
export function currentChatgptBinding(projectId:string,gameId:string){return chatgptSessions().binding(browserOwnerContext.getStore(),projectId,gameId);}
export async function assertChatgptConversationAccess(conversation:Record<string,unknown>){
 if(!conversation.chatgpt_owner_hash)return;
 const owner=browserOwnerContext.getStore();
 if(owner!==conversation.chatgpt_owner_hash)throw Error('This ChatGPT conversation belongs to another local browser session.');
 const binding=await currentChatgptBinding(String(conversation.project_id),String(conversation.game_id));
 if(binding?.accountKey!==conversation.chatgpt_account_key)throw Error('Select this conversation’s ChatGPT account before opening it.');
}
export async function assertCurrentChatgptBinding(expected:ChatgptBinding){const binding=await currentChatgptBinding(expected.projectId,expected.gameId);if(!binding||Object.keys(expected).some(key=>binding[key as keyof ChatgptBinding]!==expected[key as keyof ChatgptBinding]))throw Error('ChatGPT account, model or session changed. Start a new request.');return binding;}
