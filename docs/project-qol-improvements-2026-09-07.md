# Project usability and reliability pass — 7 September 2026

## Goal and plan

Scan the existing project, prioritize reproducible problems in everyday use, implement a bounded batch of improvements, and qualify the result in the actual browser and runtime. Preserve the extensive existing worktree changes and campaign canon.

1. Establish runtime health, inspect the dirty worktree and run the full baseline suite.
2. Inspect the library, World Explorer, reader/action controls, settings and runtime recovery paths.
3. Fix lost drafts, incorrect persistence, stale asynchronous results and difficult navigation using existing services.
4. Run regression tests and typechecking, build outside the active runtime, and exercise desktop/mobile controls against a disposable story.
5. Activate the qualified build when the runtime is idle, remove the disposable data and record remaining findings.

## Implemented findings

| Area | Verified problem | Result |
| --- | --- | --- |
| Story controls | Title changed only in browser cache; title, setting and preamble saved separately. A failed request could leave the form without feedback. | One canonical update saves all three fields before updating the cache. Duplicate saves are blocked; failures retain the draft with an inline error. Late success or failure cannot replace another active story. The preamble has an accessible name. |
| Lore drafts | The sidebar, New story and reader tabs could unmount a dirty World Explorer, bypassing its internal navigation guards. | Both containing workspaces keep the editor mounted and explain that changes must be saved or discarded. Location hierarchy/lore drafts and pending saves participate. Browser reload/close receives a before-unload guard. |
| Location and evidence navigation | Opening a parent, child or evidence record replaced the list with one row and offered no return path. An old error could remain visible. | Back returns to the previous record, including across categories. All entries restores category browsing; clicking the current category also exits the focused record. History is bounded and does not cross stories; failed navigation retains the return path. |
| Library chronology | Refreshing an existing cached story replaced its update time with `Date.now()`. Refresh order could determine the “latest” story. | Cached and returned records retain canonical creation/update times. Ordinary local edits still receive a current timestamp when no timestamp is supplied. |
| Library search/recovery | Search was limited to one shelf. Slow requests could overwrite a newer shelf selection; cached fallback looked like fresh data. | This shelf / All shelves search, shelf labels on cross-shelf results, loading feedback, explicit cached-result warnings and Retry. Outdated/unmounted requests cannot replace current results. Search/scope/sort controls wrap on mobile. |
| Provider models | A late model-list or connection-test response could populate another provider's editor or persist an old active profile's list. | Results are tied to the request, provider and credentials. Active/editor loading states are independent; provider changes and closing settings invalidate pending work. |
| Reader input and export | Enter during IME composition could submit a turn. Held Enter could repeat submission. Export failures were console-only. | Composition and repeated-key events do not submit; desktop/mobile newline shortcuts remain unchanged. Export failures appear in the reader, including the Lore tab. |

No dependency, schema migration, narrator generation or campaign lore repair was needed for this pass.

## Qualification

- Baseline: **134 test files / 1,312 tests passed**.
- Final: **137 test files / 1,341 tests passed**, including 29 added regression cases.
- `npm run check`: **0 errors, 0 warnings**.
- Isolated production build: successful in `E:\DEV\Builds\mtherios-qol-20260907`. Existing bundle-size and mixed-import build notices remain.
- Scoped whitespace check passed.
- Browser: cross-shelf search, story controls save, multiline action draft, reader/outer-workspace draft protection, hierarchy save, parent → Back → All entries, provider-editor switching, and 393 × 852 mobile library/lore layouts.
- Connection recovery: stopped only the preview server on port 5174. The library displayed cached results with a warning and Retry; restarting that server and retrying cleared the warning. The main runtime remained running during this test.
- Disposable story: `story_4773fe1f-e786-4501-b347-6d7e2f4d9de2`, with Port Alder and Harbor Market. Canonical revision 2 contains the browser-saved title, description and preamble together. Subsequent fixture revisions exercise containment. No provider-backed turns were generated.

Detailed logs and receipts are in `output/project-qol-20260907/`. The pre-existing tracked worktree diff is preserved there as `baseline.patch`, with the original status in `baseline-status.txt`.

## Remaining findings

- The main runtime already had failed background jobs. Its count reached 150 while the previous production build was still active; this batch does not retry historical provider work or change job leases.
- Provider-profile saving still uses several persistence calls; it merits the same atomic-save/error-handling treatment in a separate settings pass. The fixes here cover model discovery and connection-test ownership.
- The library's hero can briefly show the new-story invitation during its initial load. The collection itself now distinguishes loading, unavailable, cached and empty results.
- The mobile checks used a browser viewport override, not a physical iPhone keyboard.

## Activation status

The disposable story and its canon were purged through the existing story-delete gateway, after checking its exact ID, title and test role. The canonical listing confirms its removal; `fixture-cleanup.json` records the receipt. Cross-shelf chronology was verified again on the final build: the newly edited Port Alder fixture became the Continue story choice.

The qualified build is **active at http://127.0.0.1:5173**, served by PID **4764**. The previous runtime was idle with zero ready/running jobs before restart. Its complete 287-file build was copied into `output/runtime-backups/qol-before-20260907/build` and verified byte-for-byte before activation. Qualified files were then copied into the existing production build without removing directories or old assets. This safer sequence succeeded after automatic review rejected the earlier combined directory-move command; no additional user authorization was needed.

All **287 qualified build files** match the activated files, and all nine changed production sources match the qualified build source. `/api/health` is healthy; jobs remain at zero ready/running and the same 150 historical failures. The final production browser loads the new Search scope control, finds **Volantis: Black Walls Intrigue** across shelves, retains the correct latest-story choice, and reports no browser console errors. The temporary port-5174 qualification server is stopped.

Receipts: `activation.json`, `rollback-integrity.json`, `live-runtime-receipt.json` and `completion-audit.json` under `output/project-qol-20260907/`. The staged qualified build is retained there for reference. Implementation, qualification, cleanup and live activation are complete.
