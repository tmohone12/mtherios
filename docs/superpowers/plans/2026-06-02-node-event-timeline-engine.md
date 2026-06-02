# Node Event Timeline Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working slice of the server-owned event timeline engine so `/api/turn` can query compact living-world events instead of hauling broad memory packets into every prompt.

**Architecture:** Keep the existing Node terminal process, SvelteKit API shell, Drizzle/Postgres database, and canonical `/api/turn` flow. Add a focused timeline layer that stores scheduled/committed events, links events to NPCs, exposes a compact GM brief, and keeps character appearance/personality portrayal as first-class text-RPG state.

**Tech Stack:** Node.js, SvelteKit, TypeScript, Drizzle ORM, Postgres, Vitest, Zod.

---

## Scope

This plan implements phase one from `docs/superpowers/specs/2026-06-02-node-event-timeline-engine-design.md`:

- Richer server event timeline fields.
- Server `currentTurn` and optional world-time fields.
- NPC-event link table.
- Event query and due-event promotion service.
- Compact GM timeline brief for turn prompt assembly.
- Prompt preservation for NPC appearance, personality descriptors, voice, and mannerisms.
- Focused Vitest coverage for scheduling, due queries, NPC links, descriptor retention, and prompt size.

Deferred phases:

- Full browser service conversion into terminal-only API clients.
- Full world creation API and UI.
- Express/static frontend split inspired by SillyTavern.
- Qdrant/wiki replacement. Existing memory nodes, wiki pages, and Qdrant stay projections.

## File Structure

- Modify `src/lib/server/db/schema.ts`: add `stories.currentTurn`, `stories.currentWorldTime`, richer `storyEvents` columns, `npcEventLinks`, and the schema export.
- Create `drizzle/0007_event_timeline.sql`: compatible migration for existing databases.
- Modify `src/lib/contracts/memory.ts`: add event status, NPC-event link, GM brief request/response schemas, and exported types.
- Create `src/lib/contracts/memory.test.ts`: schema parse tests for the new timeline contracts.
- Create `src/lib/server/events/timeline.ts`: pure timeline selection helpers plus Drizzle wrappers for loading GM briefs and promoting due events.
- Create `src/lib/server/events/timeline.test.ts`: deterministic tests for due-event selection, NPC links, and compact brief rendering.
- Modify `src/lib/server/turn/context.ts`: carry `gmBrief` on `TurnContext` without moving DB ownership back to the browser.
- Modify `src/lib/server/turn/orchestrator.ts`: load the GM brief in the existing parallel context assembly path.
- Modify `src/lib/server/turn/promptPacket.ts`: render the GM timeline brief and NPC portrayal descriptors.
- Modify `src/lib/server/turn/promptHarness.test.ts`: prove the prompt includes descriptors and compact timeline context within budget.
- Modify `src/lib/server/turn/patchValidator.ts`: write timeline defaults for generated events and create NPC-event links from actor/target IDs.
- Modify `src/lib/server/db/worldDatabaseSchema.ts`: expose new tables/fields to the World DB explorer metadata.

## Task 1: Timeline Schema And Migration

**Files:**
- Modify: `src/lib/server/db/schema.ts`
- Create: `drizzle/0007_event_timeline.sql`
- Modify: `src/lib/server/db/worldDatabaseSchema.ts`

- [ ] **Step 1: Extend the Drizzle schema**

In `src/lib/server/db/schema.ts`, update `stories`:

```ts
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
	currentTurn: integer('current_turn').notNull().default(0),
	currentWorldTime: text('current_world_time'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(jsonObject),
	...syncColumns,
}, (table) => ({
	clientStoryIdx: index('stories_client_story_id_idx').on(table.clientStoryId),
	updatedAtIdx: index('stories_updated_at_idx').on(table.updatedAt),
}));
```

Replace the `storyEvents` table with this richer version:

```ts
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
```

Add this table immediately after `storyEvents`:

```ts
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
```

Add `npcEventLinks` to the exported `schema` object between `storyEvents` and `statePatches`.

- [ ] **Step 2: Add the SQL migration**

Create `drizzle/0007_event_timeline.sql`:

```sql
ALTER TABLE "stories"
	ADD COLUMN IF NOT EXISTS "current_turn" integer DEFAULT 0 NOT NULL,
	ADD COLUMN IF NOT EXISTS "current_world_time" text;

ALTER TABLE "story_events"
	ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'committed' NOT NULL,
	ADD COLUMN IF NOT EXISTS "created_turn" integer DEFAULT 0 NOT NULL,
	ADD COLUMN IF NOT EXISTS "occurred_turn" integer,
	ADD COLUMN IF NOT EXISTS "scheduled_turn" integer,
	ADD COLUMN IF NOT EXISTS "world_time" text,
	ADD COLUMN IF NOT EXISTS "location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	ADD COLUMN IF NOT EXISTS "faction_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	ADD COLUMN IF NOT EXISTS "memory_impact" jsonb DEFAULT '{}'::jsonb NOT NULL;

UPDATE "story_events"
	SET "status" = 'committed'
	WHERE "status" IS NULL;

UPDATE "story_events"
	SET "occurred_turn" = COALESCE("occurred_turn", "created_turn", 0)
	WHERE "status" = 'committed' AND "occurred_turn" IS NULL;

CREATE INDEX IF NOT EXISTS "story_events_story_status_turn_idx"
	ON "story_events" ("story_id","status","scheduled_turn");

CREATE INDEX IF NOT EXISTS "story_events_story_occurred_turn_idx"
	ON "story_events" ("story_id","occurred_turn");

CREATE TABLE IF NOT EXISTS "npc_event_links" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL REFERENCES "stories"("id") ON DELETE cascade,
	"event_id" text NOT NULL REFERENCES "story_events"("id") ON DELETE cascade,
	"npc_entity_id" text NOT NULL REFERENCES "entities"("id") ON DELETE cascade,
	"role" text DEFAULT 'affected' NOT NULL,
	"visibility" text DEFAULT 'player_known' NOT NULL,
	"evidence_strength" real DEFAULT 0.75 NOT NULL,
	"source_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_patch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"server_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "npc_event_links_story_event_idx"
	ON "npc_event_links" ("story_id","event_id");

CREATE INDEX IF NOT EXISTS "npc_event_links_story_npc_idx"
	ON "npc_event_links" ("story_id","npc_entity_id");
```

- [ ] **Step 3: Update World DB metadata**

In `src/lib/server/db/worldDatabaseSchema.ts`, add `currentTurn` and `currentWorldTime` to the `stories.fields` array, add the new fields to `storyEvents.fields`, and add this table entry:

```ts
npcEventLinks: {
	purpose: 'Evidence-backed links between canonical timeline events and NPC memory/personality state.',
	primaryKey: 'id',
	foreignKeys: ['storyId -> stories.id', 'eventId -> storyEvents.id', 'npcEntityId -> entities.id'],
	fields: ['id', 'storyId', 'eventId', 'npcEntityId', 'role', 'visibility', 'evidenceStrength', 'sourceEntryIds', 'sourcePatchIds', 'serverVersion', 'createdAt', 'updatedAt'],
},
```

- [ ] **Step 4: Verify schema compiles**

Run: `npm.cmd run check`

Expected: TypeScript/Svelte check completes without errors. Existing accessibility warnings are acceptable only if they were already present before this branch.

- [ ] **Step 5: Commit schema work**

```bash
git add src/lib/server/db/schema.ts src/lib/server/db/worldDatabaseSchema.ts drizzle/0007_event_timeline.sql
git commit -m "feat: add event timeline schema"
```

## Task 2: Timeline Contract Schemas

**Files:**
- Modify: `src/lib/contracts/memory.ts`
- Create: `src/lib/contracts/memory.test.ts`

- [ ] **Step 1: Write failing contract tests**

Create `src/lib/contracts/memory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	gmTimelineBriefSchema,
	npcEventLinkSchema,
	storyEventSchema,
} from './memory';

describe('timeline contracts', () => {
	it('parses scheduled story events with world time and NPC-visible metadata', () => {
		const event = storyEventSchema.parse({
			id: 'event_marriage_alliance',
			storyId: 'story_1',
			type: 'alliance',
			status: 'scheduled',
			title: 'House Vhalor marriage pact',
			body: 'House Vhalor and House Maeris will bind their fleets by marriage.',
			actorEntityIds: ['npc_vhalor_heir'],
			targetEntityIds: ['npc_maeris_heir'],
			locationId: 'loc_harbor_keep',
			locationIds: ['loc_harbor_keep'],
			factionIds: ['faction_vhalor', 'faction_maeris'],
			threadIds: ['thread_trade_war'],
			visibility: 'secret',
			createdTurn: 4,
			occurredTurn: null,
			scheduledTurn: 6,
			worldTime: '17th day of the 9th moon, 296 AC',
			memoryImpact: { relationship: 'alliance' },
			sourceEntryIds: ['entry_4'],
			sourcePatchIds: ['patch_4'],
			metadata: { inWorldDelayTurns: 2 },
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(event.status).toBe('scheduled');
		expect(event.scheduledTurn).toBe(6);
		expect(event.factionIds).toEqual(['faction_vhalor', 'faction_maeris']);
	});

	it('parses NPC-event links used as character memory evidence', () => {
		const link = npcEventLinkSchema.parse({
			id: 'npc_event_link_1',
			storyId: 'story_1',
			eventId: 'event_marriage_alliance',
			npcEntityId: 'npc_vhalor_heir',
			role: 'actor',
			visibility: 'secret',
			evidenceStrength: 0.9,
			sourceEntryIds: ['entry_4'],
			sourcePatchIds: ['patch_4'],
			serverVersion: 12,
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});

		expect(link.role).toBe('actor');
		expect(link.evidenceStrength).toBe(0.9);
	});

	it('parses compact GM timeline briefs', () => {
		const brief = gmTimelineBriefSchema.parse({
			storyId: 'story_1',
			currentTurn: 6,
			currentWorldTime: '17th day of the 9th moon, 296 AC',
			dueEvents: [{
				id: 'event_marriage_alliance',
				type: 'alliance',
				status: 'due',
				title: 'House Vhalor marriage pact',
				body: 'House Vhalor and House Maeris will bind their fleets by marriage.',
				turnsUntilDue: 0,
				worldTime: '17th day of the 9th moon, 296 AC',
				npcEntityIds: ['npc_vhalor_heir', 'npc_maeris_heir'],
				factionIds: ['faction_vhalor', 'faction_maeris'],
				locationIds: ['loc_harbor_keep'],
				visibility: 'secret',
			}],
			recentEvents: [],
			scheduledEvents: [],
			npcEvents: [],
		});

		expect(brief.dueEvents[0].turnsUntilDue).toBe(0);
	});
});
```

Run: `npm.cmd test -- src/lib/contracts/memory.test.ts`

Expected: FAIL because the new exports do not exist.

- [ ] **Step 2: Implement contract schemas**

In `src/lib/contracts/memory.ts`, replace the event enum with:

```ts
export const storyEventTypeSchema = z.enum([
	'promise',
	'betrayal',
	'reveal',
	'faction_move',
	'injury',
	'death',
	'relationship_shift',
	'agreement',
	'scene_transition',
	'clue_discovery',
	'correction',
	'imported_memory',
	'world_tick',
	'scheme',
	'rumor',
	'marriage',
	'alliance',
]);
```

Add this status schema after `memoryVisibilitySchema`:

```ts
export const storyEventStatusSchema = z.enum(['proposed', 'scheduled', 'due', 'committed', 'cancelled']);
```

Replace `storyEventSchema` with:

```ts
export const storyEventSchema = z.object({
	id: z.string(),
	storyId: z.string(),
	type: storyEventTypeSchema,
	status: storyEventStatusSchema.default('committed'),
	title: z.string(),
	body: z.string(),
	actorEntityIds: z.array(z.string()).default([]),
	targetEntityIds: z.array(z.string()).default([]),
	locationId: z.string().nullable().default(null),
	locationIds: z.array(z.string()).default([]),
	factionIds: z.array(z.string()).default([]),
	threadIds: z.array(z.string()).default([]),
	visibility: memoryVisibilitySchema.default('player_known'),
	createdTurn: z.number().int().nonnegative().default(0),
	occurredTurn: z.number().int().nonnegative().nullable().default(null),
	scheduledTurn: z.number().int().nonnegative().nullable().default(null),
	worldTime: z.string().nullable().default(null),
	memoryImpact: jsonObjectSchema.default({}),
	sourceEntryIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	metadata: jsonObjectSchema.optional(),
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
```

Add these schemas after `storyEventSchema`:

```ts
export const npcEventLinkRoleSchema = z.enum(['actor', 'target', 'witness', 'knower', 'affected']);

export const npcEventLinkSchema = z.object({
	id: z.string(),
	storyId: z.string(),
	eventId: z.string(),
	npcEntityId: z.string(),
	role: npcEventLinkRoleSchema.default('affected'),
	visibility: memoryVisibilitySchema.default('player_known'),
	evidenceStrength: z.number().min(0).max(1).default(0.75),
	sourceEntryIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	serverVersion: z.number().int().nonnegative(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const gmTimelineBriefEventSchema = z.object({
	id: z.string(),
	type: storyEventTypeSchema,
	status: storyEventStatusSchema,
	title: z.string(),
	body: z.string(),
	turnsUntilDue: z.number().int().nullable(),
	worldTime: z.string().nullable(),
	npcEntityIds: z.array(z.string()).default([]),
	factionIds: z.array(z.string()).default([]),
	locationIds: z.array(z.string()).default([]),
	visibility: memoryVisibilitySchema,
});

export const gmTimelineNpcEventSchema = z.object({
	npcEntityId: z.string(),
	eventIds: z.array(z.string()).default([]),
	summary: z.string(),
	visibility: memoryVisibilitySchema,
});

export const gmTimelineBriefSchema = z.object({
	storyId: z.string(),
	currentTurn: z.number().int().nonnegative(),
	currentWorldTime: z.string().nullable(),
	dueEvents: z.array(gmTimelineBriefEventSchema).default([]),
	recentEvents: z.array(gmTimelineBriefEventSchema).default([]),
	scheduledEvents: z.array(gmTimelineBriefEventSchema).default([]),
	npcEvents: z.array(gmTimelineNpcEventSchema).default([]),
});
```

Add exported types near the existing type exports:

```ts
export type StoryEventStatus = z.infer<typeof storyEventStatusSchema>;
export type NpcEventLinkRole = z.infer<typeof npcEventLinkRoleSchema>;
export type NpcEventLink = z.infer<typeof npcEventLinkSchema>;
export type GmTimelineBriefEvent = z.infer<typeof gmTimelineBriefEventSchema>;
export type GmTimelineNpcEvent = z.infer<typeof gmTimelineNpcEventSchema>;
export type GmTimelineBrief = z.infer<typeof gmTimelineBriefSchema>;
```

- [ ] **Step 3: Verify contracts**

Run: `npm.cmd test -- src/lib/contracts/memory.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit contracts**

```bash
git add src/lib/contracts/memory.ts src/lib/contracts/memory.test.ts
git commit -m "feat: add timeline memory contracts"
```

## Task 3: Timeline Selection Service

**Files:**
- Create: `src/lib/server/events/timeline.ts`
- Create: `src/lib/server/events/timeline.test.ts`

- [ ] **Step 1: Write failing timeline tests**

Create `src/lib/server/events/timeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { StoryEventStatus } from '$lib/contracts/memory';
import {
	buildGmTimelineBrief,
	buildNpcEventLinksForEvent,
	buildScheduledTimelineEventInsert,
	selectDueTimelineEvents,
} from './timeline';

type EventRow = Parameters<typeof selectDueTimelineEvents>[0][number];

function event(overrides: Partial<EventRow>): EventRow {
	return {
		id: overrides.id ?? 'event_1',
		storyId: 'story_1',
		type: overrides.type ?? 'world_tick',
		status: (overrides.status ?? 'committed') as StoryEventStatus,
		title: overrides.title ?? 'Market rumor spreads',
		body: overrides.body ?? 'A rumor crosses the harbor market.',
		actorEntityIds: overrides.actorEntityIds ?? [],
		targetEntityIds: overrides.targetEntityIds ?? [],
		locationId: overrides.locationId ?? null,
		locationIds: overrides.locationIds ?? [],
		factionIds: overrides.factionIds ?? [],
		threadIds: overrides.threadIds ?? [],
		visibility: overrides.visibility ?? 'player_known',
		createdTurn: overrides.createdTurn ?? 0,
		occurredTurn: overrides.occurredTurn ?? 0,
		scheduledTurn: overrides.scheduledTurn ?? null,
		worldTime: overrides.worldTime ?? null,
		memoryImpact: overrides.memoryImpact ?? {},
		sourceEntryIds: overrides.sourceEntryIds ?? [],
		sourcePatchIds: overrides.sourcePatchIds ?? [],
		metadata: overrides.metadata ?? {},
		serverVersion: overrides.serverVersion ?? 1,
		createdAt: overrides.createdAt ?? '2026-06-02T00:00:00.000Z',
		updatedAt: overrides.updatedAt ?? '2026-06-02T00:00:00.000Z',
		...overrides,
	};
}

describe('timeline service helpers', () => {
	it('selects scheduled events due on or before the current turn', () => {
		const due = event({ id: 'event_due', status: 'scheduled', scheduledTurn: 6, title: 'Marriage pact matures' });
		const future = event({ id: 'event_future', status: 'scheduled', scheduledTurn: 8, title: 'Fleet arrives' });
		const committed = event({ id: 'event_committed', status: 'committed', occurredTurn: 5 });

		expect(selectDueTimelineEvents([future, committed, due], 6).map((row) => row.id)).toEqual(['event_due']);
	});

	it('builds NPC links from actor and target IDs without duplicates', () => {
		const links = buildNpcEventLinksForEvent({
			storyId: 'story_1',
			eventId: 'event_due',
			actorEntityIds: ['npc_a', 'npc_b'],
			targetEntityIds: ['npc_b', 'npc_c'],
			visibility: 'secret',
			sourceEntryIds: ['entry_1'],
			sourcePatchIds: ['patch_1'],
			serverVersion: 4,
			now: '2026-06-02T00:00:00.000Z',
		});

		expect(links.map((link) => [link.npcEntityId, link.role])).toEqual([
			['npc_a', 'actor'],
			['npc_b', 'actor'],
			['npc_c', 'target'],
		]);
	});

	it('builds scheduled event inserts from in-world turn delays', () => {
		const scheduled = buildScheduledTimelineEventInsert({
			id: 'event_alliance',
			storyId: 'story_1',
			type: 'alliance',
			title: 'Marriage pact forms an alliance',
			body: 'Two houses marry heirs and combine harbor patrols.',
			currentTurn: 4,
			delayTurns: 2,
			worldTime: '19th day of the 9th moon, 296 AC',
			actorEntityIds: ['npc_a'],
			targetEntityIds: ['npc_b'],
			factionIds: ['faction_a', 'faction_b'],
			locationIds: ['loc_harbor'],
			threadIds: ['thread_trade_war'],
			visibility: 'secret',
			sourceEntryIds: ['entry_4'],
			sourcePatchIds: ['patch_4'],
			serverVersion: 5,
			now: '2026-06-02T00:00:00.000Z',
		});

		expect(scheduled.status).toBe('scheduled');
		expect(scheduled.createdTurn).toBe(4);
		expect(scheduled.scheduledTurn).toBe(6);
		expect(scheduled.occurredTurn).toBeNull();
		expect(scheduled.metadata).toEqual({ inWorldDelayTurns: 2 });
	});

	it('builds a compact GM brief with due, recent, future, and NPC-linked events', () => {
		const brief = buildGmTimelineBrief({
			storyId: 'story_1',
			currentTurn: 6,
			currentWorldTime: '17th day of the 9th moon, 296 AC',
			events: [
				event({ id: 'event_due', status: 'scheduled', scheduledTurn: 6, actorEntityIds: ['npc_a'], title: 'Marriage pact matures', factionIds: ['faction_a', 'faction_b'] }),
				event({ id: 'event_recent', status: 'committed', occurredTurn: 5, targetEntityIds: ['npc_c'], title: 'Spy names a traitor' }),
				event({ id: 'event_future', status: 'scheduled', scheduledTurn: 8, title: 'Fleet arrives' }),
			],
			npcLinks: [{
				id: 'link_1',
				storyId: 'story_1',
				eventId: 'event_due',
				npcEntityId: 'npc_a',
				role: 'actor',
				visibility: 'secret',
				evidenceStrength: 0.9,
				sourceEntryIds: [],
				sourcePatchIds: [],
				serverVersion: 4,
				createdAt: '2026-06-02T00:00:00.000Z',
				updatedAt: '2026-06-02T00:00:00.000Z',
			}],
			sceneEntityIds: ['npc_a'],
			presentNpcIds: ['npc_a'],
			includeSecret: true,
		});

		expect(brief.dueEvents.map((item) => item.id)).toEqual(['event_due']);
		expect(brief.scheduledEvents.map((item) => item.id)).toEqual(['event_future']);
		expect(brief.recentEvents.map((item) => item.id)).toEqual(['event_recent']);
		expect(brief.npcEvents[0].summary).toContain('Marriage pact matures');
	});
});
```

Run: `npm.cmd test -- src/lib/server/events/timeline.test.ts`

Expected: FAIL because `src/lib/server/events/timeline.ts` does not exist.

- [ ] **Step 2: Implement timeline helpers and DB wrappers**

Create `src/lib/server/events/timeline.ts`:

```ts
import { and, desc, eq, lte, or, sql } from 'drizzle-orm';
import type {
	GmTimelineBrief,
	GmTimelineBriefEvent,
	GmTimelineNpcEvent,
	MemoryVisibility,
	NpcEventLinkRole,
	StoryEventStatus,
} from '$lib/contracts/memory';
import { getDb } from '$lib/server/db/client';
import { npcEventLinks, stories, storyEvents } from '$lib/server/db/schema';

type StoryEventRow = typeof storyEvents.$inferSelect;
type StoryEventInsert = typeof storyEvents.$inferInsert;
type NpcEventLinkRow = typeof npcEventLinks.$inferSelect;
type NpcEventLinkInsert = typeof npcEventLinks.$inferInsert;

const DEFAULT_RECENT_LIMIT = 12;
const DEFAULT_SCHEDULED_LIMIT = 10;
const DEFAULT_DUE_LIMIT = 10;
const DEFAULT_NPC_LIMIT = 8;

function uniqueStrings(values: Array<string | null | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function eventLocationIds(row: StoryEventRow): string[] {
	return uniqueStrings([row.locationId, ...row.locationIds]);
}

function eventNpcIds(row: StoryEventRow, links: NpcEventLinkRow[]): string[] {
	const linked = links.filter((link) => link.eventId === row.id).map((link) => link.npcEntityId);
	return uniqueStrings([...row.actorEntityIds, ...row.targetEntityIds, ...linked]);
}

function isVisible(row: { visibility: string }, includeSecret: boolean): boolean {
	return includeSecret || row.visibility === 'public' || row.visibility === 'player_known';
}

function turnsUntilDue(row: StoryEventRow, currentTurn: number): number | null {
	return typeof row.scheduledTurn === 'number' ? row.scheduledTurn - currentTurn : null;
}

function toBriefEvent(row: StoryEventRow, currentTurn: number, links: NpcEventLinkRow[], statusOverride?: StoryEventStatus): GmTimelineBriefEvent {
	return {
		id: row.id,
		type: row.type as GmTimelineBriefEvent['type'],
		status: statusOverride ?? (row.status as StoryEventStatus),
		title: row.title,
		body: row.body,
		turnsUntilDue: turnsUntilDue(row, currentTurn),
		worldTime: row.worldTime,
		npcEntityIds: eventNpcIds(row, links),
		factionIds: row.factionIds,
		locationIds: eventLocationIds(row),
		visibility: row.visibility as MemoryVisibility,
	};
}

export function selectDueTimelineEvents(events: StoryEventRow[], currentTurn: number): StoryEventRow[] {
	return events
		.filter((event) => event.status === 'due' || (event.status === 'scheduled' && typeof event.scheduledTurn === 'number' && event.scheduledTurn <= currentTurn))
		.sort((a, b) => (a.scheduledTurn ?? 0) - (b.scheduledTurn ?? 0));
}

export function buildNpcEventLinksForEvent(input: {
	storyId: string;
	eventId: string;
	actorEntityIds: string[];
	targetEntityIds: string[];
	visibility: MemoryVisibility | string;
	sourceEntryIds: string[];
	sourcePatchIds: string[];
	serverVersion: number;
	now: string;
}): NpcEventLinkInsert[] {
	const links: NpcEventLinkInsert[] = [];
	const seen = new Set<string>();
	const push = (npcEntityId: string, role: NpcEventLinkRole) => {
		if (seen.has(npcEntityId)) return;
		seen.add(npcEntityId);
		links.push({
			id: `npc_event_${input.eventId}_${npcEntityId}`,
			storyId: input.storyId,
			eventId: input.eventId,
			npcEntityId,
			role,
			visibility: input.visibility,
			evidenceStrength: role === 'actor' ? 0.9 : 0.75,
			sourceEntryIds: input.sourceEntryIds,
			sourcePatchIds: input.sourcePatchIds,
			serverVersion: input.serverVersion,
			createdAt: input.now,
			updatedAt: input.now,
		});
	};

	input.actorEntityIds.forEach((npcEntityId) => push(npcEntityId, 'actor'));
	input.targetEntityIds.forEach((npcEntityId) => push(npcEntityId, 'target'));
	return links;
}

export function buildScheduledTimelineEventInsert(input: {
	id: string;
	storyId: string;
	type: string;
	title: string;
	body: string;
	currentTurn: number;
	delayTurns: number;
	worldTime: string | null;
	actorEntityIds?: string[];
	targetEntityIds?: string[];
	factionIds?: string[];
	locationId?: string | null;
	locationIds?: string[];
	threadIds?: string[];
	visibility?: MemoryVisibility | string;
	memoryImpact?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	sourceEntryIds?: string[];
	sourcePatchIds?: string[];
	serverVersion: number;
	now: string;
}): StoryEventInsert {
	const delayTurns = Math.max(0, Math.floor(input.delayTurns));
	return {
		id: input.id,
		storyId: input.storyId,
		type: input.type,
		status: 'scheduled',
		title: input.title,
		body: input.body,
		actorEntityIds: input.actorEntityIds ?? [],
		targetEntityIds: input.targetEntityIds ?? [],
		locationId: input.locationId ?? null,
		locationIds: input.locationIds ?? [],
		factionIds: input.factionIds ?? [],
		threadIds: input.threadIds ?? [],
		visibility: input.visibility ?? 'secret',
		createdTurn: input.currentTurn,
		occurredTurn: null,
		scheduledTurn: input.currentTurn + delayTurns,
		worldTime: input.worldTime,
		memoryImpact: input.memoryImpact ?? {},
		sourceEntryIds: input.sourceEntryIds ?? [],
		sourcePatchIds: input.sourcePatchIds ?? [],
		metadata: { ...(input.metadata ?? {}), inWorldDelayTurns: delayTurns },
		serverVersion: input.serverVersion,
		createdAt: input.now,
		updatedAt: input.now,
	};
}

export function buildGmTimelineBrief(input: {
	storyId: string;
	currentTurn: number;
	currentWorldTime: string | null;
	events: StoryEventRow[];
	npcLinks: NpcEventLinkRow[];
	sceneEntityIds?: string[];
	presentNpcIds?: string[];
	includeSecret?: boolean;
	recentLimit?: number;
	scheduledLimit?: number;
	dueLimit?: number;
	npcLimit?: number;
}): GmTimelineBrief {
	const includeSecret = input.includeSecret ?? false;
	const visibleEvents = input.events.filter((event) => isVisible(event, includeSecret));
	const visibleLinks = input.npcLinks.filter((link) => isVisible(link, includeSecret));
	const dueRows = selectDueTimelineEvents(visibleEvents, input.currentTurn).slice(0, input.dueLimit ?? DEFAULT_DUE_LIMIT);
	const dueIds = new Set(dueRows.map((row) => row.id));
	const recentRows = visibleEvents
		.filter((event) => event.status === 'committed' && !dueIds.has(event.id))
		.sort((a, b) => (b.occurredTurn ?? 0) - (a.occurredTurn ?? 0))
		.slice(0, input.recentLimit ?? DEFAULT_RECENT_LIMIT);
	const scheduledRows = visibleEvents
		.filter((event) => event.status === 'scheduled' && typeof event.scheduledTurn === 'number' && event.scheduledTurn > input.currentTurn)
		.sort((a, b) => (a.scheduledTurn ?? 0) - (b.scheduledTurn ?? 0))
		.slice(0, input.scheduledLimit ?? DEFAULT_SCHEDULED_LIMIT);
	const presentNpcIds = new Set(uniqueStrings([...(input.presentNpcIds ?? []), ...(input.sceneEntityIds ?? [])]));
	const npcEvents: GmTimelineNpcEvent[] = [...presentNpcIds].slice(0, input.npcLimit ?? DEFAULT_NPC_LIMIT).map((npcEntityId) => {
		const linked = visibleLinks
			.filter((link) => link.npcEntityId === npcEntityId)
			.map((link) => visibleEvents.find((event) => event.id === link.eventId))
			.filter((event): event is StoryEventRow => Boolean(event))
			.slice(0, 4);
		return {
			npcEntityId,
			eventIds: linked.map((event) => event.id),
			summary: linked.length
				? linked.map((event) => `${event.title}: ${event.body.slice(0, 180)}`).join(' | ')
				: 'No linked timeline events loaded for this NPC.',
			visibility: 'player_known',
		};
	}).filter((item) => item.eventIds.length > 0);

	return {
		storyId: input.storyId,
		currentTurn: input.currentTurn,
		currentWorldTime: input.currentWorldTime,
		dueEvents: dueRows.map((row) => toBriefEvent(row, input.currentTurn, visibleLinks, 'due')),
		recentEvents: recentRows.map((row) => toBriefEvent(row, input.currentTurn, visibleLinks)),
		scheduledEvents: scheduledRows.map((row) => toBriefEvent(row, input.currentTurn, visibleLinks)),
		npcEvents,
	};
}

export async function loadGmTimelineBrief(input: {
	storyId: string;
	sceneEntityIds?: string[];
	presentNpcIds?: string[];
	includeSecret?: boolean;
	currentTurn?: number;
}): Promise<GmTimelineBrief> {
	const db = getDb();
	const [story] = await db.select().from(stories).where(eq(stories.id, input.storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${input.storyId}`);
	const currentTurn = input.currentTurn ?? story.currentTurn ?? 0;
	const visibilityFilter = input.includeSecret
		? undefined
		: or(eq(storyEvents.visibility, 'public'), eq(storyEvents.visibility, 'player_known'));
	const [eventRows, linkRows] = await Promise.all([
		db.select().from(storyEvents)
			.where(and(eq(storyEvents.storyId, input.storyId), visibilityFilter))
			.orderBy(desc(storyEvents.updatedAt))
			.limit(140),
		db.select().from(npcEventLinks)
			.where(eq(npcEventLinks.storyId, input.storyId))
			.orderBy(desc(npcEventLinks.updatedAt))
			.limit(400),
	]);

	return buildGmTimelineBrief({
		storyId: input.storyId,
		currentTurn,
		currentWorldTime: story.currentWorldTime,
		events: eventRows,
		npcLinks: linkRows,
		sceneEntityIds: input.sceneEntityIds,
		presentNpcIds: input.presentNpcIds,
		includeSecret: input.includeSecret,
	});
}

export async function scheduleTimelineEvent(input: Parameters<typeof buildScheduledTimelineEventInsert>[0]): Promise<StoryEventRow> {
	const db = getDb();
	const event = buildScheduledTimelineEventInsert(input);
	const [row] = await db.insert(storyEvents).values(event).returning();
	const links = buildNpcEventLinksForEvent({
		storyId: input.storyId,
		eventId: input.id,
		actorEntityIds: input.actorEntityIds ?? [],
		targetEntityIds: input.targetEntityIds ?? [],
		visibility: input.visibility ?? 'secret',
		sourceEntryIds: input.sourceEntryIds ?? [],
		sourcePatchIds: input.sourcePatchIds ?? [],
		serverVersion: input.serverVersion,
		now: input.now,
	});
	if (links.length > 0) {
		await db.insert(npcEventLinks).values(links).onConflictDoNothing();
	}
	return row;
}

export async function promoteDueTimelineEvents(storyId: string, currentTurn: number, now = new Date().toISOString()): Promise<StoryEventRow[]> {
	const db = getDb();
	return db.update(storyEvents).set({
		status: 'due',
		occurredTurn: currentTurn,
		updatedAt: now,
	}).where(and(
		eq(storyEvents.storyId, storyId),
		eq(storyEvents.status, 'scheduled'),
		lte(storyEvents.scheduledTurn, currentTurn),
	)).returning();
}

export async function advanceStoryTurn(storyId: string, delta = 1): Promise<number> {
	const db = getDb();
	const [row] = await db.update(stories).set({
		currentTurn: sql<number>`${stories.currentTurn} + ${delta}`,
		updatedAt: new Date().toISOString(),
	}).where(eq(stories.id, storyId)).returning({ currentTurn: stories.currentTurn });
	return row?.currentTurn ?? delta;
}
```

- [ ] **Step 3: Run timeline tests**

Run: `npm.cmd test -- src/lib/server/events/timeline.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit timeline service**

```bash
git add src/lib/server/events/timeline.ts src/lib/server/events/timeline.test.ts
git commit -m "feat: add gm timeline service"
```

## Task 4: Prompt Context Wiring

**Files:**
- Modify: `src/lib/server/turn/context.ts`
- Modify: `src/lib/server/turn/orchestrator.ts`

- [ ] **Step 1: Add GM brief to turn context**

In `src/lib/server/turn/context.ts`, add the import:

```ts
import type { GmTimelineBrief } from '$lib/contracts/memory';
```

Add this field to `TurnContext`:

```ts
gmBrief: GmTimelineBrief | null;
```

Add this property to the returned object in `loadTurnContext`:

```ts
gmBrief: null,
```

- [ ] **Step 2: Load GM brief in orchestrator context assembly**

In `src/lib/server/turn/orchestrator.ts`, add:

```ts
import { loadGmTimelineBrief, promoteDueTimelineEvents } from '$lib/server/events/timeline';
```

Before `const [retrieved, ctx, wikiResult] = ...`, load the story current turn through the GM brief path by adding a fourth parallel task:

```ts
const [retrieved, ctx, gmBrief, wikiResult] = await recorder.time('turn.context_assembly', {
	parallel: true,
	memoryTokenBudget,
}, () => Promise.all([
	recorder.time('turn.memory_retrieval', {
		tokenBudget: memoryTokenBudget,
		sceneEntityIds: retrievalRequest.sceneEntityIds.length,
		presentNpcIds: retrievalRequest.presentNpcIds.length,
		threadIds: retrievalRequest.threadIds.length,
	}, () => retrieveMemoryPacket(retrievalRequest)),
	recorder.time('turn.context_load', {
		presentNpcIds: request.clientContext?.presentNpcIds?.length ?? 0,
	}, () => loadTurnContext(request.storyId, request.clientContext?.presentNpcIds ?? [])),
	recorder.time('turn.gm_timeline_brief', {
		sceneEntityIds: retrievalRequest.sceneEntityIds.length,
		presentNpcIds: retrievalRequest.presentNpcIds.length,
	}, async () => {
		const brief = await loadGmTimelineBrief({
			storyId: request.storyId,
			sceneEntityIds: retrievalRequest.sceneEntityIds,
			presentNpcIds: retrievalRequest.presentNpcIds,
			includeSecret: true,
		});
		await promoteDueTimelineEvents(request.storyId, brief.currentTurn);
		return brief;
	}),
	wikiContextTask,
]));
const ctxWithTimeline = { ...ctx, gmBrief };
```

Change prompt assembly to pass `ctxWithTimeline`:

```ts
}, () => buildServerTurnPrompt(ctxWithTimeline, retrieved, playerEntryId, {
	currentFactionId: request.clientContext?.currentFactionId ?? null,
	sceneEntityIds: request.clientContext?.sceneEntityIds ?? [],
	wikiContextMarkdown: wikiContext?.markdown ?? null,
}));
```

Change debug context counts to use `ctxWithTimeline`:

```ts
...turnContextCounts(ctxWithTimeline),
```

- [ ] **Step 3: Verify compile**

Run: `npm.cmd run check`

Expected: PASS.

- [ ] **Step 4: Commit context wiring**

```bash
git add src/lib/server/turn/context.ts src/lib/server/turn/orchestrator.ts
git commit -m "feat: wire gm timeline into turns"
```

## Task 5: Prompt Packet Timeline And Character Portrayal

**Files:**
- Modify: `src/lib/server/turn/promptPacket.ts`
- Modify: `src/lib/server/turn/promptHarness.test.ts`

- [ ] **Step 1: Write failing prompt harness test**

In `src/lib/server/turn/promptHarness.test.ts`, update `baseContext()` so it returns `gmBrief: null`.

Add this test inside the existing `describe('turn prompt harness', ...)` block:

```ts
it('includes timeline brief and text-rpg NPC portrayal without bloating the prompt', () => {
	const report = buildPromptHarnessReport({
		name: 'timeline-portrayal',
		playerText: 'I ask Lady Saera what news came from the harbor.',
		ctx: baseContext({
			entities: [
				entity('loc_crimson_spire', 'location', 'The Crimson Spire', 'The Balaerys manse inside the Black Walls.', { current: true }),
				entity('pc_balaerys', 'character', 'Balaerys Heir', 'The watched young heir of House Balaerys.', { present: true }),
				entity('npc_saera', 'character', 'Lady Saera Balaerys', 'A senior Balaerys matchmaker and court watcher.', {
					present: true,
					appearance: 'silver-streaked black hair, severe jade gown, ringed hands, sharp violet eyes',
					personalityDescriptors: ['controlled', 'cutting', 'protective when House Balaerys benefits'],
					voice: 'low, precise, and dryly amused',
					mannerisms: ['taps one ring against the table before naming a cost'],
				}),
			],
			gmBrief: {
				storyId: 'story_balaerys',
				currentTurn: 6,
				currentWorldTime: '17th day of the 9th moon, 296 AC',
				dueEvents: [{
					id: 'event_marriage_alliance',
					type: 'alliance',
					status: 'due',
					title: 'Harbor marriage pact matures',
					body: 'Two shipping houses seal a marriage and redirect their sellsails toward the Black Walls.',
					turnsUntilDue: 0,
					worldTime: '17th day of the 9th moon, 296 AC',
					npcEntityIds: ['npc_saera'],
					factionIds: ['faction_balaerys'],
					locationIds: ['loc_harbor'],
					visibility: 'secret',
				}],
				recentEvents: [],
				scheduledEvents: [],
				npcEvents: [{
					npcEntityId: 'npc_saera',
					eventIds: ['event_marriage_alliance'],
					summary: 'Harbor marriage pact matures: Saera knows the marriage will alter shipping leverage.',
					visibility: 'secret',
				}],
			},
		}),
		retrieved: packet('Lady Saera harbor news', []),
		options: {
			sceneEntityIds: ['pc_balaerys', 'npc_saera'],
		},
	});

	const findings = evaluatePromptHarness(report, {
		promptIncludes: [
			'GM timeline brief',
			'Due events',
			'Harbor marriage pact matures',
			'Appearance: silver-streaked black hair',
			'Personality: controlled; cutting; protective when House Balaerys benefits',
			'Voice: low, precise, and dryly amused',
			'Mannerisms: taps one ring against the table before naming a cost',
		],
		maxTotalBeforeGenerationTokens: 2500,
	});

	expect(failedLabels(findings)).toEqual([]);
});
```

Run: `npm.cmd test -- src/lib/server/turn/promptHarness.test.ts`

Expected: FAIL because `buildServerTurnPrompt` does not render the new fields.

- [ ] **Step 2: Implement prompt rendering**

In `src/lib/server/turn/promptPacket.ts`, add:

```ts
import type { GmTimelineBrief, GmTimelineBriefEvent } from '$lib/contracts/memory';
```

Add these helpers before `export function buildServerTurnPrompt`:

```ts
function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function entityPortrayal(entity: TurnContext['entities'][number]): string {
	const state = entity.state && typeof entity.state === 'object' ? entity.state as Record<string, unknown> : {};
	const parts = [
		typeof state.appearance === 'string' && state.appearance.trim() ? `Appearance: ${compact(state.appearance, 180)}` : '',
		stringList(state.personalityDescriptors).length ? `Personality: ${stringList(state.personalityDescriptors).slice(0, 4).join('; ')}` : '',
		typeof state.voice === 'string' && state.voice.trim() ? `Voice: ${compact(state.voice, 140)}` : '',
		stringList(state.mannerisms).length ? `Mannerisms: ${stringList(state.mannerisms).slice(0, 3).join('; ')}` : '',
	].filter(Boolean);
	return parts.length ? ` (${parts.join(' | ')})` : '';
}

function timelineLine(event: GmTimelineBriefEvent): string {
	const due = typeof event.turnsUntilDue === 'number'
		? event.turnsUntilDue <= 0 ? 'due now' : `due in ${event.turnsUntilDue} turns`
		: 'no turn due';
	const tags = [
		event.worldTime,
		event.npcEntityIds.length ? `npcs:${event.npcEntityIds.slice(0, 4).join(',')}` : '',
		event.factionIds.length ? `factions:${event.factionIds.slice(0, 4).join(',')}` : '',
	].filter(Boolean).join('; ');
	return `- ${event.type}/${event.status} ${due}: ${event.title} - ${compact(event.body, 180)}${tags ? ` (${tags})` : ''}`;
}

function renderGmTimelineBrief(brief: GmTimelineBrief | null): string {
	if (!brief) return '';
	const due = brief.dueEvents.map(timelineLine);
	const recent = brief.recentEvents.slice(0, 8).map(timelineLine);
	const scheduled = brief.scheduledEvents.slice(0, 8).map(timelineLine);
	const npc = brief.npcEvents.slice(0, 6).map((item) =>
		`- ${item.npcEntityId}: ${compact(item.summary, 220)}`
	);
	return [
		`Current turn: ${brief.currentTurn}${brief.currentWorldTime ? ` (${brief.currentWorldTime})` : ''}`,
		due.length ? `Due events:\n${due.join('\n')}` : '',
		recent.length ? `Recent events:\n${recent.join('\n')}` : '',
		scheduled.length ? `Scheduled future events:\n${scheduled.join('\n')}` : '',
		npc.length ? `NPC event memory:\n${npc.join('\n')}` : '',
	].filter(Boolean).join('\n');
}
```

Change `entityLines` to:

```ts
const entityLines = presentEntities.map((entity) =>
	`- ${entity.type}: ${entity.name}${entity.description ? ` - ${compact(entity.description, 160)}` : ''}${entityPortrayal(entity)}`
);
```

Add:

```ts
const gmTimelineBrief = renderGmTimelineBrief(ctx.gmBrief);
```

Replace the existing recent-events prompt section with:

```ts
gmTimelineBrief ? `GM timeline brief:\n${gmTimelineBrief}` : eventLines.length ? `Recent source-linked events:\n${eventLines.join('\n')}` : '',
```

- [ ] **Step 3: Verify prompt harness**

Run: `npm.cmd test -- src/lib/server/turn/promptHarness.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit prompt changes**

```bash
git add src/lib/server/turn/promptPacket.ts src/lib/server/turn/promptHarness.test.ts
git commit -m "feat: render timeline brief in turn prompts"
```

## Task 6: Timeline Defaults In Patch Validation

**Files:**
- Modify: `src/lib/server/turn/patchValidator.ts`
- Modify: `src/lib/server/events/timeline.test.ts`

- [ ] **Step 1: Expand link helper test for inserts used by patch validation**

In `src/lib/server/events/timeline.test.ts`, add this assertion to the existing `builds NPC links` test:

```ts
expect(links[0]).toMatchObject({
	id: 'npc_event_event_due_npc_a',
	storyId: 'story_1',
	eventId: 'event_due',
	npcEntityId: 'npc_a',
	visibility: 'secret',
	sourceEntryIds: ['entry_1'],
	sourcePatchIds: ['patch_1'],
	serverVersion: 4,
});
```

Run: `npm.cmd test -- src/lib/server/events/timeline.test.ts`

Expected: PASS.

- [ ] **Step 2: Apply defaults and links in patch validator**

In `src/lib/server/turn/patchValidator.ts`, add:

```ts
import { buildNpcEventLinksForEvent } from '$lib/server/events/timeline';
```

Add `npcEventLinks` to the existing schema import from `$lib/server/db/schema`.

Near the start of `applyValidatedTurnUpdate`, load the story and compute the turn:

```ts
const [story] = await db.select().from(stories).where(eq(stories.id, input.storyId)).limit(1);
if (!story) throw new Error(`Story not found: ${input.storyId}`);
const currentTurn = story.currentTurn ?? 0;
```

Add this local helper inside `applyValidatedTurnUpdate` before event inserts:

```ts
const timelineDefaults = (overrides: { status?: string; scheduledTurn?: number | null; visibility?: string } = {}) => ({
	status: overrides.status ?? 'committed',
	createdTurn: currentTurn,
	occurredTurn: overrides.status === 'scheduled' ? null : currentTurn,
	scheduledTurn: overrides.scheduledTurn ?? null,
	worldTime: story.currentWorldTime,
	locationIds: [],
	factionIds: [],
	memoryImpact: {},
	visibility: overrides.visibility ?? 'player_known',
});

const insertNpcLinks = async (event: {
	eventId: string;
	actorEntityIds?: string[];
	targetEntityIds?: string[];
	visibility: string;
	sourceEntryIds: string[];
	sourcePatchIds: string[];
}) => {
	const links = buildNpcEventLinksForEvent({
		storyId: input.storyId,
		eventId: event.eventId,
		actorEntityIds: event.actorEntityIds ?? [],
		targetEntityIds: event.targetEntityIds ?? [],
		visibility: event.visibility,
		sourceEntryIds: event.sourceEntryIds,
		sourcePatchIds: event.sourcePatchIds,
		serverVersion: input.serverVersion,
		now: createdAt,
	});
	if (links.length > 0) {
		await db.insert(npcEventLinks).values(links).onConflictDoNothing();
	}
};
```

For every `db.insert(storyEvents).values({ ... })` in `applyValidatedTurnUpdate`, add the `...timelineDefaults(...)` spread and call `insertNpcLinks(...)` after the insert. For the turn event:

```ts
const turnVisibility = 'player_known';
await db.insert(storyEvents).values({
	id: turnEventId,
	storyId: input.storyId,
	type: 'scene_transition',
	title: 'Turn resolved',
	body: input.narration.replace(/\s+/g, ' ').slice(0, 500),
	...timelineDefaults({ visibility: turnVisibility }),
	sourceEntryIds: [input.playerEntryId, input.assistantEntryId],
	sourcePatchIds: [patchId],
	metadata: {},
	serverVersion: input.serverVersion,
	createdAt,
	updatedAt: createdAt,
});
await insertNpcLinks({
	eventId: turnEventId,
	visibility: turnVisibility,
	sourceEntryIds: [input.playerEntryId, input.assistantEntryId],
	sourcePatchIds: [patchId],
});
```

For agreement and story-beat events, keep their existing visibility rules and pass any actor/target IDs already present on the update object. If an update object does not include actor/target IDs, call `insertNpcLinks` with empty arrays so no false NPC memory is invented.

After successful patch application, advance the story turn once:

```ts
await db.update(stories).set({
	currentTurn: currentTurn + 1,
	serverVersion: input.serverVersion,
	updatedAt: createdAt,
}).where(eq(stories.id, input.storyId));
```

- [ ] **Step 3: Verify patch validator compiles**

Run: `npm.cmd run check`

Expected: PASS.

- [ ] **Step 4: Commit patch validator changes**

```bash
git add src/lib/server/turn/patchValidator.ts src/lib/server/events/timeline.test.ts
git commit -m "feat: persist timeline defaults for turn events"
```

## Task 7: End-To-End Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm.cmd test -- src/lib/contracts/memory.test.ts src/lib/server/events/timeline.test.ts src/lib/server/turn/promptHarness.test.ts
```

Expected: all listed test files PASS.

- [ ] **Step 2: Run full test suite**

Run: `npm.cmd test`

Expected: all Vitest tests PASS.

- [ ] **Step 3: Run type and Svelte checks**

Run: `npm.cmd run check`

Expected: PASS.

- [ ] **Step 4: Run migration on local backend**

Run:

```bash
npm.cmd run backend:up
npm.cmd run backend:migrate
```

Expected: output includes `apply 0007_event_timeline.sql` on the first run, then `database migrations complete`. A second run should print `skip 0007_event_timeline.sql`.

- [ ] **Step 5: Inspect repository state**

Run: `git status --short`

Expected: no unstaged or staged files remain after the task commits.

## Self-Review Checklist

- Spec coverage: Task 1 implements the schema and server turn clock; Task 2 defines contracts; Task 3 implements event query and due promotion helpers; Task 4 wires the brief into `/api/turn`; Task 5 preserves text-RPG appearance/personality/voice/mannerism descriptors in prompts; Task 6 persists timeline defaults and NPC links; Task 7 verifies tests, checks, and migration.
- Type consistency: `GmTimelineBrief`, `StoryEventStatus`, `NpcEventLinkRole`, `npcEventLinks`, `currentTurn`, `currentWorldTime`, `scheduledTurn`, and `occurredTurn` are named consistently across schema, contracts, service, and prompt code.
- Compatibility: existing `storyEvents.locationId` remains in place while `locationIds` adds richer querying. Existing memory nodes, wiki, Qdrant, and browser routes remain projections/clients rather than canon owners.
- Text-RPG requirement: NPC portrayal descriptors stay in `entities.state` and are rendered in the GM prompt, so living-world events do not flatten characters into bare IDs.
