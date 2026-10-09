import { randomUUID } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { closeDb, getDb } from '$lib/server/db/client';
import { importWorldDatabaseBundle } from '$lib/server/db/worldDatabaseImport';
import { exportBackendStory } from '$lib/server/memory/canonical';
import { readImageAsset, storeImageAsset } from './imageAssets';
import { migrateGame } from './gameMigration';
import { collectPortraitAssetIds, portraitAssetUrl, remapPortraitAssetUrls } from './portraitAssetPortability';
import { patchWorldRecord } from './worldRecords';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
const integration = process.env.MYTHENGINE_IMAGE_INTEGRATION === '1' ? test : test.skip;

test('only exact generated portrait URLs are collected and remapped inside JSON', () => {
  const id = randomUUID();
  const source = { projectId: 'shelf source', gameId: 'story source' };
  const target = { projectId: 'shelf target', gameId: 'story target' };
  const url = portraitAssetUrl(id, source);
  const data = { state: { portrait: url, external: `https://example.test${url}` }, operations: [{ value: url }] };
  expect([...collectPortraitAssetIds([data], source)]).toEqual([id]);
  const newId = randomUUID();
  expect(remapPortraitAssetUrls(data, source, target, new Map([[id, newId]]))).toEqual({
    state: { portrait: portraitAssetUrl(newId, target), external: data.state.external },
    operations: [{ value: portraitAssetUrl(newId, target) }],
  });
  expect(() => remapPortraitAssetUrls(data, source, target, new Map())).toThrow('missing');
});

integration('exports a generated portrait and remaps current and historical URLs on campaign import', async () => {
  const db = getDb();
  const projectId = `shelf_portrait_export_${randomUUID()}`;
  const gameId = `story_portrait_export_${randomUUID()}`;
  const characterId = randomUUID();
  let copiedProjectId: string | null = null;
  const keys: string[] = [];
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Portrait export',${projectId})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Portrait export game')`);
    await db.execute(sql`insert into entities(id,story_id,type,name,visibility) values(${characterId},${gameId},'character','Mira','public')`);
    const asset = await storeImageAsset({ projectId, gameId, bytes: png, visibility: 'public' });
    keys.push(asset.storage_key);
    const url = portraitAssetUrl(asset.id, { projectId, gameId });
    await patchWorldRecord(gameId, 'characters', characterId,
      { updates: { state: { portrait: url } }, expectedVersion: 1, jsonMode: 'merge', reason: 'Fixture portrait' },
      { role: 'client', id: 'portability-test' });
    const secondAsset = await storeImageAsset({ projectId, gameId, bytes: png, visibility: 'public' });
    keys.push(secondAsset.storage_key);
    const secondUrl = portraitAssetUrl(secondAsset.id, { projectId, gameId });
    const [updated] = await db.execute(sql`select server_version from entities where id=${characterId}`);
    await patchWorldRecord(gameId, 'characters', characterId,
      { updates: { state: { portrait: secondUrl } }, expectedVersion: Number(updated.server_version), jsonMode: 'merge', reason: 'Replace fixture portrait' },
      { role: 'client', id: 'portability-test' });
    const bundle = await exportBackendStory(gameId);
    expect(new Set(bundle.portraitAssets?.map(image => image.id))).toEqual(new Set([asset.id, secondAsset.id]));
    if (process.env.MYTHENGINE_IMAGE_HTTP_BASE) {
      const response = await fetch(`${process.env.MYTHENGINE_IMAGE_HTTP_BASE}/api/export/${encodeURIComponent(gameId)}`);
      expect(response.status).toBe(200);
      expect(new Set((await response.json()).portraitAssets.map((image: { id: string }) => image.id))).toEqual(new Set([asset.id, secondAsset.id]));
    }
    const damaged = structuredClone(bundle);
    damaged.portraitAssets = damaged.portraitAssets!.filter(image => image.id === asset.id);
    const directory = path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets');
    const beforeFiles = await readdir(directory);
    await expect(importWorldDatabaseBundle({ bundle: damaged,
      options: { preserveIds: false, replaceExisting: false, syncWiki: false } })).rejects.toThrow('missing from the bundle');
    expect((await readdir(directory)).sort()).toEqual(beforeFiles.sort());
    const copied = await importWorldDatabaseBundle({ bundle,
      options: { preserveIds: false, replaceExisting: false, syncWiki: false } });
    const [copyProject] = await db.execute(sql`select shelf_id from stories where id=${copied.storyId}`);
    copiedProjectId = String(copyProject.shelf_id);
    const [copy] = await db.execute(sql`select state from entities where story_id=${copied.storyId} and type='character' and name='Mira'`);
    const copiedUrl = String((copy.state as Record<string, unknown>).portrait);
    const copyAssets = await db.execute(sql`select id,storage_key from assets where project_id=${copiedProjectId} and game_id=${copied.storyId}`);
    expect(copyAssets).toHaveLength(2);
    for (const image of copyAssets) {
      keys.push(String(image.storage_key));
      expect(Buffer.from((await readImageAsset({ projectId: copiedProjectId, gameId: copied.storyId, assetId: String(image.id) })).bytes)).toEqual(png);
    }
    expect(copyAssets.map(image => portraitAssetUrl(String(image.id), { projectId: copiedProjectId!, gameId: copied.storyId }))).toContain(copiedUrl);
    const patches = await db.execute(sql`select operations from state_patches where story_id=${copied.storyId} and reason in ('Fixture portrait','Replace fixture portrait')`);
    expect(collectPortraitAssetIds(patches.map(row => row.operations), { projectId: copiedProjectId, gameId: copied.storyId })).toEqual(new Set(copyAssets.map(image => String(image.id))));
    expect(JSON.stringify(patches)).not.toContain(url);
    expect(JSON.stringify(patches)).not.toContain(secondUrl);
  } finally {
    await db.execute(sql`delete from shelves where id in (${projectId},${copiedProjectId ?? projectId})`);
    for (const key of keys) await unlink(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', key)).catch(() => undefined);
  }
});

integration('moving a game rewrites its portrait URL and keeps the asset readable in the destination project', async () => {
  const db = getDb();
  const sourceProject = `shelf_portrait_move_${randomUUID()}`;
  const targetProject = `shelf_portrait_move_${randomUUID()}`;
  const gameId = `story_portrait_move_${randomUUID()}`;
  const characterId = randomUUID();
  let storageKey: string | null = null;
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${sourceProject},'Portrait source',${sourceProject}),(${targetProject},'Portrait target',${targetProject})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${sourceProject},'Portrait move game')`);
    await db.execute(sql`insert into entities(id,story_id,type,name,visibility) values(${characterId},${gameId},'character','Mira','public')`);
    const asset = await storeImageAsset({ projectId: sourceProject, gameId, bytes: png, visibility: 'public' });
    storageKey = asset.storage_key;
    const oldUrl = portraitAssetUrl(asset.id, { projectId: sourceProject, gameId });
    await patchWorldRecord(gameId, 'characters', characterId,
      { updates: { state: { portrait: oldUrl } }, expectedVersion: 1, jsonMode: 'merge', reason: 'Fixture portrait' },
      { role: 'client', id: 'portability-test' });
    const preview = await migrateGame({ projectId: sourceProject, gameId, destinationProjectId: targetProject }, true);
    expect(preview.compatible).toBe(true);
    const moved = await migrateGame({ projectId: sourceProject, gameId, destinationProjectId: targetProject,
      expectedSnapshot: preview.expectedSnapshot });
    expect(moved).toMatchObject({ moved: true });
    const [entity] = await db.execute(sql`select state from entities where id=${characterId}`);
    const newUrl = portraitAssetUrl(asset.id, { projectId: targetProject, gameId });
    expect((entity.state as Record<string, unknown>).portrait).toBe(newUrl);
    expect(Buffer.from((await readImageAsset({ projectId: targetProject, gameId, assetId: asset.id })).bytes)).toEqual(png);
    const [patch] = await db.execute(sql`select operations from state_patches where story_id=${gameId} and reason='Fixture portrait'`);
    expect(JSON.stringify(patch.operations)).toContain(newUrl);
    expect(JSON.stringify(patch.operations)).not.toContain(oldUrl);
  } finally {
    await db.execute(sql`delete from shelves where id in (${sourceProject},${targetProject})`);
    if (storageKey) await unlink(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', storageKey)).catch(() => undefined);
  }
});

afterAll(async () => { if (process.env.MYTHENGINE_IMAGE_INTEGRATION === '1') await closeDb(); });
