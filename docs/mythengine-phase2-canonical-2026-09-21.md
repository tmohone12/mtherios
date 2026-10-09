# MythEngine Phase 2: canonical workspace integration

Date: 2026-09-21. Implemented in `E:\DEV\Projects\MythEngine`, following the [custom-content slice](mythengine-phase2-2026-09-21.md). Phase 2 remains in progress; this report records the canonical metadata, editing and history-capture milestone.

## Implemented

Characters, locations, items and factions now receive a persistent workspace identity and creation baseline in the same transaction as their canonical record. PostgreSQL triggers capture later source updates regardless of whether they come from World explorer, import, extraction/background code, or direct maintenance SQL. Existing records receive exactly one migration baseline. A record update that does not increment `server_version` still increments its workspace revision, preventing a stale editor from missing that change.

Current payloads stay in `entities` and `factions`. The new `canonical_content` table holds only project/game ownership, finite adapter identity, logical folder/slug, GM-context preference, workspace hiding, source-deletion state and revision. `canonical_content_history` contains historical snapshots of that metadata and the corresponding canonical row. These tables are deliberately separate from custom documents: canonical source fields are never mirrored into a competing editable document payload.

The content workspace now edits canonical names/descriptions, validated partial fields and presentation metadata. Reads obtain the payload and metadata in one repeatable-read transaction. Saves compare a composite token of record version, metadata revision and fixed adapter version 1. They call the existing `patchWorldRecord` owner inside the same transaction, preserving domain checks, evidence references, nested-update behavior, audit rows and projection outbox. Metadata-only edits leave gameplay state unchanged. Canonical record edits followed by metadata edits create two ordered snapshots in one atomic transaction.

Hiding a record changes only catalog browsing. It does not delete or hide the underlying gameplay record. The “Include hidden canonical records” control exposes it again. Underlying source deletion or a type change marks the old catalog target as removed and retains its last snapshot; changing back revives the same catalog identity. Campaign/project deletion still owns the cascade of its catalog and history. In-place changes to canonical record identity/game ownership are rejected, and project ownership constraints block unplanned game moves.

The editor displays retained versions and their snapshots. Workspace edits carry a trusted `client` actor. Source writers without explicit attribution are honestly recorded as `backend_writer / unattributed`; a generic database write is not misrepresented as a human or a specific model. Complete source/run attribution for every writer, restoration of linked domain state, historical restore/approval and retention portability remain Phase 3/12 work.

## Export and import

Campaign exports include `worldDatabase.canonicalContent` in their existing consistent snapshot. It records adapter kind, target ID, folder/slug, context mode and hidden state, while canonical data remains in its existing export tables. Canonical ID remapping also remaps these target references. Import establishes record baselines via the source triggers, then applies metadata in the same campaign transaction. Invalid target/type/path metadata fails the import atomically. Older snapshots without this optional field remain supported.

This exports current catalog metadata, not its entire historical ledger. Standalone custom-content export remains scoped to custom types/documents. No new model tools, prompt-context behavior or provider requests are enabled by this change.

## Owners and commands

- [Migration 0024](../drizzle/0024_canonical_content_history.sql): catalog constraints, atomic source capture and baseline backfill.
- [Contracts](../src/lib/contracts/canonicalContent.ts) and [canonical owner](../src/lib/server/engine/canonicalContent.ts): scoped snapshot reads, composite revision checks, metadata/history and transfer.
- [World-record owner](../src/lib/server/engine/worldRecords.ts): accepts an existing server transaction so canonical workspace edits reuse its validated mutation path.
- [Editor](../src/lib/components/content/CanonicalContentEditor.svelte): canonical editing, stale-save feedback, retained history and unsaved-edit protection.

Commands: `content.canonical` (list/read), `content.canonical.edit` (partial domain/metadata edit), `content.canonical.history` (bounded history). They use the existing UI/CLI/MCP gateway with an explicit project and game. The adapter registry accepts only characters, locations, items and factions. Input cannot supply arbitrary SQL tables or actor authority. The fixed adapter version is not an editable custom type definition.

## Verification

- Type checks: **0 errors, 0 warnings**. Production build passed.
- Focused regression run: **81 tests passed in six files**.
- Full suite: **1,509 / 1,512 passed**. The only failures remain the three baseline-confirmed inherited prompt-budget tests. Report: `data/logs/phase2b-tests.json`.
- A disposable schema containing pre-migration character/faction rows proved truthful baseline backfill. It was removed afterward.
- Ten live fixture checks proved all four creation adapters, direct-writer capture without a version bump, nested-data preservation, hidden-view semantics, project/game isolation, concurrent stale-write rejection, and complete transaction rollback after forced history failure.
- Remapped campaign import preserved folder/context/hide metadata. Source deletion/retyping retained the expected snapshots, and ownership changes were rejected.
- Browser verification saved a canonical name, nested HP update, folder/slug and context preference. The server retained biography and sibling AC. A concurrent database edit caused visible stale-save rejection; reload preserved that edit and displayed all four retained revisions. The final UI also refreshes the saved list label and guards pagination while edits are pending.
- Original Mtherios remains on port 5173; MythEngine uses port 5174 and its separate database. No model request was submitted. All disposable projects and the migration probe were removed.

[Live evidence](evidence/mythengine-overhaul/phase2b-live-verification.json). Database backup before migration: `data/phase2b-before.sql`. Runtime/build logs: `data/logs/phase2b-*`.

## Remaining work

Subsequently, [explicit canonical creation and same-game copying](mythengine-phase2-authoring-2026-09-21.md) were implemented and live-verified. Phase 2 still needs built-in type settings/layout authoring and dependency-aware game/project migration. Ordinary editing and logical moves within a game are now implemented. Empty folders and folder-wide operations remain outstanding. Historical restore, complete per-writer attribution and linked-domain restoration must meet Phase 3's approval and consistency gates before being advertised. The wider overhaul phases remain unchanged.
