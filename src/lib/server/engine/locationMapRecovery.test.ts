import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '$lib/server/db/client';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { emptyLocationMap } from '$lib/contracts/locationMap';
import { importWorldDatabaseBundle } from '$lib/server/db/worldDatabaseImport';
import { cleanupImportedImageAssets, readImageAsset, storeImageAsset } from './imageAssets';
import { getLocationMap, saveLocationMap } from './locationMaps';

const integration = process.env.MYTHENGINE_MAP_RECOVERY_INTEGRATION === '1' ? test : test.skip;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');

integration('rolls back a replacement after importing map bytes without losing the prior map or image', async () => {
  const db = getDb();
  const projectId = `shelf_map_recovery_${randomUUID()}`;
  const gameId = `story_map_recovery_${randomUUID()}`;
  const otherGameId = `story_map_conflict_${randomUUID()}`;
  const locationId = `entity_map_recovery_${randomUUID()}`;
  const otherEntityId = `entity_map_conflict_${randomUUID()}`;
  const conflictingAliasId = `alias_map_conflict_${randomUUID()}`;
  const assetDirectory = path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets');
  let originalStorageKey: string | null = null;
  try {
    await db.execute(sql`insert into shelves(id,name,slug) values(${projectId},'Map recovery fixture',${projectId})`);
    await db.execute(sql`insert into stories(id,shelf_id,title) values(${gameId},${projectId},'Original map game'),(${otherGameId},${projectId},'Conflict holder')`);
    await db.execute(sql`insert into entities(id,story_id,type,name) values(${locationId},${gameId},'location','Crossroads'),(${otherEntityId},${otherGameId},'character','Other')`);
    await db.execute(sql`insert into entity_aliases(id,story_id,entity_id,alias,normalized_alias) values(${conflictingAliasId},${otherGameId},${otherEntityId},'Conflict','conflict')`);
    const originalAsset = await storeImageAsset({ projectId, gameId, bytes: png, visibility: 'public' });
    originalStorageKey = originalAsset.storage_key;
    const originalMap = { ...emptyLocationMap(), backgroundAssetId: originalAsset.id };
    await saveLocationMap(gameId, { locationId, expectedRevision: 0, map: originalMap, reason: 'Original background.' });
    const [beforeStory] = await db.execute(sql`select server_version from stories where id=${gameId}`);
    const beforeFiles = (await readdir(assetDirectory)).sort();
    const replacementMap = { ...emptyLocationMap(), backgroundAssetId: 'exported-map-asset' };
    const bundle = {
      schemaVersion: 3,
      shelf: { id: projectId, name: 'Map recovery fixture', slug: projectId },
      locationMapAssets: [{ id: 'exported-map-asset', visibility: 'public', mediaType: 'image/png',
        sha256: createHash('sha256').update(png).digest('hex'), bytesBase64: png.toString('base64') }],
      worldDatabase: {
        story: { id: gameId, shelfId: projectId, title: 'Replacement map game' },
        entities: [{ id: locationId, type: 'location', name: 'Crossroads' }],
        locationMaps: [{ locationId, revision: 1, map: replacementMap }],
        locationMapRevisions: [{ locationId, revision: 1, snapshot: replacementMap, actor: { kind: 'import' }, reason: 'Imported map.' }],
        entityAliases: [{ id: conflictingAliasId, entityId: locationId, alias: 'Conflict', normalizedAlias: 'conflict' }],
      },
    };

    await expect(importWorldDatabaseBundle({ bundle, options: { preserveIds: true, replaceExisting: true,
      syncWiki: false, sourceProjectId: projectId, destinationProjectId: projectId } })).rejects.toThrow();

    const [afterStory] = await db.execute(sql`select title,server_version from stories where id=${gameId}`);
    expect(afterStory).toMatchObject({ title: 'Original map game', server_version: beforeStory.server_version });
    expect(await getLocationMap(gameId, { locationId })).toMatchObject({ revision: 1, map: { backgroundAssetId: originalAsset.id } });
    expect(Buffer.from((await readImageAsset({ projectId, gameId, assetId: originalAsset.id })).bytes)).toEqual(png);
    expect((await readdir(assetDirectory)).sort()).toEqual(beforeFiles);
    const [count] = await db.execute(sql`select count(*)::integer as count from assets where game_id=${gameId}`);
    expect(count.count).toBe(1);
  } finally {
    await db.execute(sql`delete from shelves where id=${projectId}`);
    if (originalStorageKey) await cleanupImportedImageAssets([originalStorageKey]);
  }
});

afterAll(async () => { if (process.env.MYTHENGINE_MAP_RECOVERY_INTEGRATION === '1') await closeDb(); });
