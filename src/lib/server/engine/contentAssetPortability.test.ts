import { createHash, randomUUID } from 'node:crypto';
import { access, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '$lib/server/db/client';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import type { ContentItem, ContentType } from '$lib/contracts/content';
import { exportContent, history, importContent, restoreContentHistory, saveContentType, updateContent } from './content';
import { readImageAsset, selectContentCover, storeImageAsset } from './imageAssets';
import { migrateGame } from './gameMigration';
import { exportBackendStory } from '$lib/server/memory/canonical';
import { importWorldDatabaseBundle } from '$lib/server/db/worldDatabaseImport';
import { getAgentRunHistory } from './agentRuns';

const integration = process.env.MYTHENGINE_IMAGE_INTEGRATION === '1' ? test : test.skip;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
async function liveCommand(storyId: string, name: string, args: unknown) {
  const response = await fetch(`${process.env.MYTHENGINE_IMAGE_HTTP_BASE}/api/engine/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storyId, command: name, args }),
  });
  const body = await response.json() as { status: string; result: unknown };
  expect(response.status).toBe(200);
  expect(body.status).toBe('succeeded');
  return body.result;
}

integration('exports scoped cover bytes and imports a remapped, verified image without orphan files on conflict', async () => {
  const db = getDb();
  const sourceProject = `shelf_portable_${randomUUID()}`;
  const targetProject = `shelf_portable_${randomUUID()}`;
  const sourceGame = `story_portable_${randomUUID()}`;
  const targetGame = `story_portable_${randomUUID()}`;
  const typeId = randomUUID();
  const itemId = randomUUID();
  const keys: string[] = [];
  const assetDirectory = path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets');
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${sourceProject},'Source portability',${sourceProject}),(${targetProject},'Target portability',${targetProject})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${sourceGame},${sourceProject},'Source game'),(${targetGame},${targetProject},'Target game')`);
    await db.execute(sql`insert into content_types(id,project_id,key,extension,name,definition) values(${typeId},${sourceProject},'portrait','monster','Portrait','{"fields":{},"layout":[],"defaults":{},"gmContextMode":"searchable"}'::jsonb)`);
    await db.execute(sql`insert into content_items(id,project_id,game_id,type_id,title,slug,data,visibility) values(${itemId},${sourceProject},${sourceGame},${typeId},'Goblin','goblin','{}'::jsonb,'public')`);
    const sourceAsset = await storeImageAsset({ projectId: sourceProject, gameId: sourceGame, bytes: png, visibility: 'public' });
    keys.push(sourceAsset.storage_key);
    await selectContentCover({ projectId: sourceProject, gameId: sourceGame, itemId, assetId: sourceAsset.id, expectedCoverRevision: 0 });

    const bundle = await exportContent({ projectId: sourceProject, gameId: sourceGame });
    expect(bundle.assets).toEqual([{ id: sourceAsset.id, gameId: sourceGame, visibility: 'public', mediaType: 'image/png', sha256: createHash('sha256').update(png).digest('hex'), bytesBase64: png.toString('base64') }]);
    expect(bundle.items.find(item => item.id === itemId)).toMatchObject({ coverAssetId: sourceAsset.id, coverRevision: 1 });
    let imported: Awaited<ReturnType<typeof importContent>>;
    if (process.env.MYTHENGINE_IMAGE_HTTP_BASE) {
      const liveBundle = await liveCommand(sourceGame, 'content.export', { projectId: sourceProject, gameId: sourceGame });
      expect((liveBundle as typeof bundle).assets).toEqual(bundle.assets);
      imported = await liveCommand(targetGame, 'content.import', { projectId: targetProject, gameId: targetGame, bundle: liveBundle }) as typeof imported;
    } else imported = await importContent({ projectId: targetProject, gameId: targetGame, bundle });
    const mappedAssetId = imported.assetIds[sourceAsset.id];
    expect(mappedAssetId).toBeTruthy();
    expect(mappedAssetId).not.toBe(sourceAsset.id);
    const [target] = await db.execute(sql`select cover_asset_id,cover_revision from content_items where id=${imported.itemIds[itemId]}`);
    expect(target).toMatchObject({ cover_asset_id: mappedAssetId, cover_revision: 1 });
    const copied = await readImageAsset({ projectId: targetProject, gameId: targetGame, assetId: mappedAssetId });
    keys.push(copied.asset.storage_key);
    expect(Buffer.from(copied.bytes)).toEqual(png);
    await expect(readImageAsset({ projectId: sourceProject, gameId: sourceGame, assetId: mappedAssetId })).rejects.toThrow();

    const [targetType] = await db.execute(sql`select id from content_types where project_id=${targetProject} and key='portrait'`);
    await db.execute(sql`delete from content_items where id=${imported.itemIds[itemId]}`);
    await db.execute(sql`insert into content_items(id,project_id,game_id,type_id,title,slug,data,visibility) values(${randomUUID()},${targetProject},${targetGame},${targetType.id},'Conflict','goblin','{}'::jsonb,'public')`);
    const before = await readdir(assetDirectory);
    await expect(importContent({ projectId: targetProject, gameId: targetGame, bundle })).rejects.toThrow('conflicts');
    expect(await readdir(assetDirectory)).toEqual(before);
    const [count] = await db.execute(sql`select count(*)::integer as count from assets where project_id=${targetProject}`);
    expect(count.count).toBe(1);

    const wrongScope = structuredClone(bundle);
    wrongScope.assets![0].gameId = randomUUID();
    await expect(importContent({ projectId: targetProject, gameId: targetGame, bundle: wrongScope })).rejects.toThrow();
    const damaged = structuredClone(bundle);
    damaged.assets![0].sha256 = '0'.repeat(64);
    await expect(importContent({ projectId: targetProject, gameId: targetGame, bundle: damaged })).rejects.toThrow('integrity');
  } finally {
    await db.execute(sql`delete from shelves where id in (${sourceProject},${targetProject})`);
    for (const key of keys) await unlink(path.join(assetDirectory, key)).catch(() => undefined);
  }
});

integration('keeps prior cover assets and remaps retained document revisions on import', async () => {
  const db = getDb();
  const sourceProject = `shelf_history_${randomUUID()}`;
  const targetProject = `shelf_history_${randomUUID()}`;
  const sourceGame = `story_history_${randomUUID()}`;
  const targetGame = `story_history_${randomUUID()}`;
  const reusedTypeGame = `story_history_${randomUUID()}`;
  const typeId = randomUUID();
  const itemId = randomUUID();
  const keys: string[] = [];
  const assetDirectory = path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets');
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${sourceProject},'History source',${sourceProject}),(${targetProject},'History target',${targetProject})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${sourceGame},${sourceProject},'History source'),(${targetGame},${targetProject},'History target'),(${reusedTypeGame},${targetProject},'History reused type')`);
    await db.transaction(async tx => {
      const [type] = await tx.execute(sql`insert into content_types(id,project_id,key,extension,name,definition)
        values(${typeId},${sourceProject},'portrait','monster','Portrait','{"fields":{},"layout":[],"defaults":{},"gmContextMode":"searchable"}'::jsonb) returning *`);
      await history(tx, 'type', type as unknown as ContentType, 'Create type');
      const [item] = await tx.execute(sql`insert into content_items(id,project_id,game_id,type_id,title,slug,data,visibility)
        values(${itemId},${sourceProject},${sourceGame},${typeId},'Goblin','goblin','{}'::jsonb,'public') returning *`);
      await history(tx, 'item', item as unknown as ContentItem, 'Create document', 1);
    });
    await saveContentType({ projectId: sourceProject, id: typeId, expectedRevision: 1, key: 'portrait', extension: 'monster',
      name: 'Portrait Archive', definition: { fields: {}, layout: [], defaults: {}, gmContextMode: 'searchable' } });
    const oldAsset = await storeImageAsset({ projectId: sourceProject, gameId: sourceGame, bytes: png, visibility: 'public' });
    keys.push(oldAsset.storage_key);
    await selectContentCover({ projectId: sourceProject, gameId: sourceGame, itemId, assetId: oldAsset.id, expectedCoverRevision: 0 });
    const newAsset = await storeImageAsset({ projectId: sourceProject, gameId: sourceGame, bytes: png, visibility: 'public' });
    keys.push(newAsset.storage_key);
    await selectContentCover({ projectId: sourceProject, gameId: sourceGame, itemId, assetId: newAsset.id, expectedCoverRevision: 1 });
    await updateContent({ projectId: sourceProject, gameId: sourceGame, id: itemId, expectedRevision: 3, expectedTypeRevision: 2,
      changes: { title: 'Goblin King' } });
    const bundle = await exportContent({ projectId: sourceProject, gameId: sourceGame });
    expect(bundle.assets?.map(asset => asset.id).sort()).toEqual([oldAsset.id, newAsset.id].sort());
    expect(bundle.revisions?.filter(row => row.targetKind === 'item').map(row => row.revision)).toEqual([1, 2, 3, 4]);
    const forged = structuredClone(bundle);
    const oldCover = forged.revisions?.find(row => row.targetKind === 'item' && row.revision === 2);
    if (!oldCover) throw new Error('Historical cover fixture is missing.');
    oldCover.snapshot.cover_asset_id = randomUUID();
    const filesBeforeReject = await readdir(assetDirectory);
    await expect(importContent({ projectId: targetProject, gameId: targetGame, bundle: forged })).rejects.toThrow('Historical cover');
    expect(await readdir(assetDirectory)).toEqual(filesBeforeReject);
    const mismatched = structuredClone(bundle);
    mismatched.items.find(item => item.id === itemId)!.title = 'Forged current title';
    await expect(importContent({ projectId: targetProject, gameId: targetGame, bundle: mismatched })).rejects.toThrow('retained revision snapshot');
    const imported = process.env.MYTHENGINE_IMAGE_HTTP_BASE
      ? await liveCommand(targetGame, 'content.import', { projectId: targetProject, gameId: targetGame,
          bundle: await liveCommand(sourceGame, 'content.export', { projectId: sourceProject, gameId: sourceGame }) }) as Awaited<ReturnType<typeof importContent>>
      : await importContent({ projectId: targetProject, gameId: targetGame, bundle });
    const rows = await db.execute(sql`select revision,snapshot from content_revisions where project_id=${targetProject} and target_kind='item' and target_id=${imported.itemIds[itemId]} order by revision`);
    expect(rows.map(row => row.revision)).toEqual([1, 2, 3, 4]);
    const typeRows = await db.execute(sql`select revision,snapshot from content_revisions where project_id=${targetProject} and target_kind='type' and target_id=${imported.typeIds[typeId]} order by revision`);
    expect(typeRows.map(row => row.revision)).toEqual([1, 2]);
    expect(typeRows[0].snapshot).toMatchObject({ id: imported.typeIds[typeId], project_id: targetProject, name: 'Portrait' });
    const reused = await importContent({ projectId: targetProject, gameId: reusedTypeGame, bundle });
    expect(reused.typeIds[typeId]).toBe(imported.typeIds[typeId]);
    expect(reused.skippedTypeHistory).toEqual([typeId]);
    const reusedRows = await db.execute(sql`select revision from content_revisions where target_kind='item' and target_id=${reused.itemIds[itemId]} order by revision`);
    expect(reusedRows.map(row => row.revision)).toEqual([1, 2, 3, 4]);
    for (const id of [oldAsset.id, newAsset.id]) {
      const reusedAsset = await readImageAsset({ projectId: targetProject, gameId: reusedTypeGame, assetId: reused.assetIds[id] });
      keys.push(reusedAsset.asset.storage_key);
    }
    expect(rows[1].snapshot).toMatchObject({ id: imported.itemIds[itemId], project_id: targetProject, game_id: targetGame,
      type_id: imported.typeIds[typeId], cover_asset_id: imported.assetIds[oldAsset.id] });
    expect(rows[2].snapshot).toMatchObject({ cover_asset_id: imported.assetIds[newAsset.id] });
    const [current] = await db.execute(sql`select revision,cover_asset_id from content_items where id=${imported.itemIds[itemId]}`);
    expect(current).toMatchObject({ revision: 4, cover_asset_id: imported.assetIds[newAsset.id] });
    const restoreRequest = { projectId: targetProject, gameId: targetGame, targetKind: 'item' as const,
      id: imported.itemIds[itemId], targetRevision: 1, expectedRevision: 4 };
    const preview = await restoreContentHistory(restoreRequest, true);
    expect(preview).toMatchObject({ compatible: true, changes: [{ field: 'title', from: 'Goblin King', to: 'Goblin' }] });
    await restoreContentHistory({ ...restoreRequest, expectedSnapshot: preview.expectedSnapshot, confirmed: true });
    const [restoredTitle] = await db.execute(sql`select title,revision,cover_asset_id from content_items where id=${imported.itemIds[itemId]}`);
    expect(restoredTitle).toMatchObject({ title: 'Goblin', revision: 5, cover_asset_id: imported.assetIds[newAsset.id] });
    const typeRestore = { projectId: targetProject, targetKind: 'type' as const, id: imported.typeIds[typeId], targetRevision: 1, expectedRevision: 2 };
    const typePreview = await restoreContentHistory(typeRestore, true);
    expect(typePreview).toMatchObject({ compatible: true, changes: [{ field: 'name', from: 'Portrait Archive', to: 'Portrait' }] });
    await restoreContentHistory({ ...typeRestore, expectedSnapshot: typePreview.expectedSnapshot, confirmed: true });
    const [restoredType] = await db.execute(sql`select name,revision from content_types where id=${imported.typeIds[typeId]}`);
    expect(restoredType).toMatchObject({ name: 'Portrait', revision: 3 });
    for (const id of [oldAsset.id, newAsset.id]) {
      const restored = await readImageAsset({ projectId: targetProject, gameId: targetGame, assetId: imported.assetIds[id] });
      keys.push(restored.asset.storage_key);
      expect(Buffer.from(restored.bytes)).toEqual(png);
    }
  } finally {
    await db.execute(sql`delete from shelves where id in (${sourceProject},${targetProject})`);
    for (const key of keys) await unlink(path.join(assetDirectory, key)).catch(() => undefined);
  }
});

integration('moves a game and its cover asset to another project without losing the image', async () => {
  const db = getDb();
  const sourceProject = `shelf_move_${randomUUID()}`;
  const targetProject = `shelf_move_${randomUUID()}`;
  const gameId = `story_move_${randomUUID()}`;
  const typeId = randomUUID();
  const itemId = randomUUID();
  const sharedItemId = randomUUID();
  let key: string | null = null;
  const sharedKeys: string[] = [];
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${sourceProject},'Move source',${sourceProject}),(${targetProject},'Move target',${targetProject})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${sourceProject},'Move game')`);
    await db.execute(sql`insert into content_types(id,project_id,key,extension,name,definition) values(${typeId},${sourceProject},'portrait','monster','Portrait','{"fields":{},"layout":[],"defaults":{},"gmContextMode":"searchable"}'::jsonb)`);
    await db.execute(sql`insert into content_items(id,project_id,game_id,type_id,title,slug,data,visibility) values(${itemId},${sourceProject},${gameId},${typeId},'Goblin','goblin','{}'::jsonb,'public')`);
    await db.execute(sql`insert into content_items(id,project_id,type_id,title,slug,data,visibility) values(${sharedItemId},${sourceProject},${typeId},'Bestiary','bestiary','{}'::jsonb,'public')`);
    const priorAsset = await storeImageAsset({ projectId: sourceProject, gameId, bytes: png, visibility: 'public' });
    sharedKeys.push(priorAsset.storage_key);
    await selectContentCover({ projectId: sourceProject, gameId, itemId, assetId: priorAsset.id, expectedCoverRevision: 0 });
    const asset = await storeImageAsset({ projectId: sourceProject, gameId, bytes: png, visibility: 'public' });
    key = asset.storage_key;
    await selectContentCover({ projectId: sourceProject, gameId, itemId, assetId: asset.id, expectedCoverRevision: 1 });
    const sharedAsset = await storeImageAsset({ projectId: sourceProject, bytes: png, visibility: 'public' });
    sharedKeys.push(sharedAsset.storage_key);
    await selectContentCover({ projectId: sourceProject, itemId: sharedItemId, assetId: sharedAsset.id, expectedCoverRevision: 0 });
    const chatAsset = await storeImageAsset({ projectId: sourceProject, gameId, bytes: png, visibility: 'public' });
    sharedKeys.push(chatAsset.storage_key);
    await db.execute(sql`insert into story_entries(id,story_id,type,content,position,metadata,server_version)
      values(${randomUUID()},${gameId},'user_action','Show the cover',1,'{"clientTurnId":"image-move-turn"}'::jsonb,1)`);
    await db.execute(sql`insert into story_image_cards(id,project_id,game_id,client_turn_id,call_id,tool,asset_id,applied)
      values(${`story_image_${randomUUID()}`},${sourceProject},${gameId},'image-move-turn','image-move-call','generateImage',${chatAsset.id},false)`);
    const preview = await migrateGame({ projectId: sourceProject, gameId, destinationProjectId: targetProject, sharedItemIds: [sharedItemId] }, true);
    expect(preview.compatible).toBe(true);
    expect(preview.counts.storyImages).toBe(1);
    const result = await migrateGame({ projectId: sourceProject, gameId, destinationProjectId: targetProject, sharedItemIds: [sharedItemId], expectedSnapshot: preview.expectedSnapshot });
    if (!('moved' in result)) throw new Error('Game move returned only a preview.');
    expect(result.moved).toBe(true);
    const [moved] = await db.execute(sql`select project_id,type_id,cover_asset_id from content_items where id=${itemId}`);
    expect(moved).toMatchObject({ project_id: targetProject, cover_asset_id: asset.id });
    expect(Buffer.from((await readImageAsset({ projectId: targetProject, gameId, assetId: asset.id })).bytes)).toEqual(png);
    expect(Buffer.from((await readImageAsset({ projectId: targetProject, gameId, assetId: priorAsset.id })).bytes)).toEqual(png);
    const [priorRevision] = await db.execute(sql`select snapshot from content_revisions where target_kind='item' and target_id=${itemId} and revision=2`);
    expect(priorRevision.snapshot).toMatchObject({ project_id: targetProject, type_id: moved.type_id, cover_asset_id: priorAsset.id });
    const movedBundle = await exportContent({ projectId: targetProject, gameId });
    expect(movedBundle.assets?.map(image => image.id)).toContain(priorAsset.id);
    await expect(readImageAsset({ projectId: sourceProject, gameId, assetId: asset.id })).rejects.toThrow();
    const [copiedShared] = await db.execute(sql`select cover_asset_id from content_items where id=${result.sharedIds[sharedItemId]}`);
    expect(copiedShared.cover_asset_id).not.toBe(sharedAsset.id);
    const copiedSharedAsset = await readImageAsset({ projectId: targetProject, assetId: String(copiedShared.cover_asset_id) });
    sharedKeys.push(copiedSharedAsset.asset.storage_key);
    expect(Buffer.from(copiedSharedAsset.bytes)).toEqual(png);
    const movedHistory = await getAgentRunHistory({ storyId: gameId, clientTurnIds: ['image-move-turn'] });
    expect(movedHistory.images).toMatchObject([{ call_id: 'image-move-call', job_status: 'complete' }]);
    expect(String((movedHistory.images[0].image_result as { url: string }).url)).toContain(`projectId=${targetProject}`);
    expect(Buffer.from((await readImageAsset({ projectId: targetProject, gameId, assetId: chatAsset.id })).bytes)).toEqual(png);
  } finally {
    await db.execute(sql`delete from shelves where id in (${sourceProject},${targetProject})`);
    if (key) await unlink(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', key)).catch(() => undefined);
    for (const sharedKey of sharedKeys) await unlink(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', sharedKey)).catch(() => undefined);
  }
});

integration('campaign export and import restore a covered document with a new asset identity', async () => {
  const db = getDb();
  const projectId = `shelf_bundle_${randomUUID()}`;
  const gameId = `story_bundle_${randomUUID()}`;
  const typeId = randomUUID();
  const itemId = randomUUID();
  const keys: string[] = [];
  let copiedProjectId: string | null = null;
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Bundle portability',${projectId})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Bundle game')`);
    await db.execute(sql`insert into content_types(id,project_id,key,extension,name,definition) values(${typeId},${projectId},'portrait','monster','Portrait','{"fields":{},"layout":[],"defaults":{},"gmContextMode":"searchable"}'::jsonb)`);
    await db.execute(sql`insert into content_items(id,project_id,game_id,type_id,title,slug,data,visibility) values(${itemId},${projectId},${gameId},${typeId},'Goblin','goblin','{}'::jsonb,'public')`);
    const sourceAsset = await storeImageAsset({ projectId, gameId, bytes: png, visibility: 'public' });
    keys.push(sourceAsset.storage_key);
    await selectContentCover({ projectId, gameId, itemId, assetId: sourceAsset.id, expectedCoverRevision: 0 });
    const chatAsset = await storeImageAsset({ projectId, gameId, bytes: png, visibility: 'public' });
    keys.push(chatAsset.storage_key);
    await db.execute(sql`insert into story_entries(id,story_id,type,content,position,metadata,server_version)
      values(${randomUUID()},${gameId},'user_action','Show the goblin',1,'{"clientTurnId":"image-portability-turn"}'::jsonb,1)`);
    await db.execute(sql`insert into story_image_cards(id,project_id,game_id,client_turn_id,call_id,tool,asset_id,applied)
      values(${`story_image_${randomUUID()}`},${projectId},${gameId},'image-portability-turn','image-portability-call','generateImage',${chatAsset.id},false)`);
    const bundle = await exportBackendStory(gameId);
    expect(bundle.authoredContent?.assets).toHaveLength(1);
    expect(bundle.storyImages).toMatchObject([{ clientTurnId: 'image-portability-turn', callId: 'image-portability-call', asset: { id: chatAsset.id, bytesBase64: png.toString('base64') } }]);
    await db.execute(sql`delete from stories where id=${gameId}`);
    const badBundle = structuredClone(bundle);
    badBundle.storyImages![0].clientTurnId = 'missing-turn';
    const assetDirectory = path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets');
    const before = await readdir(assetDirectory);
    await expect(importWorldDatabaseBundle({ bundle: badBundle, options: { preserveIds: true, replaceExisting: false, syncWiki: false, sourceProjectId: projectId, destinationProjectId: projectId } })).rejects.toThrow('matching imported player turn');
    expect(await readdir(assetDirectory)).toEqual(before);
    const restored = await importWorldDatabaseBundle({ bundle, options: { preserveIds: true, replaceExisting: false, syncWiki: false, sourceProjectId: projectId, destinationProjectId: projectId } });
    expect(restored.storyId).toBe(gameId);
    const [document] = await db.execute(sql`select cover_asset_id from content_items where game_id=${gameId} and slug='goblin'`);
    expect(document.cover_asset_id).not.toBe(sourceAsset.id);
    const imported = await readImageAsset({ projectId, gameId, assetId: String(document.cover_asset_id) });
    keys.push(imported.asset.storage_key);
    expect(Buffer.from(imported.bytes)).toEqual(png);
    const history = await getAgentRunHistory({ storyId: gameId, clientTurnIds: ['image-portability-turn'] });
    expect(history.images).toMatchObject([{ client_turn_id: 'image-portability-turn', call_id: 'image-portability-call', job_status: 'complete' }]);
    const restoredChatId = String((history.images[0].image_result as { assetId: string }).assetId);
    expect(restoredChatId).not.toBe(chatAsset.id);
    const restoredChat = await readImageAsset({ projectId, gameId, assetId: restoredChatId });
    keys.push(restoredChat.asset.storage_key);
    expect(Buffer.from(restoredChat.bytes)).toEqual(png);
    await importWorldDatabaseBundle({ bundle, options: { preserveIds: true, replaceExisting: true, syncWiki: false, sourceProjectId: projectId, destinationProjectId: projectId } });
    await expect(access(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', imported.asset.storage_key))).rejects.toThrow();
    await expect(access(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', restoredChat.asset.storage_key))).rejects.toThrow();
    const [replacement] = await db.execute(sql`select cover_asset_id from content_items where game_id=${gameId} and slug='goblin'`);
    const replacementAsset = await readImageAsset({ projectId, gameId, assetId: String(replacement.cover_asset_id) });
    keys.push(replacementAsset.asset.storage_key);
    expect(Buffer.from(replacementAsset.bytes)).toEqual(png);
    const copied = await importWorldDatabaseBundle({ bundle, options: { preserveIds: false, replaceExisting: false, syncWiki: false } });
    expect(copied.storyId).not.toBe(gameId);
    const [copyProject] = await db.execute(sql`select shelf_id from stories where id=${copied.storyId}`);
    copiedProjectId = String(copyProject.shelf_id);
    expect(copiedProjectId).not.toBe(projectId);
    const copiedHistory = await getAgentRunHistory({ storyId: copied.storyId, clientTurnIds: ['image-portability-turn'] });
    expect(copiedHistory.images).toMatchObject([{ call_id: 'image-portability-call', job_status: 'complete' }]);
    const copiedChatId = String((copiedHistory.images[0].image_result as { assetId: string }).assetId);
    const copiedChat = await readImageAsset({ projectId: copiedProjectId, gameId: copied.storyId, assetId: copiedChatId });
    keys.push(copiedChat.asset.storage_key);
    expect(Buffer.from(copiedChat.bytes)).toEqual(png);
    const [copiedDocument] = await db.execute(sql`select cover_asset_id from content_items where game_id=${copied.storyId} and slug='goblin'`);
    const copiedCover = await readImageAsset({ projectId: copiedProjectId, gameId: copied.storyId, assetId: String(copiedDocument.cover_asset_id) });
    keys.push(copiedCover.asset.storage_key);
  } finally {
    await db.execute(sql`delete from shelves where id in (${projectId},${copiedProjectId ?? projectId})`);
    for (const key of keys) await unlink(path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', key)).catch(() => undefined);
  }
});

afterAll(async () => { if (process.env.MYTHENGINE_IMAGE_INTEGRATION === '1') await closeDb(); });
