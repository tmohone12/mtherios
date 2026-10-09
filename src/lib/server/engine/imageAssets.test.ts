import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { imageMediaType, readImageAsset, selectContentCover, storeImageAsset } from './imageAssets';
import { runBackendJobNow } from '$lib/server/jobs/processor';
import { processImageJob } from './imageJobs';
import { updateContent, writeContentInTransaction } from './content';
import { saveProjectImageStyle } from './imageStyle';
import { getAgentRunHistory, resolveGmRollFilePortrait } from './agentRuns';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');

test('accepts bounded image signatures and rejects arbitrary provider output', () => {
  expect(imageMediaType(png)).toBe('image/png');
  expect(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe('image/jpeg');
  expect(imageMediaType(Buffer.from('RIFF\0\0\0\0WEBP', 'binary'))).toBe('image/webp');
  expect(() => imageMediaType(Buffer.from('<html>'))).toThrow();
  expect(() => imageMediaType(Buffer.alloc(10_000_001))).toThrow();
});

const integration = process.env.MYTHENGINE_IMAGE_INTEGRATION === '1' ? test : test.skip;
integration('stores a scoped image once and rejects stale or cross-scope cover selections', async () => {
  const projectId = 'shelf_f91b2dfe-88d0-4cd4-acfb-8b2474e591a2';
  const gameId = 'story_dad7ef54-ec13-4329-baa3-c5a60fbaec74';
  const typeId = '55803b82-2987-48c4-a649-8e3cc571c2ca';
  const itemId = randomUUID();
  const duplicateId = randomUUID();
  const jobId = randomUUID();
  const assetIds: string[] = [];
  const keys: string[] = [];
  const db = getDb();
  try {
    await db.execute(sql`insert into content_items(id,project_id,game_id,type_id,title,slug,data,visibility) values(${itemId},${projectId},${gameId},${typeId},'Image asset smoke',${`image-smoke-${itemId}`},'{}'::jsonb,'public')`);
    const privateAsset = await storeImageAsset({ projectId, gameId, bytes: png, originJobId: jobId });
    assetIds.push(privateAsset.id); keys.push(privateAsset.storage_key);
    expect((await storeImageAsset({ projectId, gameId, bytes: png, originJobId: jobId })).id).toBe(privateAsset.id);
    expect((await readImageAsset({ projectId, gameId, assetId: privateAsset.id })).bytes).toEqual(png);
    await expect(readImageAsset({ projectId, assetId: privateAsset.id })).rejects.toThrow();
    await expect(readImageAsset({ projectId, gameId: randomUUID(), assetId: privateAsset.id })).rejects.toThrow();
    await expect(selectContentCover({ projectId, gameId, itemId, assetId: privateAsset.id, expectedCoverRevision: 0 })).rejects.toThrow();
    const publicAsset = await storeImageAsset({ projectId, gameId, bytes: png, visibility: 'public' });
    assetIds.push(publicAsset.id); keys.push(publicAsset.storage_key);
    if (process.env.MYTHENGINE_IMAGE_HTTP_BASE) {
      const url = new URL(`/api/assets/${publicAsset.id}`, process.env.MYTHENGINE_IMAGE_HTTP_BASE);
      url.searchParams.set('projectId', projectId); url.searchParams.set('gameId', gameId);
      const served = await fetch(url);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await served.arrayBuffer())).toEqual(png);
      url.searchParams.delete('gameId');
      expect((await fetch(url)).status).toBe(404);
      url.pathname = `/api/assets/${privateAsset.id}`;
      url.searchParams.set('gameId', gameId);
      expect((await fetch(url)).status).toBe(404);
      const previewUrl = new URL(`/api/assets/${privateAsset.id}/preview`, process.env.MYTHENGINE_IMAGE_HTTP_BASE);
      const preview = (origin: string, targetGameId = gameId) => fetch(previewUrl, {
        method: 'POST', headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ projectId, gameId: targetGameId }),
      });
      expect((await preview('https://other.example')).status).toBe(403);
      expect((await preview(previewUrl.origin, randomUUID())).status).toBe(404);
      const authorImage = await preview(previewUrl.origin);
      expect(authorImage.status).toBe(200);
      expect(authorImage.headers.get('cache-control')).toBe('private, no-store');
      expect(Buffer.from(await authorImage.arrayBuffer())).toEqual(png);
    }
    const selected = await selectContentCover({ projectId, gameId, itemId, assetId: publicAsset.id, expectedCoverRevision: 0 });
    expect(selected.item.cover_asset_id).toBe(publicAsset.id);
    expect(selected.item.cover_revision).toBe(1);
    const portraitUrl = `/api/assets/${publicAsset.id}?projectId=${encodeURIComponent(projectId)}&gameId=${encodeURIComponent(gameId)}`;
    expect(await resolveGmRollFilePortrait(db, projectId, gameId, 'Image asset smoke')).toBe(portraitUrl);
    expect(await resolveGmRollFilePortrait(db, projectId, randomUUID(), 'Image asset smoke')).toBeNull();
    await db.execute(sql`insert into content_items(id,project_id,game_id,type_id,title,slug,data,visibility) values(${duplicateId},${projectId},${gameId},${typeId},'Image asset smoke',${`other-smoke-${duplicateId}`},'{}'::jsonb,'public')`);
    expect(await resolveGmRollFilePortrait(db, projectId, gameId, 'Image asset smoke')).toBeNull();
    await db.execute(sql`delete from content_items where id=${duplicateId}`);
    await db.execute(sql`update content_items set visibility='gm' where id=${itemId}`);
    expect(await resolveGmRollFilePortrait(db, projectId, gameId, 'Image asset smoke')).toBeNull();
    await expect(selectContentCover({ projectId, gameId, itemId, assetId: privateAsset.id, expectedCoverRevision: 0 })).rejects.toThrow();
    await expect(selectContentCover({ projectId, itemId, assetId: publicAsset.id, expectedCoverRevision: 1 })).rejects.toThrow();
    const privateCover = await selectContentCover({ projectId, gameId, itemId, assetId: privateAsset.id, expectedCoverRevision: 1 });
    const [type] = await db.execute(sql`select revision from content_types where id=${typeId}`);
    await expect(updateContent({ projectId, gameId, id: itemId, expectedRevision: privateCover.item.revision, expectedTypeRevision: Number(type.revision), changes: { visibility: 'public' } })).rejects.toThrow('public cover');
  } finally {
    await db.execute(sql`delete from content_revisions where target_id=${itemId}`);
    await db.execute(sql`delete from content_items where id=${duplicateId}`);
    await db.execute(sql`delete from content_items where id=${itemId}`);
    for (const id of assetIds) await db.execute(sql`delete from assets where id=${id}`);
    for (const key of keys) await unlink(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', key)).catch(() => undefined);
  }
});

integration('runs a project-only image job from an existing immutable asset without provider spend', async () => {
  const projectId = `shelf_image_${randomUUID()}`;
  const typeId = randomUUID();
  const itemId = randomUUID();
  const jobId = `job_image_${randomUUID()}`;
  const db = getDb();
  let key: string | null = null;
  try {
    await db.execute(sql`insert into shelves(id,name,slug,settings) values(${projectId},'Image job smoke',${projectId},${JSON.stringify({ agentTools: { schemaVersion: 1, revision: 1, overrides: { automaticCovers: true } } })}::jsonb)`);
    await db.execute(sql`insert into content_types(id,project_id,key,extension,name,definition) values(${typeId},${projectId},'smoke','smoke','Smoke','{}'::jsonb)`);
    await db.execute(sql`insert into content_items(id,project_id,type_id,title,slug,data,visibility) values(${itemId},${projectId},${typeId},'Image job smoke','image-job-smoke','{}'::jsonb,'public')`);
    await db.execute(sql`insert into backend_jobs(id,project_id,type,payload,max_attempts) values(${jobId},${projectId},'generate_image',${JSON.stringify({ kind: 'automatic_cover', itemId, expectedCoverRevision: 0, prompt: 'A castle', styleRevision: 0 })}::jsonb,1)`);
    const asset = await storeImageAsset({ projectId, bytes: png, visibility: 'public', originJobId: jobId });
    key = asset.storage_key;
    const result = await runBackendJobNow(jobId);
    expect(result.completed).toBe(true);
    expect(result.result).toMatchObject({ assetId: asset.id, applied: true });
    const [item] = await db.execute(sql`select cover_asset_id,cover_revision from content_items where id=${itemId}`);
    expect(item).toMatchObject({ cover_asset_id: asset.id, cover_revision: 1 });
    const [job] = await db.execute(sql`select status,metadata from backend_jobs where id=${jobId}`);
    expect(job.status).toBe('complete');
    expect(job.metadata).toMatchObject({ imageResult: { assetId: asset.id, applied: true } });
    const replay = await processImageJob({ id: jobId, projectId, storyId: null,
      payload: { kind: 'automatic_cover', itemId, expectedCoverRevision: 0, prompt: 'A castle', styleRevision: 0 } });
    expect(replay).toMatchObject({ assetId: asset.id, applied: true });
    const [afterReplay] = await db.execute(sql`select cover_asset_id,cover_revision from content_items where id=${itemId}`);
    expect(afterReplay).toMatchObject({ cover_asset_id: asset.id, cover_revision: 1 });
    const [assetCount] = await db.execute(sql`select count(*)::integer as count from assets where origin_job_id=${jobId}`);
    expect(assetCount.count).toBe(1);
  } finally {
    await db.execute(sql`delete from content_revisions where target_id=${itemId}`);
    await db.execute(sql`delete from shelves where id=${projectId}`);
    if (key) await unlink(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', key)).catch(() => undefined);
  }
});

integration('records a completed GM chat image on its original turn without a provider call', async () => {
  const projectId = `shelf_chat_${randomUUID()}`;
  const gameId = `story_chat_${randomUUID()}`;
  const runId = `run_chat_${randomUUID()}`;
  const jobId = `job_chat_${randomUUID()}`;
  const clientTurnId = `turn_chat_${randomUUID()}`;
  const callId = 'image-call';
  const db = getDb();
  let key: string | null = null;
  try {
    await db.execute(sql`insert into shelves(id,name,slug,settings) values(${projectId},'Chat image smoke',${projectId},'{"agentTools":{"schemaVersion":1,"revision":1,"overrides":{"gmImages":true}}}'::jsonb)`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Chat image game')`);
    await db.execute(sql`insert into story_entries(id,story_id,type,content,position,metadata,server_version)
      values(${randomUUID()},${gameId},'user_action','Show the castle',1,${JSON.stringify({ clientTurnId })}::jsonb,1)`);
    await db.execute(sql`insert into agent_runs(id,project_id,game_id,client_turn_id,status,request,expires_at)
      values(${runId},${projectId},${gameId},${clientTurnId},'completed','{}'::jsonb,now()+interval '1 day')`);
    await db.execute(sql`insert into backend_jobs(id,project_id,story_id,type,payload,max_attempts)
      values(${jobId},${projectId},${gameId},'generate_image',${JSON.stringify({ kind: 'gm_chat', prompt: 'A castle', styleRevision: 0, origin: { role: 'gm', runId, callId } })}::jsonb,1)`);
    await db.execute(sql`insert into agent_tool_calls(run_id,call_id,tool,args_hash,args,status,result)
      values(${runId},${callId},'generateImage','fixture','{}'::jsonb,'completed',${JSON.stringify({ jobId })}::jsonb)`);
    const asset = await storeImageAsset({ projectId, gameId, bytes: png, visibility: 'public', originJobId: jobId });
    key = asset.storage_key;
    const processed = await runBackendJobNow(jobId);
    expect(processed.completed).toBe(true);
    expect(processed.result).toMatchObject({ assetId: asset.id, url: `/api/assets/${asset.id}?projectId=${encodeURIComponent(projectId)}&gameId=${encodeURIComponent(gameId)}` });
    const history = await getAgentRunHistory({ storyId: gameId, clientTurnIds: [clientTurnId] });
    expect(history.images).toMatchObject([{ client_turn_id: clientTurnId, call_id: callId, job_status: 'complete', image_result: { assetId: asset.id } }]);
    const [count] = await db.execute(sql`select count(*)::integer as count from story_image_cards where game_id=${gameId}`);
    expect(count.count).toBe(1);
    if (process.env.MYTHENGINE_IMAGE_HTTP_BASE) {
      const image = await fetch(new URL(String(processed.result?.url), process.env.MYTHENGINE_IMAGE_HTTP_BASE));
      expect(image.status).toBe(200);
      expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
      const response = await fetch(`${process.env.MYTHENGINE_IMAGE_HTTP_BASE}/api/engine/command`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storyId: gameId, command: 'agent.run.history', args: { storyId: gameId, clientTurnIds: [clientTurnId] } }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { status: string; result: typeof history };
      expect(body.status).toBe('succeeded');
      expect(body.result.images).toMatchObject(history.images);
    }
  } finally {
    await db.execute(sql`delete from shelves where id=${projectId}`);
    if (key) await unlink(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', key)).catch(() => undefined);
  }
});

integration('manual scene image keeps its turn identity through queue, asset and history', async () => {
  const projectId = `shelf_scene_${randomUUID()}`;
  const gameId = `story_scene_${randomUUID()}`;
  const jobId = `job_scene_${randomUUID()}`;
  const clientTurnId = `turn_scene_${randomUUID()}`;
  const callId = 'manual-scene-call';
  const db = getDb();
  let key: string | null = null;
  try {
    await db.execute(sql`insert into shelves(id,name,slug,settings) values(${projectId},'Manual scene smoke',${projectId},'{"agentTools":{"schemaVersion":1,"revision":1,"overrides":{"gmImages":true}}}'::jsonb)`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Manual scene game')`);
    await db.execute(sql`insert into story_entries(id,story_id,type,content,position,metadata,server_version)
      values(${randomUUID()},${gameId},'user_action','Show the gate',1,${JSON.stringify({ clientTurnId })}::jsonb,1)`);
    await db.execute(sql`insert into backend_jobs(id,project_id,story_id,type,payload,max_attempts)
      values(${jobId},${projectId},${gameId},'generate_image',${JSON.stringify({ kind: 'manual_scene', prompt: 'The gate', styleRevision: 0, browserOrigin: { clientTurnId, callId } })}::jsonb,1)`);
    const pending = await getAgentRunHistory({ storyId: gameId, clientTurnIds: [clientTurnId] });
    expect(pending.images).toMatchObject([{ client_turn_id: clientTurnId, call_id: callId, job_status: 'queued' }]);
    const asset = await storeImageAsset({ projectId, gameId, bytes: png, visibility: 'public', originJobId: jobId });
    key = asset.storage_key;
    expect((await runBackendJobNow(jobId)).completed).toBe(true);
    const complete = await getAgentRunHistory({ storyId: gameId, clientTurnIds: [clientTurnId] });
    expect(complete.images).toMatchObject([{ client_turn_id: clientTurnId, call_id: callId, job_status: 'complete', image_result: { assetId: asset.id } }]);
    expect(complete.images).toHaveLength(1);
    const [count] = await db.execute(sql`select count(*)::integer as count from story_image_cards where game_id=${gameId}`);
    expect(count.count).toBe(1);
    if (process.env.MYTHENGINE_IMAGE_HTTP_BASE) {
      const response = await fetch(`${process.env.MYTHENGINE_IMAGE_HTTP_BASE}/api/engine/command`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storyId: gameId, command: 'agent.run.history', args: { clientTurnIds: [clientTurnId] } }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { status: string; result: typeof complete };
      expect(body.status).toBe('succeeded');
      expect(body.result.images).toMatchObject(complete.images);
      const url = String((body.result.images[0].image_result as { url: string }).url);
      const image = await fetch(new URL(url, process.env.MYTHENGINE_IMAGE_HTTP_BASE));
      expect(image.status).toBe(200);
      expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    }
  } finally {
    await db.execute(sql`delete from shelves where id=${projectId}`);
    if (key) await unlink(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', key)).catch(() => undefined);
  }
});

integration('queues one automatic cover with the new document in the same transaction', async () => {
  const projectId = `shelf_image_${randomUUID()}`;
  const typeId = randomUUID();
  const rollback = new Error('rollback image queue smoke');
  process.env.MYTHENGINE_IMAGE_TEST_KEY = 'test-key';
  try {
    await expect(getDb().transaction(async tx => {
      await tx.execute(sql`insert into shelves(id,name,slug,settings) values(${projectId},'Cover queue smoke',${projectId},${JSON.stringify({ agentTools: { schemaVersion: 1, revision: 1, overrides: { automaticCovers: true } }, imageStyle: { revision: 2, prompt: 'Muted watercolor and brass details' } })}::jsonb)`);
      await tx.execute(sql`insert into content_types(id,project_id,key,extension,name,definition) values(${typeId},${projectId},'smoke','smoke','Smoke',${JSON.stringify({ fields: {}, layout: [], defaults: {}, gmContextMode: 'searchable' })}::jsonb)`);
      await tx.execute(sql`update llm_service_settings set provider_type='openai',model='gpt-image-1',api_key_ref='env:MYTHENGINE_IMAGE_TEST_KEY',enabled=true where service_id='imageGeneration'`);
      const created = await writeContentInTransaction(tx, { projectId, typeId, expectedTypeRevision: 1, title: 'A tall citadel', slug: 'tall-citadel', data: {} });
      const jobs = await tx.execute(sql`select story_id,payload,max_attempts from backend_jobs where project_id=${projectId} and type='generate_image'`);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ story_id: null, max_attempts: 1, payload: { itemId: created.item.id, expectedCoverRevision: 0, kind: 'automatic_cover', styleRevision: 2 } });
      expect((jobs[0].payload as { prompt: string }).prompt).toContain('Muted watercolor and brass details');
      throw rollback;
    })).rejects.toBe(rollback);
    const [project] = await getDb().execute(sql`select id from shelves where id=${projectId}`);
    expect(project).toBeUndefined();
  } finally { delete process.env.MYTHENGINE_IMAGE_TEST_KEY; }
});

integration('saves the project image style with revision conflict protection', async () => {
  const projectId = `shelf_image_${randomUUID()}`;
  const db = getDb();
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Image style smoke',${projectId})`);
    expect((await saveProjectImageStyle({ projectId, expectedRevision: 0, prompt: 'Oil paint, candlelight' })).imageStyle).toEqual({ revision: 1, prompt: 'Oil paint, candlelight' });
    await expect(saveProjectImageStyle({ projectId, expectedRevision: 0, prompt: 'Stale replacement' })).rejects.toThrow('changed');
    const [row] = await db.execute(sql`select settings from shelves where id=${projectId}`);
    expect((row.settings as Record<string, unknown>).imageStyle).toEqual({ revision: 1, prompt: 'Oil paint, candlelight' });
  } finally { await db.execute(sql`delete from shelves where id=${projectId}`); }
});

afterAll(async () => { if (process.env.MYTHENGINE_IMAGE_INTEGRATION === '1') await closeDb(); });
