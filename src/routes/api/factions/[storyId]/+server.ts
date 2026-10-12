import {recordVerificationReport} from '$lib/server/factions/verificationAuthoring';
import {reliefAuthoringOptions,recordReliefEvidence,requestReliefCancellation} from '$lib/server/factions/reliefAuthoring';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { stories, storyEvents, factionProjects } from '$lib/server/db/schema';
import { advanceNegotiation, initializeNegotiation, reviewFactionIntentions, reviewGardener } from '$lib/server/factions/workflow';
import {authorReliefProject} from '$lib/server/factions/persistentProjects';
import { record,worldDay } from '$lib/server/factions/intentions';
import { getMtheriosAppConfig } from '$lib/server/app/config';

// GM/developer inspection only; private plans never enter player-facing story text.
export const GET: RequestHandler = async ({ params,url }) => {
 const [story] = await getDb().select().from(stories).where(eq(stories.id, params.storyId)).limit(1);
 if (!story) return json({ error: 'Story not found.' }, { status: 404 });
 const events = await getDb().select({ id: storyEvents.id, title: storyEvents.title, body: storyEvents.body, worldTime: storyEvents.worldTime, visibility: storyEvents.visibility })
  .from(storyEvents).where(and(eq(storyEvents.storyId, params.storyId), eq(storyEvents.status, 'committed'))).orderBy(desc(storyEvents.createdTurn)).limit(5);
 return json({ inspection: 'GM/developer only', currentTurn: story.currentTurn, worldTime: story.currentWorldTime, reliefWorldDay:worldDay(story.currentWorldTime), serverVersion: story.serverVersion,
  turnJobsEnabled: getMtheriosAppConfig().turnJobsEnabled,
  inferencePolicy: process.env.MYTHENGINE_TEST_LOCAL_ONLY === 'true' ? 'local-only-testing' : 'configured-providers',
  authoring:await reliefAuthoringOptions(params.storyId,url?.searchParams.get('evidenceQuery')??''),workflow: record(record(story.metadata).factionWorkflow), projects:await getDb().select().from(factionProjects).where(eq(factionProjects.storyId,params.storyId)),events });
};
export const POST: RequestHandler = async ({ params, request }) => {
 try {
  const body = record(await request.json());
  switch (body.operation) {
   case 'create-relief-project': { if(!body.config||typeof body.config!=='object')throw new Error('Supported relief configuration is required.');return json(await authorReliefProject(params.storyId,body.project,false,body.config)); }
   case 'record-verification-report': return json(await recordVerificationReport(params.storyId,body.report));
   case 'record-relief-evidence': return json(await recordReliefEvidence(params.storyId,body.evidence));
   case 'cancel-relief-project': {
    const request=await requestReliefCancellation(params.storyId,body.project);
    const settlement=await advanceNegotiation(params.storyId,`cancel:${String(request.projectId)}`.slice(0,50),undefined,String(request.projectId));
    return json({request,settlement});
   }
   case 'review': return json({ factions: await reviewFactionIntentions(params.storyId, `manual_${crypto.randomUUID()}`), gardener: await reviewGardener(params.storyId) });
   case 'author-relief-project': return json(await authorReliefProject(params.storyId,body.project));
   case 'replan-relief-project': return json(await authorReliefProject(params.storyId,body.project,true,body.config));
   case 'initialize-negotiation': return json(await initializeNegotiation(params.storyId, body.config));
   case 'negotiation-step': {
    if (typeof body.stepId !== 'string' || !/^[a-z0-9_:-]{1,50}$/.test(body.stepId)) throw new Error('A stable stepId is required.');
    return json(await advanceNegotiation(params.storyId, body.stepId,undefined,typeof body.projectId==='string'?body.projectId:undefined));
   }
   default: return json({ error: 'Unknown faction operation.' }, { status: 400 });
  }
 } catch (error) { return json({ error: error instanceof Error ? error.message : 'Faction operation failed.' }, { status: 400 }); }
};
