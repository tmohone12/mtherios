import {canonicalExtensionDefinition,extensionValues} from './canonicalExtensions';
import { MutationError, assertExpectedRevision, mergeJsonUpdate, validateRecordField, type MutationActor } from './mutationSafety';
import { recordPatchRequestSchema } from '$lib/contracts/engine';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { patchProposals, sourceRefs, statePatches, storyEntries, storyEvents } from '$lib/server/db/schema';
import { enqueueBackendJob, enqueueStoryVaultSyncJob } from '$lib/server/jobs/outbox';
import type { RecordPatchRequest } from '$lib/contracts/engine';
import { memoryImportanceSchema, memoryNodeTypeSchema, memoryVisibilitySchema } from '$lib/contracts/memory';
import { playerCapabilitiesSchema, playerCapabilitiesUpdateSchema, readPlayerCapabilities } from '$lib/contracts/playerCapabilities';

type JsonRecord = Record<string, unknown>;
function asObject(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

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
	relationships: {
		table: 'relationships',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['source_entity_id', 'target_entity_id', 'type', 'label', 'strength', 'bidirectional', 'metadata'],
		editableColumns: {
			sourceEntityId: 'source_entity_id',
			targetEntityId: 'target_entity_id',
			type: 'type',
			label: 'label',
			strength: 'strength',
			bidirectional: 'bidirectional',
			metadata: 'metadata',
			sourceEntryIds: 'source_entry_ids',
			sourceEventIds: 'source_event_ids',
			sourcePatchIds: 'source_patch_ids',
		},
		jsonColumns: jsonColumns('metadata', 'source_entry_ids', 'source_event_ids', 'source_patch_ids'),
	},
	concepts: {
		table: 'entities',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['name', 'description', 'status', 'visibility'],
		fixedFilters: { type: 'concept' },
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
		searchColumns: ['description', 'status', 'significance', 'closure_reason', 'related_faction_ids', 'related_entity_ids'],
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
		searchColumns: [
			'type', 'status', 'title', 'body', 'visibility', 'actor_entity_ids', 'target_entity_ids',
			'faction_ids', 'thread_ids', 'location_id', 'location_ids', 'created_turn', 'occurred_turn',
			'scheduled_turn', 'world_time', 'metadata',
		],
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
	sagas: {
		table: 'sagas',
		idColumn: 'id',
		storyColumn: 'story_id',
		updatedColumn: 'updated_at',
		searchColumns: ['title', 'summary', 'overall_tone'],
		editableColumns: {
			number: 'number',
			title: 'title',
			summary: 'summary',
			arcIds: 'arc_ids',
			keyFactionShifts: 'key_faction_shifts',
			majorPowerChanges: 'major_power_changes',
			lingeringThreads: 'lingering_threads',
			overallTone: 'overall_tone',
			sourceEventIds: 'source_event_ids',
			openThreadIds: 'open_thread_ids',
			metadata: 'metadata',
		},
		jsonColumns: jsonColumns('arc_ids', 'key_faction_shifts', 'major_power_changes', 'lingering_threads', 'source_event_ids', 'open_thread_ids', 'metadata'),
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

	if (['entities', 'characters', 'locations', 'items', 'concepts'].includes(type)) add(String(record.id));
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

async function queueManualRecordPatchJobs(input: { storyId: string; serverVersion: number; type: string; recordId: string }, tx: Parameters<typeof enqueueStoryVaultSyncJob>[1]) {
 if (['jobs', 'searchIndex', 'apiCallLogs'].includes(input.type)) return;
 const indexType = ['characters', 'locations', 'items', 'concepts'].includes(input.type) ? 'entities' : input.type;
 await enqueueStoryVaultSyncJob({ storyId: input.storyId, serverVersion: input.serverVersion, reason: 'manual-record-edit', payload: { recordType: input.type, recordId: input.recordId } }, tx);
 await enqueueBackendJob({ storyId: input.storyId, type: 'index_canonical_records', dedupeKey: `record-edit-index-${input.storyId}-${input.type}-${input.recordId}-${input.serverVersion}`, payload: { recordTypes: [indexType], recordId: input.recordId, reason: 'manual_record_edit' }, maxAttempts: 3 }, tx);
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

function normalizeEditableValue(recordType: string, column: string, value: unknown): unknown {
	if (recordType !== 'memoryNodes') return value;
	if (column === 'type') return memoryNodeTypeSchema.parse(value);
	if (column === 'importance') return memoryImportanceSchema.parse(value);
	if (column === 'visibility') return memoryVisibilitySchema.parse(value);
	return value;
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
	if (type === 'locations') filters.push(sql`coalesce(metadata->>'mergedInto', '') = ''`);
	if (type === 'patchProposals' && !query) {
		filters.push(sql`${sql.raw(q('status'))} in ('pending', 'needs_review')`);
		filters.push(sql`${sql.raw(q('proposal_type'))} in ('character_reference_review', 'entity_reference_review', 'character_context_update', 'faction_project_due_resolution', 'faction_project_blocked_resolution')`);
	}
	if (query) {
		const like = `%${query}%`;
		filters.push(sql`(${sql.join(spec.searchColumns.map((column) => sql`${sql.raw(q(column))}::text ilike ${like}`), sql` or `)})`);
	}
	const exactLocationFirst = type === 'locations' && query ? sql`case when lower(trim(name)) = lower(${query}) then 0 else 1 end, ` : sql``;
	const order = spec.updatedColumn
		? sql`order by ${exactLocationFirst}${sql.raw(q(spec.updatedColumn))} desc, ${sql.raw(q(spec.idColumn))} asc`
		: sql`order by ${sql.raw(q(spec.idColumn))} asc`;
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

export async function getWorldRecord(storyId: string, type: string, recordId: string) {
	const spec = specFor(type);
	const filters = [sql`${sql.raw(q(spec.idColumn))} = ${recordId}`];
	if (storyId !== '__app__') filters.push(sql`${sql.raw(q(spec.storyColumn))} = ${storyId}`);
	for (const [column, value] of Object.entries(spec.fixedFilters ?? {})) filters.push(sql`${sql.raw(q(column))} = ${value}`);
	const rows = await getDb().execute(sql`
		select *
		from ${sql.raw(q(spec.table))}
		where ${sql.join(filters, sql` and `)}
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

async function validateRecordReferences(tx: Pick<ReturnType<typeof getDb>, 'execute'>, storyId: string, edits: Array<{ column: string; value: unknown }>) {
	const referenceTables: Record<string, string> = {
		entity_id: 'entities', source_entity_id: 'entities', target_entity_id: 'entities', subject_entity_id: 'entities', npc_entity_id: 'entities', current_location_id: 'entities', location_id: 'entities',
		entity_ids: 'entities', member_entity_ids: 'entities', actor_entity_ids: 'entities', target_entity_ids: 'entities', location_ids: 'entities', territory_ids: 'entities', affected_entity_ids: 'entities', related_entity_ids: 'entities', actor_ids: 'entities',
		faction_id: 'factions', faction_ids: 'factions', related_faction_ids: 'factions', allies: 'factions', enemies: 'factions',
		event_id: 'story_events', source_event_ids: 'story_events', source_entry_ids: 'story_entries', first_seen_entry_id: 'story_entries', parent_id: 'story_entries',
		source_patch_ids: 'state_patches', thread_ids: 'story_threads', open_thread_ids: 'story_threads', chapter_ids: 'chapters', arc_ids: 'arcs',
	};
	for (const edit of edits) {
		const table = referenceTables[edit.column];
		if (!table || edit.value === null) continue;
		const ids = [...new Set(Array.isArray(edit.value) ? edit.value as string[] : [String(edit.value)])];
		if (!ids.length) continue;
		const rows = await tx!.execute(sql`select id from ${sql.raw(q(table))} where story_id = ${storyId} and id in (${sql.join(ids.map(value => sql`${value}`), sql`, `)})`);
		if (rows.length !== ids.length) throw new MutationError('INVALID_REFERENCE', 'Referenced records must exist in the same game.', { field: edit.column });
	}
}

export async function patchWorldRecord(storyId: string, type: string, recordId: string, request: RecordPatchRequest, actor: MutationActor = { role: 'client', id: 'local-client' }, transaction?: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]) {
	request = recordPatchRequestSchema.parse(request);
	const spec = specFor(type);
	if (Object.hasOwn(request.updates, 'playerCapabilities') && Object.hasOwn(request.updates, 'state')) throw new Error('Edit playerCapabilities separately from state.');
	if (Object.hasOwn(request.updates, 'playerCapabilities') && storyId === '__app__') throw new Error('A concrete story ID is required for player capabilities.');
	if (!['human', 'client'].includes(actor.role)) throw new MutationError('TOOL_UNAVAILABLE', 'Agent record writes are not enabled until the scoped tool dispatcher is implemented.');
	const editable = Object.entries(request.updates)
		.map(([key, value]) => {
      if(key==='contentFields'&&['characters','locations','items','factions'].includes(type))return {key,value,column:'metadata'};
			if (type === 'characters' && key === 'playerCapabilities') return { key, value: playerCapabilitiesUpdateSchema.parse(value), column: 'state' };
			const column = editableColumnForKey(spec, key);
			if (!column) throw new MutationError('INVALID_FIELD', `Field is not editable: ${key}`);
			return { key, value: normalizeEditableValue(type, column, validateRecordField(type, column, value, spec.jsonColumns?.has(column) ?? false)), column };
		})
		.filter((item): item is { key: string; value: unknown; column: string } => Boolean(item.column));
	if (editable.length === 0) throw new Error('No editable fields were supplied.');

	if (new Set(editable.map(item => item.column)).size !== editable.length) throw new MutationError('INVALID_FIELD', 'Do not supply both field aliases in one update.');
	const updatedAt = nowIso();
	const patchId = id('manual_patch');
	const proposalId = id('manual_proposal');
	const db = getDb();
	const mutate = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
		const filters = [sql`${sql.raw(q(spec.idColumn))} = ${recordId}`];
		if (storyId !== '__app__') filters.push(sql`${sql.raw(q(spec.storyColumn))} = ${storyId}`);
		for (const [column, value] of Object.entries(spec.fixedFilters ?? {})) filters.push(sql`${sql.raw(q(column))} = ${value}`);
		const existingRows = await tx.execute(sql`
			select *
			from ${sql.raw(q(spec.table))}
			where ${sql.join(filters, sql` and `)}
			limit 1
			for update
		`);
		const existing = existingRows[0] as JsonRecord | undefined;
		if (!existing) throw new Error(`Record not found: ${type}/${recordId}`);
		assertExpectedRevision(existing, request, spec.versionColumn !== null);
		for (const item of editable) {
			if (item.key !== 'playerCapabilities' && item.key !== 'contentFields' && spec.jsonColumns?.has(item.column) && request.jsonMode !== 'replace') item.value = mergeJsonUpdate(existing[item.column], item.value);
		}
    const contentFieldsEdit=editable.find(item=>item.key==='contentFields');
    if(contentFieldsEdit)contentFieldsEdit.value=validateRecordField(type,'metadata',{...asObject(existing.metadata),contentFields:contentFieldsEdit.value},true);
		const extensionEdit=editable.find(item=>item.column==='metadata');
    if(extensionEdit&&['characters','locations','items','factions'].includes(type))extensionValues(await canonicalExtensionDefinition(tx,String(existing.story_id),type),extensionEdit.value);
		if (type === 'stories') {
			const settingEdit = editable.find(item => item.column === 'settings');
			const currentAgentTools = asObject(existing.settings).agentTools;
			if (settingEdit && currentAgentTools !== undefined) {
				const provided = asObject(settingEdit.value).agentTools;
				if (provided !== undefined && JSON.stringify(provided) !== JSON.stringify(currentAgentTools)) throw new MutationError('INVALID_FIELD', 'Edit agent preferences through settings.agent.save.');
				settingEdit.value = { ...asObject(settingEdit.value), agentTools: currentAgentTools };
			}
		}
		const capabilityEdit = editable.find(item => item.key === 'playerCapabilities');
		if (capabilityEdit) {
			const state = asObject(existing.state);
			const metadata = { ...asObject(asObject(existing.metadata).originalMetadata), ...asObject(existing.metadata) };
			const relationship = typeof state.relationship === 'string' ? state.relationship : asObject(state.relationship).status;
			const isPlayer = ['self', 'player_character'].includes(String(relationship)) || state.isProtagonist === true || metadata.isProtagonist === true || metadata.playerCharacter === true;
			if (existing.type !== 'character' || !isPlayer) throw new Error('Player capabilities require the canonical player character ID.');
			const current = readPlayerCapabilities(state.playerCapabilities ?? metadata.playerCapabilities);
			capabilityEdit.value = { ...state, playerCapabilities: playerCapabilitiesSchema.parse({ ...current, ...asObject(capabilityEdit.value) }) };
		}
		const operations = editable.map(({ key, column, value }) => ({
			op: 'replace',
			path: `/${type}/${recordId}/${key === 'playerCapabilities' ? 'state/playerCapabilities' : key}`,
			value: key === 'playerCapabilities' ? asObject(value).playerCapabilities : key === 'contentFields' ? asObject(value).contentFields : value,
			source: 'manual_edit',
			previousValue: key === 'playerCapabilities' ? asObject(existing.state).playerCapabilities ?? null : key === 'contentFields' ? asObject(existing.metadata).contentFields ?? null : existing[column] ?? null,
		}));
		if (type === 'relationships' && (existing.type === 'part-of' || editable.some(item => item.column === 'type' && item.value === 'part-of'))) {
			const endpoints = [existing.source_entity_id, existing.target_entity_id, ...editable.filter(item => ['source_entity_id', 'target_entity_id'].includes(item.column)).map(item => item.value)].filter((value): value is string => typeof value === 'string');
			const locationEndpoints = endpoints.length ? await tx.execute(sql`select id from entities where story_id = ${String(existing.story_id)} and type = 'location' and id in (${sql.join(endpoints.map(value => sql`${value}`), sql`, `)}) limit 1`) : [];
			if (locationEndpoints.length) throw new Error('Edit physical containment through the location workspace so ancestry, revision and history checks run together.');
		}
		if (type === 'facts' && (asObject(existing.metadata).locationLore !== undefined
			|| editable.some(item => item.column === 'metadata' && asObject(item.value).locationLore !== undefined))) {
			throw new Error('Revise scoped location lore at its owning location to preserve its effective dates and earlier versions.');
		}

		const recordStoryId = String(existing[spec.storyColumn] ?? '');
		if (!recordStoryId) throw new Error(`Record ${type}/${recordId} is missing story scope.`);
		await validateRecordReferences(tx, recordStoryId, editable);
		const versionRows = await tx.execute(sql`
			update stories
			set server_version = server_version + 1,
				updated_at = ${updatedAt}
			where id = ${recordStoryId}
			returning server_version
		`);
		const serverVersion = Number((versionRows[0] as JsonRecord | undefined)?.server_version);
		if (!Number.isFinite(serverVersion)) throw new Error(`Story not found: ${recordStoryId}`);

		await tx.insert(statePatches).values({
			id: patchId,
			storyId: recordStoryId,
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
		await tx.insert(patchProposals).values({
			id: proposalId,
			storyId: recordStoryId,
			proposalType: 'manual_edit',
			targetTable: spec.table,
			targetRecordId: recordId,
			proposedBy: actor.role,
			operations,
			reason: request.reason || 'Manual explorer edit.',
			suggestion: 'Review the manual edit before treating the record as canonical.',
			status: 'applied',
			decision: 'approved',
			validatedBy: actor.role === 'human' ? 'human' : 'schema_validator',
			affectedEntityIds,
			confidence: 1,
			sourceEntryIds: [],
			sourceEventIds: [],
			sourcePatchIds: [patchId],
			metadata: {
				sourceType: 'manual_edit',
				recordType: type,
				actor,
				priorVersion: existing.server_version ?? null,
				before: existing,
				after: { ...existing, ...Object.fromEntries(editable.map(item => [item.column, item.value])), server_version: serverVersion, updated_at: updatedAt },
			},
			serverVersion,
			createdAt: updatedAt,
			updatedAt,
		});
		await tx.insert(sourceRefs).values({
			id: id('sourceref_manual'),
			storyId: recordStoryId,
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
		await tx.insert(sourceRefs).values({
			id: id('sourceref_manual_target'),
			storyId: recordStoryId,
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

		const rows = await tx.execute(sql`
			update ${sql.raw(q(spec.table))}
			set ${sql.join(setClauses, sql`, `)}
			where ${sql.raw(q(spec.idColumn))} = ${recordId}
			returning *
		`);
		await queueManualRecordPatchJobs({ storyId: recordStoryId, serverVersion, type, recordId }, tx);
		return {
			storyId: recordStoryId,
			type,
			record: rows[0] as JsonRecord,
			patchId,
			serverVersion,
		};
	};
	return transaction ? mutate(transaction) : db.transaction(mutate);
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

/** Explicit authoring creates a new identity; it must never resolve or merge by name. */
export async function createWorldRecord(storyId:string,type:string,fields:JsonRecord,transaction:Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],reason='Canonical workspace creation.') {
  if (!['characters','locations','items','factions'].includes(type) || storyId==='__app__') throw new MutationError('INVALID_FIELD','A supported canonical kind and concrete game are required.');
  const name=typeof fields.name==='string'?fields.name.trim():'';
  if (!name || name.length>500) throw new MutationError('INVALID_FIELD','A name of 1–500 characters is required.');
  if(fields.contentFields!==undefined){fields={...fields,metadata:{...asObject(fields.metadata),contentFields:fields.contentFields}};delete fields.contentFields;}
  const definition=await canonicalExtensionDefinition(transaction,storyId,type);
  if(Object.keys(definition.fields??{}).length||asObject(fields.metadata).contentFields!==undefined)fields={...fields,metadata:{...asObject(fields.metadata),contentFields:extensionValues(definition,fields.metadata,true)}};
  const spec=specFor(type),recordId=id(type==='factions'?'faction':'entity');
  // The insert, validated patch, history, audit and outbox share the caller's transaction.
  const columns=['id','story_id','name',...Object.keys(spec.fixedFilters??{})];
  const values=[recordId,storyId,name,...Object.values(spec.fixedFilters??{})];
  const [initial]=await transaction.execute(sql`insert into ${sql.raw(q(spec.table))} (${sql.join(columns.map(column=>sql.raw(q(column))),sql`, `)}) values (${sql.join(values.map(value=>sql`${value}`),sql`, `)}) returning *`);
  const result=await patchWorldRecord(storyId,type,recordId,{updates:{...fields,name},expectedVersion:Number(initial.server_version),jsonMode:'replace',reason},{role:'client',id:'local-client'},transaction);
  if(type!=='factions') await transaction.execute(sql`insert into entity_aliases(id,story_id,entity_id,alias,normalized_alias,server_version) select ${id('alias')},${storyId},${recordId},${name},trim(regexp_replace(lower(${name}), '[^a-z0-9]+', ' ', 'g')),${result.serverVersion} where trim(regexp_replace(lower(${name}), '[^a-z0-9]+', ' ', 'g'))<>''`);
  return result.record;
}
