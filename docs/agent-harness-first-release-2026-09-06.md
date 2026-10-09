# Agent harness: first implementation release

This implements the first reliability, dialogue, and UI changes from [the harness review](./agent-harness-review-2026-09-06.md). It extends the existing Postgres, retrieval, prompt compiler, receipts, and job pipeline. No framework or dependency was added.

## What changed

### Recall survives an optional source failing

Canonical memory, lexical matches, vectors, character beliefs, timeline events, and original transcript searches now run concurrently after scene expansion. Each source has its own failure boundary and deadline. Vector lookup has a 1,200 ms allowance; the other candidate queries have 2,000 ms. The existing 3,000 ms outer preparation limit remains.

Remote embedding requests receive an abort signal, including the Ollama legacy fallback. A stalled vector lookup therefore cannot discard already available lexical and transcript matches. Degraded-source messages reach retrieval diagnostics and turn warnings. Database operations already submitted may finish after the deadline; the deadline bounds waiting, while remote embedding HTTP requests are actively cancelled.

### Recent dialogue is an effective server setting

`recentDialogueTokens` now travels from Settings through the browser request, shared contracts, engine orchestration, and server compiler. Headless callers use the same 12,000-token default, up from the former hard-coded 4,800.

The compiler keeps complete recent exchanges from the loaded 200-entry history. It no longer cuts every user action at 1,000 characters or every narration at 3,200 characters. Only a newest exchange that alone exceeds the allowance is shortened, with Unicode-safe opening and ending excerpts. Its source IDs are marked partial in the receipt. Older exchanges enter or leave together.

Settings exposes a labelled Recent Dialogue slider and number field, up to 64,000 tokens. Local-only history and retrieval controls are hidden for server-bound stories. The existing scene budget is explicitly labelled separately. Receipts record the dialogue allowance actually used; prepared-turn fingerprints already include the entire client context.

Every server generation now checks the serialized request, output allowance, and a 512-token reserve against the existing model context lookup before sending. This includes schema and tool-observation text, roll continuations, and repair requests. Oversized requests fail with an actionable explanation rather than silently dropping instructions. This is an estimated guard: provider-specific tokenizers and negotiated context limits are not yet available, and unknown model IDs still use the existing conservative lookup fallback.

### Extraction failures stay visible and can recover

GLM-5.3 requests adapt old disabled-reasoning settings to low reasoning, following [Z.ai's migration guidance](https://docs.z.ai/guides/llm/glm-5.3). The existing settings and selected models are preserved.

A later successful extraction or embedding job no longer hides an earlier failed job for a different source. The story drawer, player world sheet, and Memory settings now show completed, waiting, running, and failed extraction-job counts. These are processing counts, not a claim that every transcript entry has been audited for coverage.

Veil had 50 failed extractions: eight reasoning-setting errors and 42 historical insufficient-balance errors. The currently configured classifier was already using enabled reasoning. After a full database backup, one failed extraction was retried through the existing guarded command and completed with two operations. The other matching failures were then queued through the same command. All 50 retried extraction jobs completed successfully. Downstream consolidation and projection jobs continue in the normal durable worker; no balance purchase, provider switch, or direct canon edit was made.

The existing replay path verifies source text, preserves apply receipts, serializes canon writes, and suppresses obsolete transient state when a later narration exists. The final [evidence snapshot](./evidence/agent-harness-first-release-2026-09-06.json) confirms 855 completed extraction jobs, including these 50 retries, and zero failed, waiting, or running extraction jobs for Veil. Other job types have independent queues.

## Verification

- Full suite: 127 files, 1,224 tests passed. Focused follow-up: 106 tests passed.
- Type check: zero errors and warnings. Production build passed; existing bundle-size and mixed-import warnings remain.
- Source changes checked against the pre-work backup; unrelated working-tree edits were preserved.
- Synthetic retrieval benchmark: 32 cases, 26 of 27 positive answers retained, zero forbidden-content or budget violations, both with local-hash vectors and with embeddings disabled. Single measured round: hash p50 29 ms / p95 37 ms; disabled p50 21 ms / p95 25 ms. These are synthetic warm-query timings, not a production speedup claim. [Benchmark](../evals/memory/results/2026-09-06T18-47-40-292Z.json).
- Live read-only Veil compiler previews: 4,000-token dialogue allowance selected 14 messages / 2,879 tokens; 12,000 selected 48 / 11,866; 24,000 selected 104 / 23,386. Each retained five retrieved memory nodes. These previews do not reproduce every field of a provider request.
- Browser acceptance in a disposable campaign: changed Recent Dialogue to 24,000, confirmed slider/number agreement and persistence after reload, submitted a synthetic turn, and verified the saved narration receipt recorded `recentDialogueTokensMax: 24000`. Verified the failure notice in both world surfaces and inspected the layout. The disposable database and server were removed afterward.

## Operational artifacts and next work

The finished production build is running at **http://127.0.0.1:5175/** with its extra worker disabled. The original process on port 5173 continues the durable recovery queue. Automatic approval review rejected the final restart twice, returning only `blocked by policy`. Its API remains available, but its UI needs a manual restart after the build replacement; the app on port 5175 was verified with HTTP 200 and uses the same canonical database. The normal port has therefore not received a completed final deployment.

The source snapshot, isolated source diff, retry manifests, and 90.7 MB database dump are under `.cache-backups/harness-first-release-20260906/`. The dump's archive catalog was verified. Changes remain uncommitted for review.

The next architecture work remains source-linked scene checkpoints, temporal supersession across memory consumers, and evaluation of semantic retrieval with real paraphrases. This release improves retrieval failure handling and usable short-term context; it does not introduce those later memory layers or claim a full UI overhaul.
