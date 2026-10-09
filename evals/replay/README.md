# Executable turn replays

Run `npm run eval:turns` with Docker and the existing `pgvector/pgvector:pg16` image available. The command creates its own temporary database, applies repository migrations, and executes the real `processServerTurn` pipeline. It has no live-database or live-story option. Config, data, vault, and Vite cache directories are isolated and removed with the disposable database in `finally`. A forced process termination can leave its uniquely labeled container behind.

The default uses synthetic OpenAI-compatible responses through the real provider adapter. It performs no paid calls. The fixture covers a returning NPC with stale presence, letter delivery, narrator-private knowledge, another story's excluded fact, extraction validation, persisted ownership, and idempotent repeat. Background jobs are persisted but no worker runs; vault evidence stays inside the disposable directory.

Three scenarios run by default: the original letter delivery; Mara returning after 240 intervening scenes with a source-linked learned password behind a long belief recap; and a corrected hearing report with the older false transcript and memory still stored as superseded. The return case checks that the actual belief record and its complete learned detail reach the narrator outside the recent-dialogue window. The correction case requires the current date and excludes the superseded date from both outgoing context and narration. Each scenario independently checks narrator-private knowledge, foreign-story exclusion, ownership extraction and repeat safety.

Expectations come from `evals/scenarios/*.jsonl`. Required facts are detected in the actual provider request after prompt budgeting; disclosure is detected only in returned narration. State expectations are derived from canonical database rows, not copied from the fixture's extraction payload. Private narrator context is distinct from an NPC revealing it. Fact detectors use explicit synthetic phrases and do not claim general semantic evaluation.

These deliberate mutations each execute a separate real turn and must return exit code 1 for the corresponding failed gate:

```powershell
npm run eval:turns -- --mutation missing-fact
npm run eval:turns -- --mutation secret-leak
npm run eval:turns -- --mutation wrong-state
```

The missing-fact mutation removes the character detail from the seeded record. The secret-leak mutation changes narrator output. The wrong-state mutation removes the classifier's ownership update. All still assert pipeline execution, source isolation, and no duplicate writes/provider calls on retry.

`npm run eval:turns -- --roll` exercises an offline dice continuation through the real provider adapter. Both narration request summaries must match captured outgoing text segments, including the pre-roll assistant message and resolved-roll instruction. Every run verifies the context receipt is saved with narration and restored on an idempotent repeat. Counts describe text segments and local token estimates; provider framing and inserted message separators are excluded.

To explicitly compare a real model, set `REPLAY_MODEL_API_KEY` in your local environment, then run `npm run eval:turns -- --model MODEL_ID --provider openrouter --max-cost-usd 0.06` (or `openai`). This mode sends only synthetic fixture text to that provider for narration and extraction. It never reads saved credentials. It requires an explicit positive run-wide spend cap, permits at most six calls per scenario with at most 2,048 output tokens per call, and disallows mutation flags. This is opt-in paid execution; the implementation was tested with fake fetch responses, without making a paid call.

Model cost comes only from provider `usage.cost`. Missing cost aborts model replay before another provider request; no price is invented. The runner stops before the next provider request after cumulative reported spend exceeds the declared cap. Because a provider reports cost after a request completes, this is a guarded reported-spend ceiling rather than a prepaid billing guarantee; each scenario also retains its own `maxCostUsd` gate. Model outputs are checked by the same narrow phrase/state observations as deterministic outputs.

Reports in `results/` retain source hashes, final provider request bodies (no headers/credentials), narration, observed facts/state, checks, and latency. A normal run fails if any expectation fails. Deterministic cost is zero because requests are synthetic; its supplied token usage is fixture telemetry, not a real tokenizer measurement. This tests pipeline behavior, not model obedience, prose quality, broad NPC knowledge reasoning, or long-campaign accuracy. The latest deterministic evidence is `evals/replay/results/2026-09-07T13-05-38-462Z.json`. Additional story scenarios need their own fixture data, provider responses, and observed-state checks.
