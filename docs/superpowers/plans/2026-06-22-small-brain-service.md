# Small Brain Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a server-owned small-model service and API for context gathering, canon proposal, and world intent drafts.

**Architecture:** Add a single `smallBrain` service that runs in three modes: `context`, `canon`, and `world`. The route stays manual/API-only in this slice. The service gathers bounded story context from the existing database, calls a configured cheap model, validates the structured response, and returns proposals/warnings without mutating canon.

**Tech Stack:** SvelteKit endpoint, TypeScript, Zod, Drizzle database helpers, existing server LLM settings/resolution, Vitest.

---

## Scope

- Implement one endpoint: `POST /api/small-brain/run`.
- Implement one server service: `src/lib/server/engine/smallBrain.ts`.
- Add a visible AI Services setting for `smallBrain`, defaulting to classifier-style model settings.
- Keep all output proposal-only. The service does not write facts, memories, canon rows, story entries, events, or wiki data.
- Exclude background jobs, autonomous scheduling, embeddings, fine-tuning, local model hosting, and automatic canon import from this slice.

## Request And Response Contract

Request body:

```ts
{
  storyId: string;
  mode: 'context' | 'canon' | 'world';
  entryId?: string;
  limit?: number;
  dryRun?: boolean;
}
```

Response body:

```ts
{
  ok: boolean;
  storyId: string;
  mode: 'context' | 'canon' | 'world';
  model: string;
  result: SmallBrainResult | null;
  warnings: string[];
}
```

`dryRun` means "do the full read/generate/validate path and still write nothing." Because this slice never writes, `dryRun` is mainly a forward-compatible flag and route smoke-test signal.

## Files To Change

- Create `src/lib/services/ai/sdk/schemas/smallBrain.ts`
- Modify `src/lib/contracts/engine.ts`
- Create `src/lib/server/engine/smallBrain.ts`
- Create `src/routes/api/small-brain/run/+server.ts`
- Modify `src/lib/stores/settings.svelte.ts`
- Modify `src/lib/services/terminalSettings.ts`
- Modify `src/lib/components/settings/SettingsModal.svelte`
- Add tests:
  - `src/lib/services/ai/sdk/schemas/__tests__/smallBrain.test.ts`
  - `src/lib/server/engine/smallBrain.test.ts`
  - update `src/lib/services/terminalSettings.test.ts`

## Implementation Steps

- [x] Add shared schemas and route contract.

  Create `src/lib/services/ai/sdk/schemas/smallBrain.ts` with strict Zod schemas for:

  - `smallBrainModeSchema`: `context | canon | world`
  - `smallBrainContextResultSchema`
  - `smallBrainCanonResultSchema`
  - `smallBrainWorldResultSchema`
  - `smallBrainResultSchema`
  - exported TypeScript types

  Shape the mode outputs like this:

  ```ts
  export const smallBrainContextResultSchema = z.object({
    mode: z.literal('context'),
    brief: z.string().min(1),
    relevantEntryIds: z.array(z.string()).default([]),
    relevantEntityIds: z.array(z.string()).default([]),
    relevantFactionIds: z.array(z.string()).default([]),
    promptNotes: z.array(z.string()).default([]),
    uncertainties: z.array(z.string()).default([])
  });

  export const smallBrainCanonResultSchema = z.object({
    mode: z.literal('canon'),
    proposals: z.array(z.object({
      kind: z.enum(['fact', 'event', 'memory', 'relationship', 'contradiction']),
      summary: z.string().min(1),
      confidence: z.number().min(0).max(1),
      sourceEntryIds: z.array(z.string()).default([]),
      affectedEntityIds: z.array(z.string()).default([]),
      affectedFactionIds: z.array(z.string()).default([]),
      reviewNote: z.string().optional()
    })).default([]),
    rejected: z.array(z.object({
      summary: z.string().min(1),
      reason: z.string().min(1)
    })).default([])
  });

  export const smallBrainWorldResultSchema = z.object({
    mode: z.literal('world'),
    npcIntents: z.array(z.object({
      entityId: z.string().optional(),
      name: z.string().min(1),
      intent: z.string().min(1),
      pressure: z.number().min(0).max(1),
      evidenceEntryIds: z.array(z.string()).default([])
    })).default([]),
    strategicPulse: z.array(z.object({
      factionId: z.string().optional(),
      label: z.string().min(1),
      pressure: z.number().min(0).max(1),
      recommendedAttention: z.string().min(1)
    })).default([]),
    wikiDrafts: z.array(z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      sourceEntryIds: z.array(z.string()).default([])
    })).default([])
  });
  ```

  Modify `src/lib/contracts/engine.ts` to export:

  ```ts
  export const smallBrainRunRequestSchema = z.object({
    storyId: z.string().min(1),
    mode: smallBrainModeSchema,
    entryId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    dryRun: z.boolean().optional()
  });

  export type SmallBrainRunRequest = z.infer<typeof smallBrainRunRequestSchema>;
  ```

  Add focused schema tests in `src/lib/services/ai/sdk/schemas/__tests__/smallBrain.test.ts`:

  - accepts valid output for each mode
  - rejects an unknown mode
  - rejects confidence/pressure outside `0..1`
  - applies default arrays

- [x] Implement the server-owned small brain runner.

  Create `src/lib/server/engine/smallBrain.ts`.

  Export:

  ```ts
  export async function runSmallBrain(request: SmallBrainRunRequest): Promise<SmallBrainRunResponse>
  ```

  Add local helpers:

  - `resolveSmallBrainGeneration()`
    - first call `resolveServiceGeneration('smallBrain')`
    - if that throws or returns no usable model, call `resolveServiceGeneration('classifier')`
    - push a warning when falling back
  - `loadSmallBrainContext(db, request)`
    - load the story row
    - load recent story entries bounded by `limit`, or target `entryId` plus nearby/recent rows when `entryId` is provided
    - load bounded related durable context from existing tables used by the current engine, favoring cheap reads and small projections
  - `buildSmallBrainPrompt(mode, context)`
    - include mode-specific instructions and a compact JSON-only output requirement
  - `validateResult(mode, parsed)`
    - parse with `smallBrainResultSchema`
    - confirm `result.mode === request.mode`
    - add warnings for references to unknown entry/entity/faction ids

  Use existing server LLM primitives:

  ```ts
  const generation = resolveServiceGeneration('smallBrain');
  const text = await generateServerTextWithMetrics({
    service: 'smallBrain',
    model: generation.model,
    provider: generation.provider,
    system,
    prompt,
    temperature: generation.temperature,
    maxTokens: generation.maxTokens
  });
  const parsed = parseJsonFromGeneratedText(text.text);
  ```

  Match the exact option names to `generateServerTextWithMetrics` in `src/lib/server/turn/provider.ts` while implementing.

  The runner returns `ok: false`, `result: null`, and warnings when:

  - story is missing
  - model output is not parseable JSON
  - schema validation fails
  - generation throws

  The runner must not call `insert`, `update`, `delete`, or story import helpers.

  Add `src/lib/server/engine/smallBrain.test.ts` with mocks following the style in `src/lib/server/engine/characterDrafts.test.ts`:

  - uses `smallBrain` settings when available
  - falls back to `classifier` and reports a warning when `smallBrain` settings fail
  - returns `ok: false` on invalid JSON
  - validates mode mismatch as a failure
  - flags missing source ids in warnings
  - proves no write helpers are called by keeping the module free of writable DB calls and asserting mocked DB only receives select/query calls

- [x] Add the API route.

  Create `src/routes/api/small-brain/run/+server.ts`.

  Implement the same thin route pattern used by existing API job routes:

  ```ts
  import { json } from '@sveltejs/kit';
  import { apiError, readJson } from '$lib/server/api/errors';
  import { smallBrainRunRequestSchema } from '$lib/contracts/engine';
  import { runSmallBrain } from '$lib/server/engine/smallBrain';

  export const POST = async (event) => {
    try {
      const request = await readJson(event, smallBrainRunRequestSchema);
      return json(await runSmallBrain(request));
    } catch (error) {
      return apiError(error);
    }
  };
  ```

  Adjust imports to match the local helper signatures in the repo.

  Add a small route test only if existing route-test helpers make it cheaper than relying on the direct runner tests. The minimum route coverage is schema rejection plus successful delegation to `runSmallBrain`.

- [x] Add the visible small-model settings hook.

  Modify `src/lib/stores/settings.svelte.ts`:

  - Add `smallBrain` to `SERVICE_DEFINITIONS`.
  - Label: `Small Brain`
  - Description: `Cheap context gathering, canon proposals, and world intent drafts.`
  - Add `smallBrain` to the existing `worldState` profile `serviceIds` so it appears in the AI Services settings without creating another profile section.

  Modify `src/lib/services/terminalSettings.ts`:

  - Treat `smallBrain` like `classifier` for default key selection:

    ```ts
    if (serviceId === 'classifier' || serviceId === 'worldSimulation' || serviceId === 'smallBrain') {
      return 'classification';
    }
    ```

  - Treat `smallBrain` like `classifier` for default temperature and token settings wherever service-specific defaults are applied.

  Modify `src/lib/server/engine/llmSettings.ts`:

  - Update server-side `serviceDefaultKey(serviceId)` so `smallBrain` resolves to `classification`.
  - Update classifier-like default temperature/max token logic so `smallBrain` does not inherit narrative defaults.

  Modify `src/lib/components/settings/SettingsModal.svelte`:

  - Add `smallBrain` to the existing service sync lists that currently sync `narrative` and `classifier`.
  - Keep the UI surface generic through `SERVICE_DEFINITIONS`; no custom modal section is needed.

  Update `src/lib/services/terminalSettings.test.ts`:

  - `smallBrain` uses classification model/provider defaults.
  - `smallBrain` sync payload is preserved when serializing terminal/browser LLM settings.

- [x] Wire exports only where needed.

  If `src/lib/services/ai/sdk/schemas/index.ts` exists and is used for schema barrels, export `smallBrain` schemas there.

  Avoid adding `SmallBrainService` to `src/lib/services/ai/index.ts` unless the implementation needs a browser-side service. The approved service is server-owned, and the existing `BaseAIService` path depends on client settings stores, so the server runner is the cleaner implementation point.

- [x] Run focused verification.

  Run:

  ```powershell
  npm run test -- src/lib/services/ai/sdk/schemas/__tests__/smallBrain.test.ts src/lib/server/engine/smallBrain.test.ts src/lib/services/terminalSettings.test.ts
  ```

  Then run:

  ```powershell
  npm run check
  ```

  If the app is already running or can be started cleanly, run one API smoke:

  ```powershell
  $body = @{
    storyId = 'story_volantis_black_walls'
    mode = 'context'
    limit = 3
    dryRun = $true
  } | ConvertTo-Json

  Invoke-RestMethod -Method Post `
    -Uri http://127.0.0.1:5173/api/small-brain/run `
    -ContentType 'application/json' `
    -Body $body
  ```

  Use a real story id from the local database if `story_volantis_black_walls` is not present.

## Prompt Shape

Use one compact system prompt:

```text
You are a cheap structured reasoning worker for an RPG world database. You do not write canon. You return concise JSON proposals that a larger system or human can review. Every claim must point to source ids when possible.
```

Mode prompt requirements:

- `context`: summarize relevant context for the next larger-model call; include entry/entity/faction ids and uncertainties.
- `canon`: propose facts/events/memories/relationships/contradictions with confidence and source entry ids.
- `world`: propose NPC intents, faction pressure pulses, and wiki draft notes with evidence ids.

Force JSON with a short final instruction:

```text
Return only JSON matching the requested mode schema. No markdown. No prose outside JSON.
```

## Failure Behavior

- Missing story: `ok: false`, `result: null`, warning `Story not found: <storyId>`.
- Missing `entryId`: continue with recent context, warn `Entry not found: <entryId>`.
- Small brain settings unavailable: fall back to `classifier`, warn once.
- Invalid model JSON: `ok: false`, include parse warning with short error message.
- Schema mismatch: `ok: false`, include validation warning with short issue summary.
- Unknown referenced ids: `ok: true` only if schema is valid, but include warnings and keep result intact for review.

## Commit Strategy

Commit after focused tests pass:

```powershell
git add src/lib/services/ai/sdk/schemas/smallBrain.ts `
  src/lib/contracts/engine.ts `
  src/lib/server/engine/smallBrain.ts `
  src/routes/api/small-brain/run/+server.ts `
  src/lib/stores/settings.svelte.ts `
  src/lib/services/terminalSettings.ts `
  src/lib/server/engine/llmSettings.ts `
  src/lib/components/settings/SettingsModal.svelte `
  src/lib/services/ai/sdk/schemas/__tests__/smallBrain.test.ts `
  src/lib/server/engine/smallBrain.test.ts `
  src/lib/services/terminalSettings.test.ts

git commit -m "feat: add small brain service"
```

Do not stage unrelated files or logs already present in the worktree.

## Manual Acceptance Checklist

- [x] `POST /api/small-brain/run` exists and validates request bodies.
- [x] `context`, `canon`, and `world` modes return structured, schema-validated proposals.
- [x] The service uses `smallBrain` model settings when configured.
- [x] The service falls back to `classifier` settings with a warning.
- [x] The AI Services settings UI exposes `Small Brain`.
- [x] Server defaults treat `smallBrain` as classification-style, not narrative-style.
- [x] No canon/database writes occur in the service.
- [x] Focused tests pass.
- [x] `npm run check` passes or any existing unrelated failures are documented with exact output.
