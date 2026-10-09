# Chapter and arc memory repair

Status: complete and verified on the live local runtime. User authorized the plan, implementation, and rebuilding affected Veil summaries on 2026-09-12.

## Required behavior

- One chapter covers 20 completed player/narrator turns, in order, without a trailing delay. Preserve the opening narration and other eligible narrative evidence within the window; exclude OOC-only exchanges and keep branch/POV attribution.
- One arc covers 10 consecutive chapters using their full summaries. Existing browser settings must not silently restore the old 30-entry/5-chapter cadence.
- Summaries retain the factual sequence, decisions, conversations, discoveries, promises, consequences, character changes, and resolutions across the entire window. Compress repetitive language, not coverage.
- The reader-facing story section is a connected, self-contained chronological narrative. Ordered source accounts remain metadata for verification and rebuilds; they are not presented as the chapter itself.
- Validate a nonempty account for every supplied source. Invalid or missing model output is failed work, never a successful fallback.
- Store full summaries and preserve whole summaries through context assembly. Report omissions when the actual prompt budget cannot accommodate history.

## Source and lifecycle rules

- A completed turn is a saved narration paired to its player action. Duplicate responses cannot count the same action twice. An action whose response arrives late remains eligible until completed.
- An explicitly non-canon or OOC record remains excluded. Accepted narration following a GM instruction remains supporting narrative evidence, without counting the GM instruction as a turn.
- Full raw narrative supplies chapter facts. Historical rebuilds do not feed present-day threads or extracted event prose into generation. Event IDs remain attribution links. Extracted event titles do not populate factual chapter fields; the complete chronological accounts hold the actual changes.
- Each generated chapter must contain 20 ordered source accounts; each arc must contain ten ordered chapter accounts. JSON validation rejects missing, duplicate, reordered, or empty accounts.
- Saving a normal chapter and enqueueing its retryable arc job is atomic. Arc jobs refresh saved coverage and numbering under the story lock, so competing jobs cannot assign duplicate arc numbers or cover a chapter twice. Long campaigns have no arbitrary chapter/arc read cap in this path.
- Rebuilds save a source snapshot and draft files before replacement, then compare source state and the worker lease before an atomic swap. Validated drafts from failed rebuilds can resume under the same historical generation policy and unchanged source snapshot.
- Prompt consumers retain whole records, prioritize chapters not yet covered by an arc, and then include complete arcs. The final context budget can omit whole records with an explicit notice; it cannot silently cut the middle out of a selected summary.

## Implementation

1. Shared cadence/pair selection, fixed settings, and boundary tests.
2. Shared source-complete chapter/arc generation with strict response validation; wire the existing background processor to it.
3. Remove first/middle/last sampling and per-summary cuts; preserve full unrolled chapters and arcs within bounded prompt context.
4. Add a durable projection-only rebuild command with dry run, backup, staged generation, source revalidation, and atomic replacement. It must not run extraction, world ticks, Director planning, thread reconciliation, or character updates.
5. Run focused tests, type checks, build; deploy and rebuild Veil from the preserved transcript, then refresh derived wiki/search projections.
6. Inspect persisted ranges and source coverage, audit all chapter/arc content, and verify a fresh narrator prompt. Compare world state before/after rebuild.

## Existing evidence

The initial read-only audit found 42 Veil chapters, recent chapters using 30 entries plus a 10-entry buffer, and only two arcs covering chapters 1–20 and 21–25. Backend generation sampled chapter beats, accepted missing output as an LLM digest, and clipped concatenated arc overviews to 1,050 characters. Prompt consumers sampled again. These are generation and delivery defects, not evidence that retrieval alone failed.

## Completion evidence

- Combined focused verification: 190 tests across 14 files passed. Subsequent generation/rebuild checks passed after the final prompt safeguards. Svelte/TypeScript checks report zero errors and zero warnings.
- The fixed settings were checked in the rendered browser. The old cadence sliders are absent; the UI states 20 completed turns per chapter and ten chapters per arc.
- Veil rebuild `job_b985c023-4712-4aae-af5d-65de26bca927` completed and atomically applied: 31 chapters, three arcs covering chapters 1–10, 11–20, and 21–30, and 14 of 20 completed turns accumulated toward chapter 32. All 620 summarized turns have distinct, ordered accounts linked to 1,241 source entries, including the opening narration.
- Source snapshot, original projections, plan, and generated drafts are preserved in `data/exports/summary-rebuild-job_b985c023-4712-4aae-af5d-65de26bca927/`. Earlier rejected drafts were never applied.
- Every rebuilt chapter was audited against its complete raw source window. Corrections preserve exact conditions, actor knowledge, uncertain reports, accepted GM corrections, and dream/trial framing. Explicitly excluded OOC narration remains excluded. Corrections use the existing record-patch contract and update both the summary and its matching memory node; backups, evidence IDs, and receipts are under `output/*-summary-correction*`.
- Before/after fingerprints verified all original rows in 18 transcript/world tables and the story's turn, location, time, and metadata. Summary edits add their expected audit patches/proposals/references; they do not alter original world records. Evidence: `output/chapter-arc-world-after-rebuild.json` and `output/chapter-arc-correction-isolation.json`.
- The final assembled narrator prompt includes all three arcs and chapters 30–31. Every account in each selected record is retained without context-budget truncation; all chapters through 30 are covered by those arcs. Evidence: `output/chapter-arc-prompt-after.json` and `output/chapter-arc-prompt-verification.json`.
- All three arcs were audited against their ten corrected chapters. Thirty chapter correction artifacts and three arc correction artifacts were applied; chapter 2 required no correction. Body text, source accounts, plot points, character developments, open threads, and matching memory nodes were checked together. The 66 summary-only record patches added exactly 66 audit proposals and 132 audit references; all original rows in the 18 checked tables remain unchanged.
- The overlapping-arc-job regression passes (4/4 lifecycle tests); browser projection checks pass (8/8). The final build and Svelte/TypeScript checks passed and run under local PID 11044. Rendered verification shows 31 chapters, three arcs labeled 1–10, 11–20, and 21–30, full unclipped summaries, fixed 20/10 settings, and no browser console errors. Evidence: `output/summary-browser-final-*` and `output/chapter-arc-status-after.log`.
- Wiki refresh indexed 5,558 chunks and removed 994 obsolete chunks. Targeted canonical reindex completed 34/34 chapter/arc records with zero failures. Qdrant contains exactly the current 34 summary records; all 34 generated wiki summary pages retain every source account. Evidence: `output/chapter-arc-projection-refresh.json` and `output/chapter-arc-index-verification.json`.
- Wiki lint separately reports 66 structural warnings across the vault (duplicate titles, thin/orphan pages, and two broken links), including three arc pages with no outbound links. This is not a content-coverage or index failure; source relationships remain in the canonical records. Broader wiki cleanup is outside this chapter/arc repair.
- On 2026-09-13, the Veil reader-facing summaries were regenerated from the validated accounts by rebuild `job_10337091-a6aa-438f-a49e-b9a05d462ec3`: 31 chapters with 20 ordered source accounts each, and three arcs with ten chapter accounts each. Two stale duplicate arc rows were removed by the atomic replacement. Chapter 27 received a layout-only paragraph repair through the record-patch contract; its wording and source accounts are unchanged. The refreshed vault and canonical index contain 31 chapters and three arcs. Evidence: `output/veil-readable-rewrite-verification.json`, `output/chapter-27-paragraph-layout-backup.json`, and `output/chapter-27-paragraph-layout-receipts.json`.
