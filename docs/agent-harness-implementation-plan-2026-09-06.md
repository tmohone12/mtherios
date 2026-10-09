**Mtherios harness implementation plan — September 6, 2026**

Improve long-term campaign memory first, usable short-term context second, then responsiveness and the UI. Extend the existing server orchestrator, Postgres canon, jobs, retrieval, and Svelte components. The intended result is a campaign that retains important evidence across thousands of turns, distinguishes present truth from history and belief, and makes its memory understandable and correctable.

This document is the implementation backlog for the remaining work. It replaces the earlier review's proposed sequence where they differ. This planning pass changes documentation only. Estimates and acceptance thresholds below are proposed engineering targets, not measured improvements or promises about model behavior.

**Verified starting point**

The current source and three release reports establish this baseline:

| Area | Already implemented in source | Remaining work |
| --- | --- | --- |
| Retrieval resilience | Independent source deadlines, remote embedding cancellation, lexical/transcript fallback, degraded-source diagnostics | Large-campaign load testing and stronger semantic recall |
| Recent dialogue | Effective 12K-token default, configurable to 64K, whole-exchange selection from 200 loaded entries, partial-source receipts | Allocate the entire request budget coherently; compare recall at different allowances |
| Request limits | Serialized-request estimate plus output allowance and safety reserve checked before generation | Reliable model-capacity overrides, tool-result reservation, predictable reduction before rejection |
| Temporal memory | Agreement lifecycle, guarded source ordering, historical retrieval, owner-labelled beliefs | Broader fact/belief reconciliation and source-checked repair of legacy records |
| Scene continuity | Durable, validated primary-scene checkpoint; up to 600 source entries, 128 stored excerpts, 24 selected excerpts | Structured scene outcomes, resolved questions, other POVs, continuity beyond that bounded window |
| Memory health | Waiting/running/completed/failed processing counts; guarded retry | Contiguous coverage, missing jobs, outdated source versions, per-stage freshness |
| Inspection | Saved receipts, clipping counts, checkpoint source IDs | Faithful next-turn preview, original-evidence navigation, intelligible correction flows |

The scene release records 1,247 passing tests, a clean Svelte check, an isolated production build, and disposable-database/browser acceptance. These are recorded release results; this planning pass did not rerun them. See the [first release](agent-harness-first-release-2026-09-06.md), [temporal release](agent-harness-temporal-release-2026-09-06.md), and [scene release](agent-harness-scene-release-2026-09-06.md).

Live `npm run app:status` in this planning pass reports PID 37292 on port 5173, 150 failed jobs globally, no ready/running jobs, healthy Qdrant, unavailable Ollama, and local-hash embeddings. Failures include insufficient balance, invalid extraction output, and planner output limits. These categories need separate diagnosis. They do not prove one campaign has 150 missing memories.

The latest release is not verified as active on port 5173. Earlier release checks reported `/api/health` returning 500; that endpoint was not rechecked during this planning pass. Automatic approval review previously rejected stopping/restarting PID 37292 with only “blocked by policy.” Deployment remains a separate unfinished step; this plan does not retry that action.

**Architecture decisions**

| Layer | Responsibility | Rule |
| --- | --- | --- |
| Canonical state | Current facts, relationships, agreements, actor beliefs, events | Only validated backend writes establish canon |
| Source evidence | Original transcript/import records and their revisions | Every derived claim has source IDs; preserve existing edit/delete semantics and invalidate dependents |
| Working context | Current scene, exact recent exchanges, active commitments, selected evidence | Bounded, rebuilt for the request, scoped by campaign/branch/POV |
| Durable memory | Episodic records and scene/chapter/arc/saga projections | Source-linked, versioned, retryable, rebuildable |
| Retrieval | Structured, lexical, relationship and optional semantic search | Scope/visibility filtering precedes selection; preserve useful results during partial failure |
| Request compiler | Instructions, selected context, action, tools, output allowance | One server assembly path feeds generation and diagnostics |
| UI | Play, inspection, correction and recovery | Render effective server state and make save/error scope visible |

Current exact canon takes precedence over derived summaries. NPC belief, objective fact, historical evidence, and future intent remain distinct. A GM-visible fact is not automatically known to an NPC. Retrieved text and wiki material remain evidence rather than instructions.

External designs inform these choices; adopting their runtimes is not required. LangGraph separates checkpointed conversation state from durable namespaced memory, which maps to Mtherios's existing state and database boundaries. [LangGraph memory](https://docs.langchain.com/oss/javascript/concepts/memory).

Letta's background consolidation and Hermes's combination of compact persistent notes with original-conversation search support extending the existing jobs and evidence lookup paths. These are design references, not evidence of Mtherios performance. [Letta memory](https://docs.letta.com/configuration/memory), [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/).

Graphiti's temporal validity and provenance support extending current SQL lifecycle/source links. Anthropic's context engineering guidance supports selective compaction and measured context allocation. The decision to implement these patterns within Mtherios is an engineering judgment. [Graphiti](https://github.com/getzep/graphiti), [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

**Implementation sequence**

Each numbered slice is independently reviewable and releasable. Feature work can proceed on disposable data while production activation is unresolved. No slice is considered deployed until the running build and its effective behavior are verified.

| Slice | Outcome | Dependencies |
| --- | --- | --- |
| 0 | Reproducible baseline and safe release path | None |
| 1 | Next-turn preview and original-evidence inspector | 0 |
| 2 | Accurate memory coverage and recoverable gaps | 0; use 1 for inspection |
| 3 | Measured improvement in historical/semantic recall | 0; use 1–2 diagnostics |
| 4 | Structured consolidation across long campaigns | 2; reuse 3 retrieval |
| 5 | Unified request budgeting and preview/request agreement | 1; consume 4 memory |
| 6 | Fresh prepared context and bounded tool execution | 1, 5 |
| 7 | Measured latency, cache reuse and cost controls | 3, 5, 6 |
| 8 | Complete UI pass across the main workflows | Backend slices as needed |
| 9 | Long-campaign qualification and production activation | All required gates |

**Slice 0 — Establish a reproducible baseline and release path**

Capture the current source diff, configuration without credentials, database backup, build identity, active process identity, and baseline metrics. Preserve the unrelated dirty worktree. Keep builds isolated from files used by the running server. Confirm the existing backup can be restored to a disposable database.

Add or reuse build/version reporting in app status so a source checkout, saved production artifact, and running process can be distinguished. Diagnose health failures from endpoint output and server logs before changing runtime configuration. Classify failed jobs by campaign, stage, source version, and cause; do not batch-retry permanent provider/account failures.

Touchpoints: `scripts/app-status.mjs`, existing server startup/build scripts, `src/lib/server/engine/appStatus.ts`, and release evidence under `docs/evidence/`.

Done when: one source/build identifier accompanies every benchmark and acceptance report; database restoration succeeds; deployment and rollback steps are documented. Activation waits for a permitted restart path and does not bypass the earlier policy rejection.

**Slice 1 — Preview the draft and open its evidence**

Place **Preview context** beside the action composer. Use the actual draft, action mode, story/branch, scene hints, and effective settings through the same `buildBackendClientContext` path used by submission. Show **Next turn** and **Last sent** in the existing context inspector.

Reuse `prepareServerTurnContext`; remove the separate approximation from the new preview path. Add an explicit inspection mode that neither starts a turn nor writes campaign state, jobs, prepared-turn cache entries, cache hit counters, or wiki refreshes. Existing retrieval may call the configured embedding service; preview must not call narration or classification models. Show stale/missing derived sources rather than refreshing them invisibly.

Return a strict, allowlisted response: preparation time, draft/settings fingerprint, effective budgets, model identifier/capacity source, selected sections, source references, warnings, and estimated usage. Never serialize the internal prepared object: it contains provider configuration and credentials. Bound response text and load full evidence on demand.

Initially label this **Context before GM tool observations**. Actual generation can add tool results and observe newer state. Slice 5 completes shared final-request assembly; until then, do not claim byte-for-byte equivalence with a later generation.

Turn checkpoint/source IDs into **Open source** actions. Reuse the existing story-scoped world-record detail service where its visibility contract is suitable. Present a bounded inspector with the exact passage, position, date, and nearby context, without loading the entire transcript. Paginate oversized sources. Check current visibility on every read. A changed or deleted source is labelled explicitly; never silently substitute another passage for old evidence.

Invalidate or clearly mark previews stale when the draft, action mode, campaign, branch, settings, or known campaign revision changes. Cancel old UI requests and discard late responses. Opening and closing the inspector must preserve the draft, scroll position, and keyboard focus.

Touchpoints: `turn/orchestrator.ts`, `turn/promptReceipt.ts`, `engine/promptDiagnostics.ts`, `engine/worldRecords.ts`, contracts, `backendClientContext.ts`, `ActionInput.svelte`, `ContextWindow.svelte`, `ContextSelection.svelte`, and `WorldDrawer.svelte`.

Done when: fixed-input preview and preparation choose the same sections; no generation/canonical/cache writes occur; secrets cannot cross story/viewer boundaries; edited/deleted evidence and stale responses behave correctly; desktop and mobile flows work by keyboard and touch.

**Slice 2 — Track actual memory coverage and close processing gaps**

Define eligible source entries per stage instead of equating a job count with coverage. Track the last contiguous source position whose required processing is complete, plus missing, failed, pending and outdated sources. Separate extraction coverage from checkpoint/summary freshness and optional vector/wiki freshness.

Derive coverage from existing source rows and job/application receipts first. Add durable coverage metadata only if query measurements require it. Its validity must include source identity/version, processing version, campaign and branch. Imports with no historical job receipts are unaudited until assessed; they are not automatically “current.”

Show a compact story badge: **Memory current**, **Updating**, or **Needs attention**. Its details identify the blocked stage and oldest unresolved source, link to evidence, and open existing recovery controls. Keep optional index degradation distinct from missing canonical extraction.

Extend guarded retry to cover missing jobs and stale source revisions. Use existing idempotency/application receipts and outbox writes. Retry transient failures with existing bounded backoff; stop automatic repetition for account balance, unsupported configuration, and repeated invalid output. Prove one representative recovery before processing a batch. Preserve prior successful partial applications.

Touchpoints: `jobs/processor.ts`, `jobs/outbox.ts`, processing projections/contracts, existing job commands, `WorldDrawer.svelte`, `StoryMemoryPanel.svelte`, and Memory settings.

Done when: a successful later turn cannot conceal an earlier gap; absent jobs are detected; edits reopen only affected coverage; restart/retry never duplicates canon; “current” requires all eligible gaps to be resolved.

**Slice 3 — Improve recall with controlled comparisons**

Extend `scripts/bench-memory.mjs` and the existing fixtures. Preserve the original benchmark as a regression set; add a separate held-out set of at least 100 queries across old promises, aliases, indirect callbacks, recurring NPCs, source corrections, historical relationships, long passages, and exclusion cases. Split by scenario/campaign so near-identical paraphrases do not leak between tuning and evaluation.

Compare lexical-only, local-hash, and one accessible learned embedding model on identical disposable corpora. Keep model/version/dimensions separate during indexing; never mix embedding spaces. Compare the existing strength-aware ranking with a simple hybrid fusion only if remaining misses justify it. Record candidate recall, packet answer retention, and downstream narrator use separately.

Use source-linked passage selection and bounded relationship expansion through existing SQL entities/relationships. Diversify duplicates before packing context. Add reranking or query expansion only when the held-out failures show that cheaper retrieval cannot solve the problem.

Paid evaluation is a separate bounded run using synthetic data and a recorded spend cap; provider access and a spending decision are prerequisites. Publish available offline results if those prerequisites are absent. A provider switch is a separate rollout decision, not an automatic consequence of a successful benchmark.

Touchpoints: `memory/retrieval.ts`, `memory/ranking.ts`, `memory/embeddings.ts`, `evals/memory/`, and existing embedding settings/index rebuild paths.

Done when: regression scenarios do not regress, held-out paraphrase answer retention improves by a proposed 10 percentage points or reaches 95%, scope/exclusion violations remain zero, and latency fits the existing optional semantic deadline. If the candidate does not improve recall, retain the baseline and publish that result.

**Slice 4 — Consolidate durable memory beyond a scene window**

Extend the existing checkpoint, episodic memory, chapter and arc jobs instead of creating another memory service. Add a bounded structured scene projection containing participants, completed beats, explicit unresolved actions, current commitments, and pointers to relevant facts and actor beliefs. Represent commitments through existing agreements/threads; avoid maintaining a second competing obligation ledger.

Build authoritative fields deterministically from canon. Optional model synthesis may propose concise descriptions or missing structured updates, always with valid source IDs and strict schemas. Validate referenced sources, actor attribution, visibility, and temporal status. Unknown remains unknown: absence of a recorded answer does not prove a question is still unresolved. Generated text cannot directly replace canon.

Reconcile completed/cancelled commitments and explicit answers through existing validated updates. Preserve former states for historical retrieval. Extend source-order guards to fact/belief changes where missing; world time, transcript position, and processing time must not be compared as if they were the same clock. Legacy suspicious records become source-linked correction proposals, not bulk prose-based rewrites.

Produce chapter/arc summaries from bounded source windows plus canonical deltas and selected original evidence, avoiding repeated summary-of-summary drift. Ensure old unresolved obligations remain independently retrievable even after their source leaves the checkpoint's 600-entry window. Audit the existing saga path and complete its scheduling only where absent.

Version projections by source range/fingerprint, schema/compiler version, campaign, scene and branch/POV. Commit completed projections atomically after revalidating dependencies; deduplicate queued refreshes. Source edits, deletion, imports and branch changes invalidate affected projections. Expand beyond the primary POV only with explicit scope and knowledge tests. Add a normalized projection table only if existing metadata/rows cannot provide bounded storage and safe multiple-POV updates.

Done when: an obligation survives 1,000+ turns, restart and export/import; fulfilled obligations never return as current; another POV's private information stays isolated; stale workers cannot replace newer projections; model failure leaves deterministic memory and original evidence usable.

**Slice 5 — Allocate the complete request budget**

Introduce one server budget calculation covering static instructions, dynamic canon, exact dialogue, checkpoints, retrieved passages, player action, tool schemas/results, provider framing and output reserve. Reuse the installed tokenizer where applicable, document estimates elsewhere, and expose an explicit model-capacity override when capacity is unknown. Do not silently infer unlimited capacity from a model name.

Keep current dialogue settings and a manual mode. Add an Auto mode that fits the effective model window. Preserve core instructions, current action, indispensable scene state and the newest exchange; reduce duplicate/low-value retrieved material before compressing older conversation. If protected content alone cannot fit, return an actionable error instead of quietly changing the action or disabling rules.

Reserve space for GM observations and continuation/repair requests. Share final request assembly and serialization with the preview and provider boundary. For frozen state, settings and tool observations, the preview and sent request must agree. Save request hashes and section/source receipts; make raw prompt text available only in the appropriate inspection surface, without adding it to routine logs.

Compare 8K/12K/24K dialogue allowances on the same scenes, including crowded scenes and small model windows. Increase defaults only when behavior improves. Keep token estimates visibly distinct from provider-reported usage.

Touchpoints: `turn/promptPacket.ts`, `turn/orchestrator.ts`, `turn/provider.ts`, `turn/promptReceipt.ts`, `ai/context/modelWindows.ts`, settings contracts, and `ContextWindow.svelte`.

Done when: primary, tool-augmented, continuation and repair requests respect effective capacity; oversized multilingual exchanges remain intelligible and bounded; receipts match the serialized request; higher dialogue budgets measurably retain additional relevant exchanges.

**Slice 6 — Keep prepared context fresh and tools bounded**

The current prepared-turn cache fingerprints the request but does not include canonical revisions. Revalidate relevant campaign/source, prompt override, model/settings, and projection dependencies before consuming cached preparation. If freshness cannot be established cheaply, rebuild. Never let inspecting a preview reserve or consume the real turn.

Keep read tools narrow: find candidates, open evidence, resolve canonical records. Audit every tool used during preparation for writes or hidden expensive work. Apply strict argument schemas, campaign/POV scope, deadlines, result-size caps, duplicate-call suppression, cancellation, and a bounded call/round allowance. Use existing deterministic calls first; add an adaptive retrieval round only if replay results demonstrate a recall gain within the latency allowance.

Carry tool source IDs and omission/failure reasons into receipts. Recheck stale generation results before validated state application. Exercise disconnect/retry behavior so a dropped stream cannot create duplicate turns or repeated canon changes.

Done when: source edits, changed prompt overrides and model switches invalidate preparation; a stalled tool cannot hang a turn; duplicate client submission remains idempotent; tool text cannot issue engine instructions; read-only inspection never executes a write-capable path.

**Slice 7 — Improve speed and expose real cache/cost behavior**

Measure database loading, each retrieval source, wiki access, compilation, tool observations, provider time to first token, generation and background processing separately. Record cold/warm p50 and p95 on the same source build and corpus, including concurrent narration plus background jobs.

Use those measurements to remove duplicate reads, batch known related lookups, and keep vault/index rebuilding off the foreground path where a valid fallback exists. Ensure cancelled HTTP work stops and database timeout behavior is described honestly. Avoid increasing worker concurrency until database contention and provider limits are measured.

Keep stable prompt sections stable and changing scene/action text in the dynamic portion. Display **Application cache reuse** separately from provider cached-input/cache-write tokens. Missing provider telemetry means unavailable, not zero. Show provider-reported cost when available and clearly marked estimates otherwise.

Proposed performance gates: local context preparation p95 at or below 1 second on the reference large fixture; graceful partial retrieval by the existing 3-second outer deadline with stalled semantics; at least 20% improvement in the measured dominant local bottleneck without recall loss. Record baseline hardware and corpus size; investigate and revise a target before rollout if the baseline makes it unsuitable. Provider latency remains a separate metric.

Touchpoints: existing timing instrumentation, `engine/cache.ts`, `turn/provider.ts`, retrieval/context loaders, `scripts/bench-generation.mjs`, `EnginePanel.svelte`, and receipt UI.

**Slice 8 — Complete the UI workflow pass**

Inventory existing dirty UI changes before editing. Use the current components, design tokens and installed primitives. Track each screen through desktop, narrow mobile, loading, empty, offline and error states; finishing only the Memory tab does not complete this slice.

| Surface | Planned result | Acceptance |
| --- | --- | --- |
| Story library/onboarding | Clear campaign identity, continue/create flow, recoverable setup/provider errors | Existing campaign opens reliably; failed setup can resume without duplicate records |
| Reader/composer | Stable scroll, readable long passages, visible action mode, preserved drafts, clear generation/cancel/reconnect states | Draft survives reload/story switching; mobile keyboard does not cover controls; no duplicate submission |
| Context inspector | Next turn/Last sent, effective limits, source inclusion reasons and evidence viewer | Inspecting does not send; stale preview is obvious; keyboard focus returns correctly |
| World/memory | Current/history/belief distinctions, evidence links, source-linked correction proposal | Known facts and beliefs are distinguishable; correction uses the validator and shows its result |
| Settings | Effective Recent dialogue, Retrieved history, Total request limit, scope and save status | Visible changes affect server receipts and survive reload; failed saves remain visible |
| Engine/recovery | Stage-specific coverage, actionable failures, guarded retries, separate cache/usage metrics | User can identify a blocked stage and verify recovery without reading raw logs |

Keep diagnostic detail collapsed during play. Use labelled controls, visible focus, accessible dialogs, reduced-motion support, sufficient contrast, and touch-friendly targets. Reuse one evidence viewer and one context-selection presentation. Avoid new decorative dashboards without a concrete task.

Verify 390 × 844 and desktop layouts, long text, keyboard-only navigation and browser console/network errors. Mobile keyboard geometry requires a physical-device check before claiming an iPhone fix; simulated viewport checks are only partial evidence.

**Slice 9 — Qualify long campaigns and activate the release**

Create a deterministic 1,000-turn campaign fixture and a 10,000-entry retrieval/load fixture using the existing persistence and replay tooling. Include commitments introduced in the middle of early passages, later resolution, conflicting rumors, GM corrections, long gaps, scene transitions, alternate POVs, edits/deletions and remapped imports.

Run forced extraction failure, invalid schema, embedding outage, stale projection, duplicate/late job, cancelled generation and database reconnection cases. Distinguish “evidence was stored,” “it reached the prompt,” and “the narrator used it correctly.” Never infer generation quality from retrieval recall alone.

For model behavior, use fixed prompts/settings and repeated trials with a declared token/cost cap. Score unsupported assertions, resurrected obligations, repeated settled questions and NPC knowledge leaks separately from prose preference. Use blinded paired review for subjective narration quality; report raw cases and denominators.

Release in stages: disposable synthetic campaign, restored isolated campaign, permitted single-campaign production canary, then broader use. A canary that calls a provider must have an explicit data/model/cost scope. Existing offline suites can run independently of that decision.

Before activation, run relevant focused tests, the full suite, `npm run check`, and an isolated production build. Check diffs and preserve unrelated work. Verify running build identity, `/api/health`, `/api/app/status`, one prepared context, one completed turn and its saved receipt, and one durable processing cycle. Do not silently disable failing health checks to pass deployment.

Rollback must restore the prior application artifact/configuration while preserving new canonical data. Keep schema changes additive and compatible during rollout; derived projections/indexes can be rebuilt. Restore a whole database only for a justified data-recovery operation, not as ordinary code rollback.

**Cross-cutting release gates**

| Gate | Required evidence |
| --- | --- |
| Correctness | Zero scope/visibility, duplicate-application and request-capacity violations in deterministic suites |
| Provenance | Every derived claim included in context resolves to valid sources or is explicitly labelled unavailable/stale |
| Coverage | All eligible source gaps are visible; later successes cannot hide them |
| Recall | Existing regression set preserved; held-out improvements reported separately from training/tuning results |
| Consolidation | Long-lived commitments and current/historical distinctions survive restart, correction and import/export |
| UI | All six workflow surfaces pass desktop/mobile and keyboard acceptance; physical-device limits stated |
| Performance | Cold/warm timings, provider latency, local cache and provider cache reported separately |
| Operations | Build identity verified, health diagnosed, recovery and rollback exercised, deployment status explicit |

Each slice leaves a short release note, exact source/build identifiers, focused test evidence, relevant browser or database acceptance, known limitations, and the next dependency. Benchmarks include dirty-source hashes because Git HEAD alone does not describe this checkout.

**Scope and decision boundaries**

The committed implementation direction uses the current TypeScript/Svelte/Postgres stack and existing jobs. A new graph database, replacement agent framework, autonomous agent fleet, unlimited context, or an additional vector store requires a demonstrated failure that the existing architecture cannot address. None is part of this backlog by default.

Automatic semantic reconciliation, a learned embedding provider default, and adaptive tool exploration are gated by their own evaluations. Provider spending, inaccessible services and runtime policy restrictions must be recorded as concrete prerequisites, without preventing independent source/test/UI work. No account settings, production data, deployment state or provider choice changes merely because this plan exists.

The next implementation starts with slice 0's baseline capture and slice 1's preview/evidence workflow, followed by coverage and durable recall. Completion means the required behavior passes its release gates and is verified in the intended runtime—not just that code or a build artifact exists.
