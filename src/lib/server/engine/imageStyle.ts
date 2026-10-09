import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { projectImageStyleSaveSchema, readProjectImageStyle } from '$lib/contracts/imageStyle';
import { MutationError } from './mutationSafety';

export async function saveProjectImageStyle(input: unknown) {
  const request = projectImageStyleSaveSchema.parse(input);
  return getDb().transaction(async tx => {
    const [project] = await tx.execute(sql`select settings from shelves where id=${request.projectId} for update`);
    if (!project) throw new MutationError('SCOPE_DENIED', 'Project not found.');
    const current = readProjectImageStyle(project.settings);
    if (current.revision !== request.expectedRevision) throw new MutationError('REVISION_CONFLICT', 'Project image style changed. Reload before saving.', { expected: request.expectedRevision, actual: current.revision });
    const next = { revision: current.revision + 1, prompt: request.prompt };
    await tx.execute(sql`update shelves set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{imageStyle}',${JSON.stringify(next)}::jsonb,true),server_version=server_version+1,updated_at=now() where id=${request.projectId}`);
    return { projectId: request.projectId, imageStyle: next };
  });
}
