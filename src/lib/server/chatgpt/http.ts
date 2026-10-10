import { randomBytes } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { ownerHash } from './session';
import { chatgptSessions } from './owner';
export const ownerCookie='mythengine-chatgpt-browser';
export function localBrowserOwner(event:RequestEvent,mutation=false){
 if(event.url.hostname!=='127.0.0.1'||event.url.protocol!=='http:'||!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(event.getClientAddress()))throw Error('ChatGPT sign-in is available only from the local loopback app.');
 const site=event.request.headers.get('sec-fetch-site');if(site&&site!=='same-origin'&&site!=='none')throw Error('Cross-origin ChatGPT connection request denied.');
 if(mutation&&event.request.headers.get('origin')!==event.url.origin)throw Error('Same-origin browser authorization is required.');
 let cookie=event.cookies.get(ownerCookie);
 if(!cookie||! /^[A-Za-z0-9_-]{43}$/.test(cookie)){if(mutation)throw Error('Reload the Assistant before connecting ChatGPT.');cookie=randomBytes(32).toString('base64url');event.cookies.set(ownerCookie,cookie,{path:'/',httpOnly:true,sameSite:'strict',secure:false,maxAge:365*86400});}
 const owner=ownerHash(cookie);
 if(mutation)chatgptSessions().validateCsrf(owner,event.request.headers.get('x-mythengine-csrf')??'');
 return owner;
}
