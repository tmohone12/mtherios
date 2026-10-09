# MythEngine Phase 2g: folder archive and recovery

Date: 2026-09-22. Status: **Implemented, built and live-verified in the independent MythEngine clone. Phase 2 and the full overhaul remain in progress.**

## Behavior

- Manage folders now offers Archive and Restore with mandatory previews, affected counts, per-record details and explicit apply controls. Reviewed work protects project/game selection until applied or discarded.
- Archive marks active custom documents read-only and hides live, visible canonical entries from the workspace. It never deletes canonical records, changes a game version or removes accepted gameplay context. Previously archived documents, hidden/deleted canonical entries and separately archived child trees are untouched.
- An inferred folder gets a saved root. The root stores a recovery receipt identifying exactly the documents, canonical metadata and saved child folders changed by that archive, together with their archived revisions. Every change and the receipt have retained revision history.
- Restore uses that receipt. It skips records changed since the archive and explicitly lists them in the preview. It never replaces later payloads, moves records back or restores earlier archives. Unchanged internal reference cycles recover together. Current type validation, unreadable/archived outside references and occupied active paths can block recovery before any changes.
- Project locking serializes authoring operations. Preview fingerprints bind operation, scope, current root and affected records. Canonical writes additionally lock source records before metadata and check revision again. A stale preview or late history failure leaves no partial operation.
- Default tree lists active folder paths; Include archived and the folder manager retain access to archived paths. Restore archived folder trees before moving or copying them. New content may still be authored under an archived path; it remains active and is outside the prior recovery receipt.

## Transfer boundary

Content and campaign bundles retain folder archive flags as an optional backward-compatible field. Custom document archives and canonical hidden metadata retain their existing transfer paths. Conflicting destination folder archive state rejects import rather than changing existing state.

**Batch recovery receipts stay in their original scope.** Imported archived folders have no receipt and the recovery preview explicitly says that it restores folder paths only. Archived imported documents use their individual recovery flow. Portable receipts, including dependency/identity remapping across custom and canonical records, remain a Phase 2 transfer task. No imported archive is silently unarchived.

## Verification

- 42 focused tests across content-folder archive, folders, canonical authoring, content validation and canonical persistence passed.
- **npm run check**: zero errors and zero warnings. **npm run build**: passed, with existing bundling advisories.
- Backed up the isolated database to **data/phase2g-before.sql** before applying migration 0027. Original database and services were not targeted. The original service was already PID 53564. Five original-checkout files differ from the initial clone manifest (portrait/character work timestamped 03:16–03:18 UTC, before this milestone); they were preserved and recorded as existing drift, not overwritten.
- Replaced only the verified MythEngine listener on port 5174. Running PID **59600**, source build **19e79c89375bcaa60157413ef3339ee14b0ca775d0aca6bfb3ec965eb64a29fb**, artifact **1bbb5f42efdc121af270862943ae346a2b37673b45e9b61ff0731f4926b6df7d**.
- Eight live fixture checks passed: read-only/scope-aware preview; outside incoming-reference rejection; stale preview and injected late-history rollback; canonical/shared/pre-existing archive preservation; export/import archive preservation and disclosed recovery limit; cycle/empty-folder/exact-receipt recovery; later-edit protection and occupied-path rejection; concurrent archive applied once.
- Browser: selected a disposable game, reviewed and applied Archive, confirmed tree removal and saved server flags, reloaded, previewed and applied Restore, then reloaded again. The document and empty folder returned; the canonical NPC appeared in the default visible list. All disposable projects were removed; the existing user campaign retained its ID and server version.
- [Live evidence](evidence/mythengine-overhaul/phase2g-live-verification.json) records the runtime, checks and browser observations. [Scoped changes](evidence/mythengine-overhaul/phase2g-changes.json) records pre/post hashes, whitespace checks, documentation links and original-checkout protection. Reproduction helpers: [live checks](evidence/mythengine-overhaul/phase2g-verify-live.mjs) and [browser fixture](evidence/mythengine-overhaul/phase2g-browser-fixture.mjs). They target the isolated local runtime and create/remove explicitly tracked disposable fixtures.

## Remaining work

Continue the [overhaul plan](mythengine-overhaul-plan-2026-09-21.md): portable archive receipts, canonical schema/default extension and dependency-aware project migration; then the remaining history/context/tool/Assistant phases. This milestone does not qualify provider generation or claim a clean full test suite. The three inherited prompt-budget failures remain documented in the earlier reports.
