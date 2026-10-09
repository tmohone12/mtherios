# Sol handoff: Jev, purposeful narration, and service consolidation

- Date: 2026-09-27
- Status: **Implementation in progress.** See [the implementation evidence](sol-jev-narration-implementation-report-2026-09-27.md) for verified slices and remaining gates.
- Checkout: `E:\DEV\Projects\MythEngine`
- Intended implementer: Sol, using the user's configured models and providers.
- Priority: purposeful NPC behavior, natural scene progression, and fewer duplicate model calls.

## Assignment and scope

Expand the existing Jev adapter and decision paths so the GM, dialogue model, and background jobs use consistent intentions and evidence. Consolidate overlapping services after their callers have moved. The user's central requirement is that faction activity enters narration naturally: it must fit the scene and leave room for the player's interests, ordinary conversation, cooperation, and quiet.

The user subsequently authorized implementation and made this an active goal. Follow the session's authorization for provider spending, runtime restart, or campaign operations. Preserve the dirty checkout and all unrelated work. Read [AGENTS.md](../AGENTS.md) before implementation.

Build on the [earlier context/harness plan](sol-context-harness-integration-plan-2026-09-27.md) and its [implementation evidence](context-harness-implementation-report-2026-09-27.md). Recheck current source rather than reimplementing already completed actor isolation, final request budgeting, faction idempotency, or due-event feedback. The earlier report's synthetic fixtures do not establish real prose quality.

## Observable result

1. An NPC's response reflects their goal, personality, relevant memory, and actual knowledge. Narration and dialogue share the same applicable decision.
2. Accepted agreements and answered questions lead to action or closure. They are not repeatedly presented as unresolved negotiations.
3. Factions and off-scene NPCs can progress without making every turn about them. A relevant consequence appears through a believable local effect or interaction.
4. Quiet scenes remain quiet when no established consequence requires attention. Ignoring a suggested hook does not create a new emergency.
5. Fewer model passes perform the same work. Call counts, retained context, fallbacks, and actual narrative outcomes remain inspectable.

## Current implementation to reuse

| Owner | Current behavior / implication |
| --- | --- |
| [jev.ts](../src/lib/server/turn/jev.ts) | OpenRouter/NanoGPT decision transport, bounded options/source IDs, timeout and confidence handling. The transport already accepts multiple questions; memory verification uses that facility. Extend this owner. |
| [agentRuns.ts](../src/lib/server/engine/agentRuns.ts), [turn/orchestrator.ts](../src/lib/server/turn/orchestrator.ts) | The GM can call `askJev`; the subsequent turn can independently request an automatic reaction. The handoff currently carries formatted observations, not a reusable typed actor decision. |
| [gmTools.ts](../src/lib/server/engine/gmTools.ts), [dialoguePass.ts](../src/lib/server/turn/dialoguePass.ts) | Actor-scoped evidence and isolated speaker requests already exist. Reuse them for knowledge, portrayal, commitments, and selected memories. |
| [strategicFramePromptCard.ts](../src/lib/services/ai/context/strategicFramePromptCard.ts) | Prompts already prioritize player action and allow quiet, but the narrator block can include five active cards sorted by pressure. A prose instruction alone does not enforce scene selection. |
| [planner.ts](../src/lib/server/plotBrain/planner.ts), [lifecycle.ts](../src/lib/server/plotBrain/lifecycle.ts) | Director planning already permits quiet frames, limits promoted faction consequences, and distinguishes pending/applied state and quiet periods. |
| [processor.ts](../src/lib/server/jobs/processor.ts), [autonomy.ts](../src/lib/server/factions/autonomy.ts) | Jev already selects eligible faction moves and off-scene NPC activity. NPC background evidence is thinner than in-scene evidence, and its choices are currently wait/prepare/investigate. |
| [dueEventFeedback.ts](../src/lib/server/events/dueEventFeedback.ts), [sceneCheckpoint.ts](../src/lib/server/memory/sceneCheckpoint.ts) | Final-source realization and scene continuity exist. A selected cue, a narrated signal, and a completed world event need distinct receipts. |
| [turnMemoryEnvelope.ts](../src/lib/server/turn/turnMemoryEnvelope.ts) | An inline extraction experiment exists behind `MTHERIOS_INLINE_TURN_MEMORY=1`. It remains off by default; dialogue edits and due events currently require fallback. |

Keep PostgreSQL and existing canonical writers authoritative. Jev selects among supported alternatives; it does not generate prose, establish hidden discoveries, or commit world outcomes. New hypotheses and intentions stay separate from accepted events and NPC beliefs.

## Required faction presentation policy

Implement this in selection, packet construction, and final-source receipts. Adding another paragraph to the system prompt is insufficient.

### Selection rules

- **The player's current action is the scene's focus.** Finish the answer, interaction, or established immediate consequence before offering unrelated developments. An ordinary purchase or intimate conversation does not automatically become a faction encounter.
- **Zero is a successful result.** Present at most one new discretionary faction/Director cue per scene opportunity, and at most one per turn. These are ceilings, never quotas. Existing conversations about a faction may continue when the player engages.
- **An opportunity spans the interaction.** Reuse the existing scene boundary/source window with branch, POV, and location identity; carry its cue allowance across ordinary follow-up turns. A checkpoint refresh, new message, different faction, or different candidate does not reset it. Reset only for a supported scene/activity transition or explicit player engagement. Do not use a checkpoint content hash as the scene identity, because it changes during the conversation.
- **Require a causal connection.** A candidate must connect to the current place, involved actor, chosen route, transaction, or player-requested topic. High pressure and dramatic potential alone are insufficient.
- **Use observable effects.** Narrate an established local effect: a posted fee, a familiar contact's changed availability, or an NPC carrying out an evidenced step. Secret strategy and faction dossiers remain GM reference. Even when a public effect is visible, its secret cause stays hidden unless learned.
- **Do not repeat a hook because it was ignored.** Reappearance requires a substantive new sourced development, a new relevant interaction, or the player asking. A new card title, paraphrase, turn number, or pressure score does not count as new evidence.
- **Honor closure, refusal, and quiet state.** Exclude resolved/player-closed threads and deferred pressure as existing lifecycle rules require. NPC independence continues within canon; it does not authorize reopening the player's rejected plot under another name.
- **Urgent exceptions need facts.** Numeric faction pressure currently influences urgency; that score must not authorize interruption. A source-linked imminent consequence that actually reaches this scene can require direct treatment. Do not invent a deadline, messenger, attack, travel, or player commitment to make it urgent.
- **Keep world truth intact.** The one-cue ceiling limits optional presentation. It must not suppress multiple already-established consequences that directly affect the player's action, freeze world clocks, or cancel pending events merely to keep prose calm.

### Presentation choices

Use a small closed choice in existing turn metadata: `none`, `ambient`, or `direct`.

- `none`: continue the current scene without a new faction hook. Do not replace it with a generic threat, portent, or mysterious stranger.
- `ambient`: one brief detail integrated into the current action. No mandatory explanation, quest offer, cliffhanger, or demand for the player to respond. Do not append an identical atmospheric sentence to every turn.
- `direct`: a relevant actor interaction or consequence already supported by the scene, or the topic the player deliberately pursued. The GM controls natural wording and length.

Examples assume the underlying effects are already established:

| Situation | Intended treatment |
| --- | --- |
| Player buys breakfast; a distant faction dispute exists | Complete the purchase/conversation. No dispute cue. |
| Player books a ship; a local dock levy has changed | The clerk includes the new fee in the booking. Explain the politics only if the conversation calls for it. |
| Player hears about a blockade and continues a personal conversation | Continue that conversation. Do not send another courier or increase danger because the hook was ignored. |
| Player asks who ordered the levy | Answer from available knowledge or investigate; a substantive faction scene is now appropriate. |
| An established inspection begins at this dock now | Show the immediate effect with supported scope. Do not force the player's response or reveal the inspectors' private plans. |
| An NPC knows that a ship was seized but not who ordered it | Their behavior can reflect the seizure. Their speech cannot identify its hidden sponsor. |

### Selection is not delivery

Record candidate source/action IDs, exclusion reasons, selected cue/mode, and evidence revision in the existing request/turn receipt. After the final dialogue-adjusted prose is persisted, record a cue as surfaced only with a validated source span. Reuse due-event feedback and existing metadata; add no standalone presentation database or scheduling service.

A visible hint does not realize the entire faction plan. A delivered cue does not prove the player accepted a quest. NPC knowledge changes require that NPC's own observation/communication evidence. A cue dropped by final budgeting or omitted from prose remains undelivered; do not mark it completed. Conversely, an already delivered unchanged signal must not return through a different prompt section. Carry validated presentation history across scene-checkpoint refreshes; a disposable checkpoint alone cannot be its durable owner.

## Ordered implementation slices

### P0 — Record the baseline and preserve compatibility

- [ ] Inventory all callers of `askJev`, automatic actor decisions, Active Recall, Continuity Review, World Simulation, and the browser Strategic World Brain wrapper. Capture which are enabled in the chosen test settings; registered service IDs do not equal calls per turn.
- [ ] Extend existing synthetic replay cases with the acceptance scenarios below. Capture per-role requests, serialized input size, usage when real, decision reuse, dialogue calls, and surfaced faction sources.
- [ ] Keep the current model/provider selections, disabled states, and dialogue behavior as the baseline. No fresh embedding job is required for this work.

### P1 — Reuse decisions and make NPC intentions specific

Owners: `jev.ts`, `agentRuns.ts`, `agentRunPlanner.ts`, `turn/orchestrator.ts`, `gmTools.ts`, `dialoguePass.ts`, and their existing contracts/tests.

- [ ] Extend the persisted `askJev` result with the actor ID, question family, validated candidate IDs/descriptions, selected option, source/evidence fingerprint, action fingerprint, model/rubric version, and usage. Fit this into the existing tool receipt and turn options rather than introducing a cache service.
- [ ] Give the planner and automatic path a shared definition of the immediate NPC response task. A validated specific response can satisfy that task before the generic fallback is requested; do not implement a cache whose generic and specific option sets can never match. Unrelated custom questions remain separate decisions.
- [ ] Reuse a result only for an equivalent decision with the same actor, action, options/rubric, evidence, and visibility scope. An arbitrary custom `askJev` question does not replace an automatic social reaction. Recheck after player answers, rolls, canonical changes, and resumed runs; distinguish duplicate delivery from a new decision.
- [ ] Pass applicable typed results into narration and the matching speaker's dialogue request; automatic reactions fill remaining gaps. Preserve configured non-Jev behavior and unknown/failure fallbacks.
- [ ] Let the existing GM planning pass propose two to five specific supported actions. In the same actor request, optionally select delivery stance and one relevant memory/commitment ID, including `none`. Avoid a separate option-writing model call or unnecessary planner round.
- [ ] Feed concise bio/persona/appearance, current goal, relevant beliefs, and exact selected memory through the existing actor packet. Selection cannot manufacture a memory or turn an intention into a completed act. Avoid repeating the same callback without renewed relevance.
- [ ] Use the existing planner's immediate exchange to recognize answered questions and accepted terms; choose continuation, action, closure, or hold. Do not add another scene manager. Ambiguous acceptance still requires interpretation against the actual offer; never invent player consent.

Acceptance: a negotiation produces one applicable Jev judgment, shared by GM and dialogue; changed evidence prevents reuse; "I accept" advances the established offer; private memories remain isolated. Existing timeout, invalid-option, missing-answer, probability, and cancellation handling still works. Batch questions only when they may see the same evidence; separate actors' private packets and separate public scene selection from actor secrets.

### P2 — Enforce natural faction presentation

Owners: `strategicFramePromptCard.ts`, `turn/orchestrator.ts`, `promptPacket.ts`, `plotBrain/planner.ts`, `plotBrain/lifecycle.ts`, `events/timeline.ts`, `dueEventFeedback.ts`, `promptReceipt.ts`.

- [ ] Apply the policy above to a small candidate set before prompt serialization. Reuse location, actor, timeline, thread closure, checkpoint, and prior delivery evidence. Rank relevance before pressure. Deterministically choose `none` when no candidate is eligible.
- [ ] Use Jev for an ambiguous selection only at an existing relevant decision/planning opportunity. Do not add a mandatory request to every turn. A failed/uncertain optional selection defaults to no new cue; established immediate consequences remain available regardless.
- [ ] Pass only the selected discretionary cue into active narrator guidance. Keep required canonical facts and source IDs, and retain full faction/Director records for tools and world jobs. Audit alternate injection paths: timeline briefs, faction sheets, raw agent observations, stored custom prompts, and the legacy World Simulation block must not restage withheld pressure as instructions.
- [ ] Keep one source/action identity across faction tick, Director card, scene cue, final narration evidence, and actor memory. Deduplicate multiple cards/events representing the same effect. Do not equate source revision churn with substantive novelty.
- [ ] Extend existing final-source feedback to validate and persist surfaced signals as distinct from event realization. Make retry, delayed extraction, stale-source rejection, and concurrent delivery idempotent. While feedback is pending, use current recent prose/receipts conservatively; do not keep offering the same candidate every turn.
- [ ] Include selection dependencies and new receipt/checkpoint freshness in prepared-context reuse. Budget the selected cue as a complete record through the existing final allocator; record any omission accurately.

Acceptance: a quiet scene gets no new hook; an ordinary local effect can appear without a quest; ignored cues do not escalate; a genuine immediate consequence remains visible; a selected but unwritten cue is never marked delivered. Verify both prepared packets and completed final-source receipts.

### P3 — Connect background NPC activity to memory and concrete plans

Owners: off-scene NPC job in `jobs/processor.ts`, `getActorDecisionView` in `engine/gmTools.ts`, existing faction plans/writers.

- [ ] Replace the thin background evidence packet with a bounded actor-specific view. Include relevant recent changes and established commitments, not the whole transcript or other actors' secrets.
- [ ] Prefer actors affected by new relevant events over modulo-only rotation while preserving a deterministic tie-break, current cadence, eligibility, and idempotency.
- [ ] Offer concrete supported steps from saved plans or already-generated Director/GM options. If no executable step exists, hold or use the existing bounded preparation behavior. Do not add an extra prose generation just to invent choices for every tick.
- [ ] Keep attempts, communications, discoveries, costs, and completed effects distinct. Validate each effect through existing writers under the current source/version. A Jev selection alone cannot create successful trades, new knowledge, or arbitrary resource changes.
- [ ] Feed accepted effects into existing faction/Director evidence. Scene presentation still passes P2; background progress does not guarantee a foreground mention.

Acceptance: an off-scene NPC acts differently when a relevant fact becomes known, never uses an unlearned secret, and produces no duplicate effect on retry. Several valid background moves can occur while the next scene remains quiet.

### P4 — Consolidate research and world movement

Complete caller migration before removing a service. Keep historical receipts readable and saved settings recoverable. Do not copy a retired prose prompt/model into the Jev decision configuration.

| Removal target | Required migration and deletion gate |
| --- | --- |
| `activeRecall` generative planner | Move needed history/page-read tools into the existing GM planning path. Check `agentRuns.ts`, direct `engine/command.ts` turn submission, and `api/turn/stream/+server.ts`. Preserve Research-off, visibility, citation limits, streaming/abort, idempotency, and direct-call behavior. The current `researchAlreadyPerformed` flag already prevents some duplication; setting it universally is not a migration. Delete the service only after all supported routes have equivalent evidence access. |
| Browser `worldSimulation` | Map each behavior used by `ActionInput.svelte`, `services/ai/tools/executor.ts`, and `services/ai/background/runner.ts` to canonical faction/NPC jobs or Director planning. Preserve unrelated weather/time/other effects actually relied upon. Define explicit backend-unavailable behavior; browser fallback must not silently invent canonical world movement. Remove the model path when every supported behavior has an owner. |
| Browser `StrategicWorldBrainService` wrapper/export | Verify no runtime consumers remain, then remove its file and lazy export. Retain the live server Director, its `strategicWorldBrain` setting, schemas, and shared prompts. This is code cleanup, not an inference saving. |

- [ ] Update `settings.svelte.ts`, its old-group migration maps, `terminalSettings.ts`, server `llmSettings.ts`, `PromptsPanel.svelte`, relevant UI/command validation, prompt overrides, and export/import compatibility together. Extend their existing settings/consolidation tests. Preserve explicit disabled states and user settings in the existing compatibility storage; prevent browser refresh/sync from reactivating retired services. Do not introduce a new settings archive subsystem.
- [ ] Keep summaries, character continuity, Lore Master, authoring, and image generation outside this removal scope. They have independent responsibilities that these bounded Jev choices do not replace.
- [ ] Update the architecture owner only after the new responsibility is implemented and verified.

Acceptance: browser, CLI/MCP engine submission, and direct streaming preserve their contracts; no retired service makes a request; settings round trips preserve surviving overrides; faction effects have one canonical execution owner.

### P5 — Consolidate bounded verification without losing extraction coverage

Owners: `continuityReview` job in `jobs/processor.ts`, `jev.ts`, `turnMemoryEnvelope.ts`, `patchValidator.ts`, `dueEventFeedback.ts`.

- [ ] Replace free-form Continuity Review generation only for supported checks with explicit candidates: exact sentence IDs plus relevant facts, commitments, actor knowledge, and player action. Jev returns typed supported/contradiction/private-knowledge/invented-player-action/uncertain verdicts; code maps IDs to exact spans and the existing warning writer.
- [ ] Generate candidates through existing extraction/evidence paths and deterministic risk triggers. Preserve all current warning categories, including ignored corrections and intent mistaken for events. A judge cannot discover an omitted contradiction. Retain the existing enabled review behavior or its fallback until candidate recall and false positives qualify the replacement; preserve a user's explicit disabled setting. If equivalence is unproven, mark retirement incomplete.
- [ ] Keep the existing inline memory experiment gated. On supported turns, verify narrator-proposed source-quoted changes against the final persisted prose. Extend typed routing deliberately for beliefs/promises; the current verifier only accepts confidently matched events. Do not lower a threshold and treat that as support for new write types.
- [ ] Retain classifier fallback for missing/incomplete candidates, changed dialogue, unsupported schemas, due-event feedback, and uncertain evidence until each case has explicit coverage. An empty candidate list does not prove nothing changed.
- [ ] Reuse one post-turn judgment request only where questions share the correct evidence and visibility scope. Preserve source revision checks, sparse updates, retry semantics, and final-narration fingerprints. Add no universal second prose pass or generic judge framework.

Acceptance: promises remain promises; witnessed facts update only eligible actors; wrong/missing candidates fall back safely; final rewritten dialogue controls verification; surfaced signals do not complete their parent plots. Classifier retirement is not a completion requirement: safe reduction of supported calls is the objective.

### P6 — Offer selective dialogue while preserving the experiment

Owners: dialogue settings/UI, `turn/orchestrator.ts`, `dialoguePass.ts`, actor decision receipt from P1.

- [ ] Preserve the user's existing enabled/disabled choice and current all-eligible-speakers behavior. Add a visible optional "important exchanges" mode if implementing selective routing; do not silently switch an existing configuration.
- [ ] Reuse the actor decision and established scene stakes to identify consequential exchanges. Do not call Jev solely to decide whether to save a dialogue call. If evidence is uncertain, preserve the configured dialogue behavior.
- [ ] Maintain per-speaker privacy, exact factual/commitment constraints, original-draft fallback, cancellation, and one final persisted narration. Selected ambient faction details must not cause unrelated speakers to receive private faction context.

Acceptance: a greeting avoids a dialogue request in selective mode; a consequential bargain still uses it; default behavior remains unchanged; mixed selected/skipped speakers preserve all original text outside validated replacements.

## Verification and qualification

Extend the existing tests and disposable replay rather than creating a second harness. Run only affected suites during each slice; run type checks when contracts change. Useful existing test owners include `jev.test.ts`, `agentRunPlanner.test.ts`, `turnFacade.test.ts`, `turn/orchestrator.test.ts`, `dialoguePass.test.ts`, `strategicFramePromptCard.test.ts`, `plotBrain/planner.test.ts`, `plotBrain/lifecycle.test.ts`, `jobs/processor.test.ts`, `dueEventFeedback.test.ts`, `promptReceipt.test.ts`, and `settings.consolidation.test.ts`.

Required multi-turn cases:

| Case | Passing evidence |
| --- | --- |
| Quiet meal/personal conversation with several remote high-pressure factions | No discretionary faction cue, no unrelated interruption, no forced scene-selection call. |
| Three different eligible minor faction cues across three turns of one personal conversation | The same scene allowance persists; no rotation of ambient hooks or checkpoint-refresh reset. |
| Faction pressure 95 and a critical label, without a sourced immediate local consequence | The quiet scene remains uninterrupted; the urgency label cannot bypass relevance. |
| Booking passage under an established local levy | At most one brief relevant cue; booking remains the focus; political exposition is optional. |
| Player ignores the levy hook for three subsequent turns | No repeated warning, new courier, fabricated urgency, or relabeled duplicate. Existing world rules still run normally. |
| Player asks about that faction later | A relevant discussion is available without pretending the underlying event is new. |
| Real sourced danger arrives during a quiet scene | Immediate canon is respected despite quiet selection; no extra unsupported threat is added. |
| "I accept" after an established bargain | Terms are honored; one applicable actor decision is reused; the same demand is not renegotiated. |
| Relevant old memory plus another actor's secret | The memory changes behavior; the secret stays out of that actor's Jev/dialogue request. |
| Selected cue omitted, merely hinted, then actually realized | Separate selected/surfaced/realized receipts; exact final-source support; no premature completion. |
| Background effect, Director promotion, NPC observation, later response | One source-linked causal chain; no automatic foregrounding or omniscient knowledge. |
| Delayed extraction, retry, resumed run, player closure, stale prepared context | No duplicate writes, replayed hook, reopened closed thread, or stale decision reuse. |
| Jev disabled, timeout, malformed result, low confidence, Research off, direct SSE | Safe fallbacks preserve canonical truth, streaming, and user settings. |

Commands to adapt to the changed files:

```powershell
npm test -- src/lib/server/turn/jev.test.ts src/lib/server/turn/orchestrator.test.ts src/lib/services/ai/context/strategicFramePromptCard.test.ts
npm run check
npm run eval:turns -- --agent-loop
npm run build
git diff --check
```

The current `--agent-loop` mode is a deterministic fixture with its own disposable database and no real provider requests. Recheck the script before running it. Build/test success is source/artifact evidence, not proof of deployment or natural writing.

For prose qualification, compare representative outputs using the same source snapshots, player actions, model settings, and available seeds. Use disposable campaigns and provider calls only within the implementation session's authorization. Evaluate: whether the action was answered, unwanted interruptions, repeated demands, factual preservation, NPC voice, earned memory use, and faction exposition. Have a reader assess naturalness; keyword assertions cannot prove it. Include multiple quiet scenes, not just a successful faction encounter.

Record requests by role, actual provider tokens/cost where available, serialized input size, latency, reuse/fallback counts, and cue source/outcome. Report synthetic usage separately. Settings grouping alone is not a saving. Do not claim a percentage reduction before measuring; optional features need to replace work or produce a demonstrated quality benefit.

## Completion and handoff

- [ ] P0 baseline and acceptance fixtures recorded.
- [ ] P1 actor decision reuse, specific intentions, and memory selection verified.
- [ ] P2 natural faction selection and final-source delivery tracking verified.
- [x] P3 background NPC memory and supported concrete steps verified in disposable replay; real prose qualification remains under the shared verification gate.
- [ ] P4 caller migrations and each claimed service deletion verified.
- [ ] P5 supported verification consolidation qualified; remaining fallback/deletion limits explicit.
- [x] P6 optional selective dialogue verified without changing existing preferences.
- [ ] Required source, settings/UI, and replay checks passed; prose qualification status stated separately.
- [ ] `ARCHITECTURE.md` describes actual owners, and a dated evidence report lists calls removed, behavior observed, fallbacks retained, and unresolved gates.

Implement in the order above. Keep unchecked work visible rather than redefining completion around a subset. Rollback should disable future optional decisions or restore the prior code path while retaining accepted events, transcript, source receipts, and user settings. Never rewind canon to undo a presentation change.
