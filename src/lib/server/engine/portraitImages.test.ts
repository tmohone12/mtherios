import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { runBackendJobNow } from '$lib/server/jobs/processor';
import { recoverStaleBackendJobs } from '$lib/server/jobs/outbox';
import { processImageJob } from './imageJobs';
import { storeImageAsset } from './imageAssets';
import { reservePortraitImageInTransaction, readPortraitImageStatus } from './portraitImages';

const integration = process.env.MYTHENGINE_IMAGE_INTEGRATION === '1' ? test : test.skip;

integration('reserves a scoped character image using saved appearance and rejects a competing request', async () => {
  const projectId = `shelf_portrait_${randomUUID()}`;
  const gameId = `story_portrait_${randomUUID()}`;
  const characterId = randomUUID();
  const secretId = randomUUID();
  const locationId = randomUUID();
  const rollback = new Error('rollback portrait smoke');
  process.env.MYTHENGINE_IMAGE_TEST_KEY = 'test-key';
  try {
    await expect(getDb().transaction(async tx => {
      await tx.execute(sql`insert into shelves(id,name,slug,settings) values(${projectId},'Portrait smoke',${projectId},
        ${JSON.stringify({ imageStyle: { revision: 3, prompt: 'Copperplate watercolor' } })}::jsonb)`);
      await tx.execute(sql`insert into stories(id,shelf_id,title,settings,current_location_id) values(${gameId},${projectId},'Portrait game',
        ${JSON.stringify({ agentTools: { schemaVersion: 1, revision: 1, overrides: { gmImages: true } } })}::jsonb,${locationId})`);
      await tx.execute(sql`insert into entities(id,story_id,type,name,description,visibility) values(${locationId},${gameId},'location','Storm Harbor','Under copper lanterns','public')`);
      const bio = `Raised beside the lighthouse. ${'She recalls every ship by its painted prow. '.repeat(28)}`;
      await tx.execute(sql`insert into entities(id,story_id,type,name,description,state,metadata,visibility)
        values(${characterId},${gameId},'character','Mira',${bio},
        ${JSON.stringify({ bio: 'Saved lore biography', appearance: 'scarred left cheek', visualDescriptors: { hair: 'copper braid', eyes: 'green' }, presentation: 'naval jacket' })}::jsonb,
        ${JSON.stringify({ background: 'Harbor cartographer' })}::jsonb,'public')`);
      await tx.execute(sql`insert into entities(id,story_id,type,name,visibility) values(${secretId},${gameId},'character','Secret','gm_only')`);
      await tx.execute(sql`update llm_service_settings set provider_type='openai',model='gpt-image-1',api_key_ref='env:MYTHENGINE_IMAGE_TEST_KEY',enabled=true where service_id='imageGeneration'`);
      const input = { projectId, gameId, characterId, callId: 'portrait-call' };
      const queued = await reservePortraitImageInTransaction(tx, input);
      expect(queued).toMatchObject({ isNew: true, styleRevision: 3 });
      expect((await reservePortraitImageInTransaction(tx, input)).jobId).toBe(queued.jobId);
      await expect(reservePortraitImageInTransaction(tx, { ...input, callId: 'other-call' })).rejects.toMatchObject({ code: 'IMAGE_PENDING' });
      await expect(reservePortraitImageInTransaction(tx, { ...input, characterId: secretId })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
      const [job] = await tx.execute(sql`select story_id,payload from backend_jobs where id=${queued.jobId}`);
      expect(job.story_id).toBe(gameId);
      expect(job.payload).toMatchObject({ kind: 'character_portrait', characterId, expectedEntityVersion: queued.expectedEntityVersion, styleRevision: 3 });
      const prompt = String((job.payload as Record<string, unknown>).prompt);
      for (const detail of ['scarred left cheek', 'copper braid', 'green', 'naval jacket', 'Copperplate watercolor'])
        expect(prompt).toContain(detail);
      for (const detail of [bio.trim(), 'Saved lore biography', 'Harbor cartographer', 'Storm Harbor', 'fully covering tunic']) expect(prompt).not.toContain(detail);
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await getDb().execute(sql`select id from shelves where id=${projectId}`))[0]).toBeUndefined();
  } finally {
    delete process.env.MYTHENGINE_IMAGE_TEST_KEY;
  }
});

integration('attaches a seeded portrait asset to canonical character state without provider spend', async () => {
  const projectId = `shelf_portrait_${randomUUID()}`;
  const gameId = `story_portrait_${randomUUID()}`;
  const characterId = randomUUID();
  const jobId = `job_portrait_${randomUUID()}`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  const db = getDb();
  let storageKey: string | null = null;
  try {
    await db.execute(sql`insert into shelves(id,name,slug,settings) values(${projectId},'Portrait completion',${projectId},
      '{"agentTools":{"schemaVersion":1,"revision":1,"overrides":{"gmImages":true}}}'::jsonb)`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Portrait completion game')`);
    await db.execute(sql`insert into entities(id,story_id,type,name,visibility) values(${characterId},${gameId},'character','Mira','public')`);
    const [before] = await db.execute(sql`select server_version from entities where id=${characterId}`);
    await db.execute(sql`insert into backend_jobs(id,project_id,story_id,type,payload,max_attempts) values
      (${jobId},${projectId},${gameId},'generate_image',
       ${JSON.stringify({ kind: 'character_portrait', characterId, expectedEntityVersion: Number(before.server_version), prompt: 'Mira at the harbor', styleRevision: 0 })}::jsonb,1)`);
    const asset = await storeImageAsset({ projectId, gameId, bytes: png, visibility: 'public', originJobId: jobId });
    storageKey = asset.storage_key;
    const processed = await runBackendJobNow(jobId);
    expect(processed.completed).toBe(true);
    const url = `/api/assets/${asset.id}?projectId=${encodeURIComponent(projectId)}&gameId=${encodeURIComponent(gameId)}`;
    expect(processed.result).toMatchObject({ applied: true, assetId: asset.id, url });
    const [after] = await db.execute(sql`select state,server_version from entities where id=${characterId}`);
    expect(after.state).toMatchObject({ portrait: url });
    expect(Number(after.server_version)).toBeGreaterThan(Number(before.server_version));
    const replay = await processImageJob({ id: jobId, projectId, storyId: gameId,
      payload: { kind: 'character_portrait', characterId, expectedEntityVersion: Number(before.server_version), prompt: 'Mira at the harbor', styleRevision: 0 } });
    expect(replay).toMatchObject({ applied: true, assetId: asset.id, url });
    const [afterReplay] = await db.execute(sql`select state,server_version from entities where id=${characterId}`);
    expect(afterReplay.state).toMatchObject({ portrait: url });
    expect(Number(afterReplay.server_version)).toBe(Number(after.server_version));
    const [assetCount] = await db.execute(sql`select count(*)::integer as count from assets where origin_job_id=${jobId}`);
    expect(assetCount.count).toBe(1);
    const uncertainJobId = `job_portrait_uncertain_${randomUUID()}`;
    await db.execute(sql`insert into backend_jobs(id,project_id,story_id,type,payload,status,attempt_count,max_attempts,locked_at,locked_by)
      values(${uncertainJobId},${projectId},${gameId},'generate_image','{"kind":"gm_chat","prompt":"Uncertain provider response"}'::jsonb,
        'running',1,1,now()-interval '2 hours','dead-worker')`);
    await db.execute(sql`update backend_jobs set status='running',attempt_count=1,max_attempts=1,
      locked_at=now()-interval '2 hours',locked_by='dead-worker' where id=${jobId}`);
    expect(await recoverStaleBackendJobs(60_000, gameId)).toBe(2);
    const recovered = await db.execute(sql`select id,status,max_attempts from backend_jobs where id in (${jobId},${uncertainJobId}) order by id`);
    expect(recovered.find(row => row.id === jobId)).toMatchObject({ status: 'retry', max_attempts: 2 });
    expect(recovered.find(row => row.id === uncertainJobId)).toMatchObject({ status: 'failed', max_attempts: 1 });
    expect((await runBackendJobNow(jobId)).completed).toBe(true);
    const [afterRecovery] = await db.execute(sql`select state,server_version from entities where id=${characterId}`);
    expect(afterRecovery.state).toMatchObject({ portrait: url });
    expect(Number(afterRecovery.server_version)).toBe(Number(after.server_version));
    const [afterRecoveryAssetCount] = await db.execute(sql`select count(*)::integer as count from assets where origin_job_id=${jobId}`);
    expect(afterRecoveryAssetCount.count).toBe(1);
    expect(await readPortraitImageStatus({ projectId, gameId, characterId })).toMatchObject({ jobId, status: 'complete', imageResult: { applied: true, url } });
    if (process.env.MYTHENGINE_IMAGE_HTTP_BASE) {
      const response = await fetch(new URL(url, process.env.MYTHENGINE_IMAGE_HTTP_BASE));
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
      const commandUrl = `${process.env.MYTHENGINE_IMAGE_HTTP_BASE}/api/engine/command`;
      const statusResponse = await fetch(commandUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storyId: gameId, command: 'image.portrait.status', args: { projectId, gameId, characterId } }) });
      expect(statusResponse.status).toBe(200);
      expect((await statusResponse.json()).result).toMatchObject({ jobId, status: 'complete', imageResult: { applied: true, url } });
      const denied = await fetch(commandUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storyId: gameId, command: 'image.portrait.status', args: { projectId, gameId: 'another-game', characterId } }) });
      expect((await denied.json()).status).toBe('failed');
    }
  } finally {
    await db.execute(sql`delete from shelves where id=${projectId}`);
    if (storageKey) await unlink(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', storageKey)).catch(() => undefined);
  }
});

afterAll(async () => { if (process.env.MYTHENGINE_IMAGE_INTEGRATION === '1') await closeDb(); });
