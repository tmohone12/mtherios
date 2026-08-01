# Strategic Plot Brain Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Extend Mtherios' existing Strategic World Brain into a source-linked plot steering brain that mines lore/chapters/arcs, creates plot cards and antagonist candidates, schedules pressure beats, and feeds existing world simulation, narrator, timeline, scheme, memory, and review systems without making unsupported AI output canon.

**Architecture:** Build on the current `StrategicWorldBrainService` rather than adding a parallel prompt kitchen. The new layer adds strict Zod schemas for tension seeds, antagonist candidates, plot cards, activation plans, and write plans; prompt builders expose chapter/arc/lore/timeline material in bounded sections; a deterministic reconciler converts approved plot-card plans into existing `story_threads`, `story_events`, `npc_event_links`, and `patch_proposals`. The current `WorldSimulationService` and narrator prompt card then consume those records as slow-burn pressure.

**Tech Stack:** TypeScript, Zod, Drizzle/Postgres, SvelteKit, Vitest, existing AI SDK service abstractions, existing engine command envelope, existing timeline/story-thread/patch-proposal tables.

---

## Existing Systems to Connect

The implementation should attach to these existing seams:

- **Deep planner:** `src/lib/services/ai/generation/StrategicWorldBrainService.ts`
  - Already uses service id `strategicWorldBrain` and returns `StrategicWorldFrame`.
- **Strategic input prompt:** `src/lib/services/ai/context/strategicWorldBrainInput.ts`
  - Already includes story, current arc, recent arcs, relevant older arcs, current arc chapters, recent chapters, entries, factions, characters, schemes, threads, world events, rumors, agreements, reputation, and previous frame.
- **Strategic schema:** `src/lib/services/ai/sdk/schemas/strategicWorldBrain.ts`
  - Add plot-brain schemas here first; keep schema normalization tolerant but bounded.
- **Runtime strategic cards:** `src/lib/services/ai/context/strategicFramePromptCard.ts`
  - Add compact plot-card/pressure-clock output to narrator/worldsim blocks.
- **Fast world sim / momentum:** `src/lib/services/ai/generation/WorldSimulationService.ts`
  - Consume strategic plot pressure as the arc-level weather system; do not create a new planner in fast turns.
- **Canon tables:** `src/lib/server/db/schema.ts`
  - Reuse `storyThreads`, `storyEvents`, `npcEventLinks`, `patchProposals`, `sourceRefs`, `memoryNodes`, `continuityWarnings` before adding a `plot_cards` table.
- **Timeline service:** `src/lib/server/events/timeline.ts`
  - Use `scheduleTimelineEvent()` and `buildNpcEventLinksForEvent()` for pressure beats and NPC-specific relevance.
- **Patch review:** `src/lib/contracts/memory.ts`, `src/lib/server/memory/canonical.ts`, `WorldExplorer.svelte`
  - Hard state changes from plot brain should become patch proposals, not direct canon mutation.
- **Scheme system:** `src/lib/services/ai/scheme/SchemeService.ts`
  - Strategic plot cards can create/update schemes through existing scheme directive logic, but should not duplicate reactive scheme evaluation.
- **Engine orchestrator:** `src/lib/server/engine/orchestrator.ts`, `src/lib/server/engine/command.ts`
  - Add a world-tick/custom command path for running strategic plot planning and exposing result summaries through the control surface.
- **Wiki/vault/search projections:** `src/lib/services/wikiExport.ts`, `src/lib/server/wiki/storyVault.ts`
  - Export active plot pressure and clue trails as projections only; Postgres remains source of truth.

## Design Invariants

- Postgres backend canon is authoritative.
- AI output is proposal-only until validated by strict schema and backend write paths.
- Generated markdown, Qdrant, IndexedDB, and prompt cards are projections/caches, not canon.
- Plot steering creates pressure, clues, offers, delays, and consequences; it does not decide player actions.
- Secret plot facts must remain secret until a player-facing clue/event makes them visible.
- Use existing tables for v1. Do not add a `plot_cards` table until the shape proves stable.
- Every plot card must cite evidence from chapters, arcs, entries, events, threads, schemes, factions, agreements, or memory.

---

## Phase 1: Schema Shape — Plot Brain Result as Part of StrategicWorldFrame

### Task 1: Add plot-brain TypeScript interfaces

**Objective:** Extend runtime types so strategic frames can carry tension seeds, antagonist candidates, plot cards, activation decisions, and write-plan drafts.

**Files:**
- Modify: `src/lib/types/index.ts` near `StrategicWorldFrame`
- Test: existing schema tests later in this phase

**Step 1: Add interfaces before `StrategicWorldFrame`**

Add these types near the existing strategic types:

```ts
export type PlotBrainTensionKind =
  | 'debt'
  | 'oath'
  | 'rivalry'
  | 'resource_shortage'
  | 'succession'
  | 'secret'
  | 'romantic_pressure'
  | 'faction_goal_conflict'
  | 'wounded_pride'
  | 'mystery'
  | 'threat'
  | 'moral_contradiction'
  | 'earned_goodwill'
  | 'location_pressure'
  | 'other'

export interface PlotBrainTensionSeed {
  id: string
  title: string
  kind: PlotBrainTensionKind
  involvedEntityIds: string[]
  involvedFactionIds: string[]
  involvedLocationIds: string[]
  pressure: number
  volatility: number
  playerRelevance: number
  canonConfidence: number
  unresolvedQuestion: string
  whyItMatters: string
  evidenceRefs: StrategicEvidenceRef[]
}

export type PlotBrainActorRole =
  | 'primary_antagonist'
  | 'subplot_antagonist'
  | 'rival'
  | 'pressure_actor'
  | 'false_antagonist'
  | 'tragic_opponent'
  | 'hidden_patron'
  | 'unwitting_catalyst'

export interface PlotBrainAntagonistCandidate {
  id: string
  actorEntityId?: string | null
  actorFactionId?: string | null
  name: string
  role: PlotBrainActorRole
  tensionSeedIds: string[]
  motive: string
  fear: string
  woundOrNeed: string
  method: string
  lineTheyWillNotCross: string
  escalationTrigger: string
  hesitationTrigger: string
  plausibilityScore: number
  dramaticScore: number
  agencyRisk: number
  evidenceRefs: StrategicEvidenceRef[]
}

export type PlotBrainPlotKind = StrategicPlotLine['kind']
  | 'romantic_complication'
  | 'moral_dilemma'
  | 'social_pressure'
  | 'economic_pressure'

export type PlotBrainLifecycleStage =
  | 'seed'
  | 'simmer'
  | 'reveal'
  | 'escalate'
  | 'crisis'
  | 'fallout'
  | 'resolved'
  | 'dormant'

export interface PlotBrainClue {
  clue: string
  delivery: 'rumor' | 'scene_detail' | 'npc_behavior' | 'document' | 'found_object' | 'absence' | 'price_or_resource' | 'direct_confession' | 'other'
  truth: string
  visibility: 'subtle' | 'obvious'
  evidenceRefs: StrategicEvidenceRef[]
}

export interface PlotBrainPressureBeat {
  delayTurns: number
  title: string
  body: string
  urgency: 'simmer' | 'emerging' | 'immediate'
  visibility: 'secret' | 'player_known' | 'public'
  actorEntityIds: string[]
  targetEntityIds: string[]
  locationIds: string[]
  factionIds: string[]
  memoryImpact: Record<string, unknown>
}

export interface PlotBrainPlotCard {
  id: string
  title: string
  logline: string
  kind: PlotBrainPlotKind
  lifecycleStage: PlotBrainLifecycleStage
  pressure: number
  urgency: 'dormant' | 'simmer' | 'emerging' | 'immediate'
  visibility: 'secret' | 'rumored' | 'player_known' | 'public'
  actorEntityIds: string[]
  actorFactionIds: string[]
  antagonistCandidateIds: string[]
  targetEntityIds: string[]
  targetFactionIds: string[]
  locationIds: string[]
  goal: string
  motive: string
  method: string
  stakes: string
  playerTouchpoints: string[]
  clueTrail: PlotBrainClue[]
  pressureBeats: PlotBrainPressureBeat[]
  ignoredOutcome: string
  successOutcome: string
  failureOutcome: string
  partialOutcome: string
  sourceRefs: StrategicEvidenceRef[]
  continuityRisks: string[]
  antiRailroadNotes: string[]
}

export interface PlotBrainActivationPlan {
  activateNow: string[]
  keepDormant: string[]
  retireOrMerge: string[]
  rationale: string
}

export interface PlotBrainWritePlan {
  storyThreadCreates: Array<Partial<StoryThread> & { title?: string | null; sourceRefs?: StrategicEvidenceRef[] }>
  storyThreadUpdates: Array<{ threadId: string; status?: StoryThread['status']; significance?: StoryThread['significance']; description?: string; reason: string }>
  timelineEvents: Array<PlotBrainPressureBeat & { plotCardId: string; threadId?: string | null; sourceRefs: StrategicEvidenceRef[] }>
  patchProposals: StrategicCanonPatch[]
}
```

**Step 2: Add fields to `StrategicWorldFrame`**

Add optional/defaultable fields:

```ts
tensionSeeds: PlotBrainTensionSeed[]
antagonistCandidates: PlotBrainAntagonistCandidate[]
plotCards: PlotBrainPlotCard[]
activationPlan: PlotBrainActivationPlan
plotBrainWritePlan: PlotBrainWritePlan
```

**Step 3: Run typecheck later after schema task**

Do not run full check yet; schema still needs matching fields.

### Task 2: Add Zod schemas for plot-brain fields

**Objective:** Validate and normalize plot-brain output at the AI boundary.

**Files:**
- Modify: `src/lib/services/ai/sdk/schemas/strategicWorldBrain.ts`
- Test: `src/lib/services/ai/sdk/schemas/__tests__/schemas.test.ts`

**Step 1: Add schema definitions**

Add schemas near `strategicPlotLineSchema`:

```ts
const boundedScore = z.preprocess((value) => {
  const numeric = asNumber(value)
  if (numeric == null) return value
  return Math.max(0, Math.min(100, numeric))
}, z.number().min(0).max(100).default(50))

export const plotBrainTensionSeedSchema = z.object({
  id: z.string().default(''),
  title: z.string().default('Unresolved tension'),
  kind: z.enum([
    'debt', 'oath', 'rivalry', 'resource_shortage', 'succession', 'secret',
    'romantic_pressure', 'faction_goal_conflict', 'wounded_pride', 'mystery',
    'threat', 'moral_contradiction', 'earned_goodwill', 'location_pressure', 'other',
  ]).default('other'),
  involvedEntityIds: stringArray,
  involvedFactionIds: stringArray,
  involvedLocationIds: stringArray,
  pressure: boundedScore,
  volatility: boundedScore,
  playerRelevance: boundedScore,
  canonConfidence: confidence,
  unresolvedQuestion: z.string().default(''),
  whyItMatters: z.string().default(''),
  evidenceRefs: evidenceRefsArray,
})

export const plotBrainAntagonistCandidateSchema = z.object({
  id: z.string().default(''),
  actorEntityId: z.string().nullable().optional(),
  actorFactionId: z.string().nullable().optional(),
  name: z.string().default('Unknown actor'),
  role: z.enum([
    'primary_antagonist', 'subplot_antagonist', 'rival', 'pressure_actor',
    'false_antagonist', 'tragic_opponent', 'hidden_patron', 'unwitting_catalyst',
  ]).default('pressure_actor'),
  tensionSeedIds: stringArray,
  motive: z.string().default(''),
  fear: z.string().default(''),
  woundOrNeed: z.string().default(''),
  method: z.string().default(''),
  lineTheyWillNotCross: z.string().default(''),
  escalationTrigger: z.string().default(''),
  hesitationTrigger: z.string().default(''),
  plausibilityScore: boundedScore,
  dramaticScore: boundedScore,
  agencyRisk: boundedScore,
  evidenceRefs: evidenceRefsArray,
})

export const plotBrainClueSchema = z.object({
  clue: z.string(),
  delivery: z.enum(['rumor', 'scene_detail', 'npc_behavior', 'document', 'found_object', 'absence', 'price_or_resource', 'direct_confession', 'other']).default('other'),
  truth: z.string().default(''),
  visibility: z.enum(['subtle', 'obvious']).default('subtle'),
  evidenceRefs: evidenceRefsArray,
})

export const plotBrainPressureBeatSchema = z.object({
  delayTurns: z.number().int().min(0).max(50).default(1),
  title: z.string(),
  body: z.string(),
  urgency: z.enum(['simmer', 'emerging', 'immediate']).default('simmer'),
  visibility: z.enum(['secret', 'player_known', 'public']).default('secret'),
  actorEntityIds: stringArray,
  targetEntityIds: stringArray,
  locationIds: stringArray,
  factionIds: stringArray,
  memoryImpact: z.record(z.string(), z.unknown()).default({}),
})

export const plotBrainPlotCardSchema = z.object({
  id: z.string().default(''),
  title: z.string(),
  logline: z.string().default(''),
  kind: z.enum([
    'main_plot', 'subplot', 'character_arc', 'faction_plot', 'mystery', 'war',
    'political_intrigue', 'survival', 'personal_goal', 'background_pressure',
    'romantic_complication', 'moral_dilemma', 'social_pressure', 'economic_pressure',
  ]).default('subplot'),
  lifecycleStage: z.enum(['seed', 'simmer', 'reveal', 'escalate', 'crisis', 'fallout', 'resolved', 'dormant']).default('seed'),
  pressure: boundedScore,
  urgency: z.enum(['dormant', 'simmer', 'emerging', 'immediate']).default('simmer'),
  visibility: z.enum(['secret', 'rumored', 'player_known', 'public']).default('secret'),
  actorEntityIds: stringArray,
  actorFactionIds: stringArray,
  antagonistCandidateIds: stringArray,
  targetEntityIds: stringArray,
  targetFactionIds: stringArray,
  locationIds: stringArray,
  goal: z.string().default(''),
  motive: z.string().default(''),
  method: z.string().default(''),
  stakes: z.string().default(''),
  playerTouchpoints: stringArray,
  clueTrail: z.array(plotBrainClueSchema).default([]),
  pressureBeats: z.array(plotBrainPressureBeatSchema).default([]),
  ignoredOutcome: z.string().default(''),
  successOutcome: z.string().default(''),
  failureOutcome: z.string().default(''),
  partialOutcome: z.string().default(''),
  sourceRefs: evidenceRefsArray,
  continuityRisks: stringArray,
  antiRailroadNotes: stringArray,
})

export const plotBrainActivationPlanSchema = z.object({
  activateNow: stringArray,
  keepDormant: stringArray,
  retireOrMerge: stringArray,
  rationale: z.string().default(''),
}).default({ activateNow: [], keepDormant: [], retireOrMerge: [], rationale: '' })

export const plotBrainWritePlanSchema = z.object({
  storyThreadCreates: z.array(z.record(z.string(), z.unknown())).default([]),
  storyThreadUpdates: z.array(z.object({
    threadId: z.string(),
    status: z.enum(['open', 'imminent', 'stalled', 'closed', 'abandoned']).optional(),
    significance: z.enum(['minor', 'moderate', 'major', 'critical']).optional(),
    description: z.string().optional(),
    reason: z.string().default('Strategic plot brain update.'),
  })).default([]),
  timelineEvents: z.array(plotBrainPressureBeatSchema.extend({
    plotCardId: z.string().default(''),
    threadId: z.string().nullable().optional(),
    sourceRefs: evidenceRefsArray,
  })).default([]),
  patchProposals: z.array(strategicCanonPatchSchema).default([]),
}).default({ storyThreadCreates: [], storyThreadUpdates: [], timelineEvents: [], patchProposals: [] })
```

**Step 2: Add fields to `strategicWorldFrameBaseSchema`**

Add defaults:

```ts
tensionSeeds: z.array(plotBrainTensionSeedSchema).default([]),
antagonistCandidates: z.array(plotBrainAntagonistCandidateSchema).default([]),
plotCards: z.array(plotBrainPlotCardSchema).default([]),
activationPlan: plotBrainActivationPlanSchema,
plotBrainWritePlan: plotBrainWritePlanSchema,
```

**Step 3: Add normalization for common model shapes**

In `normalizeStrategicWorldFrame`, map likely aliases:

```ts
if (!Array.isArray(frame.tensionSeeds) && Array.isArray(frame.tensions)) frame.tensionSeeds = frame.tensions
if (!Array.isArray(frame.antagonistCandidates) && Array.isArray(frame.actors)) frame.antagonistCandidates = frame.actors
if (!Array.isArray(frame.plotCards) && Array.isArray(frame.plots)) frame.plotCards = frame.plots
if (!isRecord(frame.activationPlan) && isRecord(frame.plotActivationPlan)) frame.activationPlan = frame.plotActivationPlan
if (!isRecord(frame.plotBrainWritePlan) && isRecord(frame.writePlan)) frame.plotBrainWritePlan = frame.writePlan
```

**Step 4: Write schema tests**

Add tests to `src/lib/services/ai/sdk/schemas/__tests__/schemas.test.ts` proving:

- minimal strategic frame defaults plot-brain fields to empty arrays
- alternate keys `tensions`, `actors`, `plots`, `writePlan` normalize correctly
- numeric scores clamp to 0-100
- confidence accepts 75 as 0.75 if existing confidence helper already does this

**Step 5: Run focused schema test**

Run:

```bash
npm test -- src/lib/services/ai/sdk/schemas/__tests__/schemas.test.ts
```

Expected: PASS.

---

## Phase 2: Prompt Contract — Make the Deep Brain Actually Think in Tensions, Actors, Plot Cards, and Write Plans

### Task 3: Update strategic system prompt with plot-brain role contract

**Objective:** Teach the planner to produce plot-brain fields without breaking existing strategic outputs.

**Files:**
- Modify: `src/lib/services/ai/context/strategicWorldBrainInput.ts`
- Test: `src/lib/services/ai/context/strategicWorldBrainInput.test.ts`

**Step 1: Extend `buildStrategicWorldBrainSystemPrompt()`**

Add a block after the existing job list:

```ts
`\n\nPLOT BRAIN CONTRACT:
- First mine unresolved tensions from canon. Do not create plots from vibes.
- Then select actors or antagonists whose desires plausibly create friction. Antagonists do not need to be evil.
- Then shape simple plotCards with clue trails, pressure beats, ignored outcomes, and anti-railroad notes.
- Then create a plotBrainWritePlan that maps approved pressure into existing Mtherios systems: storyThreads for durable plot identity, storyEvents for scheduled pressure beats, npcEventLinks through actor/target ids, and patchProposals for hard state changes.
- Every tensionSeed and plotCard must include evidenceRefs. Low-evidence ideas are proposals, not canon.
- Use at most one immediate plot card. Most plot pressure should simmer or emerge slowly.
- Do not make every ally secretly treacherous. Earned goodwill can become real help.\n`
```

**Step 2: Extend JSON field-name instructions**

Add exact names:

```ts
`- tensionSeeds[] describe unresolved canon tensions before plot invention.
- antagonistCandidates[] describe plausible pressure actors and their motives/fears/methods.
- plotCards[] are executable plot/subplot cards with clueTrail and pressureBeats.
- activationPlan chooses which plotCards activate now, stay dormant, or retire/merge.
- plotBrainWritePlan maps plotCards to storyThreads, timelineEvents, and patchProposals.\n`
```

**Step 3: Add tests**

In `strategicWorldBrainInput.test.ts`, assert system prompt contains:

```ts
expect(prompt).toContain('PLOT BRAIN CONTRACT')
expect(prompt).toContain('tensionSeeds[]')
expect(prompt).toContain('plotCards[]')
expect(prompt).toContain('plotBrainWritePlan')
expect(prompt).toContain('storyThreads for durable plot identity')
expect(prompt).toContain('storyEvents for scheduled pressure beats')
```

**Step 4: Run focused prompt tests**

Run:

```bash
npm test -- src/lib/services/ai/context/strategicWorldBrainInput.test.ts
```

Expected: PASS.

### Task 4: Add a user-prompt section for explicit memory weighting

**Objective:** Make the service read lore, chapters, arcs, and older memory with different authority levels.

**Files:**
- Modify: `src/lib/services/ai/context/strategicWorldBrainInput.ts`
- Test: `src/lib/services/ai/context/strategicWorldBrainInput.test.ts`

**Step 1: Add section to `buildStrategicWorldBrainUserPrompt()` before `BUILD THE NEXT STRATEGIC WORLD FRAME`**

```ts
'PLOT MEMORY WEIGHTING',
'Immediate scene memory: recent raw entries and current location override broad plans. Do not steer away from the player’s current situation unless a scheduled event is due.',
'Chapter memory: use scene outcomes, irreversible changes, NPC knowledge changes, promises/debts/oaths, discovered clues, relationship changes, faction changes, and open threads as medium-term causal fuel.',
'Arc memory: use arcs for strategic direction, recurring conflicts, stale threads, and character trajectory.',
'Saga or older memory: use as theme and long-term consequence only, not as permission for sudden twists.',
'Every plotCard must cite at least one evidenceRef from chapter, arc, lore/entity, scheme, thread, event, agreement, faction, rumor, or memory.',
```

**Step 2: Add tests**

Assert prompt contains `PLOT MEMORY WEIGHTING`, `Chapter memory`, `Arc memory`, and `Every plotCard must cite`.

**Step 3: Run focused prompt tests**

Run:

```bash
npm test -- src/lib/services/ai/context/strategicWorldBrainInput.test.ts
```

Expected: PASS.

---

## Phase 3: Deterministic Reconciler — Connect Plot Cards to Timeline, Threads, and Review

### Task 5: Create plot-brain reconciler helper

**Objective:** Convert `StrategicWorldFrame.plotBrainWritePlan` into validated draft operations using existing canon surfaces.

**Files:**
- Create: `src/lib/server/plotBrain/reconciler.ts`
- Test: `src/lib/server/plotBrain/reconciler.test.ts`

**Step 1: Write failing tests**

Test cases:

1. It limits immediate timeline events to one per run.
2. It converts `storyThreadCreates` into safe thread inserts with generated ids.
3. It preserves source refs in metadata and source arrays where possible.
4. It rejects timeline events without title/body.
5. It rejects pressure beats that force player actions by text pattern if reuse possible from `plotMomentumAgency` or add a local guard.

**Step 2: Implement pure planner first**

Start with a pure function, no DB writes:

```ts
export interface PlotBrainReconcileInput {
  storyId: string
  currentTurn: number
  frame: StrategicWorldFrame
  now: string
}

export interface PlotBrainReconcilePlan {
  threadCreates: Array<typeof storyThreads.$inferInsert>
  threadUpdates: Array<{ id: string; updates: Partial<typeof storyThreads.$inferInsert>; reason: string }>
  timelineEvents: Array<Parameters<typeof buildScheduledTimelineEventInsert>[0]>
  patchProposalCreates: Array<typeof patchProposals.$inferInsert>
  warnings: string[]
}

export function buildPlotBrainReconcilePlan(input: PlotBrainReconcileInput): PlotBrainReconcilePlan
```

**Step 3: Use existing event builder shape**

For each timeline event draft, create args compatible with `buildScheduledTimelineEventInsert()`:

```ts
{
  storyId,
  type: 'plot_pressure' as StoryEventType,
  title,
  body,
  currentTurn,
  delayTurns,
  now,
  actorEntityIds,
  targetEntityIds,
  locationIds,
  factionIds,
  threadIds: [threadId].filter(Boolean),
  visibility,
  memoryImpact,
  metadata: {
    source: 'strategic_plot_brain',
    plotCardId,
    urgency,
    sourceRefs,
  },
}
```

**Step 4: Enforce pacing limits**

Inside the pure helper:

```ts
const MAX_IMMEDIATE = 1
const MAX_EMERGING = 2
const MAX_TOTAL_EVENTS = 6
```

Downgrade or skip extras with warnings.

**Step 5: Run tests**

Run:

```bash
npm test -- src/lib/server/plotBrain/reconciler.test.ts
```

Expected: PASS.

### Task 6: Add DB apply function for reconciler

**Objective:** Actually write accepted thread/event/proposal drafts through backend code, while preserving validation and source links.

**Files:**
- Modify: `src/lib/server/plotBrain/reconciler.ts`
- Test: `src/lib/server/plotBrain/reconciler.test.ts` or integration-style memory canonical test if patterns exist

**Step 1: Add apply function**

```ts
export async function applyPlotBrainReconcilePlan(plan: PlotBrainReconcilePlan): Promise<{
  threadsCreated: number
  threadsUpdated: number
  eventsScheduled: number
  patchProposalsCreated: number
  warnings: string[]
}> {
  // use getDb().transaction
}
```

**Step 2: Insert story threads**

Use `getDb().insert(storyThreads).values(...).onConflictDoNothing()`.

**Step 3: Update existing story threads**

Only allow fields:

- `description`
- `status`
- `significance`
- `relatedFactionIds`
- `relatedEntityIds`
- `sourceEventIds`
- `sourcePatchIds`
- `updatedAt`

Do not overwrite unrelated fields.

**Step 4: Schedule timeline events**

Prefer calling `scheduleTimelineEvent()` so `npc_event_links` are created consistently.

**Step 5: Insert patch proposals**

Use `patchProposals` with:

```ts
proposalType: 'strategic_plot_brain'
targetTable: proposal.targetTable ?? 'story_threads'
targetRecordId: proposal.targetRecordId ?? storyId
proposedBy: 'strategic_plot_brain'
status: 'pending'
metadata.source = 'strategic_plot_brain'
```

**Step 6: Run tests**

Run:

```bash
npm test -- src/lib/server/plotBrain/reconciler.test.ts
```

Expected: PASS.

---

## Phase 4: Service Integration — StrategicWorldBrainService Produces IDs and Reconcile Summary

### Task 7: Stabilize IDs for plot-brain outputs

**Objective:** Ensure model outputs without ids receive deterministic-ish runtime ids before later systems consume them.

**Files:**
- Modify: `src/lib/services/ai/generation/StrategicWorldBrainService.ts`
- Test: create or extend `src/lib/services/ai/generation/StrategicWorldBrainService.test.ts`

**Step 1: Add id fill helpers**

In service file:

```ts
function fillId(prefix: string, value: string | undefined, index: number): string {
  return value?.trim() || `${prefix}_${index + 1}_${uuid().slice(0, 8)}`
}
```

**Step 2: Normalize frame fields after schema parse**

Inside `plan()` frame construction:

```ts
tensionSeeds: result.tensionSeeds.map((seed, index) => ({ ...seed, id: fillId('tension', seed.id, index) })),
antagonistCandidates: result.antagonistCandidates.map((candidate, index) => ({ ...candidate, id: fillId('actor', candidate.id, index) })),
plotCards: result.plotCards.map((card, index) => ({ ...card, id: fillId('plot', card.id, index) })),
activationPlan: result.activationPlan,
plotBrainWritePlan: result.plotBrainWritePlan,
```

**Step 3: Test**

Mock `generateStructured()` result with empty ids and assert returned frame has ids.

**Step 4: Run test**

Run:

```bash
npm test -- src/lib/services/ai/generation/StrategicWorldBrainService.test.ts
```

Expected: PASS.

### Task 8: Add strategic plot-brain command handler

**Objective:** Expose planning through the engine command boundary so the control surface/MCP/orchestrator can run it.

**Files:**
- Modify: `src/lib/server/engine/command.ts`
- Modify: `src/lib/contracts/engine.ts`
- Test: `src/lib/server/engine/command.test.ts`

**Step 1: Add command args schema**

In `contracts/engine.ts`, add args for something like:

```ts
export const engineStrategicPlotBrainArgsSchema = z.object({
  trigger: strategicBrainTriggerSchema.default('manual'),
  execute: z.boolean().default(false),
  includeSecret: z.boolean().default(true),
  currentTurn: z.number().int().nonnegative().optional(),
})
```

If importing schema from AI layer creates an undesirable dependency, duplicate the trigger enum in contracts and keep it in sync with a test.

**Step 2: Add command case**

In `executeEngineCommand`, add:

```ts
case 'plotBrain.plan': {
  // load story context using existing canonical loaders
  // call aiServices.strategicWorldBrain.plan(input)
  // build reconcile plan
  // apply only if args.execute === true
  // return frame summary + reconcile summary
}
```

Important: if full context loading is not yet centrally available, implement this as a thin command that calls a new helper from Phase 5.

**Step 3: Test non-execute path**

Assert command returns:

- status succeeded
- frame summary contains plotCards count
- no DB apply occurred when `execute:false`

**Step 4: Test execute path with stubbed reconciler**

Assert `applyPlotBrainReconcilePlan()` called only when `execute:true`.

**Step 5: Run command tests**

Run:

```bash
npm test -- src/lib/server/engine/command.test.ts
```

Expected: PASS.

---

## Phase 5: Context Cartographer — Build Complete Strategic Input from Existing Backend State

### Task 9: Create backend context builder for strategic plot planning

**Objective:** Load the existing systems into `StrategicWorldBrainInput` without depending on browser store state.

**Files:**
- Create: `src/lib/server/plotBrain/context.ts`
- Test: `src/lib/server/plotBrain/context.test.ts`

**Step 1: Define input/output**

```ts
export interface LoadStrategicPlotBrainContextInput {
  storyId: string
  trigger: StrategicBrainTrigger
  currentTurn?: number
  includeSecret?: boolean
}

export async function loadStrategicPlotBrainContext(input: LoadStrategicPlotBrainContextInput): Promise<StrategicWorldBrainInput>
```

**Step 2: Load from Postgres tables**

Use `getDb()` and existing schema tables:

- `stories`
- `chapters`
- `arcs`
- `sagas` if useful for metadata/prompt in future
- `storyEntries`
- `entities`
- `factions`
- `relationships`
- `storyThreads`
- `storyEvents`
- `npcEventLinks`
- `agreements`
- existing scheme source if schemes are still IndexedDB/browser-side for now; if backend schema exists elsewhere, use canonical loader

**Step 3: Preserve existing shape**

If backend rows do not map exactly to local `Entry`, create small mapper helpers in this file. Do not mutate global stores.

**Step 4: Select relevant older arcs**

Use deterministic selection:

- always current arc and recent 4 arcs
- older arcs matching open thread ids or faction/entity names
- cap at 4 older arcs

**Step 5: Test selection**

Use fixture rows to prove:

- current arc selected
- recent chapters selected newest-first or bounded as prompt expects
- older relevant arc selected because its `openThreadIds` intersects active threads
- deleted/closed/abandoned threads are filtered where appropriate

**Step 6: Run tests**

Run:

```bash
npm test -- src/lib/server/plotBrain/context.test.ts
```

Expected: PASS.

### Task 10: Wire context builder into `plotBrain.plan` command

**Objective:** Make the engine command run with real backend context.

**Files:**
- Modify: `src/lib/server/engine/command.ts`
- Modify: `src/lib/server/engine/command.test.ts`

**Step 1: Use helper**

Command flow:

```ts
const context = await loadStrategicPlotBrainContext({ storyId, trigger, currentTurn, includeSecret })
const frame = await aiServices.strategicWorldBrain.plan(context)
const reconcilePlan = buildPlotBrainReconcilePlan({ storyId, currentTurn: context.story.currentTurn, frame, now })
const applied = execute ? await applyPlotBrainReconcilePlan(reconcilePlan) : null
```

**Step 2: Return compact response**

Response result should include:

```ts
{
  frameId,
  arcNumber,
  tensionSeeds: frame.tensionSeeds.length,
  antagonistCandidates: frame.antagonistCandidates.length,
  plotCards: frame.plotCards.length,
  scheduledEvents: reconcilePlan.timelineEvents.length,
  patchProposals: reconcilePlan.patchProposalCreates.length,
  applied,
  warnings,
  narratorPromptCard: frame.narratorPromptCard,
}
```

**Step 3: Add test with mocked context/service/reconciler**

Assert the command calls all pieces in order.

**Step 4: Run tests**

Run:

```bash
npm test -- src/lib/server/engine/command.test.ts
```

Expected: PASS.

---

## Phase 6: Runtime Consumption — Make Other Systems Feel the Plot Brain

### Task 11: Add plot-card pressure to strategic prompt-card builders

**Objective:** Let narrator and fast world sim see compact plot pressure without leaking all hidden machinery.

**Files:**
- Modify: `src/lib/services/ai/context/strategicFramePromptCard.ts`
- Test: create `src/lib/services/ai/context/strategicFramePromptCard.test.ts` if none exists

**Step 1: Add compact formatter**

```ts
function formatPlotCards(frame: StrategicWorldFrame, includeSecret: boolean): string {
  return (frame.plotCards ?? [])
    .filter(card => includeSecret || card.visibility !== 'secret')
    .slice(0, includeSecret ? 5 : 3)
    .map(card => {
      const clues = card.clueTrail?.length ? ` Clues: ${card.clueTrail.slice(0, 2).map(c => c.clue).join('; ')}` : ''
      const touch = card.playerTouchpoints?.length ? ` Touchpoints: ${card.playerTouchpoints.slice(0, 2).join('; ')}` : ''
      return `- [${card.urgency}/${card.lifecycleStage}] ${card.title}: ${compact(card.logline || card.stakes, 420)}${touch}${clues}`
    })
    .join('\n')
}
```

**Step 2: Narrator block uses visible/guarded pressure**

In `buildStrategicNarratorBlock`, include plot cards but keep warning:

```text
Plot pressure is guidance only. Do not reveal secret actor/motive unless evidence is present.
```

**Step 3: World sim block includes fuller pressure**

In `buildStrategicWorldSimBlock`, include plot cards, pressure beats, ignored outcomes, and clocks more freely because it is hidden planner context.

**Step 4: Tests**

Assert:

- narrator block includes plot title and touchpoint
- narrator block includes anti-secret warning
- worldsim block includes ignored outcome
- compacting prevents giant prompt section

**Step 5: Run tests**

Run:

```bash
npm test -- src/lib/services/ai/context/strategicFramePromptCard.test.ts
```

Expected: PASS.

### Task 12: Let timeline due events drive scheme evaluation and plot card maturation

**Objective:** Ensure scheduled plot beats interact with existing SchemeService and world simulation rather than sitting inert.

**Files:**
- Modify: `src/lib/services/ai/scheme/SchemeService.ts`
- Test: `src/lib/services/ai/scheme/SchemeService.test.ts`

**Step 1: Extend relevant timeline event types**

Add to `SCHEME_RELEVANT_TIMELINE_EVENTS`:

```ts
'plot_pressure',
'clue',
'rumor',
```

Only if `StoryEventType` permits these values. If type is open string, fine; if enum is strict, add to contract first.

**Step 2: Add test**

Assert `shouldEvaluate({ timeline_events: [{ type: 'plot_pressure' }] })` returns true.

**Step 3: Run test**

Run:

```bash
npm test -- src/lib/services/ai/scheme/SchemeService.test.ts
```

Expected: PASS.

### Task 13: Make chapter condensation preserve plot-brain fuel

**Objective:** Ensure chapters/arcs feed future planning with tension-rich data.

**Files:**
- Modify: `src/lib/server/jobs/processor.ts` around chapter digest prompt
- Test: existing processor tests if available, otherwise add focused prompt-string test if helper is exported

**Step 1: Update chapter digest prompt**

Where prompt says to use `plotThreads`, add:

```text
Use plotThreads for unresolved dangers, promises, relationship tensions, mysteries, clue trails, antagonist pressure, faction pressure, and earned goodwill that should carry forward.
```

**Step 2: Ensure deterministic fallback includes timeline event thread ids and plot pressure events**

If chapter digest fallback already pulls `eventTitles` and `threadIds`, ensure `plot_pressure` events are not filtered out.

**Step 3: Run related tests**

Run likely tests:

```bash
npm test -- src/lib/server/jobs/processor.test.ts
```

If no test file exists, run a focused search and add one around the exported digest helper only if practical.

---

## Phase 7: UI / Control Surface — Make the Brain Inspectable

### Task 14: Add engine command to WorldExplorer control surface

**Objective:** Let the user run a review-only or execute plot brain pass from the database/control UI.

**Files:**
- Modify: `src/lib/components/database/WorldExplorer.svelte`
- Test: `src/lib/components/database/WorldExplorer.gateway.test.ts`

**Step 1: Add a control action**

Add button/action near orchestrator/LLM controls:

- `Plan Plot Brain` → `plotBrain.plan` with `execute:false`
- `Apply Plot Brain Plan` → `plotBrain.plan` with `execute:true`

If UI already has generic command input, prefer adding a small preset rather than new heavy UI.

**Step 2: Show summary**

Display counts:

- tension seeds
- antagonist candidates
- plot cards
- scheduled events
- patch proposals
- warnings

**Step 3: Test gateway boundary**

Update `WorldExplorer.gateway.test.ts` to assert:

```ts
expect(source).toContain('plotBrain.plan')
expect(source).toContain('Plan Plot Brain')
```

**Step 4: Run test**

Run:

```bash
npm test -- src/lib/components/database/WorldExplorer.gateway.test.ts
```

Expected: PASS.

### Task 15: Export active plot pressure to wiki/vault projection

**Objective:** Make active plot pressure visible in generated campaign docs without making markdown canonical.

**Files:**
- Modify: `src/lib/services/wikiExport.ts`
- Test: create/update wiki export tests if present

**Step 1: Extend existing scheme/thread section**

The export already includes active schemes/open threads. Add a subsection for recent `storyEvents` with `metadata.source === 'strategic_plot_brain'` and open story threads with plot-brain metadata.

**Step 2: Include only player-known/public secrets in player-facing export**

For secret events, either omit or mark under GM-only page if such split exists.

**Step 3: Run tests**

Run related wiki export tests or at minimum:

```bash
npm test -- src/lib/services/wikiExport.test.ts
```

If no test exists, add a narrow test for formatting function if exported; otherwise defer with manual verification in final phase.

---

## Phase 8: Orchestrator Integration — Add Worker Roles Without Adding a New Agent Sprawl

### Task 16: Extend orchestrator world_tick plan with plot-brain command

**Objective:** Let backend orchestrator include strategic plot planning on world ticks/manual custom runs.

**Files:**
- Modify: `src/lib/server/engine/orchestrator.ts`
- Test: `src/lib/server/engine/orchestrator.test.ts` or `command.test.ts` depending existing coverage

**Step 1: Add role responsibility text**

Update `faction_simulator` or add no new role. Prefer reusing `faction_simulator` + `continuity_auditor`:

- faction simulator: can call `plotBrain.plan` for arc-level pressure
- continuity auditor: reviews warnings/contradictions

Avoid adding a separate role until needed.

**Step 2: Add world_tick tool call**

In `buildWorldTickToolCalls()`, add after `timeline.brief` and before `jobs.worldSim`:

```ts
makeToolCall(1, 'faction_simulator', 'plotBrain.plan', {
  trigger: 'manual',
  execute: false,
  includeSecret: true,
}, 'Draft strategic plot pressure before running fast world simulation; keep it reviewable unless explicitly executed.')
```

Do not execute by default. For custom/manual mode, allow context flag `executePlotBrain` later.

**Step 3: Renumber or use array insertion carefully**

Keep tests stable.

**Step 4: Test**

Assert orchestrator plan includes `plotBrain.plan` for world_tick and not for normal turn unless requested.

**Step 5: Run tests**

Run:

```bash
npm test -- src/lib/server/engine/orchestrator.test.ts src/lib/server/engine/command.test.ts
```

Expected: PASS.

---

## Phase 9: End-to-End Verification

### Task 17: Add focused integration test for review-only plot brain pass

**Objective:** Prove a plot-brain plan can be requested without mutating canon.

**Files:**
- Test: `src/lib/server/engine/command.test.ts` or new `src/lib/server/plotBrain/plotBrainCommand.test.ts`

**Step 1: Arrange fake context and fake AI frame**

Frame contains:

- one tension seed
- one antagonist candidate
- one plot card
- one timeline event in write plan

**Step 2: Execute `plotBrain.plan` with `execute:false`**

Assert:

- result counts are correct
- `scheduleTimelineEvent` not called
- DB insert helper not called

**Step 3: Execute with `execute:true`**

Assert:

- apply function called
- summary reports scheduled event count

**Step 4: Run test**

Run:

```bash
npm test -- src/lib/server/engine/command.test.ts
```

Expected: PASS.

### Task 18: Full local verification

**Objective:** Confirm the implementation did not break project quality gates.

**Files:**
- No code changes beyond prior tasks

**Step 1: Run focused tests first**

Run:

```bash
npm test -- src/lib/services/ai/sdk/schemas/__tests__/schemas.test.ts src/lib/services/ai/context/strategicWorldBrainInput.test.ts src/lib/server/plotBrain/reconciler.test.ts src/lib/server/engine/command.test.ts
```

Expected: PASS.

**Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS, or report unrelated pre-existing failures with exact failing tests.

**Step 3: Run type/check**

Run:

```bash
npm run check
```

Expected: PASS.

**Step 4: Run build**

Run:

```bash
npm run build
```

Expected: PASS. Existing Svelte accessibility/chunk warnings are warnings, not blockers, if no new errors appear.

---

## Future Phase: Optional `plot_cards` Table

Do not start here. Add a dedicated table only after v1 proves useful through `story_threads` + `story_events`.

Possible migration later:

```ts
plotCards: {
  id, storyId, title, logline, kind, lifecycleStage, pressure, urgency,
  visibility, actorEntityIds, actorFactionIds, targetEntityIds,
  targetFactionIds, locationIds, goal, motive, method, stakes,
  clueTrail, pressureBeats, outcomes, sourceEntryIds, sourceEventIds,
  sourcePatchIds, metadata, serverVersion, createdAt, updatedAt
}
```

Add only if:

- UI needs direct plot-card browsing/filtering,
- story_threads metadata becomes too crowded,
- or plot cards need independent lifecycle beyond thread/event records.

---

## Rollout Strategy

1. **Review-only first:** `plotBrain.plan execute:false` should work before anything writes canon.
2. **Schedule only:** Allow `execute:true` to create story threads and scheduled events, but patch proposals remain pending.
3. **Worldsim consumption:** Fast world sim reads scheduled/due pressure and strategic cards.
4. **Narrator visibility:** Narrator only sees compact scene-relevant pressure, never raw secret motive dumps.
5. **UI inspection:** User can inspect generated tensions, actors, plot cards, scheduled beats, and warnings.
6. **Tighten prompts after real runs:** Update prompt/schema normalization from observed model failures.

## Acceptance Criteria

- Strategic brain output includes `tensionSeeds`, `antagonistCandidates`, `plotCards`, `activationPlan`, and `plotBrainWritePlan`.
- Every generated plot card has source evidence or is downgraded/warned as low-confidence proposal.
- Review-only command produces no DB writes.
- Execute command writes through existing validated backend paths.
- Pressure beats appear as `story_events` and link to NPCs through existing timeline/NPC event logic.
- Hard state changes are patch proposals, not direct canon mutation.
- World sim and narrator prompt cards can consume compact plot pressure.
- Full verification commands pass or known unrelated failures are documented.

## Notes for Implementation Agents

- Do not broad-stage this repo; the worktree is dirty.
- Prefer small pure helpers and focused tests before DB integration.
- Do not add dependencies.
- Do not create a second strategic prompt service; extend the existing strategic world brain.
- Keep prompt sections bounded. If context gets large, select better; do not raise token caps first.
- Preserve the existing slow-burn/agency guards from `WorldSimulationService` and `plotMomentumAgency`.
