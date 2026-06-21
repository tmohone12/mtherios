import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { patchProposals, sourceRefs, statePatches, storyEntries, storyEvents } from '$lib/server/db/schema';
import { enqueueBackendJob, enqueueStoryVaultSyncJob } from '$lib/server/jobs/outbox';
import { bumpStoryVersion } from '$lib/server/memory/canonical';
import type { RecordPatchRequest } from '$lib/contracts/engine';

type JsonRecord = Record<string, unknown>;

interface RecordSpec {
	table: string;
	idColumn: string;
	storyColumn: string;
	updatedColumn?: string;
	versionColumn?: string | null;
	searchColumns: string[];
	editableColumns: Record<string, string>;
	jsonColumns?: Set<string>;
	fixedFilters?: Record<string, string>;
}

const jsonColumns = (...columns: string[]) => new Set(columns);

export const WORLD_RECORD_TYPES: Record<string, RecordSpec> = {
	stories: {
		table: 'stories',
		idColumn: 'id',
		storyColumn: 'id',
		updatedColumn: 'updated_at',
		searchColumns: ['title', 'description', 'genre', 'header_prompt'],
		editableColumns: {
			title: 'title',
			description: 'description',
			genre: 'genre',
			mode: 'mode',
			settings: 'settings',
			headerPrompt: 'header_prompt',
			currentLocationId: 'current_location_id',
			currentTurn: 'current_turn',
			currentWorldTime: 'current_world_time',
			metadata: 'metadata',
		},
		jsonColumns: jsonColumns('settings', 'metadata'),
	},
	transcript: {
		table: 'story_entries',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['content', 'type'],
		editableColumns: {
			type: 'type',
			content: 'content',
			parentId: 'parent_id',
			branchId: 'branch_id',
			metadata: 'metadata',
		},
		jsonColumns: jsonColumns('metadata'),
	},
	entities: {
		table: 'entities',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['name', 'description', 'type', 'status', 'visibility'],
		editableColumns: {
			type: 'type',
			name: 'name',
			description: 'description',
			status: 'status',
			visibility: 'visibility',
			state: 'state',
			metadata: 'metadata',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
		},
		jsonColumns: jsonColumns('state', 'metadata', 'source_entry_ids', 'source_event_ids', 'source_patch_ids'),
	},
	characters: {
		table: 'entities',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['name', 'description', 'status', 'visibility'],
		fixedFilters: { type: 'character' },
		editableColumns: {
			name: 'name',
			description: 'description',
			status: 'status',
			visibility: 'visibility',
			state: 'state',
			metadata: 'metadata',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
		},
		jsonColumns: jsonColumns('state', 'metadata', 'source_entry_ids', 'source_event_ids', 'source_patch_ids'),
	},
	locations: {
		table: 'entities',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['name', 'description', 'status', 'visibility'],
		fixedFilters: { type: 'location' },
		editableColumns: {
			name: 'name',
			description: 'description',
			status: 'status',
			visibility: 'visibility',
			state: 'state',
			metadata: 'metadata',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
		},
		jsonColumns: jsonColumns('state', 'metadata', 'source_entry_ids', 'source_event_ids', 'source_patch_ids'),
	},
	items: {
		table: 'entities',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['name', 'description', 'status', 'visibility'],
		fixedFilters: { type: 'item' },
		editableColumns: {
			name: 'name',
			description: 'description',
			status: 'status',
			visibility: 'visibility',
			state: 'state',
			metadata: 'metadata',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
		},
		jsonColumns: jsonColumns('state', 'metadata', 'source_entry_ids', 'source_event_ids', 'source_patch_ids'),
	},
	factions: {
		table: 'factions',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['name'],
		editableColumns: {
			entityId: 'entity_id',
			name: 'name',
			goals: 'goals',
			resources: 'resources',
			memberEntityIds: 'member_entity_ids',
			territoryIds: 'territory_ids',
			allies: 'allies',
			enemies: 'enemies',
			pressure: 'pressure',
			metadata: 'metadata',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
		},
		jsonColumns: jsonColumns('goals', 'resources', 'member_entity_ids', 'territory_ids', 'allies', 'enemies', 'metadata', 'source_entry_ids', 'source_event_ids', 'source_patch_ids'),
	},
	factionMemberships: {
		table: 'faction_memberships',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['role', 'rank', 'status', 'visibility'],
		editableColumns: {
			factionId: 'faction_id',
			entityId: 'entity_id',
			role: 'role',
			rank: 'rank',
			status: 'status',
			visibility: 'visibility',
			metadata: 'metadata',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
		},
		jsonColumns: jsonColumns('metadata', 'source_entry_ids', 'source_event_ids', 'source_patch_ids'),
	},
	factionResources: {
		table: 'faction_resources',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['kind', 'name', 'status', 'visibility'],
		editableColumns: {
			factionId: 'faction_id',
			kind: 'kind',
			name: 'name',
			amount: 'amount',
			status: 'status',
			locationId: 'location_id',
			visibility: 'visibility',
			metadata: 'metadata',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
		},
		jsonColumns: jsonColumns('metadata', 'source_entry_ids', 'source_event_ids', 'source_patch_ids'),
	},
	factionGoals: {
		table: 'faction_goals',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['goal', 'status', 'secrecy'],
		editableColumns: {
			factionId: 'faction_id',
			goal: 'goal',
			status: 'status',
			priority: 'priority',
			secrecy: 'secrecy',
			metadata: 'metadata',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
		},
		jsonColumns: jsonColumns('metadata', 'source_entry_ids', 'source_event_ids', 'source_patch_ids'),
	},
	factionProjects: {
		table: 'faction_projects',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['project', 'status', 'visibility'],
		editableColumns: {
			factionId: 'faction_id',
			project: 'project',
			status: 'status',
			progress: 'progress',
			priority: 'priority',
			dueTurn: 'due_turn',
			worldTime: 'world_time',
			costs: 'costs',
			gains: 'gains',
			risks: 'risks',
			visibility: 'visibility',
			metadata: 'metadata',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
		},
		jsonColumns: jsonColumns('costs', 'gains', 'risks', 'metadata', 'source_entry_ids', 'source_event_ids', 'source_patch_ids'),
	},
	agreements: {
		table: 'agreements',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['category', 'terms', 'status', 'secrecy'],
		editableColumns: {
			parties: 'parties',
			category: 'category',
			terms: 'terms',
			status: 'status',
			secrecy: 'secrecy',
			consequences: 'consequences',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
		},
		jsonColumns: jsonColumns('parties', 'consequences', 'source_entry_ids', 'source_event_ids', 'source_patch_ids'),
	},
	threads: {
		table: 'story_threads',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['description', 'status', 'significance', 'closure_reason'],
		editableColumns: {
			description: 'description',
			status: 'status',
			significance: 'significance',
			relatedFactionIds: 'related_faction_ids',
			relatedEntityIds: 'related_entity_ids',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
			closedAt: 'closed_at',
			closureReason: 'closure_reason',
		},
		jsonColumns: jsonColumns('related_faction_ids', 'related_entity_ids', 'source_entry_ids', 'source_event_ids', 'source_patch_ids'),
	},
	events: {
		table: 'story_events',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['type', 'title', 'body', 'visibility'],
		editableColumns: {
			type: 'type',
			status: 'status',
			title: 'title',
			body: 'body',
			actorEntityIds: 'actor_entity_ids',
			targetEntityIds: 'target_entity_ids',
			locationId: 'location_id',
			locationIds: 'location_ids',
			factionIds: 'faction_ids',
			threadIds: 'thread_ids',
			visibility: 'visibility',
			createdTurn: 'created_turn',
			occurredTurn: 'occurred_turn',
			scheduledTurn: 'scheduled_turn',
			worldTime: 'world_time',
			memoryImpact: 'memory_impact',
			sourceEntryIds: 'source_entry_ids',
			sourcePatchIds: 'source_patch_ids',
			metadata: 'metadata',
		},
		jsonColumns: jsonColumns('actor_entity_ids', 'target_entity_ids', 'location_ids', 'faction_ids', 'thread_ids', 'memory_impact', 'source_entry_ids', 'source_patch_ids', 'metadata'),
	},
	npcEventLinks: {
		table: 'npc_event_links',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['role', 'visibility'],
		editableColumns: {
			eventId: 'event_id',
			npcEntityId: 'npc_entity_id',
			role: 'role',
			visibility: 'visibility',
			evidenceStrength: 'evidence_strength',
			sourceEntryIds: 'source_entry_ids',
			sourcePatchIds: 'source_patch_ids',
		},
		jsonColumns: jsonColumns('source_entry_ids', 'source_patch_ids'),
	},
	patches: {
		table: 'state_patches',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['reason', 'status'],
		editableColumns: {
			operations: 'operations',
			reason: 'reason',
			status: 'status',
			validationWarnings: 'validation_warnings',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
		},
		jsonColumns: jsonColumns('operations', 'validation_warnings', 'source_entry_ids', 'source_event_ids'),
	},
	facts: {
		table: 'facts',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['type', 'title', 'statement', 'status', 'visibility'],
		editableColumns: {
			type: 'type',
			subjectEntityId: 'subject_entity_id',
			targetEntityId: 'target_entity_id',
			title: 'title',
			statement: 'statement',
			confidence: 'confidence',
			status: 'status',
			visibility: 'visibility',
			firstSeenEntryId: 'first_seen_entry_id',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
			metadata: 'metadata',
		},
		jsonColumns: jsonColumns('source_entry_ids', 'source_event_ids', 'source_patch_ids', 'metadata'),
	},
	sourceRefs: {
		table: 'source_refs',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['source_type', 'source_id', 'target_table', 'target_record_id', 'target_record_field', 'source_field'],
		editableColumns: {
			sourceType: 'source_type',
			sourceId: 'source_id',
			targetTable: 'target_table',
			targetRecordId: 'target_record_id',
			targetRecordField: 'target_record_field',
			sourceField: 'source_field',
			confidence: 'confidence',
			rationale: 'rationale',
			notes: 'notes',
		},
		jsonColumns: jsonColumns(),
	},
	patchProposals: {
		table: 'patch_proposals',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['proposal_type', 'target_table', 'target_record_id', 'status'],
		editableColumns: {
			proposalType: 'proposal_type',
			targetTable: 'target_table',
			targetRecordId: 'target_record_id',
			proposedBy: 'proposed_by',
			reason: 'reason',
			suggestion: 'suggestion',
			operations: 'operations',
			status: 'status',
			decision: 'decision',
			validatedBy: 'validated_by',
			affectedEntityIds: 'affected_entity_ids',
			confidence: 'confidence',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
			metadata: 'metadata',
		},
		jsonColumns: jsonColumns('operations', 'affected_entity_ids', 'source_entry_ids', 'source_event_ids', 'source_patch_ids', 'metadata'),
	},
	continuityWarnings: {
		table: 'continuity_warnings',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['warning_type', 'title', 'details', 'level', 'status'],
		editableColumns: {
			warningType: 'warning_type',
			level: 'level',
			title: 'title',
			status: 'status',
			details: 'details',
			entityIds: 'entity_ids',
			factionIds: 'faction_ids',
			threadIds: 'thread_ids',
			actorIds: 'actor_ids',
			resolutionNotes: 'resolution_notes',
			resolvedBy: 'resolved_by',
			resolvedAt: 'resolved_at',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
			metadata: 'metadata',
		},
		jsonColumns: jsonColumns('entity_ids', 'faction_ids', 'thread_ids', 'actor_ids', 'source_entry_ids', 'source_event_ids', 'source_patch_ids', 'metadata'),
	},
	memoryNodes: {
		table: 'memory_nodes',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['type', 'title', 'content', 'summary', 'visibility'],
		editableColumns: {
			type: 'type',
			title: 'title',
			content: 'content',
			summary: 'summary',
			keywords: 'keywords',
			entityIds: 'entity_ids',
			factionIds: 'faction_ids',
			threadIds: 'thread_ids',
			locationId: 'location_id',
			visibility: 'visibility',
			importance: 'importance',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
			metadata: 'metadata',
		},
		jsonColumns: jsonColumns('keywords', 'entity_ids', 'faction_ids', 'thread_ids', 'source_entry_ids', 'source_event_ids', 'source_patch_ids', 'metadata'),
	},
	chapters: {
		table: 'chapters',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['title', 'scene_outcome'],
		editableColumns: {
			number: 'number',
			title: 'title',
			sceneOutcome: 'scene_outcome',
			irreversibleChanges: 'irreversible_changes',
			npcKnowledgeChanges: 'npc_knowledge_changes',
			promisesDebtsOaths: 'promises_debts_oaths',
			discoveredClues: 'discovered_clues',
			relationshipChanges: 'relationship_changes',
			factionChanges: 'faction_changes',
			openThreads: 'open_threads',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			metadata: 'metadata',
		},
		jsonColumns: jsonColumns('irreversible_changes', 'npc_knowledge_changes', 'promises_debts_oaths', 'discovered_clues', 'relationship_changes', 'faction_changes', 'open_threads', 'source_entry_ids', 'source_event_ids', 'metadata'),
	},
	arcs: {
		table: 'arcs',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['title', 'summary'],
		editableColumns: {
			number: 'number',
			title: 'title',
			summary: 'summary',
			chapterIds: 'chapter_ids',
			sourceEventIds: 'source_event_ids',
			openThreadIds: 'open_thread_ids',
			metadata: 'metadata',
		},
		jsonColumns: jsonColumns('chapter_ids', 'source_event_ids', 'open_thread_ids', 'metadata'),
	},
	searchIndex: {
		table: 'search_index_records',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		versionColumn: null,
		searchColumns: ['record_type', 'record_id', 'collection', 'status', 'error', 'model'],
		editableColumns: {
			status: 'status',
			error: 'error',
			metadata: 'metadata',
		},
		jsonColumns: jsonColumns('metadata'),
	},
	jobs: {
		table: 'backend_jobs',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		versionColumn: null,
		searchColumns: ['type', 'status', 'last_error'],
		editableColumns: {
			status: 'status',
			lastError: 'last_error',
			metadata: 'metadata',
		},
		jsonColumns: jsonColumns('metadata'),
	},
	apiCallLogs: {
		table: 'api_call_logs',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'created_at',
		versionColumn: null,
		searchColumns: ['service_id', 'operation', 'provider_type', 'provider_name', 'model', 'endpoint', 'status', 'error'],
		editableColumns: {},
		jsonColumns: jsonColumns('metadata'),
	},
};

function nowIso(): string {
	return new Date().toISOString();
}

function id(prefix = 'patch'): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function q(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

function specFor(type: string): RecordSpec {
	const spec = WORLD_RECORD_TYPES[type];
	if (!spec) throw new Error(`Unsupported world record type: ${type}`);
	return spec;
}

function asArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sourceRefIds(row: JsonRecord) {
	return {
		sourceEntryIds: asArray(row.source_entry_ids ?? row.sourceEntryIds),
		sourceEventIds: asArray(row.source_event_ids ?? row.sourceEventIds),
		sourcePatchIds: asArray(row.source_patch_ids ?? row.sourcePatchIds),
	};
}

function inferAffectedEntityIds(type: string, record: JsonRecord): string[] {
	const ids = new Set<string>();
	const add = (value: unknown) => {
		if (typeof value === 'string' && value.trim()) ids.add(value);
	};
	const addMany = (value: unknown) => {
		if (!Array.isArray(value)) return;
		for (const item of value) add(item);
	};

	if (['entities', 'characters', 'locations', 'items'].includes(type)) add(String(record.id));
	add(record.entityId);
	add(record.sourceEntityId);
	add(record.targetEntityId);
	add(record.subjectEntityId);
	add(record.believerEntityId);
	add(record.locationId);
	addMany(record.entityIds);
	addMany(record.memberEntityIds);
	addMany(record.actorEntityIds);
	addMany(record.targetEntityIds);
	addMany(record.locationIds);
	addMany(record.affectedEntityIds);
	return [...ids];
}

async function queueManualRecordPatchJobs(input: { storyId: string; serverVersion: number; type: string; recordId: string }) {
	if (['jobs', 'searchIndex', 'apiCallLogs'].includes(input.type)) return;
	const indexType = ['characters', 'locations', 'items'].includes(input.type) ? 'entities' : input.type;
	try {
		await Promise.all([
			enqueueStoryVaultSyncJob({
				storyId: input.storyId,
				serverVersion: input.serverVersion,
				reason: 'manual-record-edit',
				payload: { recordType: input.type, recordId: input.recordId },
			}),
			enqueueBackendJob({
				storyId: input.storyId,
				type: 'index_canonical_records',
				dedupeKey: `manual-record-edit-index-${input.storyId}-${input.type}-${input.recordId}`,
				payload: {
					recordTypes: [indexType],
					recordId: input.recordId,
					reason: 'manual_record_edit',
				},
				maxAttempts: 3,
			}),
		]);
	} catch (error) {
		console.warn('[WorldRecords] Failed to queue manual record patch jobs:', error);
	}
}

function valueExpression(spec: RecordSpec, column: string, value: unknown) {
	if (spec.jsonColumns?.has(column)) return sql`${JSON.stringify(value ?? null)}::jsonb`;
	return sql`${value}`;
}

function editableColumnForKey(spec: RecordSpec, key: string): string | null {
	if (Object.prototype.hasOwnProperty.call(spec.editableColumns, key)) return spec.editableColumns[key];
	if (Object.values(spec.editableColumns).includes(key)) return key;
	return null;
}

export function listWorldRecordTypes(): string[] {
	return Object.keys(WORLD_RECORD_TYPES);
}

export async function listWorldRecords(
	storyId: string,
	options: { type?: string; q?: string; cursor?: string | null; limit?: number } = {},
) {
	const type = options.type || 'entities';
	const spec = specFor(type);
	const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
	const offset = Math.max(0, Number.parseInt(options.cursor ?? '0', 10) || 0);
	const filters = [sql`${sql.raw(q(spec.storyColumn))} = ${storyId}`];
	for (const [column, value] of Object.entries(spec.fixedFilters ?? {})) {
		filters.push(sql`${sql.raw(q(column))} = ${value}`);
	}
	const query = options.q?.trim() ?? '';
	if (type === 'patchProposals' && !query) {
		filters.push(sql`${sql.raw(q('status'))} in ('pending', 'needs_review')`);
		filters.push(sql`${sql.raw(q('proposal_type'))} in ('character_reference_review', 'entity_reference_review', 'character_context_update', 'faction_project_due_resolution', 'faction_project_blocked_resolution')`);
	}
	if (query) {
		const like = `%${query}%`;
		filters.push(sql`(${sql.join(spec.searchColumns.map((column) => sql`${sql.raw(q(column))}::text ilike ${like}`), sql` or `)})`);
	}
	const order = spec.updatedColumn
		? sql`order by ${sql.raw(q(spec.updatedColumn))} desc`
		: sql``;
	const rows = await getDb().execute(sql`
		select *
		from ${sql.raw(q(spec.table))}
		where ${sql.join(filters, sql` and `)}
		${order}
		limit ${limit + 1}
		offset ${offset}
	`);
	const page = rows.slice(0, limit) as JsonRecord[];
	return {
		storyId,
		type,
		records: page,
		nextCursor: rows.length > limit ? String(offset + limit) : null,
		limit,
	};
}

export async function getWorldRecord(type: string, recordId: string) {
	const spec = specFor(type);
	const rows = await getDb().execute(sql`
		select *
		from ${sql.raw(q(spec.table))}
		where ${sql.raw(q(spec.idColumn))} = ${recordId}
		limit 1
	`);
	const record = rows[0] as JsonRecord | undefined;
	if (!record) throw new Error(`Record not found: ${type}/${recordId}`);
	const refs = sourceRefIds(record);
	const [sourceEntries, sourceEvents, sourcePatches] = await Promise.all([
		refs.sourceEntryIds.length
			? getDb().select().from(storyEntries).where(and(eq(storyEntries.storyId, String(record[spec.storyColumn])), inArray(storyEntries.id, refs.sourceEntryIds)))
			: [],
		refs.sourceEventIds.length
			? getDb().select().from(storyEvents).where(and(eq(storyEvents.storyId, String(record[spec.storyColumn])), inArray(storyEvents.id, refs.sourceEventIds)))
			: [],
		refs.sourcePatchIds.length
			? getDb().select().from(statePatches).where(and(eq(statePatches.storyId, String(record[spec.storyColumn])), inArray(statePatches.id, refs.sourcePatchIds)))
			: [],
	]);
	return {
		type,
		record,
		sourceEntries,
		sourceEvents,
		sourcePatches,
	};
}

export async function patchWorldRecord(type: string, recordId: string, request: RecordPatchRequest) {
	const spec = specFor(type);
	const existingRows = await getDb().execute(sql`
		select *
		from ${sql.raw(q(spec.table))}
		where ${sql.raw(q(spec.idColumn))} = ${recordId}
		limit 1
	`);
	const existing = existingRows[0] as JsonRecord | undefined;
	if (!existing) throw new Error(`Record not found: ${type}/${recordId}`);

	const storyId = String(existing[spec.storyColumn] ?? '');
	if (!storyId) throw new Error(`Record ${type}/${recordId} is missing story scope.`);
	const editable = Object.entries(request.updates)
		.map(([key, value]) => ({ key, value, column: editableColumnForKey(spec, key) }))
		.filter((item): item is { key: string; value: unknown; column: string } => Boolean(item.column));
	if (editable.length === 0) throw new Error('No editable fields were supplied.');

	const serverVersion = await bumpStoryVersion(storyId);
	const updatedAt = nowIso();
	const patchId = id('manual_patch');
	const proposalId = id('manual_proposal');
	const operations = editable.map(({ key, value }) => ({
		op: 'replace',
		path: `/${type}/${recordId}/${key}`,
		value,
		source: 'manual_edit',
	}));
	await getDb().insert(statePatches).values({
		id: patchId,
		storyId,
		operations,
		reason: request.reason || 'Manual explorer edit.',
		status: 'applied',
		validationWarnings: [],
		sourceEntryIds: [],
		sourceEventIds: [],
		serverVersion,
		createdAt: updatedAt,
		updatedAt,
	});
	const affectedEntityIds = inferAffectedEntityIds(type, existing);
	await getDb().insert(patchProposals).values({
		id: proposalId,
		storyId,
		proposalType: 'manual_edit',
		targetTable: spec.table,
		targetRecordId: recordId,
		proposedBy: 'human',
		operations,
		reason: request.reason || 'Manual explorer edit.',
		suggestion: 'Review the manual edit before treating the record as canonical.',
		status: 'applied',
		decision: 'approved',
		validatedBy: 'human',
		affectedEntityIds,
		confidence: 1,
		sourceEntryIds: [],
		sourceEventIds: [],
		sourcePatchIds: [patchId],
		metadata: {
			sourceType: 'manual_edit',
			recordType: type,
		},
		serverVersion,
		createdAt: updatedAt,
		updatedAt,
	});
	await getDb().insert(sourceRefs).values({
		id: id('sourceref_manual'),
		storyId,
		sourceType: 'state_patch',
		sourceId: patchId,
		targetTable: 'patch_proposals',
		targetRecordId: proposalId,
		targetRecordField: 'operations',
		sourceField: 'manual_edit',
		confidence: 1,
		rationale: request.reason || 'Manual explorer edit.',
		notes: `Applied to ${type}/${recordId}`,
		serverVersion,
		createdAt: updatedAt,
		updatedAt,
	});
	await getDb().insert(sourceRefs).values({
		id: id('sourceref_manual_target'),
		storyId,
		sourceType: 'state_patch',
		sourceId: patchId,
		targetTable: spec.table,
		targetRecordId: recordId,
		targetRecordField: editable[0]?.column ?? null,
		sourceField: 'manual_edit',
		confidence: 1,
		rationale: request.reason || 'Manual explorer edit.',
		notes: `Patch proposal ${proposalId}`,
		serverVersion,
		createdAt: updatedAt,
		updatedAt,
	});

	const setClauses = editable.map(({ column, value }) => {
		return sql`${sql.raw(q(column))} = ${valueExpression(spec, column, value)}`;
	});
	const versionColumn = spec.versionColumn === undefined ? 'server_version' : spec.versionColumn;
	if (versionColumn) setClauses.push(sql`${sql.raw(q(versionColumn))} = ${serverVersion}`);
	if (spec.updatedColumn) setClauses.push(sql`${sql.raw(q(spec.updatedColumn))} = ${updatedAt}`);

	const rows = await getDb().execute(sql`
		update ${sql.raw(q(spec.table))}
		set ${sql.join(setClauses, sql`, `)}
		where ${sql.raw(q(spec.idColumn))} = ${recordId}
		returning *
	`);
	await queueManualRecordPatchJobs({ storyId, serverVersion, type, recordId });
	return {
		storyId,
		type,
		record: rows[0] as JsonRecord,
		patchId,
		serverVersion,
	};
}

export async function getStoryEntriesAround(storyId: string, position: number, radius = 40) {
	const limit = Math.max(1, Math.min(200, Math.trunc(radius * 2 + 1)));
	const rows = await getDb().execute(sql`
		select *
		from story_entries
		where story_id = ${storyId}
			and position between ${Math.trunc(position - radius)} and ${Math.trunc(position + radius)}
		order by position asc
		limit ${limit}
	`);
	return {
		storyId,
		position,
		entries: rows,
	};
}
