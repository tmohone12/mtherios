<script lang="ts">
 import { onMount,untrack } from 'svelte';
 import type {AssistantConnection,AssistantConnectionState} from '$lib/contracts/assistantConnection';
 import { setChatgptCsrf,chatgptCsrfHeaders } from '$lib/services/chatgptBrowser';
 type Account={key:string;label:string;state:string;expiresAt:number};
 type Status={supported:boolean;csrf:string;pending:boolean;notice:string|null;selection:{accountKey:string;model:string}|null;accounts:Account[];models:Array<{id:string;label:string}>;catalogLoaded?:boolean;connection:AssistantConnection|null;connectionError:string|null};
 let {projectId,gameId,onState}:{projectId:string;gameId:string;onState:(state:AssistantConnectionState)=>void}=$props();
 let status=$state<Status|null>(null),error=$state(''),busy=$state(false),accountKey=$state(''),model=$state('');
 let models=$state<Array<{id:string;label:string}>>([]);
 let modelsLoaded=$state(false),configuredConfirmed=$state(false);
 const choicePending=$derived(!!status?.selection&&(accountKey!==status.selection.accountKey||(!!model&&model!==status.selection.model)));
 const ready=$derived(!!status?.connection&&!busy&&!error&&!choicePending&&(status.connection.kind==='chatgpt'?!!status.accounts.find(a=>a.key===status!.selection?.accountKey&&!['disconnected','revoked','consent_missing','expired','revocation_unconfirmed'].includes(a.state)):configuredConfirmed));
 $effect(()=>{const value={scope,connection:status?.connection??null,ready};untrack(()=>onState(value));});
 let version=0,actionVersion=0,alive=false,poll:ReturnType<typeof setTimeout>|undefined;
 let connectionElement:HTMLDetailsElement;
 const selected=$derived(status?.accounts.find(account=>account.key===accountKey));
 const active=$derived(status?.accounts.find(account=>account.key===status?.selection?.accountKey));
 const scope=$derived(JSON.stringify({projectId,gameId}));
 async function request(action?:string,extra:Record<string,unknown>={}){
  const response=await fetch(action?'/api/chatgpt/session':'/api/chatgpt/session?'+new URLSearchParams({projectId,gameId}),action?{method:'POST',headers:{'Content-Type':'application/json',...chatgptCsrfHeaders()},body:JSON.stringify({projectId,gameId,action,...extra})}:{cache:'no-store'});
  const value=await response.json();if(!response.ok)throw Error(value.error??'ChatGPT connection failed.');return value;
 }
 async function load(){
  const current=++version,key=scope;
  try{
   const value=await request() as Status;if(!alive||current!==version||scope!==key)return;
   status=value;error='';setChatgptCsrf(value.csrf);
   if(!value.accounts.some(account=>account.key===accountKey)){accountKey=value.selection?.accountKey??value.accounts.at(-1)?.key??'';models=[];modelsLoaded=false;model='';}
   if(value.selection?.accountKey===accountKey){models=value.models;modelsLoaded=value.catalogLoaded??value.models.length>0;model=models.some(entry=>entry.id===value.selection!.model)?value.selection.model:'';}

   if(value.pending)poll=setTimeout(()=>void load(),2000);
  }catch(cause){if(alive&&current===version)error=(cause as Error).message;}
 }
 async function act(action:string,extra:Record<string,unknown>={}){
  if(busy)return;busy=true;error='';const key=scope,current=++actionVersion,requestedAccount=accountKey;
  if(action==='models'){models=[];modelsLoaded=false;}
  try{
   const value=await request(action,extra);
   if(!alive||key!==scope||current!==actionVersion||requestedAccount!==accountKey)return;
   if(action==='models'){if(value.accountKey!==requestedAccount)throw Error('The model catalog belongs to another account. Load the current account models again.');models=value.models;modelsLoaded=true;model=models.some(entry=>entry.id===model)?model:'';}
   else {status=value;setChatgptCsrf(value.csrf);if(action==='logout'){models=[];modelsLoaded=false;model='';}if(action==='select'){configuredConfirmed=value.connection?.kind==='configured';accountKey=value.selection?.accountKey??accountKey;connectionElement.open=false;}}
  }catch(cause){if(key===scope&&current===actionVersion)error=(cause as Error).message;}finally{if(key===scope&&current===actionVersion)busy=false;}
 }
 async function begin(){
  if(busy)return;
  // Open during the author gesture; only a one-time local launch ticket reaches JS.
  const popup=window.open('about:blank','_blank');if(popup)popup.opener=null;
  busy=true;error='';const key=scope;
  try{const value=await request('begin',{...(accountKey?{accountKey}:{})});if(!alive||key!==scope){popup?.close();return;}if(!popup){error='Your browser blocked sign-in. Allow popups for this local app and try again.';await request('cancel');return;}popup.location.replace(value.launchUrl);await load();}
  catch(cause){popup?.close();if(key===scope)error=(cause as Error).message;}finally{if(key===scope)busy=false;}
 }
 function accountChanged(){actionVersion++;busy=false;configuredConfirmed=false;error='';models=[];modelsLoaded=false;model='';if(selected&&!['disconnected','revoked','consent_missing','expired','revocation_unconfirmed'].includes(selected.state))void act('models',{accountKey,refresh:true});}
 onMount(()=>{alive=true;void load();return()=>{alive=false;version++;actionVersion++;clearTimeout(poll);};});
 $effect(()=>{scope;if(alive){version++;actionVersion++;busy=false;status=null;configuredConfirmed=false;accountKey='';model='';models=[];modelsLoaded=false;error='';clearTimeout(poll);void load();}});
</script>

<details class="connection" bind:this={connectionElement}>
 <summary><strong>Assistant connection</strong><span>{!status?'Checking connection':status.connection?.kind==='chatgpt'?`ChatGPT · ${status.connection.model}`:status.connection?.kind==='configured'?`${status.connection.provider} · ${status.connection.model}`:'Unavailable'}</span></summary>
 <div class="connection-body">
  <p role="status">{ready?`Ready to send via ${status?.connection?.kind==='chatgpt'?'ChatGPT plan':status?.connection?.kind==='configured'?status.connection.provider:''} · ${status?.connection?.model}`:choicePending?'Your new account/model choice is not active. Apply it before sending.':status?.connection?.kind==='configured'?'Choose ChatGPT below, or explicitly confirm the configured provider before sending.':'The Assistant cannot send until its connection is ready.'}</p>
  {#if status?.connectionError}<p class="error" role="alert">{status.connectionError}</p>{/if}
  {#if error}<button onclick={()=>{configuredConfirmed=false;void load();}} disabled={busy}>Reload connection</button>{/if}
  <p>This connection controls Assistant messages for {gameId?'the selected story':'this project'}. GM/narration, images, batch jobs and indexing retain their own configured providers. ChatGPT offers story reads and reviewed edits without auxiliary model calls.</p>
  <p>Use your ChatGPT plan through MythEngine. Story edits pause for your review. Conversations stay with their account and selected story.</p>
  {#if !status}<p role="status">{error||'Checking the local connection…'}</p>{/if}
  {#if status && !status.supported}<p role="status">This integration requires Windows protected credential storage. Continue using your configured service on this platform.</p>{/if}
  {#if status?.notice}<p role="status">{status.notice}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if gameId && status?.supported}
   <label>ChatGPT account<select aria-label="ChatGPT account" value={accountKey} onchange={event=>{accountKey=event.currentTarget.value;accountChanged();}} disabled={busy||status.pending}><option value="">Add account or workspace</option>{#each status.accounts as account}<option value={account.key}>{account.label} - {account.state}</option>{/each}</select></label>
   {#if status.pending}<p role="status">Finish registration and plan consent in the OpenAI browser window. Your previous account is unchanged until validation.</p><button onclick={()=>act('cancel')} disabled={busy}>Cancel sign-in</button>
   {:else}<button class="sign-in" onclick={begin} disabled={busy}>Continue with ChatGPT</button>{/if}
   {#if selected}
    <p role="status">{selected.state==='connected'?'Connected. Choose an eligible model for this story.':selected.state==='consent_missing'?'Plan permission was not granted. Continue with ChatGPT to authorize it.':selected.state==='limit'?'The last request reached a ChatGPT usage limit. Review your app limits before trying again.':selected.state==='unsupported'?'The last model/request was unavailable for this plan. Choose another eligible model.':selected.state==='revocation_unconfirmed'?'Signed out locally. Remote revocation was not confirmed. You can disconnect MythEngine in ChatGPT Settings.':selected.state==='network'?'The last request could not complete. No automatic model retry was made.':'Disconnected or expired. Continue with ChatGPT to reconnect.'}</p>
    <button onclick={()=>act('models',{accountKey,refresh:true})} disabled={busy||status.pending||['disconnected','revoked','consent_missing','expired','revocation_unconfirmed'].includes(selected.state)}>{modelsLoaded?'Refresh account models':'Load account models'}</button>
    {#if modelsLoaded}<p role="status">{models.length} selectable {models.length===1?'model':'models'} returned for this account. ChatGPT Chat and Codex can show different catalogs.</p>{/if}
    {#if models.length}<label>ChatGPT model<select aria-label="ChatGPT model" bind:value={model} onchange={()=>{configuredConfirmed=false;}} disabled={busy}><option value="">Choose a model</option>{#each models as entry}<option value={entry.id}>{entry.label}</option>{/each}</select></label><button onclick={()=>act('select',{accountKey,model})} disabled={busy||!model||['disconnected','revoked','consent_missing','expired','revocation_unconfirmed'].includes(selected.state)}>Use ChatGPT for this story</button>{:else if modelsLoaded}<p>This account catalog returned no selectable models. Check the selected account/workspace and its plan permission; a model shown in another OpenAI app may not be offered through this connection.</p>{:else}<p>No current model catalog is loaded. Load the account models before choosing one; availability is checked again by inference.</p>{/if}
    <button onclick={()=>act('logout',{accountKey})} disabled={busy}>Sign out of this account</button>
   {/if}
   {#if status.selection}<p>Active: {active?.label??'Disconnected account'} · {status.selection.model}. Connection failures never fall back to another provider.</p>{/if}
  {/if}
  {#if status?.connection?.kind==='configured'}<p>Configured Assistant: {status.connection.provider} · {status.connection.model}. Its provider can charge separately from your ChatGPT plan.</p><button onclick={()=>{error='';configuredConfirmed=true;accountKey=status?.selection?.accountKey??'';}} disabled={busy}>Confirm {status.connection.provider} for {gameId?'this story':'this project'}</button>{:else if status?.selection}<button onclick={()=>act('select',{accountKey:null})} disabled={busy}>Use configured service for this story</button>{/if}
  <p class="usage">Plan usage and app limits: <a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noreferrer">ChatGPT Settings → Usage</a>. Subscription usage is not an API key; currency cost is not estimated here.</p>
 </div>
</details>

<style>
 .connection{flex:0 0 auto;min-height:0;border-bottom:1px solid var(--border-secondary);background:var(--bg-primary);font-size:12px}
 summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;cursor:pointer}
 summary:focus-visible,button:focus-visible,select:focus-visible{outline:2px solid var(--text-accent);outline-offset:2px}
 summary span{color:var(--text-accent);font-size:11px;overflow-wrap:anywhere}.connection-body{display:grid;gap:10px;padding:0 18px 16px;max-height:min(34dvh,max(120px,calc(100dvh - 510px)));overflow:auto;overscroll-behavior:contain}
 p{margin:0;line-height:1.55;color:var(--text-muted);overflow-wrap:anywhere}label{display:grid;gap:5px;color:var(--text-secondary)}
 select,button{min-height:40px;border:1px solid var(--border-primary);border-radius:7px;background:var(--bg-secondary);color:var(--text-primary);padding:8px 10px;font:inherit;width:100%;min-width:0;text-align:left}
 button:hover{background:var(--bg-tertiary)}button:disabled{opacity:.5;cursor:not-allowed}.sign-in{background:#fff;color:#111;font-weight:600;text-align:center}.sign-in:hover{background:#eee}.error{color:var(--error)}a{color:var(--text-accent);text-decoration:underline}.usage{font-size:11px}
</style>
