import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { getAgentSettings } from './agentSettings';
import { resolveServiceGeneration } from './llmSettings';
import { findImageAssetForJob, selectContentCover, storeImageAsset } from './imageAssets';
import { generateOpenAiImage } from './imageProvider';
import { MutationError } from './mutationSafety';
import { recordManualStoryImageCard, recordStoryImageCard } from './storyImageCards';
import { patchWorldRecord } from './worldRecords';
import { generateSceneImagePrompt, sceneImageContextSchema } from './sceneImagePrompt';
import { stableJobId } from '$lib/server/jobs/outbox';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const imageJobPayload = z.object({
  kind: z.enum(['automatic_cover', 'explicit_cover', 'gm_chat', 'assistant_chat', 'manual_scene', 'character_portrait']),
  execution: z.literal('api').optional(),
  prompt: z.string().trim().min(1).max(8000),
  sceneContext: sceneImageContextSchema.optional(),
  sceneStyle: z.string().max(800).optional(),
  scenePromptPrepared: z.boolean().optional(),
  itemId: z.string().min(1).max(200).optional(),
  expectedCoverRevision: z.number().int().min(0).optional(),
  styleRevision: z.number().int().min(0).default(0),
  model: z.string().min(1).max(200).optional(),
  characterId: z.string().min(1).max(200).optional(),
  expectedEntityVersion: z.number().int().nonnegative().optional(),
  callId: z.string().min(1).max(200).optional(),
  origin: z.object({ role: z.enum(['gm', 'assistant']), runId: z.string().min(1).max(200), callId: z.string().min(1).max(200), conversationId: z.string().min(1).max(200).optional() }).strict().optional(),
  browserOrigin: z.object({ clientTurnId: z.string().min(1).max(200), callId: z.string().min(1).max(200) }).strict().optional(),
}).strict();

/** Reuse image receipts/history without publishing work to the queue. */
export async function reserveDirectImageRequest(tx: Tx, input: {
  projectId: string; storyId: string | null; dedupeKey: string; payload: Record<string, unknown>;
}) {
  const jobId = stableJobId(input.storyId ?? `project:${input.projectId}`, 'generate_image', input.dedupeKey);
  const payload = imageJobPayload.parse({ ...input.payload, execution: 'api' });
  const [reserved] = await tx.execute(sql`insert into backend_jobs(id,project_id,story_id,type,payload,status,attempt_count,max_attempts,locked_at,locked_by)
    values(${jobId},${input.projectId},${input.storyId},'generate_image',${JSON.stringify(payload)}::jsonb,'running',1,1,now(),'image-api')
    on conflict(id) do update set payload=backend_jobs.payload || jsonb_build_object('execution','api'),status='running',attempt_count=1,max_attempts=1,
      locked_at=now(),locked_by='image-api',updated_at=now()
      where backend_jobs.status in ('queued','retry') returning id`);
  return { jobId, isNew: Boolean(reserved) };
}

/** Await prompt preparation, provider transport and canonical attachment in the API call. */
export async function completeDirectImageRequest(receipt: { jobId: string; isNew: boolean }) {
  const [row] = await getDb().execute(sql`select project_id,story_id,payload,status,last_error,metadata from backend_jobs where id=${receipt.jobId}`);
  if (!row) throw new MutationError('SCOPE_DENIED', 'Image request not found.');
  if (!receipt.isNew) {
    if (row.status === 'complete') return { status: 'complete' as const, jobId: receipt.jobId, imageResult: (row.metadata as Record<string, unknown>).imageResult };
    throw new MutationError(row.status === 'failed' ? 'IMAGE_FAILED' : 'IMAGE_PENDING',
      row.status === 'failed' ? String(row.last_error ?? 'Image request failed. Start a new request to retry.') : 'This image request is already in progress.');
  }
  try {
    const imageResult = await processImageJob({ id: receipt.jobId, projectId: String(row.project_id),
      storyId: typeof row.story_id === 'string' ? row.story_id : null, payload: row.payload as Record<string, unknown> });
    if (!('assetId' in imageResult)) throw new MutationError('IMAGE_TARGET_CHANGED', `Image target is unavailable: ${imageResult.reason}`);
    await getDb().execute(sql`update backend_jobs set status='complete',last_error=null,locked_at=null,locked_by=null,updated_at=now()
      where id=${receipt.jobId} and locked_by='image-api'`);
    return { status: 'complete' as const, jobId: receipt.jobId, imageResult };
  } catch (error) {
    await getDb().execute(sql`update backend_jobs set status='failed',last_error=${error instanceof Error ? error.message : String(error)},
      locked_at=null,locked_by=null,updated_at=now() where id=${receipt.jobId} and locked_by='image-api'`);
    throw error;
  }
}

export async function processImageJob(job: { id: string; projectId: string; storyId: string | null; payload: Record<string, unknown> }) {
  const payload = imageJobPayload.parse(job.payload);
  const scope = { projectId: job.projectId, ...(job.storyId ? { gameId: job.storyId } : {}) };
  const settings = await getAgentSettings(scope);
  const gate = payload.kind === 'automatic_cover' ? settings.effective.automaticCovers
    : payload.kind === 'assistant_chat' ? settings.effective.assistantImages : settings.effective.gmImages;
  if (!gate) throw new MutationError('IMAGE_DISABLED', 'Image generation is disabled for this project or chat.');
  const isCover = payload.kind === 'automatic_cover' || payload.kind === 'explicit_cover';
  if (isCover && (!payload.itemId || payload.expectedCoverRevision === undefined)) throw new MutationError('INVALID_IMAGE', 'Cover jobs require a document and expected cover revision.');
  let asset = await findImageAssetForJob(scope, job.id);
  const isPortrait = payload.kind === 'character_portrait';
  let portraitAlreadyApplied = false;
  if (isPortrait) {
    if (!job.storyId || !payload.characterId || payload.expectedEntityVersion === undefined) throw new MutationError('INVALID_IMAGE', 'Portrait jobs require a character and expected revision.');
    const [character] = await getDb().execute(sql`select e.server_version,e.visibility,e.state from entities e join stories s on s.id=e.story_id
      where e.id=${payload.characterId} and e.story_id=${job.storyId} and e.type='character' and s.shelf_id=${job.projectId}`);
    if (!character || !['public', 'player_known'].includes(String(character.visibility))) throw new MutationError('SCOPE_DENIED', 'The portrait character is unavailable.');
    const assetUrl = asset ? `/api/assets/${asset.id}?projectId=${encodeURIComponent(job.projectId)}&gameId=${encodeURIComponent(job.storyId)}` : null;
    portraitAlreadyApplied = Boolean(assetUrl && Number(character.server_version) > payload.expectedEntityVersion &&
      character.state && typeof character.state === 'object' && !Array.isArray(character.state) && (character.state as Record<string, unknown>).portrait === assetUrl);
    if (Number(character.server_version) !== payload.expectedEntityVersion && !portraitAlreadyApplied)
      throw new MutationError('REVISION_CONFLICT', 'The character changed before portrait generation. Request a new portrait.');
  }
  if (payload.kind === 'manual_scene') {
    if (!job.storyId || !payload.browserOrigin) throw new MutationError('INVALID_IMAGE', 'Scene jobs require a game turn origin.');
    const [turn] = await getDb().execute(sql`select id from story_entries where story_id=${job.storyId} and type='user_action' and metadata->>'clientTurnId'=${payload.browserOrigin.clientTurnId} limit 1`);
    if (!turn) return { applied: false, reason: 'turn_unavailable' };
  }
  // GM chat images are requested by the player and must render in that game's chat.
  let visibility: 'gm' | 'public' = payload.kind === 'gm_chat' || payload.kind === 'manual_scene' || isPortrait ? 'public' : 'gm';
  let coverAlreadyApplied = false;
  if (isCover) {
    const [item] = await getDb().execute(sql`select visibility,cover_revision,cover_asset_id from content_items where id=${payload.itemId!} and project_id=${job.projectId} and game_id is not distinct from ${job.storyId} and deleted_at is null`);
    if (!item) return { applied: false, reason: 'document_unavailable' };
    coverAlreadyApplied = Boolean(asset && item.cover_asset_id === asset.id && Number(item.cover_revision) === payload.expectedCoverRevision! + 1);
    if (Number(item.cover_revision) !== payload.expectedCoverRevision && !coverAlreadyApplied) return { applied: false, reason: 'cover_changed' };
    visibility = item.visibility === 'public' ? 'public' : 'gm';
  }
  if (!asset) {
    const resolved = await resolveServiceGeneration('imageGeneration');
    if (resolved.missingReason || !resolved.profile || !resolved.setting?.model) throw new MutationError('IMAGE_UNAVAILABLE', resolved.missingReason ?? 'Configure an image generation model first.');
    if (!['openai', 'nanogpt', 'openrouter'].includes(resolved.profile.providerType)) throw new MutationError('IMAGE_UNAVAILABLE', 'The configured image service provider is unsupported.');
    if (payload.model && resolved.setting.model !== payload.model) throw new MutationError('IMAGE_UNAVAILABLE', 'The image model changed after this request. Create a new request with the current profile.');
    if (payload.sceneContext && !payload.scenePromptPrepared) {
      const prepared = await generateSceneImagePrompt(payload.sceneContext, payload.sceneStyle ?? '');
      payload.prompt = prepared.prompt;
      payload.scenePromptPrepared = true;
      await getDb().execute(sql`update backend_jobs set payload=${JSON.stringify(payload)}::jsonb,
        metadata=metadata || jsonb_build_object('scenePromptAgent',${JSON.stringify({ participantIds: prepared.participantIds, model: prepared.model, usage: prepared.usage })}::jsonb)
        where id=${job.id} and project_id=${job.projectId}`);
    }
    const generated = await generateOpenAiImage({
      apiKey: resolved.profile.apiKey, model: resolved.setting.model, prompt: payload.prompt,
      baseUrl: resolved.profile.baseUrl, provider: resolved.profile.providerType as 'openai' | 'nanogpt' | 'openrouter',
      maxCostUsd: Number(process.env.MYTHENGINE_IMAGE_MAX_COST_USD),
    });
    asset = await storeImageAsset({ ...scope, bytes: generated.bytes, visibility, originJobId: job.id,
      provider: resolved.profile.providerType, model: resolved.setting.model,
      promptStyleRevision: payload.styleRevision, usage: generated.usage ?? undefined });
  }
  let applied = false;
  let reason: string | null = null;
  const assetUrl = asset.visibility === 'public' ? `/api/assets/${asset.id}?projectId=${encodeURIComponent(job.projectId)}${job.storyId ? `&gameId=${encodeURIComponent(job.storyId)}` : ''}` : null;
  if (isCover) {
    if (coverAlreadyApplied) applied = true;
    else {
      try {
        await selectContentCover({ ...scope, itemId: payload.itemId!, assetId: asset.id, expectedCoverRevision: payload.expectedCoverRevision! });
        applied = true;
      } catch (error) {
        if (!(error instanceof MutationError) || !['REVISION_CONFLICT', 'SCOPE_DENIED'].includes(error.code)) throw error;
        reason = 'cover_changed';
      }
    }
  }
  if (isPortrait && assetUrl) {
    if (portraitAlreadyApplied) applied = true;
    else {
      try {
        await patchWorldRecord(job.storyId!, 'characters', payload.characterId!, {
          updates: { state: { portrait: assetUrl } }, expectedVersion: payload.expectedEntityVersion!,
          jsonMode: 'merge', reason: 'Generated character portrait',
        }, { role: 'client', id: `image-job:${job.id}` });
        applied = true;
      } catch (error) {
        if (!(error instanceof MutationError) || error.code !== 'REVISION_CONFLICT') throw error;
        reason = 'character_changed';
      }
    }
  }
  const result = { assetId: asset.id, applied, ...(reason ? { reason } : {}),
    ...(assetUrl ? { url: assetUrl } : {}) };
  await getDb().execute(sql`update backend_jobs set metadata=metadata || jsonb_build_object('imageResult',${JSON.stringify(result)}::jsonb) where id=${job.id} and project_id=${job.projectId}`);
  if (payload.origin?.role === 'gm' && job.storyId && asset.visibility === 'public' && (payload.kind === 'gm_chat' || payload.kind === 'explicit_cover'))
    await recordStoryImageCard({ projectId: job.projectId, gameId: job.storyId, jobId: job.id,
      runId: payload.origin.runId, callId: payload.origin.callId,
      tool: payload.kind === 'gm_chat' ? 'generateImage' : 'generateFileImage', assetId: asset.id, applied });
  if (payload.kind === 'manual_scene' && payload.browserOrigin && job.storyId && asset.visibility === 'public')
    await recordManualStoryImageCard({ projectId: job.projectId, gameId: job.storyId, clientTurnId: payload.browserOrigin.clientTurnId,
      callId: payload.browserOrigin.callId, assetId: asset.id });
  return result;
}
