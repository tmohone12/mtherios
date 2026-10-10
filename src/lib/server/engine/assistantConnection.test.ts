import {expect,test,vi} from 'vitest';
vi.mock('$lib/server/chatgpt/owner',()=>({currentChatgptBinding:vi.fn()}));
vi.mock('./llmSettings',()=>({resolveServiceGeneration:vi.fn(),requireResolvedServiceProfile:vi.fn()}));
import {assertConnectionMatches,parseAssistantConnection,assertRunConnection,safeAssistantError,publicProviderEndpoint} from './assistantConnection';
const configured={kind:'configured' as const,projectId:'project',gameId:'story',provider:'nanogpt',model:'glm',endpoint:'https://nano-gpt.com/api/v1',settingsHash:'a'.repeat(64)};
const chatgpt={kind:'chatgpt' as const,projectId:'project',gameId:'story',accountKey:'account',epoch:1,model:'plan-model'};
test('requires a scoped explicit provider choice, including configured billing',()=>{
 expect(()=>parseAssistantConnection(undefined,'project','story')).toThrow('Choose');
 expect(()=>parseAssistantConnection(chatgpt,'project','other')).toThrow('another selected story');
 expect(parseAssistantConnection(configured,'project','story')).toEqual(configured);
});
test.each([{...chatgpt,model:'other'},{...chatgpt,accountKey:'other'},{...chatgpt,epoch:2},configured])('rejects a stale provider/model/account/epoch selection %#',actual=>expect(()=>assertConnectionMatches(chatgpt,actual)).toThrow('No other provider'));
test('configured setting changes require fresh explicit confirmation',()=>expect(()=>assertConnectionMatches(configured,{...configured,settingsHash:'b'.repeat(64)})).toThrow());
test('saved runs cannot change lanes, accounts or models on continuation',()=>{
 const binding={...chatgpt,owner:'owner',clientId:'client',subject:'sub'};
 assertRunConnection(null,null);assertRunConnection(binding,binding);
 for(const pair of [[null,binding],[binding,null],[binding,{...binding,model:'new'}]] as const)expect(()=>assertRunConnection(pair[0],pair[1])).toThrow('cannot switch');
});
test('provider errors retain balance/status evidence while removing credential fragments',()=>{
 const message=safeAssistantError(Error('Server LLM request failed (402): {"message":"insufficient balance","api_key":"sk-EXAMPLEEXAMPLE"} Bearer private-fixture-value'));
 expect(message).toContain('(402)');expect(message).toContain('insufficient balance');expect(message).not.toContain('EXAMPLE');expect(message).not.toContain('private-fixture');
 expect(publicProviderEndpoint('https://user:secret@example.invalid/v1?api_key=secret')).toBe('https://example.invalid/v1');
});
