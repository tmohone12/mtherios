import { randomBytes,randomUUID,createHash,createPublicKey,verify,timingSafeEqual } from 'node:crypto';
import { createServer,type Server } from 'node:http';
import { requestScope } from '$lib/server/requestScopes';
import type { ChatgptStore,ChatgptAccount } from './storage';
import { listChatgptPlanModels,type ChatgptPlanSession } from '$lib/server/engine/chatgptPlanAdapter';

const issuer='https://auth.openai.com', resource='https://api.openai.com/v1';
const authorize=issuer+'/api/accounts/authorize',tokenEndpoint=issuer+'/api/accounts/oauth/token';
const scopes='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const browserOwnerContext=requestScope<string>();
export const ownerHash=(cookie:string)=>createHash('sha256').update(cookie).digest('hex');
export const scopeKey=(owner:string,projectId:string,gameId:string)=>JSON.stringify([owner,projectId,gameId]);
const opaque=()=>randomBytes(32).toString('base64url');
const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export interface ChatgptBinding { owner:string;accountKey:string;clientId:string;subject:string;epoch:number;model:string;projectId:string;gameId:string }
type Fetch=(url:string,init?:RequestInit)=>Promise<Response>;
type Listener={redirectUri:string;close():void};
type Pending={owner:string;state:string;nonce:string;verifier:string;clientId?:string;accountKey?:string;hostId:string;listener:Listener;expiresAt:number;ticket:string;processing:boolean;url:string};
type Dependencies={store:ChatgptStore;fetch?:Fetch;now?:()=>number;listen?:(callback:(url:URL)=>Promise<void>)=>Promise<Listener>};

function loopbackListener(callback:(url:URL)=>Promise<void>):Promise<Listener> {
 return new Promise((resolve,reject)=>{
  let server:Server;
  server=createServer(async(request,response)=>{
   response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');response.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'");
   const address=server.address();
   const host=typeof address==='object'&&address?'127.0.0.1:'+address.port:'';
   if(request.method!=='GET'||request.headers.host!==host||!['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress??'')){response.writeHead(400).end('Invalid callback.');return;}
   const url=new URL(request.url??'', 'http://'+host);
   if(url.pathname!=='/auth/callback'){response.writeHead(404).end();return;}
   try {await callback(url);response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end('<!doctype html><title>MythEngine</title><h1>Return to MythEngine</h1><p>The sign-in result is shown in your Assistant. You can close this tab.</p>');}
   catch {response.writeHead(400).end('Sign-in could not be completed. Return to MythEngine for the next step.');}
  });
  server.once('error',()=>reject(Error('Unable to start the loopback sign-in listener.')));
  server.listen(0,'127.0.0.1',()=>{const address=server.address();if(typeof address==='object'&&address)resolve({redirectUri:`http://127.0.0.1:${address.port}/auth/callback`,close:()=>{server.close();server.closeIdleConnections();}});});
 });
}

export class ChatgptSessions {
 private fetch:Fetch;private now:()=>number;private pending=new Map<string,Pending>();private notices=new Map<string,string>();
 private catalog=new Map<string,{at:number;epoch:number;models:Array<{id:string;label:string}>}>();private aborts=new Map<string,Set<AbortController>>();
 private scopeAborts=new Map<string,Set<AbortController>>();
 private csrf=new Map<string,{value:string;expires:number}>();
 constructor(private deps:Dependencies){this.fetch=deps.fetch??fetch;this.now=deps.now??Date.now;}
 csrfToken(owner:string){let value=this.csrf.get(owner);if(!value||value.expires<this.now()){value={value:opaque(),expires:this.now()+3600000};this.csrf.set(owner,value);}return value.value;}
 validateCsrf(owner:string,value:string){const saved=this.csrf.get(owner);if(!saved||saved.expires<this.now()||!equal(saved.value,value))throw Error('Reload the Assistant before changing the ChatGPT connection.');}
 private async request(url:string,init:RequestInit={}) {
  if(!url.startsWith(issuer+'/'))throw Error('Invalid OpenAI authentication endpoint.');
  try {return await this.fetch(url,{...init,redirect:'error',signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});}catch{throw Error('OpenAI sign-in service is unavailable. Try again later.');}
 }
 private async discovery(){const response=await this.request(issuer+'/.well-known/openid-configuration');if(!response.ok)throw Error('OpenAI identity discovery is unavailable.');const value=await response.json();if(value.issuer!==issuer)throw Error('Invalid OpenAI identity issuer.');for(const key of ['jwks_uri','revocation_endpoint']){const url=new URL(value[key]);if(url.origin!==issuer||url.username||url.password||url.hash)throw Error('Invalid OpenAI identity endpoint.');}return value as {issuer:string;jwks_uri:string;revocation_endpoint:string};}
 private async identity(jwt:string,clientId:string,nonce?:string){
  try {
   const parts=jwt.split('.');if(parts.length!==3||jwt.length>20000)throw Error();
   const header=JSON.parse(Buffer.from(parts[0],'base64url').toString()),claims=JSON.parse(Buffer.from(parts[1],'base64url').toString());
   if(header.alg!=='RS256'||typeof header.kid!=='string')throw Error();
   const discovery=await this.discovery(),keysResponse=await this.request(discovery.jwks_uri);if(!keysResponse.ok)throw Error();
   const keys=await keysResponse.json(),key=keys.keys?.find((entry:Record<string,unknown>)=>entry.kid===header.kid&&entry.kty==='RSA'&&(!entry.use||entry.use==='sig')&&(!entry.alg||entry.alg==='RS256'));
   if(!key||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw Error();
   const audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud],seconds=this.now()/1000;
   if(claims.iss!==issuer||!audiences.includes(clientId)||(audiences.length>1&&claims.azp!==clientId)||typeof claims.exp!=='number'||claims.exp<=seconds||typeof claims.sub!=='string'||!claims.sub||typeof claims.iat!=='number'||claims.iat>seconds+5||(claims.nbf&&claims.nbf>seconds+5)||(nonce&&(!claims.nonce||!equal(claims.nonce,nonce))))throw Error();
   return {subject:claims.sub as string,email:typeof claims.email==='string'?claims.email.slice(0,300):'ChatGPT account'};
  }catch{throw Error('OpenAI identity validation failed. Start a fresh sign-in.');}
 }
 private async token(form:URLSearchParams){const response=await this.request(tokenEndpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});if(!response.ok){let code='';try{code=(await response.json()).error;}catch{};if(code==='invalid_grant')throw Error('invalid_grant');throw Error('OpenAI token exchange failed. Start a fresh sign-in.');}const value=await response.json();if(value.token_type!=='Bearer'||typeof value.access_token!=='string'||!value.access_token||typeof value.expires_in!=='number'||value.expires_in<=0||typeof value.scope!=='string')throw Error('Invalid OpenAI token response.');return value;}
 private stop(owner:string){const pending=this.pending.get(owner);if(pending){pending.listener.close();this.pending.delete(owner);}}
 async cancel(owner:string){this.stop(owner);this.notices.set(owner,'Sign-in cancelled. Your previous account is unchanged.');}
 async begin(owner:string,accountKey?:string){
  if(!this.deps.store.supported)throw Error('Windows protected credential storage is required.');
  this.stop(owner);
  const saved=await this.deps.store.change(records=>{records.hostId??='urn:uuid:'+randomUUID();const account=accountKey?records.accounts.find(a=>a.key===accountKey&&a.owner===owner):undefined;if(accountKey&&!account)throw Error('Account is outside this browser session.');return {hostId:records.hostId,account};});
  const state=opaque(),nonce=opaque(),verifier=opaque();
  const listener=await (this.deps.listen??loopbackListener)(url=>this.callback(owner,url));
  const url=new URL(authorize);url.search=new URLSearchParams({client_id:saved.account?.clientId??'dynamic_agent_client',ext_agent_host_id:saved.hostId,response_type:'code',redirect_uri:listener.redirectUri,scope:scopes,resource,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}).toString();
  if(saved.account){if(saved.account.idToken)url.searchParams.set('id_token_hint',saved.account.idToken);if(saved.account.email!=='ChatGPT account')url.searchParams.set('login_hint',saved.account.email);if(saved.account.state==='consent_missing')url.searchParams.set('prompt','consent');}else url.searchParams.set('agent_name_hint','MythEngine');
  const pending:Pending={owner,state,nonce,verifier,listener,hostId:saved.hostId,clientId:saved.account?.clientId,accountKey,expiresAt:this.now()+300000,ticket:opaque(),processing:false,url:url.href};this.pending.set(owner,pending);this.notices.delete(owner);
  const timer=setTimeout(()=>{if(this.pending.get(owner)===pending){this.stop(owner);this.notices.set(owner,'Sign-in expired. Start again.');}},300000);timer.unref();
  return {launchUrl:'/api/chatgpt/authorize?ticket='+pending.ticket};
 }
 launch(owner:string,ticket:string){const pending=this.pending.get(owner);if(!pending||pending.expiresAt<this.now()||!equal(pending.ticket,ticket))throw Error('Sign-in launch expired.');pending.ticket=opaque();return pending.url;}
 async callback(owner:string,url:URL){
  const pending=this.pending.get(owner);if(!pending||pending.processing||pending.expiresAt<this.now()||url.origin+url.pathname!==pending.listener.redirectUri)throw Error('Sign-in callback expired.');
  for(const key of ['state','code','client_id','error'])if(url.searchParams.getAll(key).length>1)throw Error('Ambiguous sign-in callback.');
  if(!equal(url.searchParams.get('state')??'',pending.state))throw Error('Invalid sign-in state.');
  pending.processing=true;
  try {
   if(url.searchParams.has('error')){this.notices.set(owner,'ChatGPT consent was declined. Your previous account is unchanged.');return;}
   const clientId=url.searchParams.get('client_id')??pending.clientId,code=url.searchParams.get('code');
   if(!clientId||clientId==='dynamic_agent_client'||!code||clientId.length>300||(pending.clientId&&clientId!==pending.clientId))throw Error('Incomplete or mismatched client registration.');
   const value=await this.token(new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code,code_verifier:pending.verifier,redirect_uri:pending.listener.redirectUri,resource}));
   if(typeof value.id_token!=='string')throw Error('OpenAI did not return an identity token.');
   const identity=await this.identity(value.id_token,clientId,pending.nonce),granted=value.scope.split(/\s+/).filter(Boolean);
   if(this.pending.get(owner)!==pending)throw Error('Sign-in was cancelled before completion.');
   await this.deps.store.change(records=>{
    if(this.pending.get(owner)!==pending)throw Error('Sign-in was cancelled before completion.');
    const previous=pending.accountKey?records.accounts.find(a=>a.key===pending.accountKey&&a.owner===owner):undefined;
    if(pending.accountKey&&(!previous||previous.subject!==identity.subject||previous.clientId!==clientId))throw Error('The returning account identity changed.');
    const key=previous?.key??createHash('sha256').update(JSON.stringify([owner,clientId,identity.subject])).digest('hex').slice(0,32);
    const existing=records.accounts.find(a=>a.key===key),account:ChatgptAccount={key,owner,clientId,...identity,epoch:(existing?.epoch??0)+1,accessToken:value.access_token,refreshToken:value.refresh_token,idToken:value.id_token,scopes:granted,expiresAt:this.now()+value.expires_in*1000,earliestRefreshAt:typeof value.earliest_refresh_at==='number'?value.earliest_refresh_at:undefined,savedAt:this.now(),state:granted.includes('chatgpt.tokens.use.direct')?'connected':'consent_missing'};
    if(existing)records.accounts.splice(records.accounts.indexOf(existing),1,account);else records.accounts.push(account);
    this.catalog.delete(key);
   });
   this.notices.set(owner,granted.includes('chatgpt.tokens.use.direct')?'ChatGPT connected. Choose its model for this story.':'Signed in, but ChatGPT plan consent was not granted. Reauthorize to use your plan.');
  }catch(error){this.notices.set(owner,(error as Error).message==='invalid_grant'?'The authorization code expired. Start a fresh sign-in.':(error as Error).message);throw error;}
  finally{if(this.pending.get(owner)===pending)this.stop(owner);}
 }
 async status(owner:string,projectId:string,gameId:string){
  const records=await this.deps.store.read(),selection=records.selections[scopeKey(owner,projectId,gameId)];
  const account=selection?records.accounts.find(a=>a.key===selection.accountKey&&a.owner===owner):undefined,cache=account?this.catalog.get(account.key):undefined;
  const current=cache&&account?.state==='connected'&&cache.epoch===account.epoch&&this.now()-cache.at<300000;
  return {supported:this.deps.store.supported,csrf:this.csrfToken(owner),pending:this.pending.has(owner),notice:this.notices.get(owner)??null,selection:selection??null,accounts:records.accounts.filter(a=>a.owner===owner).map(a=>({key:a.key,label:a.email+' · '+a.key.slice(0,6),state:a.lastError??(a.state==='connected'&&a.expiresAt<this.now()&&!a.refreshToken?'expired':a.state),expiresAt:a.expiresAt})),models:current?cache.models:[],catalogLoaded:!!current};
 }
 async binding(owner:string|undefined,projectId:string,gameId:string):Promise<ChatgptBinding|null>{if(!owner)return null;const records=await this.deps.store.read(),selection=records.selections[scopeKey(owner,projectId,gameId)];if(!selection)return null;const account=records.accounts.find(a=>a.key===selection.accountKey&&a.owner===owner);if(!account)throw Error('Selected ChatGPT account is disconnected.');return {owner,accountKey:account.key,clientId:account.clientId,subject:account.subject,epoch:account.epoch,model:selection.model,projectId,gameId};}
 async select(owner:string,projectId:string,gameId:string,accountKey:string|null,model?:string){
  if(accountKey){const models=await this.models(owner,accountKey);if(!model||!models.some(m=>m.id===model))throw Error('Select a model from this account’s current catalog.');}
  for(const abort of this.scopeAborts.get(scopeKey(owner,projectId,gameId))??[])abort.abort(Error('Story connection changed.'));
  await this.deps.store.change(records=>{const key=scopeKey(owner,projectId,gameId);if(accountKey)records.selections[key]={accountKey,model:model!};else delete records.selections[key];});
 }
 private abortAccount(key:string){for(const abort of this.aborts.get(key)??[])abort.abort(Error('ChatGPT session ended.'));this.aborts.delete(key);this.catalog.delete(key);}
 async logout(owner:string,key:string){
  const saved=await this.deps.store.read();if(!saved.accounts.some(a=>a.key===key&&a.owner===owner))throw Error('Account is outside this browser session.');
  this.abortAccount(key);this.stop(owner);let revoked=false;
  await this.deps.store.change(async records=>{
   const account=records.accounts.find(a=>a.key===key&&a.owner===owner);if(!account)throw Error('Account is outside this browser session.');
   if(account.refreshToken){for(let attempt=0;attempt<2;attempt++){try{const discovery=await this.discovery();const response=await this.request(discovery.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:account.refreshToken,token_type_hint:'refresh_token',client_id:account.clientId}).toString()});if(response.ok){revoked=true;break;}if(response.status<500)break;}catch{}if(!attempt)await new Promise(resolve=>setTimeout(resolve,250));}}
   delete account.accessToken;delete account.refreshToken;delete account.idToken;account.scopes=[];account.expiresAt=0;account.epoch++;account.state='disconnected';account.lastError=revoked?undefined:'revocation_unconfirmed';
  });
  this.notices.set(owner,revoked?'Signed out. The renewable session was revoked.':'Signed out locally. Remote revocation was not confirmed; disconnect MythEngine in ChatGPT Settings.');return {revoked};
 }
 async credentials(binding:ChatgptBinding):Promise<ChatgptPlanSession>{return this.credentialFor(binding);}
 private async credentialFor(binding:ChatgptBinding,catalog=false):Promise<ChatgptPlanSession>{
  const session=await this.deps.store.change(async records=>{
   const selection=records.selections[scopeKey(binding.owner,binding.projectId,binding.gameId)],account=records.accounts.find(a=>a.key===binding.accountKey&&a.owner===binding.owner);
   if(!account||account.clientId!==binding.clientId||account.subject!==binding.subject||account.epoch!==binding.epoch||(!catalog&&(selection?.accountKey!==binding.accountKey||selection.model!==binding.model)))throw Error('The selected ChatGPT account or story model changed. Start a new request.');
   if(account.state!=='connected'||!account.scopes.includes('chatgpt.tokens.use.direct')||!account.accessToken)throw Error('ChatGPT is disconnected or plan consent is missing. Continue with ChatGPT to reconnect.');
   if(account.expiresAt<=this.now()+60000){
    if(!account.refreshToken)throw Error('ChatGPT access expired. Continue with ChatGPT again.');
    if(account.earliestRefreshAt&&this.now()<account.earliestRefreshAt*1000)throw Error('ChatGPT refresh is not available yet. Try again later.');
    try {
     const value=await this.token(new URLSearchParams({grant_type:'refresh_token',client_id:account.clientId,refresh_token:account.refreshToken,resource}));
     if(typeof value.refresh_token!=='string'||!value.refresh_token)throw Error('Invalid rotating refresh token.');
     if(value.id_token){const identity=await this.identity(value.id_token,account.clientId);if(identity.subject!==account.subject)throw Error('Refreshed identity changed.');account.idToken=value.id_token;}
     account.accessToken=value.access_token;account.refreshToken=value.refresh_token;account.scopes=value.scope.split(/\s+/).filter(Boolean);account.expiresAt=this.now()+value.expires_in*1000;account.earliestRefreshAt=typeof value.earliest_refresh_at==='number'?value.earliest_refresh_at:undefined;account.savedAt=this.now();delete account.lastError;
     if(!account.scopes.includes('chatgpt.tokens.use.direct')){account.state='consent_missing';return {error:'ChatGPT plan permission was removed. Reauthorize to continue.'};}
    }catch(error){if((error as Error).message==='invalid_grant'){account.state='revoked';account.epoch++;delete account.accessToken;delete account.refreshToken;delete account.idToken;return {error:'ChatGPT session expired or was revoked. Continue with ChatGPT again.'};}throw error;}
   }
   return {enabled:true,accessToken:account.accessToken,grantedScopes:account.scopes,fetchImpl:this.fetch};
  });
  if('error'in session)throw Error(session.error);return session as ChatgptPlanSession;
 }
 async models(owner:string,key:string,refresh=false){const records=await this.deps.store.read(),account=records.accounts.find(a=>a.key===key&&a.owner===owner);if(!account)throw Error('Account is outside this browser session.');if(account.state!=='connected'||!account.scopes.includes('chatgpt.tokens.use.direct')||!account.accessToken)throw Error('ChatGPT is disconnected or plan consent is missing. Continue with ChatGPT to reconnect.');const binding:ChatgptBinding={owner,accountKey:key,clientId:account.clientId,subject:account.subject,epoch:account.epoch,model:'catalog',projectId:'catalog',gameId:'catalog'};
  // Catalog refresh shares the same protected rotation owner; temporary selection is never stored.
  const cached=this.catalog.get(key);if(!refresh&&cached?.epoch===account.epoch&&this.now()-cached.at<300000)return cached.models;
  this.catalog.delete(key);
  const models=await listChatgptPlanModels(await this.credentialFor(binding,true));
  const current=(await this.deps.store.read()).accounts.find(a=>a.key===key&&a.owner===owner);
  if(!current||current.epoch!==binding.epoch||current.state!=='connected')throw Error('ChatGPT account changed while its catalog was loading. Load the current account models again.');
  this.catalog.set(key,{at:this.now(),epoch:account.epoch,models});return models;
 }
 async run<T>(binding:ChatgptBinding,signal:AbortSignal|undefined,work:(session:ChatgptPlanSession,signal:AbortSignal)=>Promise<T>):Promise<T>{
  const abort=new AbortController(),set=this.aborts.get(binding.accountKey)??new Set<AbortController>();set.add(abort);this.aborts.set(binding.accountKey,set);
  const scope=scopeKey(binding.owner,binding.projectId,binding.gameId),scopeSet=this.scopeAborts.get(scope)??new Set<AbortController>();scopeSet.add(abort);this.scopeAborts.set(scope,scopeSet);
  const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
  try{const session=await this.credentials(binding);combined.throwIfAborted();const result=await work(session,combined);combined.throwIfAborted();await this.credentials(binding);return result;}
  finally{scopeSet.delete(abort);if(!scopeSet.size)this.scopeAborts.delete(scope);set.delete(abort);if(!set.size)this.aborts.delete(binding.accountKey);}
 }
 async failure(binding:ChatgptBinding,kind:'limit'|'unsupported'|'revoked'|'network'){if(kind==='revoked')this.abortAccount(binding.accountKey);await this.deps.store.change(records=>{const account=records.accounts.find(a=>a.key===binding.accountKey&&a.owner===binding.owner&&a.epoch===binding.epoch);if(!account)return;account.lastError=kind==='revoked'?undefined:kind;if(kind==='revoked'){account.state='revoked';account.epoch++;delete account.accessToken;delete account.refreshToken;delete account.idToken;}});}
}
