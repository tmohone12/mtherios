import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { storyImageExportSchema } from '$lib/contracts/worldDatabase';
import { getDb } from '$lib/server/db/client';
import { importImageAsset, readImageAsset } from './imageAssets';
import { MutationError } from './mutationSafety';
import { currentServerProviderHooks } from '$lib/server/turn/provider';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function recordStoryImageCard(input: {
  projectId: string; gameId: string; jobId: string; runId: string; callId: string;
  tool: 'generateImage' | 'generateFileImage'; assetId: string; applied: boolean;
}) {
  const db = getDb();
  await db.transaction(async tx => {
    const signal = currentServerProviderHooks()?.signal;
    signal?.throwIfAborted();
    const [origin] = await tx.execute(sql`select r.client_turn_id,r.status,r.continuation->'state'->'budget'->>'stopReason' as stop_reason from agent_runs r
      join agent_tool_calls t on t.run_id=r.id and t.call_id=${input.callId}
      join backend_jobs j on j.id=${input.jobId} and j.project_id=r.project_id and j.story_id=r.game_id
      join assets a on a.id=${input.assetId} and a.origin_job_id=j.id and a.project_id=r.project_id and a.game_id=r.game_id
      where r.id=${input.runId} and r.project_id=${input.projectId} and r.game_id=${input.gameId}
        and t.tool=${input.tool} and j.payload->'origin'->>'role'='gm'
        and j.payload->'origin'->>'runId'=r.id and j.payload->'origin'->>'callId'=t.call_id
        and ((t.status='completed' and t.result->>'jobId'=j.id) or t.status='reserved') for update of r`);
    if (!origin) throw new MutationError('SCOPE_DENIED', 'Image job no longer matches its GM tool call.');
    if (origin.status === 'failed' || origin.status === 'cancelled' || origin.stop_reason) return;
    signal?.throwIfAborted();
    await tx.execute(sql`insert into story_image_cards(id,project_id,game_id,client_turn_id,call_id,tool,asset_id,applied)
      values(${`story_image_${randomUUID()}`},${input.projectId},${input.gameId},${origin.client_turn_id},${input.callId},${input.tool},${input.assetId},${input.applied})
      on conflict (game_id,client_turn_id,call_id) do nothing`);
  });
}

export async function recordManualStoryImageCard(input: { projectId: string; gameId: string; clientTurnId: string; callId: string; assetId: string }) {
  const db = getDb();
  const [turn] = await db.execute(sql`select e.id from story_entries e join stories s on s.id=e.story_id
    where s.id=${input.gameId} and s.shelf_id=${input.projectId} and e.type='user_action'
      and e.metadata->>'clientTurnId'=${input.clientTurnId} limit 1`);
  if (!turn) return false;
  await db.execute(sql`insert into story_image_cards(id,project_id,game_id,client_turn_id,call_id,tool,asset_id,applied)
    values(${`story_image_${randomUUID()}`},${input.projectId},${input.gameId},${input.clientTurnId},${input.callId},'generateImage',${input.assetId},false)
    on conflict (game_id,client_turn_id,call_id) do nothing`);
  return true;
}

export async function readStoryImageCardHistory(gameId: string, clientTurnIds: readonly string[]) {
  if (!clientTurnIds.length) return [];
  const ids = [...new Set(clientTurnIds)];
  const rows = await getDb().execute(sql`select c.client_turn_id,c.call_id,c.tool,c.applied,c.project_id,a.id as asset_id,a.usage
    from story_image_cards c join assets a on a.id=c.asset_id and a.project_id=c.project_id and a.game_id=c.game_id
    where c.game_id=${gameId} and c.client_turn_id in (${sql.join(ids.map(id => sql`${id}`),sql`,`)})
      and a.visibility='public' order by c.created_at,c.id limit 1000`);
  return rows.map(row => ({ client_turn_id: String(row.client_turn_id), call_id: String(row.call_id), tool: String(row.tool),
    job_id: null, job_status: 'complete', job_error: null,
    image_result: { assetId: String(row.asset_id), applied: row.applied === true,
      url: `/api/assets/${encodeURIComponent(String(row.asset_id))}?projectId=${encodeURIComponent(String(row.project_id))}&gameId=${encodeURIComponent(gameId)}` },
    image_usage: row.usage ?? null }));
}

export async function exportStoryImageCards(db: Db | Tx, projectId: string, gameId: string) {
  const rows = await db.execute(sql`select c.client_turn_id,c.call_id,c.tool,c.applied,a.id as asset_id,a.visibility
    from story_image_cards c join assets a on a.id=c.asset_id and a.project_id=c.project_id and a.game_id=c.game_id
    where c.project_id=${projectId} and c.game_id=${gameId} and a.visibility='public'
    order by c.created_at,c.id limit 5001`);
  if (rows.length > 5000) throw new MutationError('INVALID_IMAGE', 'Too many story images for one bundle.');
  const result = [];
  for (const row of rows) {
    const { asset, bytes } = await readImageAsset({ projectId, gameId, assetId: String(row.asset_id) });
    result.push({ clientTurnId: row.client_turn_id, callId: row.call_id, tool: row.tool, applied: row.applied,
      asset: { id: asset.id, visibility: 'public', mediaType: asset.media_type, sha256: asset.sha256, bytesBase64: Buffer.from(bytes).toString('base64') } });
  }
  return z.array(storyImageExportSchema).max(5000).parse(result);
}

export async function importStoryImageCards(tx: Tx, input: {
  projectId: string; gameId: string; cards: unknown; createdAssetKeys: string[];
}) {
  const cards = z.array(storyImageExportSchema).max(5000).parse(input.cards);
  const identities = new Set<string>();
  for (const card of cards) {
    const key = `${card.clientTurnId}\0${card.callId}`;
    if (identities.has(key)) throw new MutationError('INVALID_IMAGE', 'Duplicate story image origin in bundle.');
    identities.add(key);
    const [turn] = await tx.execute(sql`select id from story_entries where story_id=${input.gameId}
      and type='user_action' and metadata->>'clientTurnId'=${card.clientTurnId} limit 1`);
    if (!turn) throw new MutationError('INVALID_IMAGE', 'Story image has no matching imported player turn.');
  }
  for (const card of cards) {
    const assetId = await importImageAsset(tx, { projectId: input.projectId, gameId: input.gameId,
      mediaType: card.asset.mediaType, sha256: card.asset.sha256, bytesBase64: card.asset.bytesBase64,
      visibility: 'public', createdKeys: input.createdAssetKeys });
    await tx.execute(sql`insert into story_image_cards(id,project_id,game_id,client_turn_id,call_id,tool,asset_id,applied)
      values(${`story_image_${randomUUID()}`},${input.projectId},${input.gameId},${card.clientTurnId},${card.callId},${card.tool},${assetId},${card.applied})`);
  }
  return cards.length;
}
