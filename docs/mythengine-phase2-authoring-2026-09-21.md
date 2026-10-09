# MythEngine Phase 2: canonical creation and copying

Date: 2026-09-21. Implemented and live-verified in the independent MythEngine clone. This extends the [canonical metadata/edit/history milestone](mythengine-phase2-canonical-2026-09-21.md); it does not complete Phase 2 or the overhaul.

## Behavior

The content workspace can now create characters, locations, items and factions with explicit new identities. Select a game, choose Record kind, and use **New canonical record**. Names, descriptions (for entity records), extra validated fields and folder/context metadata save together. Same-name creation deliberately creates a separate record; it cannot overwrite or merge a resolved identity. Empty names, unsupported fields, invalid references and conflicting folder/slug paths fail atomically.

Open an existing record and use **Copy canonical record** to choose a new name and folder/slug within the same game. The source's composite revision is checked under its row lock. The copy receives a fresh canonical ID, catalog ID, creation history and audit trail. Source payload/history remain unchanged. Context and hidden preferences follow the copy; an inherited hidden record remains accessible through Include hidden canonical records.

Copying is a single-record authoring operation. It preserves editable row fields, nested data and valid same-game references. It does not clone relationship rows, location containment/lore, aliases, faction side tables or source evidence arrays. A faction copy has no reused backing entity identity. Resolver/import identity metadata, pending activation metadata and resolved-proposal links are removed, including their legacy metadata wrapper; other authored metadata survives. The new catalog revision and state-patch reason link to the source identity and revision. Player-character and merged-record copies are rejected with an explanation. Cross-game/project copies require the later dependency-aware migration workflow.

The editor protects unsaved create/copy forms during scope changes, disables close/navigation while a request is pending, preserves the copy form after an error, and opens the successfully created record. Copies use the existing partial-update editor and retained-history display.

## Shared implementation

- [Contracts](../src/lib/contracts/canonicalContent.ts): strict create/copy requests, explicit project/game/kind, source revision and destination path; caller-supplied identity/authority and cross-game targets are rejected.
- [Canonical owner](../src/lib/server/engine/canonicalContent.ts): scope, locked source snapshot, copy-field policy and metadata in one transaction.
- [World-record owner](../src/lib/server/engine/worldRecords.ts): explicit identity creation followed by its existing validated patch, reference checks, audit and outbox in the same transaction. Entity name aliases use the database normalization rule and omit empty normalized aliases.
- [Editor](../src/lib/components/content/CanonicalContentEditor.svelte) and [workspace](../src/lib/components/content/ContentWorkspace.svelte): visible create/copy controls through the shared gateway.

Commands: `content.canonical.create` accepts `{projectId,gameId,kind,fields,metadata?}`; fields require a name and use the world-record adapter's editable keys. `content.canonical.copy` accepts `{projectId,gameId,kind,id,expected,name,metadata:{folder,slug}}`. Both return the existing canonical view and composite revision. CLI/MCP use the same engine gateway; model-role tool dispatch remains a later phase.

No migration or dependency was added. Creation produces a baseline row snapshot, validated field-update snapshot, and an optional workspace metadata snapshot in one transaction. A failed step commits none of them. History restoration remains disabled.

## Verification

- 76 focused tests passed across canonical content, world records and command gateway suites. Added coverage checks strict authority/destination boundaries, copied-data independence, retained legacy authoring, player guards, faction backing identity and stale/project denial.
- Svelte/TypeScript: 0 errors and 0 warnings. Production build passed. No new full-suite claim: the preceding milestone recorded three inherited prompt-budget failures.
- Nine live checks covered all four kinds, same-name/new identities, non-Latin aliases, scope and revision rejection, invalid input/path rollback, player-copy rejection, forced late-history rollback, concurrent same-path creation, canonical reads and campaign export.
- Browser created Seren with biography/HP/AC, showed a duplicate-path error without losing the copy form, then created a distinct copy. Editing its HP to 4 retained AC 16 and biography; the original still had HP 12. The copy displayed its own four revisions and source-linked creation reason. Busy close and unsaved scope controls were verified in the rendered UI.
- All disposable projects and temporary failure triggers were removed. The original checkout/runtime are unchanged; jobs remain disabled and no provider request was submitted.

See [live and browser evidence](evidence/mythengine-overhaul/phase2c-live-verification.json) and [scoped change manifest](evidence/mythengine-overhaul/phase2c-changes.json).

## Remaining Phase 2 work

[Built-in layouts and context defaults](mythengine-phase2-types-2026-09-21.md) were subsequently implemented. Canonical schema/default extensions, dependency-aware game/project migration, empty folders and folder-wide operations remain open. Canonical payload adapters remain fixed at version 1. Complete historical restoration/attribution and model consumption of context preferences are later phases, not implied by these authoring controls.
