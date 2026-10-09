# MythEngine Phase 2: persistent folders and subtree moves

Date: 2026-09-21. Status: **implemented, built and live-verified in the independent MythEngine copy**. Phase 2 and the full overhaul remain in progress.

## Delivered behavior

Project content now has a **Manage folders** editor. Empty folders persist in PostgreSQL and appear in the content tree after reload. Logical ancestors are derived from saved folders, custom documents and canonical metadata. Shared-project and game folders have separate ownership.

Moving a folder requires a preview of its affected descendants and a snapshot token. The move includes archived documents and retained canonical entries whose source rows were deleted. It changes paths, increments metadata/document/folder revisions and records history atomically. It preserves record IDs, payloads, reference targets, source-deleted state and the game's canonical version. Game moves exclude shared documents, and path matching uses whole segments so `Rules` does not move `Ruleset`.

Creating or changing a descendant invalidates an earlier preview. Missing previews, stale snapshots, foreign scopes, moves into the source subtree and destination merging fail without partial writes. The UI clears a preview when its source/destination changes, displays server conflicts and guards scope/navigation while edits or requests are pending.

## Ownership and portability

- [Migration 0026](../drizzle/0026_content_folders.sql) adds `content_folders` and folder revision targets. The isolated database was backed up to `data/phase2e-before.sql` before migration.
- [Folder contracts](../src/lib/contracts/contentFolders.ts) define strict requests and segment-aware paths. [Content server](../src/lib/server/engine/content.ts) owns list/create/preview/move, project locking, history and transfer. Commands are `content.folders.list`, `.create`, `.previewMove` and `.move` with explicit `projectId` and optional `gameId`.
- Create accepts `path`; preview accepts `from` and `to`; move additionally requires the returned `expectedSnapshot`. Paths are logical, bounded to 500 characters, and cannot contain traversal or OS paths. Folder inventory is capped at 5,000 total saved folders/documents/canonical entries per scope and fails explicitly above that bound.
- [Canonical owner](../src/lib/server/engine/canonicalContent.ts) updates metadata through its existing source/envelope locking and history path. Canonical create/copy/edit also take the project lock before mutation.
- [Folder manager](../src/lib/components/content/FolderManager.svelte) and [workspace](../src/lib/components/content/ContentWorkspace.svelte) use the same engine gateway. Large previews display the first 50 entries with the total affected count.

Content snapshots carry optional `folders`, retaining compatibility with older exports. Both shared and game folders transfer; game ownership remaps to the destination game. Existing empty folder paths can be reused during import, while conflicting document/type definitions still abort the transaction. Campaign import/export uses this same owner. Current paths transfer; complete historical-ledger portability remains later work.

## Verification

- 36 focused tests passed across folder, content-validation, canonical-authoring, built-in-type and persistence suites. New folder cases cover segment boundaries, read-only previews, new-child/revision invalidation, required snapshots and destination rejection.
- Svelte/TypeScript reported 0 errors and 0 warnings. Production build passed with the existing Vite chunk/import warnings. No new full-suite claim.
- Seven live checks passed, including archived and source-deleted entries, scope isolation, payload/identity preservation, forced history-failure rollback, content transfer and remapped campaign transfer.
- Browser verification created `Rules/Empty`, confirmed dirty scope protection, previewed and moved it, invalidated a preview by editing its destination, rejected a stale preview after a concurrent folder creation, successfully refreshed the move and verified persistence after reload. Switching to the fixture game excluded the shared folders. The rendered editor was visually checked.
- All disposable projects and temporary failure triggers were removed. The existing user campaign was retained. Browser checks ran in a separate temporary tab; the user's story tab stayed open. No turn/model request was submitted by these checks. Workers remain disabled.
- Activated runtime: port 5174, PID 24256, source `1b5b748e10fdaad3aad6148abe23d1fda1915aa62aeeca7fded91a22d1f876c4`, artifact `af42608126d1baf6236f70e1c41bd5ee02f577b4c51bf542ab91ea08ec0c2bbf`.

[Live/browser evidence](evidence/mythengine-overhaul/phase2e-live-verification.json) · [Scoped changes](evidence/mythengine-overhaul/phase2e-changes.json).

## Remaining work

Canonical schema/default extension and migration, folder-wide copy/archive/restore, and dependency-aware project/game migration remain Phase 2 gaps. Complete history restore and historical transfer, context consumption, research, assistant/tools and subsequent phases remain as described in the [overhaul plan](mythengine-overhaul-plan-2026-09-21.md).
