# MythEngine Phase 2 completion

Date: 2026-09-22. **Phase 2 is complete in the isolated MythEngine working copy.** Branch: `codex/mythengine-overhaul`. [Overhaul plan](mythengine-overhaul-plan-2026-09-21.md). Phases 3–12 remain planned.

## Final capabilities

Built-in character, location, item and faction types accept embedded extension schemas, defaults and layouts. Values live in `metadata.contentFields`; canonical domain fields retain their existing owners. The type editor previews incompatible records and offers a reviewed missing-default migration. Apply checks the preview snapshot and record revisions, fills missing values without replacing authored values, and writes type/record history atomically. New canonical records receive defaults. The record editor can replace or remove optional extension values without losing other metadata. UI, CLI and MCP share these canonical reads/writes.

Folder archive recovery receipts now travel with snapshots. Imports reconstruct eligible members against the imported IDs and revisions. Full campaign transfer supplies the explicit canonical ID mapping; custom-only content transfers reject canonical recovery members rather than guessing their identities. Existing archives and later-edited records retain the earlier recovery rules. Imported receipts cannot claim pre-existing destination folders or folders absent from their bundle.

The game workspace offers **Move game** with a destination, dependency preview and optional shared-document selection. It follows the transitive typed references, copies required/selected shared content with new IDs, remaps those references and keeps game-owned document/canonical/game IDs. Ownership, history, jobs, archive receipts and the projection outbox move in one transaction. Conflicting types or paths, changed previews, explicit unresolved cross-game associations and running work prevent the move. The review explains that destination settings and shared content apply afterward.

## Acceptance evidence

| Phase 2 gate | Evidence |
| --- | --- |
| Project/game scope, custom Gear and Rules, nested updates, stale saves, type/layout validation | [Initial custom workspace](mythengine-phase2-2026-09-21.md), [canonical integration](mythengine-phase2-canonical-2026-09-21.md), [authoring](mythengine-phase2-authoring-2026-09-21.md) |
| Built-in layouts and context settings; empty folders and subtree moves | [Type settings](mythengine-phase2-types-2026-09-21.md), [folders](mythengine-phase2-folders-2026-09-21.md) |
| Folder copy references, archive/recovery and later-edit protection | [Folder copying](mythengine-phase2-folder-copy-2026-09-21.md), [archive/recovery](mythengine-phase2-folder-archive-2026-09-22.md) |
| Canonical schema/default migration, preserved data, CLI/MCP parity | Final live checks 1–3 and browser checks in [verification evidence](evidence/mythengine-overhaul/phase2h-live-verification.json) |
| Remapped campaign and shared-content receipt transfer, hostile receipt rollback | Final live checks 4–7 in the same evidence |
| Dependency closure, conflicts, stale review, atomic rollback, IDs/references/history/jobs and post-move recovery | Final live checks 8–11; browser move with optional shared content and persistence after reload |

The final verification created disposable projects, including cyclic document references and a mixed canonical/custom archived subtree. A fixture-scoped late audit failure proved that game migration rolls back ownership, copies and revisions. Fixtures and the failure trigger were removed. The user campaign **The Journey** remained at server version **1249**; its ID and version were checked before and after. The two existing default-project examples remain active.

The browser showed the required-field conflict, applied reviewed defaults, saved a custom field, rendered it in the layout, invalidated the move review after selection changed, and retained the result after reload. Browser verification used source build `e7a373318a5c`; only server/import-test hardening followed it. All eleven live API scenarios were repeated on the final build.

## Verification and runtime

- `npm run check`: **0 errors, 0 warnings**.
- `npm run build`: **passed**, including the artifact fingerprint.
- `npm test`: **1,552 passed; 3 inherited failures**, across 158 files (157 passed). The failures are the existing promptHarness chapter/arc budget expectations: “retains all nine full chapters while they await the next arc,” “omits an arc that cannot fit whole and reports the missing history,” and “budgets rendered arc memory while retaining the newest covered chapter.” They remain unresolved; the suite is not fully green. [Test summary](evidence/mythengine-overhaul/phase2h-test-summary.json).
- Final live API verification: **11/11 passed**. [Recorded API fixture](evidence/mythengine-overhaul/phase2h-live-fixture.mjs), [browser setup/assertions](evidence/mythengine-overhaul/phase2h-browser-fixture.mjs). These are machine-local verification recipes using the recorded isolated runtime and scratch output directory; inspect targets before replaying.
- Phase-scoped whitespace checks, documentation links and applied-file SHA-256 checks: see [change audit](evidence/mythengine-overhaul/phase2h-changes.json).

Final runtime: `http://127.0.0.1:5174/`, PID **60692**, source **aa5c536e90ffcf2a05dfd0de64035b4549df6072e52aea72582526492fd0e765**, artifact **3ecff85f49967bbf79b9400b060373506dd590118e3c426f8739429b74c6a47d**. PostgreSQL remains on **5433**, Qdrant on **6335/6336**, data under `E:\DEV\Projects\MythEngine\data`. Migration 0028 was applied after backup to `data/phase2h-before.sql`. The original port-5173 process was not restarted; the source-protection audit records its current identity and the five original-checkout differences already present before this milestone.

Jobs remain disabled. The existing 29 queued/2 completed jobs, stale campaign vault (1247 versus canonical 1249), missing index and unavailable Ollama remain recorded runtime conditions. No model turn, user-campaign repair, background-job replay or provider qualification was performed. Changes are unstaged and preserve the inherited dirty checkout.

## Boundaries and next phase

Canonical extension schemas support embedded values; typed references belong to custom document types. Core domain schemas are not rewritten. Incompatible schema changes are rejected until records are explicitly adapted; for example, make a field optional, remove its values, then remove the schema field. Preview/migration scans are bounded to 5,000 records. These constraints are explicit validation behavior.

Content-only snapshots do not contain canonical payloads, so canonical archive recovery requires a full campaign snapshot. Project moves copy selected/referenced shared documents; they do not infer dependencies from prose or names. Explicit unresolved foundation/base/parent/overlay game links produce an actionable conflict. Full retained historical-version portability and broad import qualification remain later-phase work.

**Next: Phase 3, complete retained item/type history and approved restore.** Audit every editable writer, capture the required baseline/version coverage, add history diff/restore and server-bound confirmation, and prove that restores append a new revision without rewinding the campaign. Saved GM context preference consumption remains Phase 4. The overall overhaul is not complete.
