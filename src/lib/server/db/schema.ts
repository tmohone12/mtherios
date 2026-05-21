import { sql } from 'drizzle-orm';
import {
	boolean,
	customType,
	index,
	integer,
	jsonb,
	pgTable,
	real,
	text,
	timestamp,
} from 'drizzle-orm/pg-core';

const jsonArray = sql`'[]'::jsonb`;
const jsonObject = sql`'{}'::jsonb`;

export const pgVector = customType<{
	data: number[];
	driverData: string;
	config: { dimensions: number };
}>({
	dataType(config) {
		return `vector(${config?.dimensions ?? 1536})`;
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

export const stories = pgTable('stories', {
	id: text('id').primaryKey(),
	clientStoryId: text('client_story_id'),
	title: text('title').notNull(),
	description: text('description'),
	genre: text('genre'),
	mode: text('mode').notNull().default('adventure'),
	settings: jsonb('settings').$type<Record<string, unknown> | null>().default(null),
	headerPrompt: text('header_prompt'),
	currentLocationId: text('current_location_id'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	clientStoryIdx: index('stories_client_story_id_idx').on(table.clientStoryId),
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
	storyPositionIdx: index('story_entries_story_position_idx').on(table.storyId, table.position),
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
	title: text('title').notNull(),
	body: text('body').notNull(),
	actorEntityIds: jsonb('actor_entity_ids').$type<string[]>().notNull().default(jsonArray),
	targetEntityIds: jsonb('target_entity_ids').$type<string[]>().notNull().default(jsonArray),
	locationId: text('location_id'),
	threadIds: jsonb('thread_ids').$type<string[]>().notNull().default(jsonArray),
	visibility: text('visibility').notNull().default('player_known'),
	sourceEntryIds: jsonb('source_entry_ids').$type<string[]>().notNull().default(jsonArray),
	sourcePatchIds: jsonb('source_patch_ids').$type<string[]>().notNull().default(jsonArray),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	storyTypeIdx: index('story_events_story_type_idx').on(table.storyId, table.type),
	updatedAtIdx: index('story_events_updated_at_idx').on(table.updatedAt),
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
	embedding: pgVector('embedding', { dimensions: 1536 }),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	storyTypeIdx: index('memory_nodes_story_type_idx').on(table.storyId, table.type),
	storyLocationIdx: index('memory_nodes_story_location_idx').on(table.storyId, table.locationId),
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

export const backendJobs = pgTable('backend_jobs', {
	id: text('id').primaryKey(),
	storyId: text('story_id').notNull().references(() => stories.id, { onDelete: 'cascade' }),
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
	storyStatusIdx: index('backend_jobs_story_status_idx').on(table.storyId, table.status),
	typeStatusIdx: index('backend_jobs_type_status_idx').on(table.type, table.status),
	runAfterIdx: index('backend_jobs_run_after_idx').on(table.status, table.runAfter),
}));

export const schema = {
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
	agreements,
	storyThreads,
	storyEvents,
	statePatches,
	memoryNodes,
	chapters,
	arcs,
	syncOps,
	backendJobs,
};
