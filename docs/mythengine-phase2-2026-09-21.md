# MythEngine Phase 2: custom content workspace

Current status (2026-09-22): **Phase 2 is complete.** See the [completion report](mythengine-phase2-complete-2026-09-22.md). The dated progress and remaining-work statements below describe this initial slice.

Date: 2026-09-21. **Custom-document slice implemented; Phase 2 remains in progress.** Working copy: `E:\DEV\Projects\MythEngine`, branch `codex/mythengine-overhaul`. [Overhaul plan](mythengine-overhaul-plan-2026-09-21.md).

## Available now

The **Project content** workspace creates project-owned types and shared or game-owned documents in PostgreSQL. It includes logical folder groups, paginated search, a schema/default/layout editor, schema impact preview, a generic JSON document editor with rendered field previews, move/copy/archive and confirmed archive recovery. The existing Shelves and World explorer workspaces remain available. Unsaved edits block scope/navigation changes and trigger the browser unload guard.

Types support text, long text, finite numbers, booleans, enums, arrays, nested objects and typed document references (`{ "itemId": "..." }`). Layouts consist only of plain-text sections and field ordering. Unknown fields, executable layout properties, unsafe object keys, oversized payloads and invalid logical paths are rejected. Reference defaults are not supported; assign references on individual documents so ownership is explicit. Defaults apply when creating a document and do not overwrite existing documents after a type edit.

Each write checks the item and type revisions under a project lock, validates the full resulting document and references, and appends its revision snapshot in the same transaction. Partial object updates merge recursively; arrays replace. Type changes preview incompatible documents and refuse the save until those conflicts are resolved. A failed history write rolls back the document and its revision. Incoming active references prevent archive; archive retains identity and history. Recovery requires explicit confirmation and rechecks revision, schema, references and path conflicts. Full historical restore and clearing an existing type layout remain Phase 3 work.

Shared documents are readable alongside the selected game's documents. Editing a shared document requires selecting the shared project scope. Project documents cannot refer into a game, and one game cannot refer into another. Database foreign keys enforce type/project/game ownership. Local UI/CLI/MCP authoring is attributed to `client`; these commands do not grant a model authority or enable the future tool dispatcher. Audience and GM-context preferences are stored independently. **They are not yet consumed by GM prompts or model tools.**

Characters, locations, items and factions can be browsed through read-only, scoped views of their existing canonical owners. No duplicate character/location/faction payloads are created. Their domain editors remain in World explorer.

The fresh default project contains Gear and Rules example types, an Example travel cloak document and an Example table rules document. These were created and verified in the browser; they are sample authoring content, not an imported campaign.

## Gateway and storage

Migration [0023_authored_content.sql](../drizzle/0023_authored_content.sql) adds `content_types`, `content_items` and `content_revisions`. The [content owner](../src/lib/server/engine/content.ts), [contracts](../src/lib/contracts/content.ts) and [validation](../src/lib/server/engine/contentValidation.ts) serve all clients through the engine gateway.

| Command | Purpose |
| --- | --- |
| `content.types.list`, `.preview`, `.save` | Read definitions; preview compatibility; create or revision-check a type edit |
| `content.list`, `.read` | Paginated literal text search/list and batch reads of up to 50 IDs |
| `content.write`, `.update` | Create/full authored replacement or nested partial updates |
| `content.organize` | Move, copy, archive or confirmed restore; stable identity except copy |
| `content.canonical` | Read existing domain records for an explicit selected game |
| `content.export`, `.import` | Consistent custom-content snapshot and transactional remapped import |

Use `storyId: "__app__"` with explicit `projectId` and optional `gameId`; a game envelope must match the requested game. The generic `mythengine_engine_command` MCP tool and `app:engine command` CLI use the same contracts.

```powershell
npm run app:engine -- command --story __app__ --command content.list --args '{"projectId":"shelf_default"}' --json
```

Exports contain scoped shared/game documents, types, layout/defaults, audience/context settings, archived state and typed references. Imports allocate new content identities and remap references, including forward/cyclic references. Compatible destination type definitions may be reused; conflicting definitions or paths reject the entire import. A fresh destination project is the simple full-copy path. Custom-content IDs always remap; canonical campaign `preserveIds` retains its existing separate semantics. Import creates an attributed baseline, not fabricated historical edits. Historical revision transfer remains Phase 3/12 work.

Normal campaign exports now include `authoredContent` inside the same read-only repeatable-read snapshot. Canonical bundle imports write that content in the same transaction as the campaign, so content conflicts roll back the campaign too. Existing bundles without authored content still parse. Shared content is included in a campaign's snapshot; importing into an already-populated project can require resolving shared-path conflicts first.

## Verification

- Type checks: **0 errors, 0 warnings**. Production build passed.
- Focused regression run: **121 tests passed in seven files** (content validation, canonical persistence/import, gateway, world-record editor, MCP and workspace behavior).
- Live disposable fixtures passed nested-data preservation, concurrent revision conflicts, project/game isolation, type impact/stale type checks, stable moves/fresh copies, reference-aware archive, confirmed recovery, remapped content and campaign imports, canonical read views, HTTP/CLI/MCP parity, forced history-failure rollback and database ownership constraints.
- Browser: created Gear/Rules types; previewed layout; saw a missing-layout-field error; saved both example documents; checked the unsaved navigation guard and persistence after a full reload. Archive/recovery was also exercised through the visible controls.
- Original Mtherios remained on port 5173; MythEngine uses port 5174 and its own database on 5433. No provider request was sent. Disposable verification projects were removed; only the two documented examples remain.

[Live evidence](evidence/mythengine-overhaul/phase2-live-verification.json). Build log: `data/logs/phase2-build.log`. Final full-suite run: **1,505 / 1,508 passed**. Its only three failures are the previously baseline-confirmed inherited prompt-budget tests. The report is `data/logs/phase2-tests.json`; this overhaul has not fixed those failures.

## Subsequent canonical milestone

[Canonical workspace integration](mythengine-phase2-canonical-2026-09-21.md) now implements persistent canonical metadata, source-row baseline/history capture, composite-revision editing, history browsing and remapped metadata import. The remaining-work list below records the earlier slice; use the newer report for current status.

## Remaining Phase 2 work at this initial slice

Persistent built-in content envelopes and baseline history must be established atomically for every canonical creation/import writer before advertising full cross-writer history. Built-in folder/context metadata and composite item/type/canonical revision tokens, adapter-aware writes/copies, dependency-aware game/project migration and complete export of those envelopes remain outstanding. The current canonical tab is a read-only view, not that completed adapter layer. Folder groups currently represent document paths; empty-folder records and folder-wide operations are not implemented. The generic editor is functional JSON plus preview; richer field controls can build on its existing schema.

Phases 3–12 (full history, prompt context, durable tools, Research, interactions/dice, Assistant, batch helpers, images/names, maps and final qualification) remain planned. This slice does not complete the overhaul.
