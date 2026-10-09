# Agent harness: current and historical agreements

This is the next bounded implementation slice from the [harness review](./agent-harness-review-2026-09-06.md). It fixes agreement lifecycle persistence and makes temporal memory distinctions visible through existing retrieval and UI paths. It adds no dependency, framework, or database migration.

## Result

The backend previously recorded an event for `update`, `fulfill`, `break`, and `expire` without changing the agreement row. Those operations now update the canonical agreement inside the existing transaction. `annul` and `supersede` are supported as explicit terminal actions too. Active and contested agreements remain current; resolved records remain historical.

Changes target an exact same-story ID, or a unique normalized parties/category match. An invalid ID never falls back to another record. Ambiguous targets, already-resolved targets, repeated sources, and older transcript sources produce warnings instead of changing canon. Exact duplicate creations and late creations of already-resolved commitments are guarded; a later, newly renewed commitment can still be created. Unidentified matches are bounded at 200 rows and require an exact ID beyond that ceiling.

Resolution preserves the original terms and parties. Revision changes the current terms while the source event retains both the previous and resulting record. Canonical rows retain the original source IDs and append the new source entry, event, and patch IDs. Omitting secrecy preserves it. A history event containing previously secret terms stays secret even if the revised agreement becomes public.

The classifier now receives up to 40 relevant agreement records, including IDs and resolved statuses, in synchronous extraction, deferred extraction, and recovery prompts. Terms are bounded to 400 characters per record. Canonical status remains authoritative; prose is not scanned to decide whether an agreement should be closed.

## Retrieval and UI

- Agreement recall runs as another independently bounded source in the existing parallel retrieval path. It can retrieve closed commitments directly from canon and labels them **historical agreement; no current duty**. Agreement events remain historical evidence.
- Temporal ranking honors `validFromTurn` and `validToTurn`, preserves supersession chains through intermediate revisions, and scopes belief revisions to their owner. Transcript positions are no longer incorrectly treated as world-turn numbers.
- `memory.retrieve` accepts optional `includeHistorical: true` to include former revisions with explicit historical labels. Secret/foreign-story records, removed transcript sources, rejected proposals, and future facts remain excluded under the applicable visibility and validity rules. Candidate counts and final packet budgets remain bounded.
- NPC beliefs carry owner labels and are described as potentially false in both memory packets and the narrator's actor-belief section. This does not infer belief corrections or rewrite the canonical belief table automatically.
- The world drawer and player menu agree on current versus historical status. The player menu has a collapsed Agreement history section; contested commitments remain current. Strategic/world-simulation and wiki consumers use the same current-status predicate. Recognized closed statuses survive the browser projection and wiki import. An unknown server status is no longer silently converted into an active agreement.

## Verification

- Full suite: **128 files, 1,242 tests passed**. Final focused checks: **105 tests passed**.
- Type check: **0 errors, 0 warnings**. Production build passed with the existing bundle-size and mixed-import warnings.
- Real PostgreSQL acceptance after 150 turns: fulfillment, annulment, revision, repeat/late-job rejection, connection restart, historical retrieval, secrecy, and remapped-ID export/import passed. Original terms and agreement/event/source links survived the round trip. No model calls were made.
- Browser acceptance used a disposable campaign. Both world surfaces showed one contested current agreement and three historical agreements with fulfilled, annulled, and superseded statuses. The secret agreement was absent. The player-menu layout was visually inspected. The temporary viewport, tab, server, and database were cleaned up.
- Changes were checked against the pre-work source snapshot; unrelated dirty work was preserved. Snapshot, isolated diff, and verification logs are in `.cache-backups/harness-temporal-slice-20260906/`.

## Runtime status and remaining work

The production build is ready, but **the existing process has not been restarted**. Automatic approval review rejected stopping/restarting verified PID 37292 on port 5173, returning only `blocked by policy`. At the subsequent read-only check, the root UI returned HTTP 200 and `/api/health` returned HTTP 500. The process retains the earlier loaded build and needs a manual restart after the output replacement. Stop the current Mtherios server, then run `npm run app:start` from this checkout. The previous preview process on port 5175 was also left untouched; it is not verification of this release.

Existing campaign records were not batch-corrected or replayed. Rows whose terms describe supersession while their structured status remains active still need an explicit, source-checked correction. Historical ranking relies on recorded metadata and the bounded candidate set; it is not a general detector of contradictions in prose. Scene checkpoints, automated belief/fact reconciliation, and semantic embedding comparisons remain subsequent slices.
