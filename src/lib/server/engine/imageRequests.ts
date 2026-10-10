import { sql } from 'drizzle-orm';
import { readProjectImageStyle, styledImagePrompt } from '$lib/contracts/imageStyle';
import { resolveAgentSettings } from '$lib/contracts/agentTools';
import { getDb } from '$lib/server/db/client';
import { completeDirectImageRequest, reserveDirectImageRequest } from './imageJobs';
import { readAgentDocument } from './agentSettings';
import { resolveApiKeyRef } from './llmSettings';
import { isImageProfile } from './imageProvider';
import { sceneCharacterState } from './sceneImagePrompt';
import { MutationError } from './mutationSafety';
import { imageTaskSetting } from './modelSettings';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type ExplicitImageRequest = {
  role: 'gm' | 'assistant'; projectId: string; gameId: string | null;
  runId: string; callId: string; conversationId?: string;
  prompt: string; fileName?: string;
};

export async function configuredImageModel(tx: Tx): Promise<string> {
  const profile = await imageTaskSetting(tx);
  if (!profile || profile.enabled === false || !['openai', 'nanogpt', 'openrouter'].includes(String(profile.provider_type)) ||
    typeof profile.model !== 'string' || !isImageProfile(String(profile.provider_type), profile.model) ||
    !resolveApiKeyRef(typeof profile.api_key_ref === 'string' ? profile.api_key_ref : null))
    throw new MutationError('IMAGE_UNAVAILABLE', 'Configure an enabled image generation service and key before requesting an image.');
  const maxImageCostUsd = Number(process.env.MYTHENGINE_IMAGE_MAX_COST_USD);
  if (profile.provider_type === 'nanogpt' && !(Number.isFinite(maxImageCostUsd) && maxImageCostUsd > 0))
    throw new MutationError('IMAGE_UNAVAILABLE', 'Set MYTHENGINE_IMAGE_MAX_COST_USD before requesting NanoGPT images.');
  return profile.model;
}

/** Reserve a direct image request under the tool's transaction; transport follows after commit. */
export async function reserveExplicitImage(tx: Tx, request: ExplicitImageRequest) {
  if (!request.prompt.trim() || request.prompt.length > 1000) throw new MutationError('INVALID_IMAGE', 'Image prompt must be 1–1,000 characters.');
  if (request.fileName && (request.role !== 'gm' || !request.gameId)) throw new MutationError('TOOL_DENIED', 'Only a game GM can remake a file cover.');
  const [project] = await tx.execute(sql`select settings from shelves where id=${request.projectId}`);
  if (!project) throw new MutationError('SCOPE_DENIED', 'Project not found.');
  const [game] = request.gameId ? await tx.execute(sql`select settings from stories where id=${request.gameId} and shelf_id=${request.projectId}`) : [];
  if (request.gameId && !game) throw new MutationError('SCOPE_DENIED', 'Game not found in this project.');
  const settings = resolveAgentSettings(readAgentDocument(project.settings), game ? readAgentDocument(game.settings) : undefined);
  if (!(request.role === 'gm' ? settings.effective.gmImages : settings.effective.assistantImages)) throw new MutationError('IMAGE_DISABLED', 'Image generation is disabled for this chat.');
  const model = await configuredImageModel(tx);

  let item: Record<string, unknown> | undefined;
  if (request.fileName) {
    const fileName = request.fileName.trim().replaceAll('\\', '/').toLowerCase();
    const matches = await tx.execute(sql`select i.id,i.title,i.description,i.cover_revision from content_items i join content_types t on t.id=i.type_id
      where i.project_id=${request.projectId} and i.game_id=${request.gameId} and i.deleted_at is null and i.branch_id is null and i.pov_character is null
      and (lower(i.id)=${fileName} or lower(i.title)=${fileName} or lower(i.slug || '.' || t.extension)=${fileName}
        or lower(case when i.folder='' then i.slug || '.' || t.extension else i.folder || '/' || i.slug || '.' || t.extension end)=${fileName})
      order by i.id limit 2`);
    if (matches.length !== 1) throw new MutationError(matches.length ? 'AMBIGUOUS_FILE' : 'SCOPE_DENIED', matches.length ? 'More than one file matches that name. Use its full folder and filename.' : 'File not found in this game.');
    item = matches[0];
  }
  const style = readProjectImageStyle(project.settings);
  const prompt = styledImagePrompt(request.prompt, style);
  const kind = request.fileName ? 'explicit_cover' : request.role === 'gm' ? 'gm_chat' : 'assistant_chat';
  const payload = { kind, prompt, styleRevision: style.revision, model,
    ...(item ? { itemId: item.id, expectedCoverRevision: Number(item.cover_revision) } : {}),
    origin: { role: request.role, runId: request.runId, callId: request.callId, ...(request.conversationId ? { conversationId: request.conversationId } : {}) } };
  const receipt = await reserveDirectImageRequest(tx, { projectId: request.projectId, storyId: request.gameId,
    dedupeKey: `${request.role}:${request.runId}:${request.callId}`, payload });
  return { ...receipt, ...(item ? { itemId: String(item.id), expectedCoverRevision: Number(item.cover_revision) } : {}), styleRevision: style.revision };
}

/** Browser scene requests use the same server image pipeline and a durable turn origin. */
export async function generateManualSceneImage(request: { projectId: string; gameId: string; clientTurnId: string; callId: string; prompt?: string }) {
  const receipt = await getDb().transaction(tx => reserveManualSceneImageInTransaction(tx, request));
  return { ...await completeDirectImageRequest(receipt), styleRevision: receipt.styleRevision };
}

export async function reserveManualSceneImageInTransaction(tx: Tx, request: { projectId: string; gameId: string; clientTurnId: string; callId: string; prompt?: string }) {
    const [project] = await tx.execute(sql`select settings from shelves where id=${request.projectId}`);
    const [game] = await tx.execute(sql`select settings,current_location_id from stories where id=${request.gameId} and shelf_id=${request.projectId}`);
    if (!project || !game) throw new MutationError('SCOPE_DENIED', 'Game not found in this project.');
    const settings = resolveAgentSettings(readAgentDocument(project.settings), readAgentDocument(game.settings));
    if (!settings.effective.gmImages) throw new MutationError('IMAGE_DISABLED', 'Image generation is disabled for this game.');
    const [turn] = await tx.execute(sql`select id from story_entries where story_id=${request.gameId} and type='user_action' and metadata->>'clientTurnId'=${request.clientTurnId} limit 1`);
    if (!turn) throw new MutationError('SCOPE_DENIED', 'The image origin turn was not found in this game.');
    const [narration] = await tx.execute(sql`select content,position,metadata from story_entries where story_id=${request.gameId} and type='narration'
      and (parent_id=${turn.id} or id=${`narration_${request.clientTurnId}`}) order by position desc limit 1`);
    if (!narration || !String(narration.content).trim()) throw new MutationError('INVALID_IMAGE', 'A saved narration is required for a scene image.');
    const [location] = game.current_location_id ? await tx.execute(sql`select name,description from entities
      where id=${game.current_location_id} and story_id=${request.gameId} and type='location' and visibility in ('public','player_known')`) : [];
    const visibleCharacters = await tx.execute(sql`select id,name,description,state,metadata from entities where story_id=${request.gameId}
      and type='character' and status='active' and visibility in ('public','player_known') order by name`);
    const preceding = await tx.execute(sql`select content from story_entries where story_id=${request.gameId} and type='narration'
      and position < ${narration.position} and branch_id is null
      and coalesce(metadata->'parallelPov','null'::jsonb)=coalesce(${JSON.stringify(narration.metadata ?? {})}::jsonb->'parallelPov','null'::jsonb)
      and coalesce(metadata->>'narrativeMode','') not in ('ooc','gm_control') order by position desc limit 6`);
    const sceneContext = { narration: String(narration.content), recentNarration: preceding.reverse().map(row => String(row.content)),
      location: location ? { name: String(location.name), description: typeof location.description === 'string' ? location.description : null } : null,
      characters: visibleCharacters.map(character => ({ id: String(character.id), name: String(character.name),
        description: typeof character.description === 'string' ? character.description : null, state: sceneCharacterState(character.state, character.metadata) })) };
    const model = await configuredImageModel(tx);
    const style = readProjectImageStyle(project.settings);
    const receipt = await reserveDirectImageRequest(tx, { projectId: request.projectId, storyId: request.gameId,
      dedupeKey: `manual-scene:${request.clientTurnId}:${request.callId}`,
      payload: { kind: 'manual_scene', prompt: 'Scene image awaiting prompt preparation.', sceneContext, sceneStyle: style.prompt, model, styleRevision: style.revision,
        browserOrigin: { clientTurnId: request.clientTurnId, callId: request.callId } } });
    return { ...receipt, styleRevision: style.revision };
}
