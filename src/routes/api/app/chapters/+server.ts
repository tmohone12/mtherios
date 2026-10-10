import {json,type RequestHandler} from '@sveltejs/kit';
import {chapterRunnerActionSchema,RECOVERY_ROUTE} from '$lib/contracts/chapterRunner';
import {getSqlClient} from '$lib/server/db/client';
import {getMtheriosAppConfig} from '$lib/server/app/config';
import {resolveApiKeyRef} from '$lib/server/engine/llmSettings';
import {getChapterRunnerStatus,configureChapterRunner,tickChapterRunner} from '$lib/server/jobs/chapterSummaryRunner';
import {apiError} from '$lib/server/memory/http';
const gate=()=>{const c=getMtheriosAppConfig();return {enabled:c.chapterRunnerEnabled,storyId:c.chapterRunnerStoryId};};
export const GET:RequestHandler=async({url})=>{
 try {const sid=url.searchParams.get('storyId');if(!sid)return json({error:'storyId is required.'},{status:400});
  return json(await getChapterRunnerStatus(getSqlClient(),sid,gate()));
 }catch(e){return apiError(e);}
};
export const POST:RequestHandler=async({request})=>{
 try {
  const input=chapterRunnerActionSchema.parse(await request.json()),db=getSqlClient(),g=gate();
  if(input.action==='disable')return json(await configureChapterRunner(db,input.storyId,g));
  if(input.action==='enable')return json(await configureChapterRunner(db,input.storyId,g,input.approval));
  return json(await tickChapterRunner(db,input.storyId,g,{profile:async()=>{
   // The approved chapter route owns its model and spending ceiling. A change
   // to general memory generation must not silently change or disable it.
   const apiKey=resolveApiKeyRef('env:NANOGPT_API_KEY');
   if(!apiKey.trim())throw Error('Pinned NanoGPT chapter connection is unavailable. Configure NANOGPT_API_KEY before resuming.');
   return {id:'server-chapter-runner',name:'Approved chapter summaries',providerType:'nanogpt',
    baseUrl:RECOVERY_ROUTE.baseUrl,apiKey,customModels:[RECOVERY_ROUTE.model],fetchedModels:[],reasoningModels:[],hiddenModels:[],favoriteModels:[]};
  }}));
 }catch(e){return apiError(e);}
};
