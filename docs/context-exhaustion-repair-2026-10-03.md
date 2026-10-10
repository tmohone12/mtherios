# Context exhaustion repair — 2026-10-03

Separate combined candidate based on verified faction stage three. Original stage three and accepted live source are preserved. No database migration, dependency, launcher or service-setting change.

## Observed failure

Read-only inspection of the original database identified GM Pi run `run_b6002733-8c4f-4ef1-b6fb-7634b5c8c912`, created 23:17:26 UTC and stopped 23:17:50.119 UTC with `context_budget_exhausted`. The selected OpenRouter model was `xiaomi/mimo-v2.6-pro`, reasoning off, output allowance 8192, effective local context cap 128000. The cap came from runtime normalization; it is not a verified provider context-window specification.

The first generation succeeded. A subsequent memory recall serialized 228155 characters, approximately 94237 tokens, including raw nodes and 32 retrieval trace rows. The selected evidence packet itself was 4788 characters. Saved history was approximately 109834 tokens against an estimated message allowance of 97074 after framing. Recent tool results were protected from existing old-history compaction. The next generation was refused locally before dispatch. This was not an observed provider rejection.

The same run also used its eight-request limit: seven actual local embedding dispatches and one GM generation. Initial preparation and repeated preparation embedded the same two queries three times; recall embedded once. An earlier 23:10 run stopped with `request_budget_exhausted`. The observed cumulative token usage, approximately 37974, was below the 120000 limit. There was no evidence of charging one dispatch twice.

## Model-facing evidence

`memoryRecallEvidence` projects recognized `memory.retrieve` receipts into selected packet text plus bounded source references. It applies to recent and recovered recall messages before admission. Original tool receipts, state history, call IDs, errors and source records remain durable and unchanged.

Selected quote text is preserved exactly when the envelope fits 4096 tokens. Nodes absent from rendered selection and raw ranking/inspection traces are excluded from the model request. Source references carry node IDs, up to eight entry/event/patch IDs per node, position/hash/revision/time and belief owner where present. At most sixteen selected nodes are referenced. The envelope explains that these are reports/evidence, not new canon or NPC knowledge. Oversized packets are explicitly partial and require an exact source reread; source entry IDs are actionable with `world.record.get` using type `transcript`. Position-based reads require `campaign.entriesAround` with a numeric source position.

This changes model admission only. It does not infer missing narrative, verify reported claims, grant knowledge to NPCs, remove durable history or expand a context cap. Other oversized recent tool types retain the existing refusal behavior.

## Reusing preparation work

Every scene preparation, source search, setting/tool resolution and visibility filter still runs fresh. Only successful exact query embedding vectors may be reused within a single `advancePi` invocation. A scope owns at most 32 vectors and ends on return; nothing is persisted or shared across runs, users, resume invocations or restart.

Before use, the callback checks current run status, lease owner, terminal budget and deadline. Cancellation is checked around revision reads and dispatch. The key combines a fresh PostgreSQL story/project/source/settings revision with exact embedding texts, provider, model, endpoint, credential, dimensions and request options; only its digest is retained in memory. A result is cached only if valid and the revision is unchanged after dispatch. Failed or cancelled calls are not cached. Concurrent misses are not coalesced, preserving each caller's cancellation and accounting.

Real embedding dispatches retain the existing budget reservation and usage receipt path. Cache hits create no fictitious API call or token charge. Generation/output/tool/cost/time caps and durable terminal budget refusals remain unchanged. Fresh retrieval remains necessary even when a local source edit does not change the database revision, because no retrieved content is cached.

## Validation and recovery

Synthetic mocked GM regression follows recall, exact transcript reread, ready decision and final narration within the original eight-request limit: two embedding dispatches plus four generation requests, two tools, one canonical commit. Raw diagnostics stay in durable receipts and are absent from sent model history. Independent query-scope tests cover changed identities/revisions, failed calls, cancellation, terminal authority and concurrent scopes. Disposable PostgreSQL tests verify real revision changes, fresh source edits and private-story/secret visibility boundaries. Shared Assistant runtime regressions are included because evidence projection is shared.

No paid inference, live story turn, production write, job clear, reset, restart, deployment or worker resume was performed. Narrative quality with the real model has not been evaluated. Full raw receipts still occupy durable storage; this patch addresses request admission and redundant dispatches, not retention policy. Revision checks add database reads during query embedding.

The already exhausted run remains terminal by design. In the diagnosed run no canonical turn/narration entry was committed, and both completed tools were read-only. After an authorized rollout, recovery is a fresh submission of the preserved player text with a new client turn ID. Do not reset its budget, rerun terminal tool effects or reset the campaign. Recheck current story/run activity before recovery; these observations describe the inspected run, not later user work.

Activation remains the parent's guarded rollout: obtain a quiet window and fresh compatible backups, preserve the original database/data root and keep workers/wiki autoindex paused. Verify the combined artifact/source identity before cutover. Code rollback cannot undo later confirmed story effects; never erase their receipts.
