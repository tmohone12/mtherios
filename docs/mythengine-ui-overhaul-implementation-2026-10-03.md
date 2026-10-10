# MythEngine UI overhaul — 2026-10-03

The newer checkout now has a cohesive story-first interface: a quieter reading surface, a direct tool rail and focus mode, a Continue story library landing, a responsive Assistant, and grouped runtime settings. Existing Pi/Jev/canon/knowledge behavior, provider selection, security configuration, and background settings were preserved.

## Implementation

- Story: desktop navigation for Story, World lore, Chapters, Characters, Assistant, Settings, and Library; mobile tabs and accessible actions; dedicated reading width and scene context; visible saved-run, question, recovery, and Stop states.
- Library: latest-story hero across shelves, concise shelf cards, direct new-story/import actions, clear loading/empty/error states, and preserved archive/restore/repair capabilities.
- Assistant: side-by-side desktop layout and modal mobile layout, clear scope, saved conversations, persistent run status, pinned composer, and keyboard focus handling.
- Settings: grouped sections, separate runtime/GM/Assistant/image preferences, inherited versus saved state, explanatory labels, and saved feedback. No provider/model changes were made to real configuration.
- Navigation: URL-backed workspace/story tabs, Back/Forward and reload restoration, guards for dirty authoring/provider controls, and generation checks that prevent late story loads from replacing the current story.

Sixteen source/test files were promoted with before/after hashes and recoverable source copies. Existing uncommitted implementation was retained. No dependencies were added.

## Verification

- 254 tests passed across 31 selected relevant files; no failures or skips in that selected suite. The entire repository suite was not run.
- Svelte typecheck: 0 errors, 0 warnings.
- Production build succeeded. Existing Vite mixed-import and bundle-size notices remain.
- Tested source: `d0525c7fddf6f6bde40f18411e08182ec6f28b03dfae67f0c7d7f5bb72797657`.
- Tested artifact: `603482dd77b82d866c50a9263f08ebec57c980ac1662a97556d3ae7e495c7c9a`.

Production-browser tests used an isolated Playwright Chrome profile on RaijinAi at port 5274, a disposable PostgreSQL database, synthetic campaign data, and a local mock provider. The user's ordinary browser was not controlled. No real campaign was advanced and testing incurred no paid provider calls.

Covered Story dependent lookups, question/restart/reload/resume, repeated answer, actual CLI/MCP replay with no repeated tools, Assistant sources, successful edits, stale-edit rejection, Story and Assistant delayed cancellation/reload with no late publication, navigation history, dirty-editor guards, focus mode, keyboard focus traps/Escape, saved preferences restored after testing, and Library actions. Responsive checks passed at 390×844, 768×900, 1024×740, 1440×620, and 1440×1000. Screenshots were visually reviewed.

Three existing WorldExplorer assertions had become stale after prior implementation; they were narrowed/updated to the existing canonical/manual/preview semantics. Source equality confirmed those implementation files were not changed by this overhaul. Added regression coverage verifies generation guards and navigation state. Browser test harness URL/summary-selector/resize timing mistakes were corrected; no application JS error was observed. Connection resets were expected during owned test-server restarts.

Supporting receipts: `ui-qa-summary.json`, `output/ui-final-tests.log`, `output/ui-final-check.log`, `output/ui-final-build.log`, `ui-smoke-replay-evidence.json`, and the disposable run's cancellation and Assistant-edit receipts.

## Visual deliverables

All screenshots use synthetic story text. Ten native Library files were saved successfully; exact IDs and metadata are in `.library-delivery-20261003/all-10-screenshot-receipts.json`.

| View | Before Library ID | After Library ID |
| --- | --- | --- |
| Story desktop | libfile_36dfe3c2b41c81919f90d328a0a4c770 | libfile_9921d3a10d788191b03195ba39a63f10 |
| Story mobile | libfile_59625a6946f08191b4e37cada15d8d90 | libfile_5d3cd856bae08191b6b5696bccc47edd |
| Assistant desktop | — | libfile_f3f9ed15ed148191b0d47bc7e7b50bdb |
| Assistant mobile | — | libfile_bc0105665a5c819195489922b33f1b41 |
| Settings desktop | — | libfile_94f721bca57c819190b72b7e828f9d5a |
| Settings mobile | — | libfile_b6cc2d23ec2881919a8d58bebf65105c |
| Library desktop | — | libfile_bf1edbaf26508191b7a22e8a647e98b6 |
| Library mobile | — | libfile_b2a811a5ced08191926d9c68363edd3a |

## Data and deployment

The original port 5173 database is authoritative. At initial inventory its latest campaign had 349 turns / 726 entries versus 265 turns / 548 entries in the test copy. The test copy also contains many fixtures and older model preferences. Do not replace the original database/settings with the test copy.

The intended deployment runs the newer tested build on the existing 5173 origin with the original configuration, database, data root, vaults, and secret references in place. This retains browser-origin drafts/settings. The original checkout/build stays available for rollback. No public hosting or remote push is involved.

Both database archive restores passed exact snapshot-digest verification in the online backup. Ongoing live vault writes invalidated the first full tree comparison; that partial backup must not be represented as an activation-ready coherent backup. The final deployment receipt records the final consistent backup and actual outcome separately.

Deployment completed at **2026-10-03 01:34:36 UTC**. The original process was stopped only after two immediate checks showed zero active Story, Assistant, and background jobs. A final original database archive was restored and compared against the exact snapshot. Stable file manifests cover 32,676 vault files. All existing canonical/settings tables matched their pre-migration counts and digests before startup; only additive migration 0048_source_mounts.sql was applied.

The tested UI is now live at **http://127.0.0.1:5173**, PID **31760**, from the newer checkout. Health reports database `mythengine` with 61 tables; the data/vault root remains `E:\DEV\Projects\MythEngine\data`. The original 14 stories, 8 shelves, and 13,414 story entries were retained. AI service settings matched their final-backup digest. Existing workers remain enabled with their existing `all` scope; this was not enabled by UI testing or deployment.

The final read-only live browser check passed in a separate isolated Chrome profile: Library → existing campaign → Assistant → Agent Tools → Chapters/Back → mobile → reload → Library. No Story turn or Assistant message was submitted. The fresh profile's onboarding was dismissed locally. The user's normal browser profile was not touched. Existing users can refresh their current 5173 tab; the app-shell Reload control was also tested during QA.

Use **`E:\DEV\Projects\MythEngine-copy-20261001-183000\Start-Live.cmd`** for this release. Its guarded launcher uses the original configuration/data and opens 5173. It was verified to recognize the already-running release without a duplicate launch. Keep the task workspace and its release scripts/backup records in place because the shortcut references them. The original checkout and its old launcher remain available for rollback; port 5174 remains the unchanged separate test-copy process with older test data.

Backup root: `C:\Users\Raijin\Documents\Codex\2026-10-02\task-3\ui-release-backups\20261003010305`.

Final activation and rollback record: `cutover-20261003012918\ui-activation.json` inside that backup root. The final restore-verified archive is `original-final.dump` in the same subfolder (SHA256 `1A75DFAD071D6BA9317672EF5EEA4DB4D6563A984B80AE3701A8D693AB7E8F3A`). File manifests reference the verified baseline plus final deltas. Do not delete either while retaining this rollback point.

For rollback, run the workspace `Rollback-MythEngineUiRelease.ps1 -ActivationManifest <full activation record path>` after active work is idle. It validates the current release and original build before switching, keeps the current database in place, and does not remove the additive source_mounts table. This preserves play saved after deployment. Rollback was reviewed and its guards checked; an actual rollback was not performed because the release passed verification.

Final evidence: `output/ui-live-status.json`, `output/ui-live-browser-receipt.json`, the activation record and final database/file manifests. The disposable mock app, labeled database container and temporary files were removed after 31 local mock requests; durable receipts remain. No public deployment or remote push occurred. No remaining deployment blocker.
