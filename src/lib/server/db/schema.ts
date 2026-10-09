import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	foreignKey,
	customType,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	real,
	text,
	timestamp,
	uniqueIndex,
	unique,
} from 'drizzle-orm/pg-core';

const jsonArray = sql`'[]'::jsonb`;
const jsonObject = sql`'{}'::jsonb`;

export const pgVector = customType<{
	data: number[];
	driverData: string;
	config: { dimensions?: number };
}>({
	dataType(config) {
		return config?.dimensions ? `vector(${config.dimensions})` : 'vector';
	},
	toDriver(value) {
		return `[${value.join(',')}]`;
	},
	fromDriver(value) {
		if (Array.isArray(value)) return value.map(Number);
		return String(value)
			.replace(/^\[|\]$/g, '')
			.split(',')
			.map((item) => Number(item.trim()))
			.filter((item) => Number.isFinite(item));
	},
});

const syncColumns = {
	serverVersion: integer('server_version').notNull().default(1),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
};

export const shelves = pgTable('shelves', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').notNull(),
	description: text('description'),
	genre: text('genre'),
	coverImageUrl: text('cover_image_url'),
	settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default(jsonObject),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	nameIdx: index('shelves_name_idx').on(table.name),
	slugIdx: uniqueIndex('shelves_slug_idx').on(table.slug),
	updatedAtIdx: index('shelves_updated_at_idx').on(table.updatedAt),
}));

export const stories = pgTable('stories', {
	id: text('id').primaryKey(),
	shelfId: text('shelf_id').notNull().default('shelf_default').references(() => shelves.id, { onDelete: 'cascade' }),
	clientStoryId: text('client_story_id'),
	title: text('title').notNull(),
	description: text('description'),
	genre: text('genre'),
	mode: text('mode').notNull().default('adventure'),
	role: text('role').notNull().default('playable'),
	timelineMode: text('timeline_mode').notNull().default('overlay'),
	settings: jsonb('settings').$type<Record<string, unknown> | null>().default(null),
	headerPrompt: text('header_prompt'),
	currentLocationId: text('current_location_id'),
	currentTurn: integer('current_turn').notNull().default(0),
	currentWorldTime: text('current_world_time'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	clientStoryIdx: index('stories_client_story_id_idx').on(table.clientStoryId),
	projectIdentity: unique('stories_project_identity').on(table.shelfId, table.id),
	shelfIdx: index('stories_shelf_idx').on(table.shelfId),
	shelfUpdatedIdx: index('stories_shelf_updated_idx').on(table.shelfId, table.updatedAt),
	updatedAtIdx: index('stories_updated_at_idx').on(table.updatedAt),
}));

export const storyEntries = pgTable('story_entries', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	type: text('type').notNull(),
	content: text('content').notNull(),
	position: integer('position').notNull(),
	parentId: text('parent_id'),
	branchId: text('branch_id'),
	metadata: jsonb('metadata').$type<Record<string, unknown> | null>().default(null),
	...syncColumns,
}, (table) => ({
	storyPositionIdx: uniqueIndex('story_entries_story_position_unique_idx').on(table.storyId, table.position),
	contentSearchIdx: index('story_entries_content_fts_idx').using('gin', sql`to_tsvector('english', coalesce(${table.content}, ''))`),
}));

export const entities = pgTable('entities', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	type: text('type').notNull(),
	name: text('name').notNull(),
	description: text('description'),
	status: text('status').notNull().default('active'),
	visibility: text('visibility').notNull().default('player_known'),
	state: jsonb('state').$type<Record<string, unknown>>().notNull().default(jsonObject),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	...syncColumns,
}, (table) => ({
	storyTypeIdx: index('entities_story_type_idx').on(table.storyId, table.type),
	storyNameIdx: index('entities_story_name_idx').on(table.storyId, table.name),
}));

export const locationMaps = pgTable('location_maps', {
  locationId: text('location_id').primaryKey().references(() => entities.id, { onDelete: 'cascade' }),
  storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(), map: jsonb('map').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, t => ({ storyIdx: index('location_maps_story_idx').on(t.storyId), revisionCheck: check('location_maps_revision_check', sql`${t.revision}>0`) }));
export const locationMapRevisions = pgTable('location_map_revisions', {
  locationId: text('location_id').notNull().references(() => locationMaps.locationId, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(), snapshot: jsonb('snapshot').notNull(), actor: jsonb('actor').notNull(),
  reason: text('reason').notNull(), createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, t => ({ identity: primaryKey({ columns: [t.locationId, t.revision] }), revisionCheck: check('location_map_revisions_revision_check', sql`${t.revision}>0`) }));

export const entityAliases = pgTable('entity_aliases', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	entityId: text('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
	alias: text('alias').notNull(),
	normalizedAlias: text('normalized_alias').notNull(),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	...syncColumns,
}, (table) => ({
	aliasIdx: index('entity_aliases_story_alias_idx').on(table.storyId, table.normalizedAlias),
	normalizedAliasCheck: check('entity_aliases_normalized_alias_check', sql`${table.normalizedAlias} = trim(regexp_replace(lower(${table.alias}), '[^a-z0-9]+', ' ', 'g'))`),
}));

export const relationships = pgTable('relationships', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	sourceEntityId: text('source_entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
	targetEntityId: text('target_entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
	type: text('type').notNull(),
	label: text('label'),
	strength: real('strength').notNull().default(0.5),
	bidirectional: boolean('bidirectional').notNull().default(false),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	...syncColumns,
}, (table) => ({
	sourceIdx: index('relationships_source_idx').on(table.storyId, table.sourceEntityId),
	targetIdx: index('relationships_target_idx').on(table.storyId, table.targetEntityId),
}));

export const factions = pgTable('factions', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	entityId: text('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	goals: jsonb('goals').$type<string[]>().notNull().default(jsonArray),
	resources: jsonb('resources').$type<Record<string, unknown>>().notNull().default(jsonObject),
	memberEntityIds: jsonb('member_entity_ids').$type<string[]>().notNull().default(jsonArray),
	territoryIds: jsonb('territory_ids').$type<string[]>().notNull().default(jsonArray),
	allies: jsonb('allies').$type<string[]>().notNull().default(jsonArray),
	enemies: jsonb('enemies').$type<string[]>().notNull().default(jsonArray),
	pressure: integer('pressure').notNull().default(0),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	...syncColumns,
}, (table) => ({
	storyIdx: index('factions_story_idx').on(table.storyId),
	entityIdx: index('factions_entity_idx').on(table.entityId),
}));

export const factionMemberships = pgTable('faction_memberships', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	factionId: text('faction_id').notNull().references(() => factions.id, { onDelete: 'cascade' }),
	entityId: text('entity_id').references(() => entities.id, { onDelete: 'set null' }),
	role: text('role').notNull().default('member'),
	rank: text('rank'),
	status: text('status').notNull().default('active'),
	visibility: text('visibility').notNull().default('player_known'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	...syncColumns,
}, (table) => ({
	factionIdx: index('faction_memberships_faction_idx').on(table.storyId, table.factionId),
	entityIdx: index('faction_memberships_entity_idx').on(table.storyId, table.entityId),
}));

export const factionResources = pgTable('faction_resources', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	factionId: text('faction_id').notNull().references(() => factions.id, { onDelete: 'cascade' }),
	kind: text('kind').notNull(),
	name: text('name').notNull(),
	amount: real('amount'),
	status: text('status').notNull().default('available'),
	locationId: text('location_id'),
	visibility: text('visibility').notNull().default('player_known'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	...syncColumns,
}, (table) => ({
	factionIdx: index('faction_resources_faction_idx').on(table.storyId, table.factionId),
	kindIdx: index('faction_resources_kind_idx').on(table.storyId, table.kind),
}));

export const factionGoals = pgTable('faction_goals', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	factionId: text('faction_id').notNull().references(() => factions.id, { onDelete: 'cascade' }),
	goal: text('goal').notNull(),
	status: text('status').notNull().default('active'),
	priority: integer('priority').notNull().default(5),
	secrecy: text('secrecy').notNull().default('player_known'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	...syncColumns,
}, (table) => ({
	factionIdx: index('faction_goals_faction_idx').on(table.storyId, table.factionId),
	statusIdx: index('faction_goals_status_idx').on(table.storyId, table.status),
}));

export const factionProjects = pgTable('faction_projects', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	factionId: text('faction_id').notNull().references(() => factions.id, { onDelete: 'cascade' }),
	project: text('project').notNull(),
	status: text('status').notNull().default('planned'),
	progress: real('progress').notNull().default(0),
	priority: integer('priority').notNull().default(5),
	dueTurn: integer('due_turn'),
	worldTime: text('world_time'),
	costs: jsonb('costs').$type<Record<string, unknown>>().notNull().default(jsonObject),
	gains: jsonb('gains').$type<Record<string, unknown>>().notNull().default(jsonObject),
	risks: jsonb('risks').$type<string[]>().notNull().default(jsonArray),
	visibility: text('visibility').notNull().default('player_known'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	...syncColumns,
}, (table) => ({
	factionIdx: index('faction_projects_faction_idx').on(table.storyId, table.factionId),
	statusIdx: index('faction_projects_status_idx').on(table.storyId, table.status),
	dueTurnIdx: index('faction_projects_due_turn_idx').on(table.storyId, table.dueTurn),
}));

export const npcBeliefs = pgTable('npc_beliefs', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	believerEntityId: text('believer_entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
	subjectEntityId: text('subject_entity_id'),
	belief: text('belief').notNull(),
	confidence: real('confidence').notNull().default(0.5),
	visibility: text('visibility').notNull().default('secret'),
	evidenceEventIds: jsonb('evidence_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	...syncColumns,
}, (table) => ({
	believerIdx: index('npc_beliefs_believer_idx').on(table.storyId, table.believerEntityId),
}));

export const agreements = pgTable('agreements', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	parties: jsonb('parties').$type<string[]>().notNull().default(jsonArray),
	category: text('category').notNull(),
	terms: text('terms').notNull(),
	status: text('status').notNull().default('active'),
	secrecy: text('secrecy').notNull().default('known'),
	consequences: jsonb('consequences').$type<string[]>().notNull().default(jsonArray),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	...syncColumns,
}, (table) => ({
	storyStatusIdx: index('agreements_story_status_idx').on(table.storyId, table.status),
}));

export const storyThreads = pgTable('story_threads', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	description: text('description').notNull(),
	status: text('status').notNull().default('open'),
	significance: text('significance').notNull().default('moderate'),
	relatedFactionIds: jsonb('related_faction_ids').$type<string[]>().notNull().default(jsonArray),
	relatedEntityIds: jsonb('related_entity_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),
	closureReason: text('closure_reason'),
	...syncColumns,
}, (table) => ({
	storyStatusIdx: index('story_threads_story_status_idx').on(table.storyId, table.status),
}));

export const storyEvents = pgTable('story_events', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	type: text('type').notNull(),
	status: text('status').notNull().default('committed'),
	title: text('title').notNull(),
	body: text('body').notNull(),
	actorEntityIds: jsonb('actor_entity_ids').$type<string[]>().notNull().default(jsonArray),
	targetEntityIds: jsonb('target_entity_ids').$type<string[]>().notNull().default(jsonArray),
	locationId: text('location_id'),
	locationIds: jsonb('location_ids').$type<string[]>().notNull().default(jsonArray),
	factionIds: jsonb('faction_ids').$type<string[]>().notNull().default(jsonArray),
	threadIds: jsonb('thread_ids').$type<string[]>().notNull().default(jsonArray),
	visibility: text('visibility').notNull().default('player_known'),
	createdTurn: integer('created_turn').notNull().default(0),
	occurredTurn: integer('occurred_turn'),
	scheduledTurn: integer('scheduled_turn'),
	worldTime: text('world_time'),
	memoryImpact: jsonb('memory_impact').$type<Record<string, unknown>>().notNull().default(jsonObject),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	storyTypeIdx: index('story_events_story_type_idx').on(table.storyId, table.type),
	storyStatusTurnIdx: index('story_events_story_status_turn_idx').on(table.storyId, table.status, table.scheduledTurn),
	storyOccurredTurnIdx: index('story_events_story_occurred_turn_idx').on(table.storyId, table.occurredTurn),
	updatedAtIdx: index('story_events_updated_at_idx').on(table.updatedAt),
}));

export const npcEventLinks = pgTable('npc_event_links', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	eventId: text('event_id').notNull().references(() => storyEvents.id, { onDelete: 'cascade' }),
	npcEntityId: text('npc_entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
	role: text('role').notNull().default('affected'),
	visibility: text('visibility').notNull().default('player_known'),
	evidenceStrength: real('evidence_strength').notNull().default(0.75),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	...syncColumns,
}, (table) => ({
	storyEventIdx: index('npc_event_links_story_event_idx').on(table.storyId, table.eventId),
	storyNpcIdx: index('npc_event_links_story_npc_idx').on(table.storyId, table.npcEntityId),
}));

export const statePatches = pgTable('state_patches', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	operations: jsonb('operations').$type<Array<Record<string, unknown>>>().notNull().default(jsonArray),
	reason: text('reason').notNull().default(''),
	status: text('status').notNull().default('proposed'),
	validationWarnings: jsonb('validation_warnings').$type<string[]>().notNull().default(jsonArray),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	...syncColumns,
}, (table) => ({
	storyStatusIdx: index('state_patches_story_status_idx').on(table.storyId, table.status),
}));

export const facts = pgTable('facts', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	type: text('type').notNull().default('observation'),
	subjectEntityId: text('subject_entity_id').references(() => entities.id, { onDelete: 'set null' }),
	targetEntityId: text('target_entity_id').references(() => entities.id, { onDelete: 'set null' }),
	title: text('title').notNull(),
	statement: text('statement').notNull(),
	confidence: real('confidence').notNull().default(1),
	status: text('status').notNull().default('active'),
	visibility: text('visibility').notNull().default('player_known'),
	firstSeenEntryId: text('first_seen_entry_id'),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	storyTypeIdx: index('facts_story_type_idx').on(table.storyId, table.type),
	subjectEntityIdx: index('facts_subject_entity_idx').on(table.storyId, table.subjectEntityId),
	statusIdx: index('facts_story_status_idx').on(table.storyId, table.status),
}));

export const sourceRefs = pgTable('source_refs', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	sourceType: text('source_type').notNull(),
	sourceId: text('source_id').notNull(),
	targetTable: text('target_table').notNull(),
	targetRecordId: text('target_record_id').notNull(),
	targetRecordField: text('target_record_field'),
	sourceField: text('source_field'),
	confidence: real('confidence').notNull().default(1),
	rationale: text('rationale'),
	notes: text('notes'),
	serverVersion: integer('server_version').notNull().default(1),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => ({
	storySourceIdx: index('source_refs_story_source_idx').on(table.storyId, table.sourceType, table.sourceId),
	storyTargetIdx: index('source_refs_story_target_idx').on(table.storyId, table.targetTable, table.targetRecordId),
}));

export const patchProposals = pgTable('patch_proposals', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	proposalType: text('proposal_type').notNull(),
	targetTable: text('target_table').notNull(),
	targetRecordId: text('target_record_id').notNull(),
	proposedBy: text('proposed_by').notNull().default('llm'),
	operations: jsonb('operations').$type<Array<Record<string, unknown>>>().notNull().default(jsonArray),
	reason: text('reason').notNull().default(''),
	suggestion: text('suggestion').notNull().default(''),
	status: text('status').notNull().default('pending'),
	decision: text('decision'),
	validatedBy: text('validated_by'),
	affectedEntityIds: jsonb('affected_entity_ids').$type<string[]>().notNull().default(jsonArray),
	confidence: real('confidence').notNull().default(0.75),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	storyStatusIdx: index('patch_proposals_story_status_idx').on(table.storyId, table.status),
	targetIdx: index('patch_proposals_target_idx').on(table.storyId, table.targetTable, table.targetRecordId),
}));

export const continuityWarnings = pgTable('continuity_warnings', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	warningType: text('warning_type').notNull(),
	level: text('level').notNull().default('warning'),
	title: text('title').notNull(),
	status: text('status').notNull().default('open'),
	details: text('details').notNull(),
	entityIds: jsonb('entity_ids').$type<string[]>().notNull().default(jsonArray),
	factionIds: jsonb('faction_ids').$type<string[]>().notNull().default(jsonArray),
	threadIds: jsonb('thread_ids').$type<string[]>().notNull().default(jsonArray),
	actorIds: jsonb('actor_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	resolutionNotes: text('resolution_notes'),
	resolvedBy: text('resolved_by'),
	resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	storyStatusIdx: index('continuity_warnings_story_status_idx').on(table.storyId, table.status),
	storyLevelIdx: index('continuity_warnings_story_level_idx').on(table.storyId, table.level),
	levelCheck: check('continuity_warnings_level_check', sql`${table.level} in ('info', 'warning', 'error')`),
	statusCheck: check('continuity_warnings_status_check', sql`${table.status} in ('open', 'resolved', 'dismissed')`),
}));

export const memoryNodes = pgTable('memory_nodes', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	type: text('type').notNull(),
	title: text('title').notNull(),
	content: text('content').notNull(),
	summary: text('summary'),
	keywords: jsonb('keywords').$type<string[]>().notNull().default(jsonArray),
	entityIds: jsonb('entity_ids').$type<string[]>().notNull().default(jsonArray),
	factionIds: jsonb('faction_ids').$type<string[]>().notNull().default(jsonArray),
	threadIds: jsonb('thread_ids').$type<string[]>().notNull().default(jsonArray),
	locationId: text('location_id'),
	visibility: text('visibility').notNull().default('player_known'),
	importance: real('importance').notNull().default(0.5),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	embedding: pgVector('embedding'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	storyTypeIdx: index('memory_nodes_story_type_idx').on(table.storyId, table.type),
	storyLocationIdx: index('memory_nodes_story_location_idx').on(table.storyId, table.locationId),
	typeCheck: check('memory_nodes_type_check', sql`${table.type} in ('hot', 'canonical', 'episodic', 'plot_ledger', 'npc_belief', 'faction', 'procedural')`),
	importanceCheck: check('memory_nodes_importance_check', sql`${table.importance} >= 0 and ${table.importance} <= 1`),
}));

export const chapters = pgTable('chapters', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	number: integer('number').notNull(),
	title: text('title'),
	sceneOutcome: text('scene_outcome').notNull().default(''),
	irreversibleChanges: jsonb('irreversible_changes').$type<string[]>().notNull().default(jsonArray),
	npcKnowledgeChanges: jsonb('npc_knowledge_changes').$type<Array<Record<string, unknown>>>().notNull().default(jsonArray),
	promisesDebtsOaths: jsonb('promises_debts_oaths').$type<string[]>().notNull().default(jsonArray),
	discoveredClues: jsonb('discovered_clues').$type<string[]>().notNull().default(jsonArray),
	relationshipChanges: jsonb('relationship_changes').$type<string[]>().notNull().default(jsonArray),
	factionChanges: jsonb('faction_changes').$type<string[]>().notNull().default(jsonArray),
	openThreads: jsonb('open_threads').$type<string[]>().notNull().default(jsonArray),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	storyNumberIdx: index('chapters_story_number_idx').on(table.storyId, table.number),
}));

export const arcs = pgTable('arcs', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	number: integer('number').notNull(),
	title: text('title').notNull(),
	summary: text('summary').notNull(),
	chapterIds: jsonb('chapter_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	openThreadIds: jsonb('open_thread_ids').$type<string[]>().notNull().default(jsonArray),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	storyNumberIdx: index('arcs_story_number_idx').on(table.storyId, table.number),
}));

export const sagas = pgTable('sagas', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	number: integer('number').notNull(),
	title: text('title').notNull(),
	summary: text('summary').notNull(),
	arcIds: jsonb('arc_ids').$type<string[]>().notNull().default(jsonArray),
	keyFactionShifts: jsonb('key_faction_shifts').$type<string[]>().notNull().default(jsonArray),
	majorPowerChanges: jsonb('major_power_changes').$type<string[]>().notNull().default(jsonArray),
	lingeringThreads: jsonb('lingering_threads').$type<string[]>().notNull().default(jsonArray),
	overallTone: text('overall_tone').notNull().default(''),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	openThreadIds: jsonb('open_thread_ids').$type<string[]>().notNull().default(jsonArray),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	storyNumberIdx: index('sagas_story_number_idx').on(table.storyId, table.number),
}));

export const syncOps = pgTable('sync_ops', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	type: text('type').notNull(),
	payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(jsonObject),
	clientVersion: integer('client_version').notNull().default(0),
	status: text('status').notNull().default('applied'),
	error: text('error'),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const contextCheckpoints = pgTable('context_checkpoints', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	label: text('label').notNull(),
	reason: text('reason'),
	entryPosition: integer('entry_position').notNull().default(-1),
	currentTurn: integer('current_turn').notNull().default(0),
	snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull().default(jsonObject),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	storyUpdatedIdx: index('context_checkpoints_story_updated_idx').on(table.storyId, table.updatedAt),
	storyEntryIdx: index('context_checkpoints_story_entry_idx').on(table.storyId, table.entryPosition),
}));

export const backendJobs = pgTable('backend_jobs', {
	id: text('id').primaryKey(),
	projectId: text('project_id').notNull().references(() => shelves.id, { onDelete: 'cascade' }),
	storyId: text('story_id').references(() => stories.id, { onDelete: 'cascade' }),
	type: text('type').notNull(),
	payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(jsonObject),
	status: text('status').notNull().default('queued'),
	attemptCount: integer('attempt_count').notNull().default(0),
	maxAttempts: integer('max_attempts').notNull().default(5),
	runAfter: timestamp('run_after', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
	lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'string' }),
	lockedBy: text('locked_by'),
	lastError: text('last_error'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => ({
	projectStatusIdx: index('backend_jobs_project_status_idx').on(table.projectId, table.status),
	gameProject: foreignKey({ name: 'backend_jobs_game_project_fk', columns: [table.projectId, table.storyId], foreignColumns: [stories.shelfId, stories.id] }).onDelete('cascade'),
	scopeCheck: check('backend_jobs_scope_check', sql`(${table.storyId} is null and ${table.type} in ('validate_agent_settings', 'generate_image', 'assistant_batch_child')) or (${table.storyId} is not null and ${table.type} not in ('validate_agent_settings', 'assistant_batch_child'))`),
	storyStatusIdx: index('backend_jobs_story_status_idx').on(table.storyId, table.status),
	typeStatusIdx: index('backend_jobs_type_status_idx').on(table.type, table.status),
	runAfterIdx: index('backend_jobs_run_after_idx').on(table.status, table.runAfter),
}));

export const llmServiceSettings = pgTable('llm_service_settings', {
	serviceId: text('service_id').primaryKey(),
	providerType: text('provider_type').notNull(),
	baseUrl: text('base_url'),
	model: text('model'),
	temperature: real('temperature').notNull().default(1),
	maxTokens: integer('max_tokens').notNull().default(4096),
	topP: real('top_p'),
	frequencyPenalty: real('frequency_penalty'),
	presencePenalty: real('presence_penalty'),
	reasoningEffort: text('reasoning_effort'),
	contextBudget: integer('context_budget'),
	contextWindowTokens: integer('context_window_tokens'),
	enabled: boolean('enabled').notNull().default(true),
	systemPromptOverride: text('system_prompt_override'),
	apiKeyRef: text('api_key_ref'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const searchIndexRecords = pgTable('search_index_records', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	recordType: text('record_type').notNull(),
	recordId: text('record_id').notNull(),
	qdrantPointId: text('qdrant_point_id'),
	collection: text('collection').notNull(),
	contentHash: text('content_hash').notNull(),
	model: text('model'),
	status: text('status').notNull().default('queued'),
	error: text('error'),
	indexedAt: timestamp('indexed_at', { withTimezone: true, mode: 'string' }),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => ({
	storyRecordIdx: index('search_index_records_story_record_idx').on(table.storyId, table.recordType, table.recordId, table.collection),
	storyStatusIdx: index('search_index_records_story_status_idx').on(table.storyId, table.status),
	typeStatusIdx: index('search_index_records_type_idx').on(table.recordType, table.status),
}));

export const campaignFiles = pgTable('campaign_files', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
	path: text('path').notNull(),
	kind: text('kind').notNull(),
	contentHash: text('content_hash').notNull(),
	byteLength: integer('byte_length').notNull().default(0),
	serverVersion: integer('server_version').notNull().default(1),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => ({
	storyPathIdx: index('campaign_files_story_path_idx').on(table.storyId, table.path),
	storyKindIdx: index('campaign_files_story_kind_idx').on(table.storyId, table.kind),
	hashIdx: index('campaign_files_content_hash_idx').on(table.contentHash),
}));

export const engineCacheEntries = pgTable('engine_cache_entries', {
	id: text('id').primaryKey(),
	storyId: text('story_id').references(() => stories.id, { onDelete: 'cascade' }),
	cacheKey: text('cache_key').notNull(),
	kind: text('kind').notNull(),
	contentHash: text('content_hash').notNull(),
	value: text('value').notNull().default(''),
	tokenEstimate: integer('token_estimate').notNull().default(0),
	hitCount: integer('hit_count').notNull().default(0),
	missCount: integer('miss_count').notNull().default(0),
	dependencyHashes: jsonb('dependency_hashes').$type<string[]>().notNull().default(jsonArray),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	lastHitAt: timestamp('last_hit_at', { withTimezone: true, mode: 'string' }),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => ({
	storyKindIdx: index('engine_cache_entries_story_kind_idx').on(table.storyId, table.kind),
	cacheKeyIdx: index('engine_cache_entries_cache_key_idx').on(table.cacheKey),
	hashIdx: index('engine_cache_entries_content_hash_idx').on(table.contentHash),
}));

export const apiCallLogs = pgTable('api_call_logs', {
	id: text('id').primaryKey(),
	storyId: text('story_id').references(() => stories.id, { onDelete: 'cascade' }),
	serviceId: text('service_id'),
	operation: text('operation').notNull(),
	providerType: text('provider_type'),
	providerName: text('provider_name'),
	profileId: text('profile_id'),
	model: text('model'),
	endpoint: text('endpoint'),
	status: text('status').notNull().default('success'),
	durationMs: integer('duration_ms').notNull(),
	requestTokens: integer('request_tokens'),
	responseTokens: integer('response_tokens'),
	totalTokens: integer('total_tokens'),
	promptChars: integer('prompt_chars'),
	responseChars: integer('response_chars'),
	error: text('error'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => ({
	storyCreatedIdx: index('api_call_logs_story_created_idx').on(table.storyId, table.createdAt),
	serviceCreatedIdx: index('api_call_logs_service_created_idx').on(table.serviceId, table.createdAt),
	statusCreatedIdx: index('api_call_logs_status_created_idx').on(table.status, table.createdAt),
}));

export const canonicalContent = pgTable('canonical_content', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`), projectId: text('project_id').notNull().references(() => shelves.id, { onDelete: 'cascade' }), gameId: text('game_id').notNull(), kind: text('kind').notNull(), recordId: text('record_id').notNull(),
  folder: text('folder').notNull().default(''), slug: text('slug').notNull(), gmContextMode: text('gm_context_mode'), branchId: text('branch_id'), povCharacter: text('pov_character'), hidden: boolean('hidden').notNull().default(false), sourceDeleted: boolean('source_deleted').notNull().default(false), revision: integer('revision').notNull().default(1), adapterVersion: integer('adapter_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, t => ({ target: unique('canonical_content_target_unique').on(t.gameId,t.kind,t.recordId), path: unique('canonical_content_path_unique').on(t.gameId,t.kind,t.folder,t.slug),
  gameProject: foreignKey({ name: 'canonical_content_game_project_fk', columns: [t.projectId,t.gameId], foreignColumns: [stories.shelfId,stories.id] }).onDelete('cascade'),
  kind: check('canonical_content_kind_check',sql`${t.kind} in ('characters','locations','items','factions')`), mode: check('canonical_content_gm_context_mode_check',sql`${t.gmContextMode} in ('pinned','partial','searchable')`), revision: check('canonical_content_revision_check',sql`${t.revision}>0`), adapter: check('canonical_content_adapter_version_check',sql`${t.adapterVersion}=1`),
}));
export const canonicalContentHistory = pgTable('canonical_content_history', {
  contentId: text('content_id').notNull().references(() => canonicalContent.id, {onDelete:'cascade'}), revision: integer('revision').notNull(), snapshot: jsonb('snapshot').notNull(), actor: jsonb('actor').notNull(), reason: text('reason').notNull(), createdAt: timestamp('created_at', {withTimezone:true,mode:'string'}).notNull().defaultNow(),
}, t => ({ identity: primaryKey({ columns:[t.contentId,t.revision] }) }));

export const contentTypes = pgTable('content_types', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull().references(() => shelves.id, { onDelete: 'cascade' }),
  key: text('key').notNull(), extension: text('extension').notNull(), name: text('name').notNull(), definition: jsonb('definition').notNull(),
  revision: integer('revision').notNull().default(1), createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, t => ({ projectIdentity: unique('content_types_project_identity').on(t.projectId,t.id), keyUnique: unique('content_types_key_unique').on(t.projectId,t.key), extensionUnique: unique('content_types_extension_unique').on(t.projectId,t.extension), revisionCheck: check('content_types_revision_check',sql`${t.revision} > 0`) }));
export const assets = pgTable('assets', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull().references(() => shelves.id, { onDelete: 'cascade' }), gameId: text('game_id'),
  storageKey: text('storage_key').notNull().unique(), mediaType: text('media_type').notNull(), byteSize: integer('byte_size').notNull(), sha256: text('sha256').notNull(),
  visibility: text('visibility').notNull().default('gm'), originJobId: text('origin_job_id'), provider: text('provider'), model: text('model'),
  promptStyleRevision: integer('prompt_style_revision'), usage: jsonb('usage').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, t => ({ projectIdentity: unique('assets_project_identity').on(t.projectId,t.id),
  gameProject: foreignKey({ name: 'assets_game_project_fk', columns: [t.projectId,t.gameId], foreignColumns: [stories.shelfId,stories.id] }).onDelete('cascade'),
  scopeIdx: index('assets_scope_idx').on(t.projectId,t.gameId,t.createdAt), originJobUnique: uniqueIndex('assets_origin_job_unique').on(t.originJobId).where(sql`${t.originJobId} is not null`),
  typeCheck: check('assets_media_type_check',sql`${t.mediaType} in ('image/png','image/jpeg','image/webp')`),
  sizeCheck: check('assets_byte_size_check',sql`${t.byteSize} > 0 and ${t.byteSize} <= 10000000`),
  hashCheck: check('assets_sha256_check',sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  visibilityCheck: check('assets_visibility_check',sql`${t.visibility} in ('public','gm')`),
}));
export const contentItems = pgTable('content_items', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull().references(() => shelves.id, { onDelete: 'cascade' }), gameId: text('game_id'), typeId: text('type_id').notNull(),
  title: text('title').notNull(), description: text('description').notNull().default(''), folder: text('folder').notNull().default(''), slug: text('slug').notNull(), data: jsonb('data').notNull(),
  gmContextMode: text('gm_context_mode'), branchId: text('branch_id'), povCharacter: text('pov_character'), visibility: text('visibility').notNull().default('gm'), revision: integer('revision').notNull().default(1), coverAssetId: text('cover_asset_id'), coverRevision: integer('cover_revision').notNull().default(0), deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, t => ({ typeProject: foreignKey({ name: 'content_items_type_project_fk', columns: [t.projectId,t.typeId], foreignColumns: [contentTypes.projectId,contentTypes.id] }), gameProject: foreignKey({ name: 'content_items_game_project_fk', columns: [t.projectId,t.gameId], foreignColumns: [stories.shelfId,stories.id] }).onDelete('cascade'),
  coverAssetProject: foreignKey({ name: 'content_items_cover_asset_project_fk', columns: [t.projectId,t.coverAssetId], foreignColumns: [assets.projectId,assets.id] }), coverRevisionCheck: check('content_items_cover_revision_check',sql`${t.coverRevision} >= 0`),
  projectIdentity: unique('content_items_project_identity').on(t.projectId,t.id), scopeIdx: index('content_items_scope_idx').on(t.projectId,t.gameId),
  pathUnique: uniqueIndex('content_items_path_unique').on(t.projectId,sql`coalesce(${t.gameId},'')`,t.folder,t.slug,t.typeId).where(sql`${t.deletedAt} is null`),
  modeCheck: check('content_items_gm_context_mode_check',sql`${t.gmContextMode} in ('pinned','partial','searchable')`), visibilityCheck: check('content_items_visibility_check',sql`${t.visibility} in ('public','gm')`), revisionCheck: check('content_items_revision_check',sql`${t.revision} > 0`),
}));
export const contentRevisions = pgTable('content_revisions', {
  id: text('id').primaryKey(), projectId: text('project_id').notNull().references(() => shelves.id, { onDelete: 'cascade' }), targetKind: text('target_kind').notNull(), targetId: text('target_id').notNull(),
  revision: integer('revision').notNull(), priorRevision: integer('prior_revision'), typeRevision: integer('type_revision'), snapshot: jsonb('snapshot').notNull(), actor: jsonb('actor').notNull(), reason: text('reason').notNull(), createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, t=>({ identity: unique('content_revisions_identity').on(t.targetKind,t.targetId,t.revision), kindCheck: check('content_revisions_target_kind_check',sql`${t.targetKind} in ('type','item','folder')`) }));

export const canonicalTypeSettings=pgTable('canonical_type_settings',{
  projectId:text('project_id').notNull().references(()=>shelves.id,{onDelete:'cascade'}),kind:text('kind').notNull(),definition:jsonb('definition').notNull(),revision:integer('revision').notNull().default(0),updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),
},t=>({identity:primaryKey({columns:[t.projectId,t.kind]}),kind:check('canonical_type_settings_kind_check',sql`${t.kind} in ('characters','locations','items','factions')`),revision:check('canonical_type_settings_revision_check',sql`${t.revision}>=0`)}));
export const canonicalTypeHistory=pgTable('canonical_type_history',{
  projectId:text('project_id').notNull(),kind:text('kind').notNull(),revision:integer('revision').notNull(),definition:jsonb('definition').notNull(),actor:jsonb('actor').notNull(),reason:text('reason').notNull(),createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),
},t=>({identity:primaryKey({columns:[t.projectId,t.kind,t.revision]}),type:foreignKey({columns:[t.projectId,t.kind],foreignColumns:[canonicalTypeSettings.projectId,canonicalTypeSettings.kind]}).onDelete('cascade')}));
export const contentFolders=pgTable('content_folders',{
  archivedAt:timestamp('archived_at',{withTimezone:true,mode:'string'}),archiveReceipt:jsonb('archive_receipt'),
  id:text('id').primaryKey(),projectId:text('project_id').notNull().references(()=>shelves.id,{onDelete:'cascade'}),gameId:text('game_id'),path:text('path').notNull(),revision:integer('revision').notNull().default(1),createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),
},t=>({scope:foreignKey({columns:[t.projectId,t.gameId],foreignColumns:[stories.shelfId,stories.id]}).onDelete('cascade'),path:uniqueIndex('content_folders_path_unique').on(t.projectId,sql`coalesce(${t.gameId},'')`,t.path),pathLength:check('content_folders_path_check',sql`length(${t.path})>0 and length(${t.path})<=500`),revision:check('content_folders_revision_check',sql`${t.revision}>0`)}));
export const schema = {
  locationMaps, locationMapRevisions,
  contentFolders,
  canonicalTypeSettings,canonicalTypeHistory,
  canonicalContent, canonicalContentHistory,
  contentTypes, contentItems, contentRevisions,
	shelves,
	stories,
	storyEntries,
	entities,
	entityAliases,
	relationships,
	npcBeliefs,
	factions,
	factionMemberships,
	factionResources,
	factionGoals,
	factionProjects,
	agreements,
	storyThreads,
	storyEvents,
	npcEventLinks,
	statePatches,
	facts,
	sourceRefs,
	patchProposals,
	continuityWarnings,
	memoryNodes,
	chapters,
	arcs,
	sagas,
	syncOps,
	contextCheckpoints,
	backendJobs,
	llmServiceSettings,
	searchIndexRecords,
	campaignFiles,
	engineCacheEntries,
	apiCallLogs,
};
