import {beforeEach,expect,test,vi} from 'vitest';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {ChatgptSessions,scopeKey,type ChatgptBinding} from './session';
import type {ChatgptRecords,ChatgptStore} from './storage';
const owner='fixture-browser',other='foreign-browser',now=1800000000000;
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...pair.publicKey.export({format:'jwk'}),kid:'fixture',alg:'RS256',use:'sig'};
const jwt=(claims:Record<string,unknown>)=>{const data=[{alg:'RS256',kid:'fixture'},{iss:'https://auth.openai.com',aud:'fixture-client',sub:'fixture-subject',iat:now/1000,exp:now/1000+3600,email:'fixture@example.invalid',...claims}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');return data+'.'+sign('RSA-SHA256',Buffer.from(data),pair.privateKey).toString('base64url');};
let records:ChatgptRecords,sessions:ChatgptSessions,authorize:URL,transport:ReturnType<typeof vi.fn<(url:string,init?:RequestInit)=>Promise<Response>>>,closed:ReturnType<typeof vi.fn<()=>void>>;
let nonceClaims:Record<string,unknown>,refreshError:boolean,revokeStatus:number,refreshCount:number,clock:number;
beforeEach(()=>{
 records={version:1,accounts:[],selections:{}};nonceClaims={};refreshError=false;revokeStatus=200;refreshCount=0;clock=now;closed=vi.fn();let queue:Promise<unknown>=Promise.resolve();
 const store:ChatgptStore={supported:true,read:async()=>structuredClone(records),change:work=>{const task=queue.then(async()=>{const next=structuredClone(records),result=await work(next);records=next;return result;});queue=task.catch(()=>{});return task;}};
 transport=vi.fn(async(url:string,init?:RequestInit)=>{
  if(url.endsWith('/openid-configuration'))return Response.json({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/keys',revocation_endpoint:'https://auth.openai.com/revoke'});
  if(url.endsWith('/keys'))return Response.json({keys:[jwk]});
  if(url.endsWith('/revoke'))return new Response(null,{status:revokeStatus});
  if(url.endsWith('/models'))return Response.json({models:[{slug:'fixture-model',display_name:'Fixture model',visibility:'list'}]});
  if(url.endsWith('/oauth/token')){const form=new URLSearchParams(String(init?.body));if(form.get('grant_type')==='refresh_token'){refreshCount++;if(refreshError)return Response.json({error:'invalid_grant'},{status:400});return Response.json({token_type:'Bearer',access_token:'fake-refreshed',refresh_token:'fake-rotated',expires_in:3600,scope:'chatgpt.tokens.use.direct'});}
   expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'));expect(form.get('redirect_uri')).toBe('http://127.0.0.1:55999/auth/callback');return Response.json({token_type:'Bearer',access_token:'fake-access',refresh_token:'fake-refresh',id_token:jwt({nonce:authorize.searchParams.get('nonce'),...nonceClaims}),expires_in:3600,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'});
  }throw Error('Unexpected fixture network request');
 });
 sessions=new ChatgptSessions({store,now:()=>clock,fetch:transport,listen:async()=>({redirectUri:'http://127.0.0.1:55999/auth/callback',close:closed})});
});
async function connect(accountKey?:string){const launch=await sessions.begin(owner,accountKey);authorize=new URL(sessions.launch(owner,new URL(launch.launchUrl,'http://localhost').searchParams.get('ticket')!));const callback=new URL('http://127.0.0.1:55999/auth/callback');callback.search=new URLSearchParams({state:authorize.searchParams.get('state')!,code:'fake-code',client_id:'fixture-client'}).toString();await sessions.callback(owner,callback);return records.accounts.at(-1)!;}
async function bound():Promise<ChatgptBinding>{const account=await connect();await sessions.select(owner,'project','story',account.key,'fixture-model');return (await sessions.binding(owner,'project','story'))!;}
test('owns PKCE/nonce/loopback registration, one-use launch and secret-free status',async()=>{const launch=await sessions.begin(owner);const ticket=new URL(launch.launchUrl,'http://localhost').searchParams.get('ticket')!;expect(()=>sessions.launch(other,ticket)).toThrow();authorize=new URL(sessions.launch(owner,ticket));expect(()=>sessions.launch(owner,ticket)).toThrow();expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client');expect(authorize.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');const callback=new URL('http://127.0.0.1:55999/auth/callback?state='+authorize.searchParams.get('state')+'&code=fake&client_id=fixture-client');await sessions.callback(owner,callback);await expect(sessions.callback(owner,callback)).rejects.toThrow();const status=await sessions.status(owner,'project','story');expect(JSON.stringify(status)).not.toMatch(/fake-access|fake-refresh|idToken/);expect(status.selection).toBeNull();expect((await sessions.status(other,'project','story')).accounts).toEqual([]);});
test.each([{nonce:'wrong'},{iss:'https://evil.invalid'},{aud:'other-client'},{exp:0},{iat:now/1000+600},{sub:''}])('rejects identity claim %j before persistence',async claims=>{nonceClaims=claims;await expect(connect()).rejects.toThrow('identity validation');expect(records.accounts).toEqual([]);});
test('rejects state, duplicate callback and cancellation without tokens',async()=>{await sessions.begin(owner);await expect(sessions.callback(owner,new URL('http://127.0.0.1:55999/auth/callback?state=wrong&code=x'))).rejects.toThrow('state');expect(transport).not.toHaveBeenCalled();await sessions.cancel(owner);expect(closed).toHaveBeenCalled();await expect(sessions.callback(owner,new URL('http://127.0.0.1:55999/auth/callback'))).rejects.toThrow('expired');});
test('isolates owners and story selections and preserves account registration after confirmed logout',async()=>{const binding=await bound();expect(await sessions.binding(owner,'project','other')).toBeNull();await expect(sessions.models(other,binding.accountKey)).rejects.toThrow('outside');await expect(sessions.logout(other,binding.accountKey)).rejects.toThrow('outside');expect(await sessions.logout(owner,binding.accountKey)).toEqual({revoked:true});expect(records.accounts[0]).toMatchObject({clientId:'fixture-client',subject:'fixture-subject',state:'disconnected'});expect(records.accounts[0].refreshToken).toBeUndefined();expect(records.hostId).toBeTruthy();await expect(sessions.credentials(binding)).rejects.toThrow('changed');await connect(binding.accountKey);expect(authorize.searchParams.get('client_id')).toBe('fixture-client');expect(records.accounts).toHaveLength(1);});
test('serializes rotating refresh and retains explicit selection without provider fallback',async()=>{const binding=await bound();records.accounts[0].expiresAt=now+1000;const results=await Promise.all([sessions.credentials(binding),sessions.credentials(binding)]);expect(refreshCount).toBe(1);expect(results.every(r=>r.accessToken==='fake-refreshed')).toBe(true);expect(records.accounts[0].refreshToken).toBe('fake-rotated');refreshError=true;records.accounts[0].expiresAt=now;await expect(sessions.credentials(binding)).rejects.toThrow('revoked');expect(records.accounts[0].state).toBe('revoked');expect(records.selections[scopeKey(owner,'project','story')]).toBeDefined();});
test('reports unconfirmed revocation while removing every local credential',async()=>{const binding=await bound();revokeStatus=503;expect(await sessions.logout(owner,binding.accountKey)).toEqual({revoked:false});expect(records.accounts[0].lastError).toBe('revocation_unconfirmed');expect(JSON.stringify(records)).not.toMatch(/fake-access|fake-refresh/);expect(transport.mock.calls.filter(([url])=>url.endsWith('/revoke'))).toHaveLength(2);});
test('story connection switch aborts in-flight work before tools can consume a result',async()=>{const binding=await bound();let started!:()=>void;const ready=new Promise<void>(r=>started=r);let released!:()=>void;const wait=new Promise<void>(r=>released=r);const work=sessions.run(binding,undefined,async(_session,signal)=>{started();await wait;signal.throwIfAborted();return 'unsafe';});await ready;await sessions.select(owner,'project','story',null);released();await expect(work).rejects.toThrow('connection changed');});
test('CSRF tokens belong to one browser owner',()=>{const csrf=sessions.csrfToken(owner);expect(()=>sessions.validateCsrf(owner,csrf)).not.toThrow();expect(()=>sessions.validateCsrf(other,csrf)).toThrow();});
test('explicit catalog refresh bypasses five-minute cache and preserves server choices',async()=>{
 const binding=await bound(),count=()=>transport.mock.calls.filter(([url])=>url.endsWith('/models')).length;
 await sessions.models(owner,binding.accountKey);expect(count()).toBe(1);
 transport.mockResolvedValueOnce(Response.json({models:[{slug:'gpt-6.1-sol',display_name:'GPT-6.1 Sol',visibility:'list'}]}));
 expect(await sessions.models(owner,binding.accountKey,true)).toEqual([{id:'gpt-6.1-sol',label:'GPT-6.1 Sol'}]);expect(count()).toBe(2);
 await sessions.select(owner,'project','story',binding.accountKey,'gpt-6.1-sol');expect(count()).toBe(2);expect(refreshCount).toBe(0);
});
test('expired or different-registration catalogs are not advertised as current',async()=>{
 const binding=await bound();expect((await sessions.status(owner,'project','story')).catalogLoaded).toBe(true);
 clock+=300001;expect((await sessions.status(owner,'project','story')).models).toEqual([]);
 records.accounts[0].epoch++;expect((await sessions.status(owner,'project','story')).catalogLoaded).toBe(false);
 await sessions.models(owner,binding.accountKey);expect(transport.mock.calls.filter(([url])=>url.endsWith('/models'))).toHaveLength(2);
});
test('failed refresh clears stale choices and inactive accounts cannot consume cache',async()=>{
 const binding=await bound();transport.mockResolvedValueOnce(new Response(null,{status:403}));
 await expect(sessions.models(owner,binding.accountKey,true)).rejects.toThrow('HTTP 403');expect((await sessions.status(owner,'project','story')).models).toEqual([]);
 await sessions.models(owner,binding.accountKey);records.accounts[0].state='consent_missing';await expect(sessions.models(owner,binding.accountKey)).rejects.toThrow('consent');
});
test('catalog response is discarded when account identity changes during its request',async()=>{
 const binding=await bound();let started!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);
 transport.mockImplementationOnce(async()=>{started();await wait;return Response.json({models:[{slug:'stale-fixture',display_name:'Stale fixture',visibility:'list'}]})});
 const loading=sessions.models(owner,binding.accountKey,true);await ready;records.accounts[0].epoch++;release();
 await expect(loading).rejects.toThrow('account changed');expect((await sessions.status(owner,'project','story')).catalogLoaded).toBe(false);
});
test('separate account catalogs never supply choices to another account or owner',async()=>{
 const binding=await bound();records.accounts.push({...records.accounts[0],key:'second-fixture',subject:'other-subject'});
 transport.mockResolvedValueOnce(Response.json({models:[{slug:'second-model',display_name:'Second model',visibility:'list'}]}));
 expect(await sessions.models(owner,'second-fixture',true)).toEqual([{id:'second-model',label:'Second model'}]);
 expect((await sessions.models(owner,binding.accountKey))[0].id).toBe('fixture-model');await expect(sessions.models(other,'second-fixture')).rejects.toThrow('outside');
});
