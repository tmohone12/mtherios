import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { countTokens } from '$lib/utils/tokens';
import type { TurnContext } from './context';

export type AuthoredContextRecord = {
	id: string;
	title: string;
	mode: 'pinned' | 'partial';
	text: string;
	tokens: number;
};
export type AuthoredGmContext = { fingerprint: string; records: AuthoredContextRecord[] };

type CatalogRow = {
	id: string;
	kind: string;
	title: string;
	description: string | null;
	data: unknown;
	mode: 'pinned' | 'partial' | 'searchable';
	item_revision: number;
	type_revision: number;
	source_revision: number | null;
	record_id?: string;
	branch_id: string | null;
	pov_character: string | null;
};

export function compileAuthoredGmContext(
	rows: CatalogRow[],
	scope: { projectId: string; projectRevision: number | null; gameId: string; branchId: string | null; povCharacter: string | null },
): AuthoredGmContext {
	const fingerprint = createHash('sha256').update(JSON.stringify({
		...scope,
		revisions: rows.map(row => [row.id, row.item_revision, row.type_revision, row.source_revision, row.mode]),
	})).digest('hex');
	const records = rows.filter(row => row.mode !== 'searchable').map(row => {
		const mode = row.mode as 'pinned' | 'partial';
		const id = `${row.id}@${row.item_revision}${row.source_revision === null ? '' : `.${row.source_revision}`}`;
		const body = mode === 'pinned' ? `\nAuthored fields: ${JSON.stringify(row.data)}` : '';
		const text = `[${id}; type:${row.kind}; ${mode}] ${row.title}\nDescription: ${row.description ?? ''}${body}`;
		return { id, title: row.title, mode, text, tokens: countTokens(text) };
	});
	return { fingerprint, records };
}

/** Scope and mode are resolved in SQL before any body is returned to the prompt builder. */
export async function loadAuthoredGmContext(ctx: TurnContext): Promise<AuthoredGmContext> {
	const projectId = ctx.story.shelfId;
	const gameId = ctx.story.id;
	const branchId = [...ctx.recentEntries].reverse().find(entry => entry.type === 'assistant')?.branchId ?? null;
	const povCharacter = ctx.scenePov?.character?.trim().toLowerCase() ?? null;
	return getDb().transaction(async tx => {
		const custom = await tx.execute(sql`
			select i.id, t.key as kind, i.title, i.description, i.revision as item_revision,
				t.revision as type_revision, null::integer as source_revision, i.branch_id, i.pov_character,
				coalesce(i.gm_context_mode, t.definition->>'gmContextMode', 'searchable') as mode,
				case when coalesce(i.gm_context_mode, t.definition->>'gmContextMode', 'searchable') = 'pinned' then i.data else null end as data
			from content_items i join content_types t on t.id = i.type_id and t.project_id = i.project_id
			where i.project_id = ${projectId} and (i.game_id is null or i.game_id = ${gameId})
				and i.deleted_at is null and i.visibility in ('public','gm')
				and (i.branch_id is null or i.branch_id = ${branchId})
				and (i.pov_character is null or lower(i.pov_character) = ${povCharacter})
			order by i.folder, i.title, i.id`);
		const canonical = await tx.execute(sql`
			select c.id, c.kind, c.record_id, coalesce(e.name, f.name, c.record_id) as title,
				case when c.kind = 'factions' then coalesce(f.metadata->>'description','') else e.description end as description,
				c.revision as item_revision, coalesce(t.revision,0) as type_revision,
				coalesce(e.server_version,f.server_version,0) as source_revision,
				c.branch_id, c.pov_character,
				coalesce(c.gm_context_mode, t.definition->>'gmContextMode', 'searchable') as mode,
				case when coalesce(c.gm_context_mode, t.definition->>'gmContextMode', 'searchable') = 'pinned'
					then case when c.kind = 'factions'
						then jsonb_build_object('goals',f.goals,'resources',f.resources,'members',f.member_entity_ids,
							'territories',f.territory_ids,'allies',f.allies,'enemies',f.enemies,'pressure',f.pressure,'metadata',f.metadata)
						else jsonb_build_object('status',e.status,'visibility',e.visibility,'state',e.state,
							'metadata',e.metadata - 'originalMetadata' - 'entityResolver' - 'activationPlan') end
					else null end as data
			from canonical_content c
			left join canonical_type_settings t on t.project_id = c.project_id and t.kind = c.kind
			left join entities e on e.id = c.record_id and e.story_id = c.game_id and c.kind <> 'factions'
			left join factions f on f.id = c.record_id and f.story_id = c.game_id and c.kind = 'factions'
			where c.project_id = ${projectId} and c.game_id = ${gameId}
				and not c.hidden and not c.source_deleted and (e.id is not null or f.id is not null)
				and (c.branch_id is null or c.branch_id = ${branchId})
				and (c.pov_character is null or lower(c.pov_character) = ${povCharacter})
			order by c.kind, title, c.id`);
		const [project] = await tx.execute(sql`select server_version from shelves where id = ${projectId}`);
		const rows = [
			...(custom as unknown as CatalogRow[]).map(row => ({ ...row, id: `content:${row.id}` })),
			...(canonical as unknown as CatalogRow[]).map(row => ({ ...row, id: `canonical:${row.kind}:${row.record_id}` })),
		];
		return compileAuthoredGmContext(rows, { projectId, projectRevision: Number(project?.server_version ?? 0), gameId, branchId, povCharacter });
	}, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
