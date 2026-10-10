import type { RequestHandler } from '@sveltejs/kit';
import { localBrowserOwner } from '$lib/server/chatgpt/http';
import { chatgptSessions } from '$lib/server/chatgpt/owner';
export const GET:RequestHandler=event=>{try{const owner=localBrowserOwner(event);const url=chatgptSessions().launch(owner,event.url.searchParams.get('ticket')??'');return new Response(null,{status:302,headers:{Location:url,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});}catch{return new Response('Sign-in launch expired. Return to MythEngine and try again.',{status:400,headers:{'Cache-Control':'no-store'}});}};
