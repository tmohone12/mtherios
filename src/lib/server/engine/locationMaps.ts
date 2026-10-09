import { and, desc, eq, inArray } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { emptyLocationMap, locationMapBodySchema, locationMapGetSchema, locationMapSaveSchema } from '$lib/contracts/locationMap';
import { getDb } from '$lib/server/db/client';
import { assets, entities, locationMapRevisions, locationMaps, stories } from '$lib/server/db/schema';
import { enqueueStoryVaultSyncJob } from '$lib/server/jobs/outbox';

async function requireLocation(db: ReturnType<typeof getDb>, storyId: string, locationId: string) {
  const [location] = await db.select().from(entities).where(and(eq(entities.storyId, storyId), eq(entities.id, locationId), eq(entities.type, 'location'))).limit(1);
  if (!location || location.status !== 'active') throw new Error('Active location not found in this game.');
  return location;
}

export async function getLocationMap(storyId: string, raw: z.input<typeof locationMapGetSchema>) {
  const { locationId } = locationMapGetSchema.parse(raw);
  const db = getDb();
  await requireLocation(db, storyId, locationId);
  const [story] = await db.select({ projectId: stories.shelfId }).from(stories).where(eq(stories.id, storyId)).limit(1);
  if (!story) throw new Error('Game not found.');
  const [row] = await db.select().from(locationMaps).where(and(eq(locationMaps.storyId, storyId), eq(locationMaps.locationId, locationId))).limit(1);
  const map = row ? locationMapBodySchema.parse(row.map) : emptyLocationMap();
  const backgrounds = await db.select({ id: assets.id, mediaType: assets.mediaType, createdAt: assets.createdAt }).from(assets)
    .where(and(eq(assets.projectId, story.projectId), eq(assets.gameId, storyId), eq(assets.visibility, 'public')))
    .orderBy(desc(assets.createdAt)).limit(50);
  if (map.backgroundAssetId && !backgrounds.some(asset => asset.id === map.backgroundAssetId)) {
    const [selected] = await db.select({ id: assets.id, mediaType: assets.mediaType, createdAt: assets.createdAt }).from(assets)
      .where(and(eq(assets.id, map.backgroundAssetId), eq(assets.projectId, story.projectId), eq(assets.gameId, storyId), eq(assets.visibility, 'public'))).limit(1);
    if (selected) backgrounds.push(selected);
  }
  return { locationId, projectId: story.projectId, revision: row?.revision ?? 0, map, backgrounds };
}

export async function listLocationMapHistory(storyId: string, raw: z.input<typeof locationMapGetSchema>) {
  const { locationId } = locationMapGetSchema.parse(raw);
  const db = getDb();
  await requireLocation(db, storyId, locationId);
  const rows = await db.select({ revision: locationMapRevisions.revision, reason: locationMapRevisions.reason,
    createdAt: locationMapRevisions.createdAt, actor: locationMapRevisions.actor }).from(locationMapRevisions)
    .innerJoin(locationMaps, eq(locationMaps.locationId, locationMapRevisions.locationId))
    .where(and(eq(locationMaps.storyId, storyId), eq(locationMapRevisions.locationId, locationId)))
    .orderBy(desc(locationMapRevisions.revision)).limit(50);
  return { locationId, revisions: rows };
}

export async function saveLocationMap(storyId: string, raw: z.input<typeof locationMapSaveSchema>, actor: Record<string, unknown> = { kind: 'user' }) {
  const args = locationMapSaveSchema.parse(raw);
  return getDb().transaction(async tx => {
    const [story] = await tx.select().from(stories).where(eq(stories.id, storyId)).for('update').limit(1);
    if (!story) throw new Error('Game not found.');
    await requireLocation(tx as ReturnType<typeof getDb>, storyId, args.locationId);
    const [current] = await tx.select().from(locationMaps).where(eq(locationMaps.locationId, args.locationId)).limit(1);
    if (typeof actor.runId === 'string' && typeof actor.callId === 'string') {
      const prior = await tx.select().from(locationMapRevisions).where(eq(locationMapRevisions.locationId, args.locationId)).orderBy(desc(locationMapRevisions.revision)).limit(50);
      const repeat = prior.find(row => {
        const savedActor = row.actor as Record<string, unknown>;
        return savedActor.runId === actor.runId && savedActor.callId === actor.callId;
      });
      if (repeat) {
        if (!isDeepStrictEqual(repeat.snapshot, args.map)) throw new Error('This map call ID was already used for different geometry.');
        return { locationId: args.locationId, revision: repeat.revision, map: args.map, unchanged: true };
      }
    }
    if ((current?.revision ?? 0) !== args.expectedRevision) throw new Error('The map changed since it was opened. Reload it before saving.');
    if (args.map.backgroundAssetId) {
      const [background] = await tx.select().from(assets).where(and(eq(assets.id, args.map.backgroundAssetId), eq(assets.projectId, story.shelfId))).limit(1);
      if (!background || background.gameId !== storyId || background.visibility !== 'public') throw new Error('Map background must be a public image from this game.');
    }
    const links = [...args.map.regions, ...args.map.pins].filter(object => object.locationId);
    const targets = [...new Set([...links.map(object => object.locationId as string), ...args.map.tokens.map(object => object.entityId).filter((value): value is string => !!value)])];
    if (targets.length) {
      const entitiesById = new Map((await tx.select().from(entities).where(and(eq(entities.storyId, storyId), inArray(entities.id, targets)))).map(row => [row.id, row]));
      for (const object of links) {
        const target = entitiesById.get(object.locationId as string);
        if (!target || target.type !== 'location' || target.status !== 'active') throw new Error('Linked map locations must be active places in this game.');
        if (object.visibility === 'public' && !['public', 'player_known'].includes(target.visibility)) throw new Error('A public map object cannot reveal a hidden location.');
      }
      for (const token of args.map.tokens) {
        if (!token.entityId) continue;
        const target = entitiesById.get(token.entityId);
        if (!target || target.status !== 'active') throw new Error('Linked map tokens must reference active entities in this game.');
        if (token.visibility === 'public' && !['public', 'player_known'].includes(target.visibility)) throw new Error('A public map token cannot reveal a hidden entity.');
      }
    }
    if (current && isDeepStrictEqual(current.map, args.map)) return { locationId: args.locationId, revision: current.revision, map: args.map, unchanged: true };
    const revision = (current?.revision ?? 0) + 1;
    const now = new Date().toISOString();
    if (current) await tx.update(locationMaps).set({ map: args.map, revision, updatedAt: now }).where(eq(locationMaps.locationId, args.locationId));
    else await tx.insert(locationMaps).values({ locationId: args.locationId, storyId, map: args.map, revision, createdAt: now, updatedAt: now });
    await tx.insert(locationMapRevisions).values({ locationId: args.locationId, revision, snapshot: args.map, actor, reason: args.reason, createdAt: now });
    await tx.update(stories).set({ serverVersion: story.serverVersion + 1, updatedAt: now }).where(eq(stories.id, storyId));
    await enqueueStoryVaultSyncJob({ storyId, serverVersion: story.serverVersion + 1, reason: 'location-map-edit' }, tx);
    return { locationId: args.locationId, revision, map: args.map, unchanged: false };
  });
}

const restoreSchema = locationMapGetSchema.extend({ expectedRevision: z.number().int().min(1), fromRevision: z.number().int().min(1) }).strict();
export async function restoreLocationMap(storyId: string, raw: z.input<typeof restoreSchema>) {
  const args = restoreSchema.parse(raw);
  const [row] = await getDb().select({ snapshot: locationMapRevisions.snapshot }).from(locationMapRevisions)
    .innerJoin(locationMaps, eq(locationMaps.locationId, locationMapRevisions.locationId))
    .where(and(eq(locationMaps.storyId, storyId), eq(locationMapRevisions.locationId, args.locationId), eq(locationMapRevisions.revision, args.fromRevision))).limit(1);
  if (!row) throw new Error('Map revision not found in this game.');
  return saveLocationMap(storyId, { locationId: args.locationId, expectedRevision: args.expectedRevision,
    map: locationMapBodySchema.parse(row.snapshot), reason: `Restore map revision ${args.fromRevision}.` });
}
