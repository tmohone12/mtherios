# MythEngine Phase 2: built-in layouts and context defaults

Date: 2026-09-21. Implemented and live-verified in `E:\DEV\Projects\MythEngine`, following [canonical authoring](mythengine-phase2-authoring-2026-09-21.md). Phase 2 remains in progress.

## Delivered behavior

Project content now exposes layout/settings editors for characters, locations, items and factions, including projects with no games. Each project can customize section headings, field labels/order and nested display paths, and set the type's default GM-context preference. Preview uses clearly identified sample values; the canonical record editor renders the saved layout with that record's actual values. A record without an explicit context override displays its current type default.

Layouts display escaped plain text and structured JSON. The finite adapter controls allowed roots; nested paths are available only beneath state, metadata and faction resources. Unknown roots, unsafe property names, duplicate fields, excessive depth and excessive field counts are rejected. A missing nested field displays a dash. Layout changes never rename, remove, migrate or rewrite canonical payload fields.

These are presentation settings and saved context preferences. The canonical domain schemas, validation, data owners and adapter version remain fixed. Custom document types still own their existing editable schemas/defaults. Extending canonical schemas/defaults requires a separate explicit migration design. GM prompt consumption/invalidation/receipts remain Phase 4 work; the preference label is not evidence of a changed model request.

## Revision and clear behavior

Untouched built-in types read as revision 0 with deterministic defaults, without creating database rows. The first save captures that default baseline and the authored revision in one transaction. Project locking and expected revisions reject stale/concurrent changes. History writes are atomic with the setting update and attributed to the local client. The visible history shows the latest 30 retained revisions; historical restore is not enabled.

Clearing a nonempty built-in layout first presents the exact type, current revision and resulting context preference. Confirming submits that captured definition/revision; changing the draft invalidates the review. A stale confirmation fails and preserves the later save. Clearing affects the display layout, leaves all canonical fields intact, and appends a new history revision. Custom-type layout clearing remains under the existing Phase 3 gate.

## Ownership and portability

- [Migration 0025](../drizzle/0025_canonical_type_settings.sql) adds project-owned `canonical_type_settings` and `canonical_type_history`; existing domain tables are unchanged. Backup: `data/phase2d-before.sql`.
- [Contracts and safe layout lookup](../src/lib/contracts/canonicalTypes.ts) define the finite kinds, bounded paths and defaults.
- [Server owner](../src/lib/server/engine/canonicalTypes.ts) implements read/preview/save/history and transfer. Gateway commands are `content.canonicalTypes.read`, `.preview`, `.save`, and `.history`, with explicit `projectId` and `kind`. Saves/previews also require `expectedRevision` and `definition`; clear saves require `confirmedClear`.
- [Type editor](../src/lib/components/content/CanonicalTypeEditor.svelte) and [layout renderer](../src/lib/components/content/CanonicalLayout.svelte) serve the workspace and canonical record editor.

The existing content snapshot carries optional `canonicalTypes`, so older snapshots still import. Campaign snapshots include those definitions in their existing repeatable-read export. Import recreates current settings with a new local baseline/history in the destination project. Equivalent saved definitions are accepted without a redundant revision; conflicting definitions abort the whole transaction instead of overwriting project preferences. This transfers current definitions, not their complete historical ledger. No credentials or provider requests are involved.

## Verification

- 85 focused tests passed across six contract/engine/import/persistence suites. New tests cover path/authority/scope boundaries, own-property lookup, default reads, stale revisions, confirmation gating and history failure propagation.
- Svelte/TypeScript: 0 errors and 0 warnings. Production build passed and was activated on port 5174. No new full-suite claim; earlier evidence records three inherited prompt-budget failures.
- Eight live checks covered nonmutating reads/previews, attributed baseline/save history, unchanged canonical rows/game version, invalid/stale requests, stale clear confirmation, concurrent writers, forced history rollback, content transfer/conflict handling and remapped campaign transfer.
- Browser saved and reloaded a character layout showing nested HP and biography. The canonical editor displayed HP 12 and the original biography under the saved labels, plus the inherited Partial preference. Invalid paths showed a visible error. A concurrent save made the pending clear stale; confirmation failed, reload retained the new Pinned preference and original layout, and a newly reviewed clear succeeded at revision 3. History displayed revisions 3, 2, 1 and the default baseline 0.
- Server verification confirmed the browser fixture's canonical record and workspace revisions remained 1, its HP/AC/biography were unchanged, and its explicit context override remained null. All disposable projects and failure triggers were removed. Original checkout/runtime remain unchanged; jobs stay disabled.

[Live/browser evidence](evidence/mythengine-overhaul/phase2d-live-verification.json) · [Scoped changes](evidence/mythengine-overhaul/phase2d-changes.json).

## Remaining work

Phase 2 still includes canonical schema/default extension and migration, empty folders and folder-wide operations, and dependency-aware game/project migration. Complete restore, historical portability and model integration remain later phases. The presentation editor does not complete those gates.
