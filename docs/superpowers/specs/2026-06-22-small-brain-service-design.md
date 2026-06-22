# Small Brain Service Design

Date: 2026-06-22
Status: draft for user review

## Purpose

Mtherios should use small local or cheap remote models for background thinking that does not require narrator-grade prose. The small model should gather context, extract canon proposals, critique database drift, maintain NPC/faction intent notes, draft wiki updates, and suggest strategic world movement.

The small model is not canon. Postgres remains the source of truth. Transcript entries remain evidence. Wiki, Qdrant, memory nodes, and small-model outputs are projections or proposals until existing validators and canon-write paths accept them.

## Recommended Shape

Build one server service, `SmallBrainService`, with three modes:

- `context`: context gatherer plus prompt compressor.
- `canon`: canon extractor plus database critic.
- `world`: NPC intent worker, strategic pulse, and wiki draft maintainer.

Use one HTTP route:

```text
POST /api/small-brain/run
```

Request:

```json
{
  "storyId": "story_volantis_black_walls",
  "mode": "context",
  "entryId": "optional_entry_id",
  "limit": 12,
  "dryRun": true
}
```

Response:

```json
{
  "ok": true,
  "storyId": "story_volantis_black_walls",
  "mode": "context",
  "model": "configured-small-model",
  "result": {},
  "warnings": []
}
```

The model profile should be a new service id, `smallBrain`, falling back to `classifier` when `smallBrain` is not configured. The user will set the model.

## Mode Details

### `context`

Reads bounded current-scene data: recent transcript entries, selected entities, active factions, memory nodes, current location, open threads, and wiki search results when available.

Outputs:

- Relevant entity ids.
- Relevant faction ids.
- Suggested memory ids.
- Suggested wiki/search queries.
- A compact scene card for the narrator prompt.
- Warnings for missing or contradictory context.

This mode should write nothing.

### `canon`

Reads one turn pair or a small transcript window. It proposes structured database work from player action plus narration.

Outputs:

- `statePatchDrafts`
- `eventDrafts`
- `factDrafts`
- `relationshipDrafts`
- `npcBeliefDrafts`
- duplicate or merge candidates
- missing source-reference warnings

This mode must not directly write canon. It returns proposals that existing patch validation and repair flows can inspect or later accept.

### `world`

Reads recent events, chapter/arc summaries, faction records, NPC beliefs, agreements, pressure, and open threads.

Outputs:

- NPC intent cards.
- Faction move suggestions.
- Strategic pressure notes.
- Rumor seeds.
- Wiki update drafts with source ids.

This mode should run on chapter boundaries, manual button/API calls, or background jobs. It should not run every turn by default.

## Architecture

```text
API route -> SmallBrainService -> bounded DB/wiki reads -> small model -> JSON validation -> result/proposal
```

Files expected in implementation:

- `src/lib/services/ai/generation/SmallBrainService.ts`
- `src/lib/services/ai/sdk/schemas/smallBrain.ts`
- `src/lib/server/engine/smallBrain.ts`
- `src/routes/api/small-brain/run/+server.ts`
- focused tests beside the new service/route

Use existing generation settings and API-call logging patterns. Do not add a new queue type in the first slice. Manual/API invocation is enough. Background job wiring can come after the service proves useful.

## Data Flow

1. Route validates request.
2. Server loader builds a bounded input packet for the selected mode.
3. `SmallBrainService` calls the configured `smallBrain` model, or `classifier` fallback.
4. Output is parsed and validated against a mode-specific schema.
5. Route returns the validated result plus warnings.
6. Future work may enqueue accepted proposals through existing canon repair or patch-validation paths.

## Error Handling

- Missing story returns a normal API error.
- Missing model profile returns a structured warning and no model call.
- Invalid model JSON returns `ok: false`, parse diagnostics, and the raw output truncated for debugging.
- Oversized context is trimmed before calling the model.
- Any proposed canon row must include source ids or a warning explaining why evidence is missing.

## Testing

Add one small test set:

- Request validation rejects unknown modes.
- `smallBrain` falls back to `classifier`.
- Bad JSON from the model returns a warning/error instead of writing canon.
- `canon` mode result with missing source ids is marked for review.

No full agent framework, no training pipeline, and no autonomous canon writes in the first implementation.

## Later

Fine-tuning is optional and should wait until the app has real examples:

```text
bounded DB/transcript packet -> accepted structured proposal JSON
```

Do not train on the database as memory. The database should be retrieved live so outputs stay current and cite evidence.
