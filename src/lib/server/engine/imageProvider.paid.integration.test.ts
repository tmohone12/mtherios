import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { getDb } from '$lib/server/db/client';
import { runBackendJobNow } from '$lib/server/jobs/processor';
import { configuredImageModel } from './imageRequests';
import { resolveApiKeyRef } from './llmSettings';

const paid = process.env.MYTHENGINE_IMAGE_PAID_INTEGRATION === '1' ? test : test.skip;

paid('generates and attaches one real provider image to a disposable cover under a $0.01 cap', async () => {
  const db = getDb();
  const [original] = await db.execute(sql`select model,enabled,api_key_ref from llm_service_settings where service_id='imageGeneration'`);
  expect(original).toBeDefined();
  expect(resolveApiKeyRef(String(original.api_key_ref ?? ''))).not.toBe('');
  expect(Number(process.env.MYTHENGINE_IMAGE_MAX_COST_USD)).toBe(0.01);
  const projectId = `shelf_paid_image_${randomUUID()}`;
  const typeId = randomUUID();
  const itemId = randomUUID();
  const jobId = `job_paid_image_${randomUUID()}`;
  let storageKey: string | null = null;
  try {
    await db.execute(sql`update llm_service_settings set model='playground-v25',enabled=true where service_id='imageGeneration'`);
    await db.execute(sql`insert into shelves(id,name,slug,settings) values(${projectId},'Disposable image qualification',${projectId},'{"agentTools":{"schemaVersion":1,"revision":1,"overrides":{"automaticCovers":true}}}'::jsonb)`);
    await db.execute(sql`insert into content_types(id,project_id,key,extension,name,definition) values(${typeId},${projectId},'qualification','qualification','Qualification','{}'::jsonb)`);
    await db.execute(sql`insert into content_items(id,project_id,type_id,title,slug,data,visibility) values(${itemId},${projectId},${typeId},'Disposable cover','disposable-cover','{}'::jsonb,'public')`);
    const selected = await db.transaction(tx => configuredImageModel(tx));
    expect(selected).toBe('playground-v25');
    await db.execute(sql`insert into backend_jobs(id,project_id,type,payload,max_attempts) values(${jobId},${projectId},'generate_image',${JSON.stringify({ kind: 'automatic_cover', itemId, expectedCoverRevision: 0, prompt: 'A simple blue lighthouse on a plain white background, no text', styleRevision: 0, model: selected })}::jsonb,1)`);
    const started = Date.now();
    const processed = await runBackendJobNow(jobId);
    const [job] = await db.execute(sql`select status,last_error,metadata from backend_jobs where id=${jobId}`);
    expect(processed.completed, JSON.stringify({ jobStatus: job?.status, error: job?.last_error })).toBe(true);
    expect(processed.result).toMatchObject({ applied: true });
    const [item] = await db.execute(sql`select cover_asset_id,cover_revision from content_items where id=${itemId}`);
    expect(item.cover_revision).toBe(1);
    expect(item.cover_asset_id).toBe(processed.result?.assetId);
    const [asset] = await db.execute(sql`select storage_key,media_type,byte_size,usage from assets where id=${item.cover_asset_id}`);
    storageKey = String(asset.storage_key);
    expect(Number(asset.byte_size)).toBeGreaterThan(100);
    expect((asset.usage as Record<string, unknown>).estimatedCostUsd).toBeLessThanOrEqual(0.01);
    const url = new URL(`/api/assets/${item.cover_asset_id}?projectId=${encodeURIComponent(projectId)}`, 'http://127.0.0.1:5174');
    const served = await fetch(url);
    expect(served.status).toBe(200);
    expect((await served.arrayBuffer()).byteLength).toBe(Number(asset.byte_size));
    console.log(JSON.stringify({ phase: 10, provider: 'nanogpt', model: selected, jobStatus: job.status, assetMediaType: asset.media_type, assetBytes: asset.byte_size, usage: asset.usage, elapsedMs: Date.now() - started }));
  } finally {
    try {
      const [stored] = await db.execute(sql`select storage_key from assets where origin_job_id=${jobId}`);
      if (stored) storageKey = String(stored.storage_key);
      await db.execute(sql`delete from shelves where id=${projectId}`);
    } finally {
      await db.execute(sql`update llm_service_settings set model=${original.model},enabled=${original.enabled} where service_id='imageGeneration'`);
    }
    if (storageKey) await unlink(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', storageKey)).catch(() => undefined);
  }
});
