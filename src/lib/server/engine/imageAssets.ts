import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { getDb } from '$lib/server/db/client';
import { MutationError } from './mutationSafety';
import { history } from './content';
import type { ContentItem } from '$lib/contracts/content';
import { currentServerProviderHooks } from '$lib/server/turn/provider';

const MAX_IMAGE_BYTES = 10_000_000;
const storageKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)$/;
type MediaType = 'image/png' | 'image/jpeg' | 'image/webp';
type AssetRow = { id: string; project_id: string; game_id: string | null; storage_key: string; media_type: MediaType; byte_size: number; sha256: string; visibility: 'gm' | 'public'; origin_job_id: string | null };
type AssetScope = { projectId: string; gameId?: string };
export type ImageRunOrigin = { role: 'gm' | 'assistant'; runId: string; conversationId?: string };
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Lock the authorizing run before attaching an image; immutable paid receipts may remain unattached. */
export async function assertImageOriginActive(tx: Pick<Db, 'execute'>, input: AssetScope & { origin?: ImageRunOrigin }): Promise<void> {
  const signal = currentServerProviderHooks()?.signal;
  signal?.throwIfAborted();
  if (!input.origin) return;
  const [run] = input.origin.role === 'gm'
    ? await tx.execute(sql`select status,continuation->'state'->'budget'->>'stopReason' as stop_reason from agent_runs
        where id=${input.origin.runId} and project_id=${input.projectId} and game_id=${input.gameId ?? ''} for update`)
    : await tx.execute(sql`select r.status,r.result->'runtime'->'budget'->>'stopReason' as stop_reason from assistant_runs r
        join assistant_conversations c on c.id=r.conversation_id where r.id=${input.origin.runId}
          and r.conversation_id=${input.origin.conversationId ?? ''} and c.project_id=${input.projectId}
          and c.game_id is not distinct from ${input.gameId ?? null} for update of r`);
  if (!run) throw new MutationError('SCOPE_DENIED', 'Image run is unavailable in this project and game.');
  if (!['running', 'awaiting_input', 'committing', 'completed'].includes(String(run.status)) || run.stop_reason)
    throw new MutationError('IMAGE_CANCELLED', 'The originating run stopped before image attachment.');
  signal?.throwIfAborted();
}

export function imageMediaType(bytes: Uint8Array): MediaType {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new MutationError('INVALID_IMAGE', 'Image size must be between 1 and 10 MB.');
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new MutationError('INVALID_IMAGE', 'Only PNG, JPEG, and WebP images are supported.');
}

function assetPath(key: string): string {
  if (!storageKey.test(key)) throw new MutationError('INVALID_IMAGE', 'Invalid stored image key.');
  return path.join(getMtheriosAppConfig().dataRoot, 'uploads', 'assets', key);
}

async function assertScope(scope: AssetScope): Promise<void> {
  const db = getDb();
  const [project] = await db.execute(sql`select id from shelves where id=${scope.projectId}`);
  if (!project) throw new MutationError('SCOPE_DENIED', 'Project was not found.');
  if (scope.gameId) {
    const [game] = await db.execute(sql`select id from stories where id=${scope.gameId} and shelf_id=${scope.projectId}`);
    if (!game) throw new MutationError('SCOPE_DENIED', 'Game was not found in this project.');
  }
}

export async function findImageAssetForJob(scope: AssetScope, jobId: string): Promise<AssetRow | null> {
  const [row] = await getDb().execute(sql`select * from assets where origin_job_id=${jobId} and project_id=${scope.projectId} and game_id is not distinct from ${scope.gameId ?? null}`);
  return row as AssetRow | undefined ?? null;
}

/** Store provider bytes under an opaque immutable key, then publish the scoped database record. */
export async function storeImageAsset(input: AssetScope & {
  bytes: Uint8Array; visibility?: 'gm' | 'public'; originJobId?: string;
  provider?: string; model?: string; promptStyleRevision?: number; usage?: Record<string, unknown>;
}): Promise<AssetRow> {
  const mediaType = imageMediaType(input.bytes);
  if (input.originJobId) {
    const existing = await findImageAssetForJob(input, input.originJobId);
    if (existing) return existing;
  }
  await assertScope(input);
  const usage = input.usage === undefined ? null : JSON.stringify(input.usage);
  if (usage && usage.length > 16_000) throw new MutationError('INVALID_IMAGE', 'Image usage receipt is too large.');
  const id = randomUUID();
  const key = `${id}.${mediaType === 'image/png' ? 'png' : mediaType === 'image/jpeg' ? 'jpg' : 'webp'}`;
  const file = assetPath(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, input.bytes, { flag: 'wx' });
  try {
    const [row] = await getDb().execute(sql`insert into assets(id,project_id,game_id,storage_key,media_type,byte_size,sha256,visibility,origin_job_id,provider,model,prompt_style_revision,usage)
      values(${id},${input.projectId},${input.gameId ?? null},${key},${mediaType},${input.bytes.byteLength},${createHash('sha256').update(input.bytes).digest('hex')},${input.visibility ?? 'gm'},${input.originJobId ?? null},${input.provider ?? null},${input.model ?? null},${input.promptStyleRevision ?? null},${usage}::jsonb) returning *`);
    return row as AssetRow;
  } catch (error) {
    await unlink(file).catch(() => undefined);
    if (input.originJobId) {
      const existing = await findImageAssetForJob(input, input.originJobId);
      if (existing) return existing;
    }
    throw error;
  }
}

export async function readImageAsset(scope: AssetScope & { assetId: string }): Promise<{ asset: AssetRow; bytes: Uint8Array }> {
  await assertScope(scope);
  const [row] = await getDb().execute(sql`select * from assets where id=${scope.assetId} and project_id=${scope.projectId} and game_id is not distinct from ${scope.gameId ?? null}`);
  if (!row) throw new MutationError('SCOPE_DENIED', 'Image was not found in the selected project and game.');
  const asset = row as AssetRow;
  const bytes = await readFile(assetPath(asset.storage_key));
  if (bytes.byteLength !== asset.byte_size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
    throw new MutationError('INVALID_IMAGE', 'Stored image failed its integrity check.');
  return { asset, bytes };
}

/** Import files are tracked by the owning transaction wrapper for cleanup on rollback. */
export async function importImageAsset(tx: Tx, input: AssetScope & {
  mediaType: MediaType; sha256: string; bytesBase64: string; visibility: 'gm' | 'public'; createdKeys: string[];
}): Promise<string> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bytesBase64))
    throw new MutationError('INVALID_IMAGE', 'Imported image is not canonical base64.');
  const bytes = Buffer.from(input.bytesBase64, 'base64');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (imageMediaType(bytes) !== input.mediaType || digest !== input.sha256 || bytes.toString('base64') !== input.bytesBase64)
    throw new MutationError('INVALID_IMAGE', 'Imported image failed its media or integrity check.');
  const id = randomUUID();
  const key = `${id}.${input.mediaType === 'image/png' ? 'png' : input.mediaType === 'image/jpeg' ? 'jpg' : 'webp'}`;
  const file = assetPath(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: 'wx' });
  input.createdKeys.push(key);
  await tx.execute(sql`insert into assets(id,project_id,game_id,storage_key,media_type,byte_size,sha256,visibility)
    values(${id},${input.projectId},${input.gameId ?? null},${key},${input.mediaType},${bytes.length},${digest},${input.visibility})`);
  return id;
}

export async function cleanupImportedImageAssets(keys: readonly string[]): Promise<void> {
  await Promise.all(keys.map(async key => { try { await unlink(assetPath(key)); } catch { /* File may already be absent. */ } }));
}

/** A stale generated cover cannot replace a later human selection. */
export async function selectContentCover(input: AssetScope & { itemId: string; assetId: string | null; expectedCoverRevision: number; actor?: Record<string, unknown>; origin?: ImageRunOrigin }): Promise<{ item: ContentItem }> {
  if (!Number.isSafeInteger(input.expectedCoverRevision) || input.expectedCoverRevision < 0) throw new MutationError('REVISION_REQUIRED', 'Read the current cover revision first.');
  return getDb().transaction(async tx => {
    await assertImageOriginActive(tx, input);
    const [item] = await tx.execute(sql`select i.*,t.revision as type_revision from content_items i join content_types t on t.id=i.type_id where i.id=${input.itemId} and i.project_id=${input.projectId} and i.game_id is not distinct from ${input.gameId ?? null} for update of i`);
    if (!item || item.deleted_at) throw new MutationError('SCOPE_DENIED', 'Document was not found in the selected project and game.');
    if (Number(item.cover_revision) !== input.expectedCoverRevision) throw new MutationError('REVISION_CONFLICT', 'The cover changed. Reload it before selecting another image.');
    if (input.assetId) {
      const [asset] = await tx.execute(sql`select id,visibility from assets where id=${input.assetId} and project_id=${input.projectId} and game_id is not distinct from ${input.gameId ?? null}`);
      if (!asset || (item.visibility === 'public' && asset.visibility !== 'public')) throw new MutationError('SCOPE_DENIED', 'The image is unavailable for this document.');
    }
    const [saved] = await tx.execute(sql`update content_items set cover_asset_id=${input.assetId},cover_revision=cover_revision+1,revision=revision+1,updated_at=now() where id=${input.itemId} returning *`);
    await history(tx, 'item', saved as unknown as ContentItem, 'Select document cover', Number(item.type_revision), input.actor ?? { role: 'client', id: 'local-client' });
    return { item: saved as unknown as ContentItem };
  });
}
