import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';

/** Cheap conservative invalidation for query vectors, never for scene/search result reuse. */
export async function agentEmbeddingRevision(storyId: string): Promise<string> {
  const [row] = await getDb().execute(sql`
    select md5(jsonb_build_object(
      'story', to_jsonb(s), 'project', to_jsonb(p),
      'settings', jsonb_build_array(
        (select jsonb_agg(jsonb_build_array(mp.id, mp.revision) order by mp.id) from model_profiles mp),
        (select jsonb_agg(jsonb_build_array(mr.role, mr.profile_id, mr.revision) order by mr.role) from model_roles mr),
        (select jsonb_agg(jsonb_build_array(mo.task_id, mo.revision) order by mo.task_id) from model_task_overrides mo)),
      'memory', (select jsonb_agg(jsonb_build_array(m.id,m.server_version,m.updated_at) order by m.id)
        from memory_nodes m where m.story_id=s.id),
      'sources', (select jsonb_agg(jsonb_build_array(c.id,c.revision,c.source_deleted,c.hidden) order by c.id)
        from canonical_content c where c.game_id=s.id),
      'documents', (select jsonb_agg(jsonb_build_array(i.id,i.revision,i.deleted_at) order by i.id)
        from content_items i where i.project_id=s.shelf_id and (i.game_id is null or i.game_id=s.id)),
      'types', (select jsonb_agg(jsonb_build_array(t.id,t.revision) order by t.id)
        from content_types t where t.project_id=s.shelf_id)
    )::text) as embedding_revision
    from stories s left join shelves p on p.id=s.shelf_id where s.id=${storyId}`);
  if (typeof row?.embedding_revision !== 'string') throw new Error('Missing query embedding revision.');
  return row.embedding_revision;
}
