# SchemeService — Antagonist Intent Spec

## Problem

WorldSim is reactive: it summarizes the world *up to now* and emits faction-level
moves once per N in-world days. It doesn't model multi-turn antagonist plans, so
enemies don't *plot*. Lower-tier models (GLM, Kimi, DeepSeek) default to neutral
narration because nothing in context demands premeditated antagonism — only Opus
and Gemini 3 Pro infer it from vibes alone.

## Core idea

A `Scheme` is a persistent multi-stage plan owned by an antagonist (faction or
named NPC). Schemes are *birthed by player actions* and *advance on the world
clock*. When a stage matures, the service injects a concrete narrative hook into
the next turn's context — forcing the narrator to deliver, even on weak models.

## Schema

```ts
interface Scheme {
  id: string;
  storyId: string;
  ownerType: 'faction' | 'character';
  ownerEntryId: string;          // lorebook entry id
  ownerName: string;             // display name (for prompt injection)

  goal: string;                  // "kill the Lannister heir", "marry the heiress"
  trigger: string;               // what player action birthed this scheme
  triggerChapter: number;        // when it was set in motion
  triggerEntryId: string | null; // the story entry that birthed it

  stages: SchemeStage[];
  currentStageIndex: number;
  pressure: number;              // 0-100, scales narrative intensity

  status: 'incubating' | 'active' | 'climaxing' | 'resolved' | 'foiled' | 'abandoned';
  secrecy: 'secret' | 'rumored' | 'known';  // does the player know?
  nextTickAt: number | null;     // in-world day to advance regardless of player
  createdAt: number;
  updatedAt: number;
}

interface SchemeStage {
  index: number;
  label: string;                 // "gather allies", "forge the letter", "strike at feast"
  hook: string;                  // narrative beat to inject when stage activates
  condition: 'time' | 'player-location' | 'player-act' | 'prerequisite';
  conditionPayload: Record<string, any>;  // depends on type
  completed: boolean;
  completedAt: number | null;
}
```

## Where it slots in

```
Player action
    ↓
Narrator streams prose
    ↓
update_world_state (existing)
    ↓
┌─────────────────────────────────┐
│  NEW: SchemeService.evaluate()  │  ← reactive: did this turn create/escalate a scheme?
└─────────────────────────────────┘
    ↓
tickWorld(deltaMinutes)
    ↓
  ageRumors (existing)
  maybeRunWorldSim (existing)
┌─────────────────────────────────┐
│  NEW: SchemeService.tick()      │  ← proactive: advance stages, mature hooks
└─────────────────────────────────┘
    ↓
Next turn's context assembly
    ↓
┌─────────────────────────────────┐
│  NEW: SchemeService.inject()    │  ← prepend active scheme hooks into narrator system
└─────────────────────────────────┘
```

Three entry points, one service file, one new table.

## MVP (ship in 1-2 sessions)

1. **`schemes` table** + CRUD in `database.ts`. Mirror `rumors`/`factionActions`.
2. **`SchemeService.evaluate()`** — one LLM call after `update_world_state`. Reads
   recent narrative + existing schemes + lorebook antagonists. Returns:
   - new scheme to create (if player did something that warrants one)
   - existing scheme to escalate (advance stage / raise pressure)
   - nothing
   Forced tool: `manage_schemes`. Single call, cheap, 0.3 temp.
3. **`SchemeService.tick(daysElapsed)`** — purely deterministic. No LLM. Walk
   active schemes, increment in-world clock, advance any stage whose `condition:
   'time'` matured. Pressure increments by 5 per stage advance, caps at 100.
4. **`SchemeService.inject(snapshot)`** — adds an "## Active Schemes Against
   You" section to the narrator system prompt when any scheme has
   `status=active|climaxing` and `secrecy != secret` (or `pressure >= 70`
   regardless of secrecy — fate closes in). Lists owner + current stage hook.

Stop here. Test on a real ASOIAF playthrough. If antagonism feels real, ship.

## Full version (later)

- **`condition: 'player-location'`** — scheme matures when player enters a specific
  location ("the assassin is waiting at Harrenhal")
- **`condition: 'prerequisite'`** — scheme stage gates on another scheme/event
  finishing first
- **Scheme entanglement** — when scheme A reaches stage N, scheme B
  (different antagonist) reacts (vassals scheme against the schemer)
- **Foiling detection** — `evaluate()` recognizes when player action neutralizes
  a scheme (kills the schemer, exposes the plot) and marks `status=foiled` with
  a closure beat
- **Secret-aware injection** — `secret` schemes don't show in context but DO
  show in a GM-only "Hidden Schemes" sidebar in the World drawer for debugging

## Tradeoffs to flag

- **Cost:** one extra structured call per turn (`evaluate`). ~1k tokens system +
  300-800 tokens response. On the classifier-tier model it's pennies.
- **Latency:** runs *after* narration streams to the player, in parallel with
  `runBackgroundJobs`. Player doesn't wait.
- **Prompt bloat:** at most 3-4 active schemes injected per turn. Cap at 4 to
  bound context cost. Resolved/foiled schemes drop out.
- **Save/branch:** schemes belong to a branch. Branching the story branches the
  schemes (same pattern as `WorldEvent`). Existing infra handles this.
- **The mildness fix isn't free** — even with schemes injected, GLM-class models
  still need permission language ("you are writing tragic, grim ASOIAF — execute
  the scheme's stage hook decisively"). The schemes give them *what* to do; the
  prompt gives them *how violent* to be.

## Decisions (locked)

1. **`evaluate()` runs only when a story beat fires this turn** — cheaper path.
   The `update_world_state` payload already tells us when something narratively
   significant happened (`story_beats` array, `significance` >= moderate, OR a
   death, OR an agreement break). Plot-worthy moments are exactly when antagonists
   would notice and scheme. Quiet turns (player buys bread, walks to inn) skip
   the call entirely. Expected savings: 60-80% of turns skip `evaluate()`.

2. **Player-side schemes are in MVP.** Player declares intent ("I plan to kill
   Lord Frey at the wedding"), system tracks stages and consequences. Same
   schema, same service — `ownerType = 'player'`, `ownerEntryId = null`.
   - Stage advancement uses `condition: 'player-act'` predominantly (vs
     antagonist schemes which lean on `'time'`)
   - Injection differs: player schemes are surfaced to the GM/narrator as
     *opportunities and obstacles* ("Stage 2/4 reminds you: you still need
     to get the poison from the alchemist"), not as inevitable beats
   - The narrator should *complicate* player schemes (guards added, target
     forewarned by rumor, ally hesitates) — the system prompt for the
     scheme-injection block instructs this explicitly
   - **UX: both paths shipped** — `/plan <text>` inline command in ActionInput
     for fast declaration, AND a "Plan" button in the action bar that opens a
     modal with a textarea. Both funnel through `declarePlayerScheme()` which
     calls `declare_player_scheme` to structure stages.

## Open questions remaining

- Ambient antagonists — should `tick()` ever spontaneously *create* a scheme
  without a player trigger (Ramsay-style: "hates you for existing")? Probably
  yes, gated behind a "world hostility" setting. Defer to post-MVP unless you
  want it now.

## Files touched (MVP)

- `src/lib/services/ai/scheme/SchemeService.ts` — new
- `src/lib/services/ai/sdk/schemas/scheme.ts` — new (zod + tool schema)
- `src/lib/services/database.ts` — add `schemes` table + CRUD
- `src/lib/types/index.ts` — `Scheme`, `SchemeStage` types
- `src/lib/services/ai/tools/executor.ts` — wire `evaluate()` after world-update,
  `tick()` inside `tickWorld`
- `src/lib/stores/story.svelte.ts` — load schemes alongside other lorebook state,
  hook `inject()` into narrator system assembly
- `src/lib/components/story/WorldDrawer.svelte` — optional MVP: read-only scheme
  list in the World drawer
