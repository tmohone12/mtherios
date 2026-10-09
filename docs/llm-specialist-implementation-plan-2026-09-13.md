# Mtherios: active recall and specialist reasoning

Implementation handoff for GPT-5.6 Terra. Prepared September 13, 2026.

**Status: plan only.** This document changes no application behavior. Proposed budgets and acceptance targets are starting points to evaluate, not measured improvements.

## Outcome and scope

Make long campaigns remember relevant evidence, make important NPC decisions reflect their knowledge and experience, and detect consequential continuity mistakes. Use bounded specialist LLM work through the existing backend. Keep one narrator responsible for the final scene and PostgreSQL responsible for accepted state.

Implement in phases: evaluation baseline, active recall, actor decisions, continuity review, faction reasoning, then an evaluation-driven improvement workflow. Complete each phase through tests and observable behavior before widening scope. Do not replace the memory architecture, add a general agent framework, or create an always-running agent for every NPC.

This is a focused extension of the current system. The [earlier harness plan](agent-harness-implementation-plan-2026-09-06.md) records historical planning; do not assume its remaining-work claims still describe the code. The [current architecture](../ARCHITECTURE.md) and implementation own the starting point. Follow [AGENTS.md](../AGENTS.md).

## Instructions to the receiving agent

1. Read this document and inspect `git status --short`. The checkout contains extensive unrelated modified, deleted, and untracked files, including relevant implementation and tests. Preserve them. Compare your edits against the starting working tree, not only HEAD; do not reset, clean, or stage the whole repository.
2. Recheck the source facts below. They describe the working tree inspected on this date, not an immutable release.
3. Proceed with implementation when this handoff is supplied as the implementation request. Make routine choices using the code and this plan. Report a material conflict or missing required input while continuing independent work.
4. Use existing provider/service settings. GPT-5.6 Terra is the implementation agent, not an instruction to change Mtherios's runtime models. Do not invent model IDs, API keys, paid-call allowances, or deployment authorization.
5. Treat product subagents as in-application specialist workers. This plan does not require delegation to coding agents or creation of new Codex tasks.
6. Record progress and evidence at the end of this document, keeping planned and completed behavior distinct. Do not claim live deployment from source tests.

## Verified source starting point

| Area | Finding | Owner |
| --- | --- | --- |
| Turn-time exploration | The helper supports a choose/tool loop, but the actual turn call uses deterministic initial calls, `maxRounds: 0`, and a chooser that immediately returns ready. | [turn/orchestrator.ts](../src/lib/server/turn/orchestrator.ts) |
| Exploration bounds | Defaults are one planning round, two calls, 3,000 characters per result, 6,000 total, and a 7-second tool budget. The plan schema also limits calls per response. Changing constants alone does not enable model planning. | Same owner |
| Tool surface | Existing commands cover world search, record reads, transcript neighborhoods, actor briefs, scene feasibility, relationships, timeline, and wiki retrieval. | [engine/gmTools.ts](../src/lib/server/engine/gmTools.ts) |
| Retrieval | Canonical, lexical, vector, transcript, agreement, belief, and revision sources already exist. | [memory/retrieval.ts](../src/lib/server/memory/retrieval.ts), [ranking.ts](../src/lib/server/memory/ranking.ts) |
| Specialist foundation | Small Brain supports context evidence, canon proposals, and world intents with structured validation. Its existing context mode discards uncited notes/uncertainties. Do not silently loosen that contract. | [engine/smallBrain.ts](../src/lib/server/engine/smallBrain.ts), [schemas/smallBrain.ts](../src/lib/services/ai/sdk/schemas/smallBrain.ts) |
| Continuity job | `continuityAudit` checks missing entries, truncation, and faction projects; this function is not a general semantic narration reviewer. Other canonical continuity validation remains relevant. | [jobs/processor.ts](../src/lib/server/jobs/processor.ts), [memory/continuity.ts](../src/lib/server/memory/continuity.ts) |
| World planning | Faction doctrine/move planning and model-generated Director frames already exist. Preserve pending/activated state. | [factions/autonomy.ts](../src/lib/server/factions/autonomy.ts), [plotBrain/planner.ts](../src/lib/server/plotBrain/planner.ts), [lifecycle.ts](../src/lib/server/plotBrain/lifecycle.ts) |
| Evaluation | Disposable-database turn replay supports synthetic responses and opt-in model mode. Inspect its assertions before using real models: some telemetry assertions in the scanned script expect synthetic cost/cache values. | [scripts/eval-turns.mjs](../scripts/eval-turns.mjs), [replayRunner.ts](../src/lib/server/evals/replayRunner.ts) |

## Shared design rules

### Authority and scope

Workers inspect evidence and return proposals; they do not independently write canonical state. Use existing validated backend operations for accepted updates. Preserve exact source references, temporal validity, branch/POV boundaries, and the distinction between fact, belief, intention, and GM instruction.

Read-only specialist work should not advance world time, apply Director drafts, consume game resources, or replay turns. Actor decisions describe intended actions; narration and validated state processing determine what actually happened.

### Small execution contract

Reuse provider transport, generation telemetry, Zod, receipts, and the durable outbox. Introduce only the types/helpers needed by the first implemented worker; extract shared code when a second real consumer needs it.

Each invocation must identify its task, role, story, branch/POV where applicable, actor if applicable, snapshot/server version, relevant settings version or fingerprint, permitted tools, input/output token limits, aggregate deadline, and cancellation signal.

Each result must distinguish succeeded, insufficient evidence, unavailable, timed out, invalid, and stale. Return bounded findings/proposals with source IDs plus usage, duration, and any omissions. An evidence gap is a question with searched sources, not an invented fact. Preserve current Small Brain contracts unless a separately versioned extension is necessary.

Validate source existence, story membership, visibility, temporal applicability, and support for each claim. A valid-looking ID or high model confidence does not establish truth. Keep inferred actor choices labeled as inferences supported by motive/knowledge evidence.

### Scheduling, budgets, and failure

Use a shared turn-level budget across planning, tools, workers, review, and final narration. Reserve narrator output and current-scene context first. Limit concurrency and prevent nested recursive delegation. Check the deadline before launching another call; retries also consume the budget.

Propagate cancellation into provider and remote tool requests where supported. A timeout wrapper alone may leave work running; discard late results and avoid claiming cancelled billing when transport cannot abort.

Independent workers use the same snapshot. Revalidate before consuming results or applying proposals. Stale background proposals are rejected or recomputed, never silently applied to a newer scene. Extend existing prepared-context invalidation to new dependencies.

On optional-worker failure, retain successful evidence and use existing prepared context. Do not infer that an event never happened because a search failed. A failed reviewer must be recorded as unchecked, not passed.

## Phase 0 — Baseline, settings, and evaluation fixtures

**Deliverable:** a reproducible comparison and an explicit disabled baseline.

- Trace turn callers, including streaming and engine dispatch, to establish where `runGmTool` is supplied. Cover browser, CLI, and MCP paths through the shared server owner.
- Inspect existing service resolution and UI editing in [llmSettings.ts](../src/lib/server/engine/llmSettings.ts) and [SettingsModal.svelte](../src/lib/components/settings/SettingsModal.svelte). Reuse suitable service profiles and make effective fallback behavior visible. Never silently substitute a premium model.
- Add only phase-relevant settings: active-recall enablement and bounded effort initially; actor/review/faction controls when those phases land. Resolve defaults server-side and preserve explicit disablement.
- Add synthetic fixtures for an old conditional promise, ambiguous actor reference, corrected fact, unknown secret, alternate POV, and recalled evidence outside the initial candidate window.
- Extend replay for deterministic planner/tool fixtures. Keep real-model assertions separate from synthetic fixed telemetry. Record missing provider cost as unknown, not zero; enforce any declared spend policy honestly.
- Save baseline outputs and configuration/build identity. Run model comparisons only with configured credentials and an explicit applicable cost allowance, on disposable campaigns.

**Acceptance:** disabled mode preserves existing turn behavior; deterministic replay exercises the actual planner/tool/narrator path when enabled; baseline records contain settings, evidence, result, and usage status. No benchmark writes to a live campaign.

## Phase 1 — Active recall investigator

**Deliverable:** the model can investigate a missing historical detail before narration.

Primary owners: turn orchestration, retrieval/ranking, GM tools, Small Brain/provider transport, and [promptReceipt.ts](../src/lib/server/turn/promptReceipt.ts).

1. Start from existing preparation and deterministic tools. Trigger investigation for explicit historical references, unresolved named entities, insufficient relevant evidence, or important retrieved conflicts. Use observable signals; avoid a mandatory extra model call on every simple exchange.
2. Supply a compact question, current actor/scene identities, existing evidence IDs, and gaps to a structured planner. Allow only existing read commands selected for recall. The model cannot issue arbitrary engine commands or change story scope.
3. Let it choose between ready, insufficient evidence, or bounded tool calls. Validate command-specific arguments, clamp result limits, deduplicate calls, and permit a search followed by a source-neighborhood read.
4. Begin experiments with at most two model planning rounds and four total tool calls, counting deterministic initial calls against the total. Adjust schema caps and aggregate result budgeting consistently. Make final synthesis an explicitly budgeted step or retain validated source excerpts directly; do not hide an extra unbounded call.
5. Stop on sufficient support, no new evidence, repeated query, exhaustion, cancellation, or deadline. Failed searches must not produce endless reformulations.
6. Return atomic supported claims, exact conditions/revisions, source references, and unresolved questions. Keep essential quotations intact and deduplicate against prepared memory. Include the retained brief in final request budgeting and actual sent-request receipts.
7. Extend [ContextWindow.svelte](../src/lib/components/story/ContextWindow.svelte) to show why recall ran, what it found, what was omitted, and how to open original evidence. Preview must clearly distinguish preparation from observations collected only during submission.

**Acceptance cases:**

- “Remind him what he promised at the docks” retrieves the actual exchange and its condition, even when absent from initial retrieval.
- A later amendment wins for present obligations while preserving historical wording when requested.
- Ambiguous identity is not guessed into canon; the result marks ambiguity.
- Search-result text containing instructions cannot alter tool permissions or the narrator's governing instructions.
- Simple dialogue avoids the specialist path; timeout still produces a valid turn with an explicit degraded receipt.
- The receipt identifies evidence actually retained in the provider request, not merely fetched evidence.

## Phase 2 — Actor decision specialist

**Deliverable:** pivotal NPC choices reflect personal knowledge, motives, commitments, and witnessed consequences.

Extend [buildActorBrief](../src/lib/server/engine/gmTools.ts) and existing actor/Small Brain contracts as appropriate. First establish a backend-enforced actor view. GM retrieval currently has secret-inclusive paths; those are not safe defaults for an NPC worker. Public availability also does not automatically prove personal knowledge of a distant event.

- Trigger only for consequential interactions or materially changed actor circumstances. Initially cap work to two relevant actors per turn; background characters use normal narration.
- Provide actor-specific known facts, beliefs, witnessed events, relationships, current intent, practical constraints, and distinct voice evidence. Exclude another actor's private plan and other-POV secrets before selection and budgeting.
- Return a proposed immediate action, objective, condition/refusal if relevant, knowledge references, and a concise evidence-based rationale. Do not request private chain-of-thought or a full alternate scene.
- Validate identity, knowledge references, location/reachability, resources, and conflict with accepted commitments. Where the rules cannot decide feasibility, label uncertainty rather than inventing a deterministic verdict.
- Give the narrator bounded proposals. When actor proposals conflict, the scene adjudicates attempts; neither proposal is automatically success. Never generate the player's reply or choose their action.
- Do not share hidden actor results among concurrent workers. Persist any accepted durable intent through existing contracts with source/version metadata, separately from completed events.

**Acceptance:** unknown secrets remain absent from actor prompts; two actors given different knowledge produce appropriately different options; witnessed destruction changes a plausible decision; identical unwitnessed information does not leak; a refusal/condition can survive narrator synthesis; player agency remains intact.

## Phase 3 — Selective continuity reviewer

**Deliverable:** measurable source-linked detection of consequential narrative errors.

Start in shadow/background mode using [outbox.ts](../src/lib/server/jobs/outbox.ts), processor ownership, and existing continuity/proposal records. Confirm existing schema suitability before adding a migration. Preserve original prose; shadow findings do not retroactively rewrite accepted history.

- Trigger for old commitments, recent corrections, secrets, capability constraints, and major state changes.
- Compare narration to a bounded evidence set and explicit actor knowledge. Check contradictions, secret leakage, player-action invention, ignored corrections, and intentions incorrectly treated as completed events.
- Return category, severity, exact offending span, supporting source IDs, and a narrow suggested correction. Distinguish a supported contradiction from uncertain style disagreement.
- Validate findings and expose them in existing inspection/repair UI. Deduplicate retry results by source/version and record stale findings as such.
- Measure false positives with deliberately valid difficult scenes. Add synchronous review only after shadow results justify it. A pre-publication reviewer requires buffered output; already streamed text cannot honestly be described as checked before publication.
- For optional synchronous mode, allow one targeted revision and recheck hard invariants. If unresolved, record the failure clearly and use an explicit blocked/review-needed state for hard violations; do not claim success or enter a revision loop. Preserve existing normal streaming when the mode is off.

**Acceptance:** planted contradictions and leaks receive valid source-linked findings; valid deception and false NPC beliefs are not mistaken for objective canon errors; timeout is unchecked; retries do not duplicate proposals; already accepted text is never silently rewritten.

## Phase 4 — Faction reasoning on meaningful events

**Deliverable:** faction proposals respond to material changes while respecting existing simulation authority.

Extend faction autonomy and existing world-tick/Director jobs. Trigger on eligible world transitions and substantial events rather than wall-clock polling for every faction.

- Select only affected eligible factions, with a bounded batch. Give each its own knowledge, resources, goals, projects, travel constraints, and prior commitments.
- Generate proposed objective, method, target, cost, earliest feasible timing, public signal, and supporting evidence. Retain deterministic doctrine as fallback and constraint input.
- Reconcile proposals centrally against the same snapshot and existing project/resource rules. Resolve competing resource claims through the backend, not whichever worker finishes first.
- Preserve pending Director frame identity and activation semantics. A proposed siege does not become a captured city; a planned messenger does not establish delivery.
- Make jobs idempotent by triggering event/version and faction. Snapshot imports and summary rebuilds do not schedule new world advancement.

**Acceptance:** an affected faction proposes a plausible response; an uninformed faction lacks secret knowledge; insufficient resources block application; repeated job delivery has one effect; stale plans cannot override newer state; pending Director drafts remain protected.

## Phase 5 — Evaluation-driven improvement workflow

**Deliverable:** saved failures yield testable improvement proposals.

- Let the operator select a failed turn or correction and create an isolated regression case with the relevant source snapshot. Keep GM corrections as instructions/feedback rather than witnessed events.
- An evaluation worker proposes a narrow prompt, tool-description, retrieval, or settings change. Record the original failure, candidate version, and expected observable benefit.
- Evaluate current behavior and candidate on both targeted and held-out scenarios. Measure tool efficiency, source support, continuity, agency, latency, cost, and user preference for scene quality.
- Combine deterministic invariant checks with calibrated model judging and human review. Do not promote a candidate merely because the same worker grades its own output highly.
- Produce a reviewable change/report. Prompt or code candidates are versioned development artifacts; no autonomous production self-editing or canonical campaign repair.

**Acceptance:** a saved failure becomes reproducible; a narrow fix improves its target without worsening held-out invariants; candidate adoption and rollback identify exact versions.

## Verification and release gates

Use existing focused tests, extending the relevant files rather than creating a second harness: turn/orchestrator, engine/gmTools, engine/smallBrain, engine/llmSettings, jobs/outbox, memory/continuity, and evals/replayRunner tests. Add tests at the owner for genuinely new contracts. Run `npm run check` for type/UI changes and `npm run build` before artifact qualification.

Required cross-cutting scenarios include worker cancellation, malformed JSON, unsupported source IDs, foreign-story IDs, unauthorized commands, secret/POV leaks, stale snapshots, duplicate job delivery, omitted-versus-cleared updates, budget exhaustion, missing provider configuration, and worker-disabled compatibility.

For UI controls verify rendered behavior and the saved effective server setting. For runtime qualification run `npm run app:status`, confirm checkout and actual data root, and identify the served artifact. On a disposable story, verify an actual completed request/receipt, persisted result, and background job outcome. Do not infer these from preview or a green unit test.

Initial quality target: all deterministic authority/visibility/idempotency invariants pass; active recall resolves the designed multi-step fixtures; model-backed comparisons show better supported recall and actor decisions on a recorded held-out set. Collect repeated samples for variable model outcomes and report uncertainty. Set latency and cost acceptance bounds from the baseline and the user's configured allowance; do not invent an improvement percentage.

Release each feature disabled by default until its evidence supports activation. Turning it off returns future turns to the baseline path; it does not undo accepted canon. Cancel or supersede pending work where necessary. Keep schema changes backward-compatible and do not use destructive rollback against campaign data.

## Completion checklist

- [ ] Phase 0 baseline and deterministic/model evaluation paths verified.
- [ ] Phase 1 active recall works through shared turn entrypoints and actual receipts.
- [ ] Phase 2 actor knowledge isolation and decision behavior verified.
- [ ] Phase 3 shadow review measured; synchronous mode qualified separately if implemented.
- [ ] Phase 4 faction proposals preserve timing, resources, idempotency, and Director lifecycle.
- [ ] Phase 5 regression/proposal workflow produces reviewable, versioned comparisons.
- [ ] Effective settings and evidence are inspectable through existing UI.
- [ ] Focused tests, type checks, build, and applicable rendered checks recorded.
- [ ] Runtime activation status explicitly recorded as verified or not performed.

## Evidence log

September 13, 2026: planning established the starting points above. No runtime models, settings, campaign records, or application code changed during planning.

September 13, 2026: Phase 0/1 implementation slice completed in the working tree. `activeRecall` is an explicit, disabled-by-default service in Settings → Services. When enabled, only historical-gap turns use the existing shared turn entrypoint, configured service profile, bounded GM loop (two planning rounds/four total read calls), and a strict allowlist: `memory.retrieve`, transcript/entry reads, canonical reads/search, actor briefs, and timeline briefs. Planner output is parsed and clamped before dispatch; it cannot write canon or expand its command surface. The narrator receives bounded observations as evidence, while the persisted GM receipt records reason, model, retained source IDs, and omissions; Context Window labels submission-only observations separately from preparation preview.

Verification: `npm test -- --run src/lib/server/turn/orchestrator.test.ts src/lib/services/ai/sdk/schemas/__tests__/smallBrain.test.ts` (55 passing); `npm run check` (0 errors, 0 warnings); `npm run build` (passed). `npm run app:status` confirmed the terminal process at `http://127.0.0.1:5173`, its checkout/data root, database, jobs, and Qdrant. Runtime activation and a model-backed disposable-story turn were not performed: the feature remains disabled and no cost allowance or disposable campaign was supplied.

September 13, 2026: Phase 2 implementation slice completed in the working tree. `actorDecision` is a separate, disabled-by-default service with an explicit actor-isolated evidence view. It excludes unrelated secrets and secret faction goals, retaining only the NPC's own beliefs, witnessed or belief-linked events, relationships, commitments, personal agency state, and public faction facts. At most two named/present NPCs run for pivotal social actions; each receives a separate context and can only cite source IDs present in that view. Malformed or foreign citations, unavailable models, timeouts, and insufficient evidence all degrade to a recorded proposal status without narrating, writing canon, or choosing player action. Proposed actions, objectives, conditions, rationales, and evidence IDs are passed to the narrator as non-event guidance and shown in Context Window; accepted durable intent remains owned by the existing state-extraction path.

Verification: `npm test -- --run src/lib/server/turn/orchestrator.test.ts src/lib/server/engine/gmTools.test.ts` (65 passing) and `npm run check` (0 errors, 0 warnings). Model-backed/durable-intent qualification remains unperformed because this service is disabled and no disposable campaign or cost allowance was supplied. Phases 3–5 remain planned work.

## Design references

These support the workflow choices; their reported performance is not a prediction for Mtherios.

- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) — bounded workflows, orchestrator/worker roles, and selective evaluation.
- [Anthropic: Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) — separate investigation contexts, explicit delegation, source synthesis, and coordination/token overhead.
