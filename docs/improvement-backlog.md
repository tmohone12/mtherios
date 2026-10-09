# Mtherios improvement backlog

Evidence-led follow-up list. Unchecked items remain planned. The audit findings below describe the pre-fix snapshot; implementation status is recorded separately.

## Implemented — character / classifier / Director handoffs (2026-09-04)

- [x] Header-aware bounded scene excerpts preserve the narrative opening and ending. The real Volantis probe now retains the scene body and includes Player and Zhen within the same 32-dossier limit.
- [x] Director selection considers the complete canonical character roster, aliases, current mentions, presence, protagonist identity, and linked plot actors; it no longer truncates characters alphabetically before ranking.
- [x] All supported citable evidence sections print source IDs. Rejected cards explain missing actor/evidence links in the existing activation rationale, exposed in the Director panel. Explicitly empty activation lists stay quiet.
- [x] Shared read compatibility exposes legacy background, traits, voice, goals, and current knowledge without a bulk migration. The character editor exposes stable appearance, current presentation, and voice separately; narration and refinement preserve that distinction.
- [x] Initial, deferred, and repair classifier prompts include bounded canonical identity/state context. The schema supports canonical IDs, personality, rank, and current presentation. The validated write path rejects ambiguous name-only matches and inconsistent IDs; incremental biography updates preserve existing facts.
- [x] Chapter refinement reads current canonical sheets, descriptions, and bounded original/recent source passages. Manual refinement includes earliest name matches as well as recent ones, with source IDs and body-aware excerpts.
- [x] Blank/non-object/malformed chapter results fail validation. No accepted changes report skipped rather than generated. Chapter patches require confidence and quotes found in supplied evidence; accepted support is retained on the proposal. Quote matching checks provenance, not semantic entailment, so model-quality evaluation remains necessary.

Verification: **1,079 tests passed across 118 files**, `npm run check` reported zero errors/warnings, and the production build passed. A read-only real-story prompt probe passed. Browser verification confirmed the new appearance/presentation/voice controls and populated legacy personality/voice on Zhen's sheet. Explicit clearing of fallback fields also has regression coverage. No provider settings were changed, no model calls were made for verification, and existing character records were not backfilled or merged. Volantis remained at version 3191 and Veil at version 2060 during verification.

Still follow-up: memory ranking/history/excerpt work below; model-based replay evaluation; targeted character backfill reviewed against source text. These fixes improve future updates and how existing fields are read, but do not invent missing appearances or rewrite old Director frames.

## Memory retrieval

- [ ] **Preserve semantic relevance in final ranking.** `text-embedding-3-large` ranked the correct fact first for all six paraphrases, but final prompt answer recall remained 23/27 (85.2%). A strong tunnel match was discarded after recency/importance scoring. Compare calibrated similarity or hybrid rank fusion on the unchanged benchmark before changing live settings.
- [ ] **Search older transcript evidence.** Transcript-only facts outside the latest 200 entries were missed. Add bounded full-history evidence search, not a larger prompt window.
- [ ] **Preserve answers when shortening memory.** A correctly retrieved document lost the answer after the 1,200-character body cutoff. Test query-aware excerpts and actual packet answer retention.

Evidence: [memory benchmark](../evals/memory/README.md), including the successful semantic run of 2026-09-04. These are retrieval findings, not narrator-generation accuracy claims.

## Character, classifier, and Plot Director audit

Audited 2026-09-04 against current source and read-only Postgres records. The application endpoint was offline; no workers were started, model calls made, or story records changed. Priority below is the recommended implementation order, not a claim that every symptom has one cause.

### P1 — Give Plot Director the actual scene and relevant cast

- [ ] **Preserve narration content after the scene header.** The Director takes only the first 260 characters of each of the latest 16 entries. The latest Volantis narration has a 334-character header; the production prompt builder excludes even the opening of its narrative body. This undermines the instruction to prefer current events over older plot summaries. Separate time/location from scene evidence and use bounded, body-aware excerpts; retain dialogue, decisions, and resolved beats.
  - Acceptance: long-header scenes retain their concrete action and outcome; a completed or declined beat cannot be reactivated merely because its resolution was clipped.
  - Source: [recent scene formatting](../src/lib/services/ai/context/strategicWorldBrainInput.ts#L359).
- [ ] **Select characters by scene relevance, not alphabet.** The loader orders entities by type/name and limits to 120; the Director then takes only 32 character dossiers. In Volantis, `Player` is character 33 and `Vermillion Zhen Lian` is 44. A read-only production-builder probe confirms neither gets its own dossier. A name appearing in another character's description is not a substitute. Include current participants and relevant opposing actors first, with stable IDs and aliases.
  - Acceptance: a scene involving characters beyond the alphabetical cutoff includes their own identity, motives, relationships, and relevant knowledge, without increasing the fixed dossier count.
  - Sources: [entity selection](../src/lib/server/engine/serviceCommands.ts#L608), [dossier cutoff](../src/lib/services/ai/context/strategicWorldBrainInput.ts#L397), [dossier fields](../src/lib/services/ai/context/strategicWorldBrainInput.ts#L169).
- [ ] **Make evidence IDs usable and rejected activations explainable.** Arc, chapter, event, rumor, and agreement formatters omit their record IDs, although finalization requires exact IDs for those evidence types. A production-builder probe retains a synthetic event's description but loses its ID. Supply IDs beside all citable evidence and expose why an actor/reference/card was rejected; keep the canon checks.
  - Current observation: Volantis has two escalating cards but `plotActive: false` and empty `activateNow`. Both cards have empty actor/antagonist links; one candidate has no surviving evidence and the other no canonical actor. This is consistent with finalizer safety filtering, but the original raw response is not retained, so the exact historical rejection cannot be reconstructed.
  - Acceptance: every supplied evidence type is citable; unsupported actors remain blocked with a specific reason; a genuinely quiet frame is distinguishable from a rejected plan. Preserve applied-versus-pending, freshness, retirement, and player-agency guards.
  - Sources: [evidence formatting](../src/lib/services/ai/context/strategicWorldBrainInput.ts#L209), [evidence validation](../src/lib/services/ai/generation/strategicWorldFrame.ts#L63), [activation filtering](../src/lib/services/ai/generation/strategicWorldFrame.ts#L234).

### P1 — Make character capture, sheets, and consumers agree

- [ ] **Normalize existing character fields through one shared view.** Reuse the current canonical entity pipeline; do not add another character store. Some apparent missing detail is stored under fields that downstream consumers do not read.

  | Detail | Current handoff gap | Smallest useful correction |
  | --- | --- | --- |
  | Biography | Imported `background` can exist without `bio`; the editor reads `bio`, and Director uses `bio` or description. The current classifier validator does write new `background` to both fields. | Read legacy background consistently and avoid replacing a full biography with a small newly discovered fact. |
  | Personality | Classifier schema accepts `traits`, not `personality`; editor and Director read `personality`. A direct schema probe strips a supplied `personality` field. | Present existing traits consistently and align the extraction/refinement contract; preserve unknowns rather than inventing a profile. |
  | Appearance | Classifier, compact sheet, and narrator support it, but only 12 of 49 Volantis characters have `state.appearance`. Some values describe current clothing/injuries rather than stable features. | Recover explicit source-backed appearance; distinguish stable appearance from current presentation so a robe change does not replace the person's physical identity. |
  | Voice and knowledge | Classifier captures `speechStyle` and `eventMemory`; compact editor lacks a voice field, automatic refinement omits voice/background, and Director reads `knownFacts` but not event-memory knowledge. | Preserve and expose existing voice and relevant knowledge through the same view, keeping witnessed facts separate from private knowledge. |

  - Current Volantis snapshot: 49 characters; 12 appearance fields; 0 explicit personality fields; 12 nonempty backgrounds with empty bio; 13 nonempty trait lists with empty personality. These are field-coverage counts, not proof that descriptions contain no useful detail.
  - Acceptance: an imported character with background, traits, appearance, and voice retains those facts through editor display, refinement, and narration; no unrelated fields are erased. Displayed detail must remain editable and source-backed.
  - Sources: [classifier schema](../src/lib/services/ai/tools/schemas.ts#L13), [canonical field mapping](../src/lib/server/turn/patchValidator.ts#L76), [character editor](../src/lib/components/database/WorldExplorer.svelte#L1262), [refinement input projection](../src/lib/server/engine/characterDrafts.ts#L389).

### P1 — Ground classifier identity and character enrichment

- [ ] **Give the classifier a bounded canonical identity context.** Its prompt demands updates only to established canonical characters, yet receives player text, narration, and output schema—not the established roster, aliases, or current fields. Supply relevant known identities and existing state so alias mentions and genuinely changed facts can be resolved. Keep unknown characters reviewable instead of enabling automatic character creation.
  - Acceptance: title/alias mentions update the intended character, ambiguous names produce no guessed write, unchanged facts do not churn, and appearance/voice evidence reaches the intended entity. Volantis also has duplicate exact-name Aurion records; review identity ambiguity rather than automatically merging them.
  - Sources: [classifier prompt contract](../src/lib/server/turn/promptPacket.ts#L1414), [extraction job](../src/lib/server/jobs/processor.ts#L4191).
- [ ] **Feed enrichment the evidence needed for missing details.** Automatic refinement receives proposal states and two chapter digests; it omits canonical descriptions and legacy background/voice. Manual refinement sees descriptions but clips matched transcript entries to their first 500 characters. Neither path is a reliable recovery pass for appearance described much earlier in the story. Use selected source passages and the current canonical sheet, not a new summarization layer or a larger unfiltered transcript.
  - Acceptance: explicit earlier appearance and personality evidence can fill missing fields; temporary actions do not become lifelong traits; absent evidence leaves a field unknown. Measure retained facts in the final sheet and narrator context, not just proposal/application counts.
  - Sources: [manual excerpting](../src/lib/server/engine/characterDrafts.ts#L279), [chapter refinement](../src/lib/server/engine/characterDrafts.ts#L424), [chapter evidence assembly](../src/lib/server/jobs/processor.ts#L3281).

### P2 — Make enrichment validation and status trustworthy

- [ ] **Distinguish valid no-change, enriched, invalid, and fallback-only results.** Character-update parsing logs success before output shape is validated. Chapter refinement asks for evidence/confidence but discards them when accepting patches. Deterministic chapter proposals are still applied after refinement errors or no useful enrichment. Preserve useful deterministic evidence, but do not equate that with a completed character-sheet refresh; validate and retain evidence for substantive changes.
  - Current limitation: none of the 24 retained character-update API records had blank response text, and none belonged to Volantis. The blank-response behavior is a verified code risk, not a demonstrated cause of today's Volantis gaps. These logs also do not prove enrichment has never run outside retained history.
  - Acceptance: blank/null/wrong-shape responses fail clearly; valid empty updates are no-change; unsupported biography/appearance changes cannot auto-apply; fallback-only updates report exactly which fields changed.
  - Sources: [result parsing](../src/lib/server/engine/characterDrafts.ts#L226), [patch acceptance](../src/lib/server/engine/characterDrafts.ts#L484), [fallback/application](../src/lib/server/jobs/processor.ts#L3359), [canonical application](../src/lib/server/engine/canonRepair.ts#L318).

### Verification and boundaries

- Existing focused suites: **4 files, 50 tests passed** (`characterDrafts`, `patchValidator`, `strategicWorldBrainInput`, `strategicWorldFrame`). This is regression coverage, not an end-to-end quality benchmark.
- Additional one-off read-only probes used the actual prompt builder and classifier schema. They confirmed lost narration body, missing Player/Zhen dossiers, missing event IDs, and stripped personality input. They did not invoke an LLM or reconstruct the complete historical provider request.
- The acceptance cases above are proposed regression/benchmark work, not newly implemented tests. Start with deterministic handoff tests, then evaluate classifier extraction and Director decisions against fixed story fixtures.
- Only this backlog was added by this audit. No character backfill, duplicate merge, provider change, prompt change, or live story repair was performed. The Mtherios project guide kept the audit on backend canon; Ponytail kept the recommendations focused on existing handoffs rather than new subsystems.
