import { sql } from 'drizzle-orm';
import { readProjectImageStyle } from '$lib/contracts/imageStyle';
import { resolveAgentSettings } from '$lib/contracts/agentTools';
import { getDb } from '$lib/server/db/client';
import { completeDirectImageRequest, reserveDirectImageRequest } from './imageJobs';
import { buildCharacterPortraitPrompt } from '$lib/services/ai/image/portraitPrompt';
import type { Character } from '$lib/types';
import { readAgentDocument } from './agentSettings';
import { configuredImageModel } from './imageRequests';
import { MutationError } from './mutationSafety';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type PortraitRequest = { projectId: string; gameId: string; characterId: string; callId: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The server reads current canon; the browser never supplies or truncates portrait details. */
export async function generatePortraitImage(input: PortraitRequest) {
  const receipt = await getDb().transaction(tx => reservePortraitImageInTransaction(tx, input));
  return { ...await completeDirectImageRequest(receipt), expectedEntityVersion: receipt.expectedEntityVersion, styleRevision: receipt.styleRevision };
}

export async function reservePortraitImageInTransaction(tx: Tx, input: PortraitRequest) {
    const [project] = await tx.execute(sql`select settings from shelves where id=${input.projectId}`);
    const [game] = await tx.execute(sql`select settings from stories where id=${input.gameId} and shelf_id=${input.projectId}`);
    if (!project || !game) throw new MutationError('SCOPE_DENIED', 'Game not found in this project.');
    const settings = resolveAgentSettings(readAgentDocument(project.settings), readAgentDocument(game.settings));
    if (!settings.effective.gmImages) throw new MutationError('IMAGE_DISABLED', 'Image generation is disabled for this game.');
    const [entity] = await tx.execute(sql`select id,name,description,state,metadata,visibility,server_version from entities
      where id=${input.characterId} and story_id=${input.gameId} and type='character' for update`);
    if (!entity || !['public', 'player_known'].includes(String(entity.visibility)))
      throw new MutationError('SCOPE_DENIED', 'The character is unavailable for a player-visible portrait.');
    const [pending] = await tx.execute(sql`select id,payload,status from backend_jobs where project_id=${input.projectId} and story_id=${input.gameId}
      and type='generate_image' and payload->>'kind'='character_portrait' and payload->>'characterId'=${input.characterId}
      and status in ('queued','retry','running') limit 1 for update`);
    if (pending) {
      const payload = record(pending.payload);
      if (pending.status === 'running') {
        if (payload.callId === input.callId) return { isNew: false, jobId: String(pending.id),
          expectedEntityVersion: Number(payload.expectedEntityVersion), styleRevision: Number(payload.styleRevision) };
        throw new MutationError('IMAGE_PENDING', 'An image for this character is already generating.');
      }
      if (payload.callId === input.callId) return {
        ...await reserveDirectImageRequest(tx, { projectId: input.projectId, storyId: input.gameId,
          dedupeKey: `character-portrait:${input.characterId}:${input.callId}`, payload }),
        expectedEntityVersion: Number(payload.expectedEntityVersion), styleRevision: Number(payload.styleRevision),
      };
      await tx.execute(sql`update backend_jobs set status='failed',last_error='Superseded by a direct API image request.',
        locked_at=null,locked_by=null,updated_at=now() where id=${pending.id}`);
    }
    const state = record(entity.state);
    const metadata = record(entity.metadata);
    const character = {
      name: String(entity.name), description: typeof entity.description === 'string' ? entity.description : null,
      traits: Array.isArray(state.traits) ? state.traits.filter((value): value is string => typeof value === 'string') : [],
      visualDescriptors: record(state.visualDescriptors) as Character['visualDescriptors'], metadata,
    };
    const lore = { type: 'character', description: character.description, state };
    const style = readProjectImageStyle(project.settings);
    const prompt = buildCharacterPortraitPrompt(character, lore);
    const fullPrompt = style.prompt ? `${prompt}\nProject art style: ${style.prompt}` : prompt;
    if (!fullPrompt.trim() || fullPrompt.length > 8000)
      throw new MutationError('INVALID_IMAGE', 'Saved character image prompt exceeds the image provider limit; shorten the appearance or art style.');
    const model = await configuredImageModel(tx);
    const expectedEntityVersion = Number(entity.server_version);
    const receipt = await reserveDirectImageRequest(tx, { projectId: input.projectId, storyId: input.gameId,
      dedupeKey: `character-portrait:${input.characterId}:${input.callId}`,
      payload: { kind: 'character_portrait', characterId: input.characterId, callId: input.callId, expectedEntityVersion,
        prompt: fullPrompt, model, styleRevision: style.revision } });
    return { ...receipt, expectedEntityVersion, styleRevision: style.revision };
}

export async function readPortraitImageStatus(input: { projectId: string; gameId: string; characterId: string }) {
  const [entity] = await getDb().execute(sql`select e.id from entities e join stories s on s.id=e.story_id
    where e.id=${input.characterId} and e.story_id=${input.gameId} and e.type='character' and e.visibility in ('public','player_known') and s.shelf_id=${input.projectId}`);
  if (!entity) throw new MutationError('SCOPE_DENIED', 'Character not found in this game.');
  const [row] = await getDb().execute(sql`select id,status,last_error,metadata->'imageResult' as image_result
    from backend_jobs where project_id=${input.projectId} and story_id=${input.gameId} and type='generate_image'
      and payload->>'kind'='character_portrait' and payload->>'characterId'=${input.characterId}
    order by created_at desc,id desc limit 1`);
  return row ? { jobId: String(row.id), status: String(row.status), error: row.last_error ?? null,
    imageResult: row.image_result ?? null } : null;
}
