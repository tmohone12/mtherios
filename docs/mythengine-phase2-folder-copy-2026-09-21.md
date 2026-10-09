# MythEngine Phase 2: folder copies and partial-update preservation

Date: 2026-09-21. Status: **implemented, built and live-verified in the independent MythEngine copy**. Phase 2 and the full overhaul remain in progress.

## Delivered behavior

The existing **Manage folders** editor now offers Move and Copy. Copy requires its own reviewed snapshot and an unused destination within the same project/game scope. Switching operations, source or destination clears the preview. Source documents, folders and canonical rows remain intact.

Copies allocate new document identities before inserting any document. Typed references inside the copied subtree remap to those new identities, including cycles, self-references and nested references. References outside the subtree retain their existing targets and are checked for scope and archive validity before commit. Archived documents remain archived, hidden canonical entries remain hidden, and empty folders persist at the destination. Similarly named sibling folders are excluded.

Canonical copies reuse the existing same-game copy owner. They preserve authored fields and context preferences, strip resolver/import identity and source evidence, and record the source identity/revision in history. They retain links to original world records; this is not a clone of linked domain tables or a campaign migration. Player characters, merged records and deleted canonical sources block the entire folder copy at preview. No subset is silently skipped.

All new documents, canonical records, folder history, game-version changes and outbox jobs share one transaction. A failure at the end rolls back the whole operation. Stale previews and move tokens cannot authorize a copy; simultaneous copies to the same destination produce one success.

## Partial-update correction

The live cyclic-reference check exposed creation defaults materializing inside the partial-update schema. A data-only update reset omitted folder, description, audience and context preference. The [content contract](../src/lib/contracts/content.ts) now unwraps creation defaults before making update fields optional. Omitted fields retain their values; explicit empty strings and null still clear supported fields. This fixes the shared `content.update` path used by all clients. Existing saved records were not rewritten.

## Owners and bounds

- [Content server](../src/lib/server/engine/content.ts): subtree inventory, operation-bound fingerprint, two-pass document identity/reference handling and atomic history. Full snapshot import retains its strict bundle-only reference rule.
- [Canonical owner](../src/lib/server/engine/canonicalContent.ts): shared record-copy persistence, source checks and history.
- [Folder manager](../src/lib/components/content/FolderManager.svelte): operation selector, preview, application and explanation of canonical-copy boundaries.
- Gateway commands: `content.folders.previewCopy` and `content.folders.copy`. Both accept explicit `projectId`, optional `gameId`, `from` and `to`; application also requires the preview's `expectedSnapshot`. Copy returns `itemIds` and `canonicalIds` mappings.

Existing limits remain: 500-character logical paths, at most 5,000 inventory entries per scope, no root/self/descendant destination and no destination merging. Canonical records use their existing field validation. Copies start new local history rather than duplicating the source's historical ledger. No database migration or dependency was added.

## Verification

- 35 focused tests passed across four suites: folder operations, canonical authoring, content validation and persistence. New cases cover operation-bound tokens, stale copy sources, player/deleted-source rejection, and omitted-versus-explicit update fields.
- Svelte/TypeScript: 0 errors and 0 warnings. Production build passed with existing Vite import/chunk warnings. No new full-suite claim.
- Nine live checks passed: partial-update preservation, read-only preview, stale/wrong-operation rejection, late history-failure rollback including jobs/version, cycles/self/nested/external references, archived and hidden copies, canonical identity/provenance, blocked source kinds, concurrent destination writes and strict import regression.
- Browser copied a folder containing a guide, a canonical character and an empty folder. Changing Copy to Move removed the reviewed action. After applying Copy and reloading, both source and destination remained visible. Server verification confirmed new IDs, the copied guide's self-reference, retained biography and empty folder. The rendered explanation and controls were visually checked.
- All disposable fixture projects and failure triggers were removed; the existing user campaign remains. The browser check used a temporary tab and submitted no model/turn request. Workers remain disabled.
- Final runtime: port 5174, PID 60116; source `f7da6def34b2d9d85e69aa5997a86abdde8701717569c4622eb4c947153e53c0`; artifact `2e25d1e3aadfd15da28e4af0f3d5cc9c9247aa85338518cab827fa07a1950b4a`. Rebuilding while the prior process held an older manifest caused a temporary status-route module error; the verified port owner was restarted and all live checks were rerun successfully against this final identity.

[Live/browser evidence](evidence/mythengine-overhaul/phase2f-live-verification.json) · [Scoped changes](evidence/mythengine-overhaul/phase2f-changes.json).

## Remaining work

Phase 2 still needs canonical schema/default extension and migration, folder-wide archive/restore, and dependency-aware project/game migration. Complete history restore and portability, context consumption, research, assistant/tools and later phases remain in the [overhaul plan](mythengine-overhaul-plan-2026-09-21.md).
