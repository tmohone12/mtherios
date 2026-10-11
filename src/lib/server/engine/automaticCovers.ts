import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { enqueueBackendJob } from '$lib/server/jobs/outbox';
import { resolveAgentSettings } from '$lib/contracts/agentTools';
import { readAgentDocument } from './agentSettings';
import { resolveApiKeyRef } from './llmSettings';
import type { ContentItem } from '$lib/contracts/content';
import { readProjectImageStyle, styledImagePrompt } from '$lib/contracts/imageStyle';
import { isImageProfile } from './imageProvider';
import { imageTaskSetting } from './modelSettings';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Called only for a committed new document path, never for imports or copies. */
export async function enqueueAutomaticCover(tx: Tx, item: ContentItem): Promise<string | null> {
  const [project] = await tx.execute(sql`select settings from shelves where id=${item.project_id}`);
  if (!project || !resolveAgentSettings(readAgentDocument(project.settings)).effective.automaticCovers) return null;
  const profile = await imageTaskSetting(tx);
  if (!profile || profile.enabled === false || !['openai', 'nanogpt'].includes(String(profile.provider_type)) ||
    typeof profile.model !== 'string' || !isImageProfile(String(profile.provider_type), profile.model) ||
    !resolveApiKeyRef(typeof profile.api_key_ref === 'string' ? profile.api_key_ref : null)) return null;
  const maxImageCostUsd = Number(process.env.MYTHENGINE_IMAGE_MAX_COST_USD);
  if (profile.provider_type === 'nanogpt' && !(Number.isFinite(maxImageCostUsd) && maxImageCostUsd > 0)) return null;
  const style = readProjectImageStyle(project.settings);
  const prompt = styledImagePrompt(`Cover illustration for ${item.title}. ${item.description.slice(0, 550)}`, style);
  return enqueueBackendJob({ projectId: item.project_id, storyId: item.game_id, type: 'generate_image',
    dedupeKey: `automatic-cover:${item.id}:revision-${item.revision}:style-${style.revision}`, requeueExisting: false, maxAttempts: 1,
    payload: { kind: 'automatic_cover', itemId: item.id, expectedCoverRevision: item.cover_revision, prompt, styleRevision: style.revision, model: profile.model },
  }, tx);
}
