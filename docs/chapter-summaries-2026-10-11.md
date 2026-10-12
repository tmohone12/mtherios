# Chapter summaries: why they were word walls — 2026-10-11

Status: fixed in `86c8c65` (branch `fix/concise-chapter-summaries`) and deployed. This is a dated working record; [ARCHITECTURE.md](../ARCHITECTURE.md) owns the current description.

## Chapter 91 (Veil)

Before: titled "Chapter 91: Recorded Events", 29,243 characters (4,933 words) for 20 turns, plus 72 KB of stored "accounts". It was written on 2026-10-09 by the summary-recovery tool (`summary-only-recovery-v1`, protocol `server-evidence-references-v2`, `server-source-excerpts`, model `xiaomi/mimo-v2.6-flash`): the model only picks source references and the server pastes the original text. So the "summary" was 20 `Player action record:` and 94 `Story narration record:` quotes, including:

- raw player commands with their typos (`i stroll up on my horse with the kings guard and say " I am Aegon targaryen 6th of him name"`);
- director and OOC instructions recorded as story events (`gm write the ride to river run leaving a garrison for the twins`, `Write , something a little plot in kings landing ... choose a rando...`);
- POV commands (`/pov Daenerys , days later , a rider comes into court...`);
- long narration excerpts (sensory description, dialogue) and nothing saying where anyone went or why.

Because it has no summary section, the reader view and the narrator's prompt both fell back to this whole text.

After `chapter.rewriteSummary` (one regeneration from its own 20 turns with the fixed summarizer, `google/gemini-3.8-flash`): titled "Subjugation of the Riverlands: The Surrender of the Twins and the Yield of Riverrun", 242 words — an opening sentence, five bullets (the Twins' surrender and the Freys sent to the Wall; the march to Riverrun and the Blackfish's condition; Riverrun's surrender; Tyrion's reports and audit in King's Landing; Edmure's return while the Twins' new lord is debated) and a `Now:` line. The previous title and text are kept in `metadata.rewrite`.

## Why every chapter read as a wall

| Cause | Where | Fix |
| --- | --- | --- |
| The summarizer demanded completeness at any length: "4–12 connected paragraphs", "include every consequential development", "never omit distinct events to meet a word quota", "No arbitrary length limit", no bullets. Chapters averaged 7,000–13,000 characters per 20 turns. | [summaryGeneration.ts](../src/lib/server/jobs/summaryGeneration.ts) | Reader summary: opening sentence or two, one bullet per development (where, who did what and why, result; journeys and missions name destination and purpose), `Now:` line, 120–350 words per chapter (200–500 per arc). Per-turn accounts stay complete for audit and arcs. |
| Storing the summary collapsed all whitespace, so the paragraphs the summarizer produced became one line. | `formatMtheriosMemorySummary` in [mtheriosSummaryFormat.ts](../src/lib/services/ai/context/mtheriosSummaryFormat.ts) | The narrative keeps its line breaks. |
| The reader view appended "Scene at this checkpoint", "Characters" and "Threads at this checkpoint" text to the narrative, joined by spaces. | `summarizeMtheriosMemoryForRollup` (used by the browser) | `readableMemorySummary` shows only the story summary; prompts and rollups keep the condensed form. The chapter save still recognises an unchanged summary in either form. |
| The memory panel and World drawer rendered the summary in a paragraph that collapses line breaks. | [StoryMemoryPanel.svelte](../src/lib/components/memory/StoryMemoryPanel.svelte), [WorldDrawer.svelte](../src/lib/components/story/WorldDrawer.svelte) | Line breaks are shown. |
| Chapter 91 only: the recovery tool stores verbatim excerpts instead of a summary. | summary-recovery tooling | Rewrite such chapters with `chapter.rewriteSummary`. |

## Existing chapters

Chapters 1–81 (normal summarizer, 7,000–13,000 characters) and 82–90 (external reviewed drafts over 63-turn windows) keep their old text until rewritten. `chapter.rewriteSummary` refuses chapters inside an arc (all of 1–90), because arcs are validated against their chapters; rewriting those goes through `jobs.rebuildSummaries` (dry run by default), which re-windows and rebuilds chapters and arcs together.

## Verification

`svelte-check` 0/0; production build succeeds; full suite 2,379 passed, 0 failed, 297 skipped, including tests that the prompt asks for places and purposes and keeps line structure, that the reader view drops checkpoint metadata, that an unchanged reader summary keeps the stored account, and that the rewrite reads the chapter's turns in order, saves through the canonical chapter path, and refuses arc chapters and incomplete transcripts. Live: chapter 91 rewritten as above (one summarizer run).
