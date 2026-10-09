import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { reserveExplicitImage, reserveManualSceneImageInTransaction } from './imageRequests';
import { claimBackendJobs, recoverStaleBackendJobs } from '$lib/server/jobs/outbox';
import { reserveDirectImageRequest } from './imageJobs';

const integration = process.env.MYTHENGINE_IMAGE_INTEGRATION === '1' ? test : test.skip;

integration('direct image receipts cannot be claimed by the worker or requeued after a crash', async () => {
  const projectId = `shelf_direct_image_${randomUUID()}`;
  const gameId = `story_direct_image_${randomUUID()}`;
  const db = getDb();
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Direct image check',${projectId})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Direct image check')`);
    const input = { projectId, storyId: gameId, dedupeKey: 'direct-call', payload: { kind: 'gm_chat', prompt: 'A harbor' } };
    const receipt = await db.transaction(tx => reserveDirectImageRequest(tx, input));
    expect(receipt.isNew).toBe(true);
    expect((await db.transaction(tx => reserveDirectImageRequest(tx, input))).isNew).toBe(false);
    const [saved] = await db.execute(sql`select status,locked_by,payload from backend_jobs where id=${receipt.jobId}`);
    expect(saved).toMatchObject({ status: 'running', locked_by: 'image-api', payload: { execution: 'api' } });
    await db.execute(sql`update backend_jobs set status='retry',locked_at=null,locked_by=null where id=${receipt.jobId}`);
    expect(await claimBackendJobs('image-check-worker', 1, gameId)).toEqual([]);
    await db.execute(sql`update backend_jobs set status='running',locked_at=now()-interval '2 hours',locked_by='image-api' where id=${receipt.jobId}`);
    expect(await recoverStaleBackendJobs(60_000, gameId)).toBe(1);
    expect((await db.execute(sql`select status from backend_jobs where id=${receipt.jobId}`))[0].status).toBe('failed');
  } finally {
    await db.execute(sql`delete from shelves where id=${projectId}`);
  }
});

integration('gates explicit image tools, resolves a game file, and deduplicates origin calls without provider spend', async () => {
  const projectId = `shelf_image_${randomUUID()}`;
  const gameId = `story_image_${randomUUID()}`;
  const otherGameId = `story_image_${randomUUID()}`;
  const typeId = randomUUID();
  const itemId = randomUUID();
  const otherItemId = randomUUID();
  const secondItemId = randomUUID();
  const rollback = new Error('rollback explicit image smoke');
  const priorImageCostCap = process.env.MYTHENGINE_IMAGE_MAX_COST_USD;
  process.env.MYTHENGINE_IMAGE_TEST_KEY = 'test-key';
  delete process.env.MYTHENGINE_IMAGE_MAX_COST_USD;
  try {
    await expect(getDb().transaction(async tx => {
      const projectSettings = { agentTools: { schemaVersion: 1, revision: 1, overrides: { gmImages: false, assistantImages: true } }, imageStyle: { revision: 4, prompt: 'Etched copper and dim candlelight' } };
      await tx.execute(sql`insert into shelves(id,name,slug,settings) values(${projectId},'Explicit image smoke',${projectId},${JSON.stringify(projectSettings)}::jsonb)`);
      await tx.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Image game'),(${otherGameId},${projectId},'Other game')`);
      await tx.execute(sql`insert into content_types(id,project_id,key,extension,name,definition) values(${typeId},${projectId},'character','char','Character','{}'::jsonb)`);
      await tx.execute(sql`insert into content_items(id,project_id,game_id,type_id,title,folder,slug,data) values
        (${itemId},${projectId},${gameId},${typeId},'Hero','people','hero','{}'::jsonb),
        (${secondItemId},${projectId},${gameId},${typeId},'Hero','rivals','rival','{}'::jsonb),
        (${otherItemId},${projectId},${otherGameId},${typeId},'Hero','people','hero','{}'::jsonb)`);
      await tx.execute(sql`update llm_service_settings set provider_type='openai',model='gpt-image-1',api_key_ref='env:MYTHENGINE_IMAGE_TEST_KEY',enabled=true where service_id='imageGeneration'`);

      const assistant = await reserveExplicitImage(tx, { role: 'assistant', projectId, gameId: null, runId: 'assistant-run', callId: 'first-image', conversationId: 'conversation', prompt: 'A moonlit gate' });
      expect(assistant.isNew).toBe(true);
      expect((await reserveExplicitImage(tx, { role: 'assistant', projectId, gameId: null, runId: 'assistant-run', callId: 'first-image', conversationId: 'conversation', prompt: 'A moonlit gate' })).jobId).toBe(assistant.jobId);
      await expect(reserveExplicitImage(tx, { role: 'gm', projectId, gameId, runId: 'gm-run', callId: 'disabled', prompt: 'The hero' })).rejects.toThrow('disabled');
      await tx.execute(sql`update stories set settings=${JSON.stringify({ agentTools: { schemaVersion: 1, revision: 1, overrides: { gmImages: true } } })}::jsonb where id=${gameId}`);
      await expect(reserveExplicitImage(tx, { role: 'gm', projectId, gameId, runId: 'gm-run', callId: 'ambiguous', fileName: 'Hero', prompt: 'The hero' })).rejects.toThrow('More than one');
      const cover = await reserveExplicitImage(tx, { role: 'gm', projectId, gameId, runId: 'gm-run', callId: 'cover', fileName: 'people/hero.char', prompt: 'The hero at the gate' });
      expect(cover).toMatchObject({ isNew: true, itemId, expectedCoverRevision: 0, styleRevision: 4 });
      const jobs = await tx.execute(sql`select id,story_id,payload from backend_jobs where project_id=${projectId} and type='generate_image' order by id`);
      expect(jobs).toHaveLength(2);
      expect(jobs.find(job => job.id === assistant.jobId)).toMatchObject({ story_id: null, payload: { kind: 'assistant_chat', model: 'gpt-image-1', origin: { conversationId: 'conversation' } } });
      expect(jobs.find(job => job.id === cover.jobId)).toMatchObject({ story_id: gameId, payload: { kind: 'explicit_cover', itemId, expectedCoverRevision: 0, styleRevision: 4 } });
      expect((jobs.find(job => job.id === cover.jobId)!.payload as { prompt: string }).prompt).toContain('Etched copper');
      const turnId = randomUUID();
      await tx.execute(sql`insert into story_entries(id,story_id,type,content,position,metadata,server_version)
        values(${turnId},${gameId},'user_action','Show the gate',1,'{"clientTurnId":"manual-scene-turn"}'::jsonb,1)`);
      await tx.execute(sql`insert into story_entries(id,story_id,type,content,position,parent_id,server_version)
        values(${randomUUID()},${gameId},'narration','Mira stands beneath the moonlit gate.',2,${turnId},1)`);
      const locationId = randomUUID();
      await tx.execute(sql`insert into entities(id,story_id,type,name,description,visibility) values
        (${locationId},${gameId},'location','Storm Harbor','Copper lanterns line the quay.','public')`);
      await tx.execute(sql`update stories set current_location_id=${locationId} where id=${gameId}`);
      await tx.execute(sql`insert into entities(id,story_id,type,name,description,state,visibility) values
        (${randomUUID()},${gameId},'character','Mira','A weathered cartographer.',${JSON.stringify({ appearance: 'scarred left cheek', visualDescriptors: { hair: 'copper braid' } })}::jsonb,'public'),
        (${randomUUID()},${gameId},'character','Secret Mira','Hidden enemy.','{}'::jsonb,'gm_only')`);
      const manualRequest = { projectId, gameId, clientTurnId: 'manual-scene-turn', callId: 'manual-call' };
      await expect(reserveManualSceneImageInTransaction(tx, { ...manualRequest, clientTurnId: 'another-turn' })).rejects.toThrow('origin turn');
      const manual = await reserveManualSceneImageInTransaction(tx, { ...manualRequest, prompt: 'Untrusted browser scene' });
      expect((await reserveManualSceneImageInTransaction(tx, manualRequest)).jobId).toBe(manual.jobId);
      const [manualJob] = await tx.execute(sql`select payload from backend_jobs where id=${manual.jobId}`);
      expect(manualJob.payload).toMatchObject({ kind: 'manual_scene', model: 'gpt-image-1', browserOrigin: { clientTurnId: 'manual-scene-turn', callId: 'manual-call' } });
      const scenePrompt = JSON.stringify((manualJob.payload as { sceneContext: unknown }).sceneContext);
      for (const detail of ['moonlit gate', 'Storm Harbor', 'Copper lanterns', 'scarred left cheek', 'copper braid']) expect(scenePrompt).toContain(detail);
      expect(scenePrompt).not.toContain('Hidden enemy');
      expect(scenePrompt).not.toContain('Untrusted browser scene');
      await tx.execute(sql`update llm_service_settings set provider_type='openrouter',model='qwen/qwen-image-3-pro' where service_id='imageGeneration'`);
      const router = await reserveExplicitImage(tx, { role: 'assistant', projectId, gameId: null, runId: 'assistant-run', callId: 'router-image', prompt: 'A third gate' });
      expect(router.isNew).toBe(true);
      await tx.execute(sql`update llm_service_settings set provider_type='nanogpt',model='z-image-base' where service_id='imageGeneration'`);
      await expect(reserveExplicitImage(tx, { role: 'assistant', projectId, gameId: null, runId: 'assistant-run', callId: 'no-cap', prompt: 'A second gate' })).rejects.toThrow('MYTHENGINE_IMAGE_MAX_COST_USD');
      process.env.MYTHENGINE_IMAGE_MAX_COST_USD = '0.02';
      const nano = await reserveExplicitImage(tx, { role: 'assistant', projectId, gameId: null, runId: 'assistant-run', callId: 'nano-image', prompt: 'A second gate' });
      expect(nano.isNew).toBe(true);
      const [nanoJob] = await tx.execute(sql`select payload from backend_jobs where id=${nano.jobId}`);
      expect(nanoJob.payload).toMatchObject({ model: 'z-image-base', kind: 'assistant_chat' });
      throw rollback;
    })).rejects.toBe(rollback);
    const [project] = await getDb().execute(sql`select id from shelves where id=${projectId}`);
    expect(project).toBeUndefined();
  } finally {
    delete process.env.MYTHENGINE_IMAGE_TEST_KEY;
    if (priorImageCostCap === undefined) delete process.env.MYTHENGINE_IMAGE_MAX_COST_USD;
    else process.env.MYTHENGINE_IMAGE_MAX_COST_USD = priorImageCostCap;
  }
});

afterAll(async () => { if (process.env.MYTHENGINE_IMAGE_INTEGRATION === '1') await closeDb(); });
