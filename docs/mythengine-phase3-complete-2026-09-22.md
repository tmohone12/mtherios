# MythEngine Phase 3 completion

Date: 2026-09-22. **Phase 3 is complete in the isolated MythEngine working copy** on `codex/mythengine-overhaul`. The [overhaul plan](mythengine-overhaul-plan-2026-09-21.md) continues with Phase 4; this is not a completed overhaul.

## Delivered behavior

Custom documents and types, built-in type settings, and canonical character/location/item/faction records expose paginated retained history. Restore previews show concrete changed fields, schema/path conflicts and a fingerprint bound to the current revision and relevant schema. Apply requires explicit confirmation and that fingerprint; stale or incompatible reviews fail. An accepted restore uses the existing validated writer and appends a new revision, leaving subsequent history intact. Canonical restore keeps current identity, source evidence, player capabilities and resolver/activation metadata. Saved type layout clearing also requires a server-bound preview and explicit confirmation.

The content workspace renders history and restore reviews for documents, custom types, built-in types and canonical records. The same command gateway serves UI, CLI and MCP callers. [Writer coverage](evidence/mythengine-overhaul/phase3-writer-inventory.md) inventories source, import, folder, migration and automatic SQL paths rather than assuming generic patches cover them.

## Acceptance evidence

[Disposable live proof](evidence/mythengine-overhaul/phase3-live-proof.json) and its [replay script](evidence/mythengine-overhaul/phase3-live-fixture.mjs) passed five scenarios on the final build:

1. Document history pagination, concrete diff, required confirmation and new restore revision.
2. A later human edit rejects the stale reviewed restore without overwriting it.
3. An incompatible custom type restore reports affected documents; a corrected restore and a confirmed layout clear retain history.
4. Canonical record and built-in type restores enforce current domain/schema validation and append revisions.
5. A forced history insert failure rolls back the document mutation and revision together.

The browser opened a disposable project and game, previewed and confirmed a document restore from revision 1 to revision 3, then showed the earlier title and field value. A server read confirmed revisions 3, 2 and 1 and the restored title. In the same browser fixture, clearing a saved type layout displayed a confirmation; the applied clear created revision 2. Previewing and confirming revision 1 restored the layout as type revision 3. The browser fixture was deleted, and the original campaign inventory matched its before snapshot. The live fixture separately compared exact before/after hashes of the real campaign's `stories`, `story_entries`, `story_events` and `story_threads` rows; all four matched. No turn or Director activation ran.

## Verification and runtime

- `npm run check`: **0 errors, 0 warnings**.
- `npm run build`: **passed**; final source `94144f0e94149e8b1abaf202f5d7cc9c45dc15534ffe023171c0dd461711b802`, artifact `40e3d66e3a6bbc573c4a6bf56a7c639a33300df871f9d3b36c2351e0c8687e30`.
- `npm test`: **1,552 passed; 3 inherited failures** across 158 files. All failures are the previously recorded `promptHarness.test.ts` chapter/arc budget expectations. The Phase 3 built-in type confirmation test passed after the regression was corrected. [Test summary](evidence/mythengine-overhaul/phase3-test-summary.json).
- Final live MythEngine server: `http://127.0.0.1:5174/`, PID **11412**, PostgreSQL **5433**, Qdrant **6335/6336**. Jobs remain disabled. No new migration was required for Phase 3.

All verification projects and the fixture-specific failure trigger were removed. The real campaign **The Journey** remained at server version **1249**, with its world time and full story/transcript/event/thread row hashes unchanged during the final fixture. The original Mtherios runtime on port 5173 was not restarted. Changes remain unstaged in the inherited dirty MythEngine checkout.

## Boundary and next phase

History starts at the truthful catalog cutover baseline. Remapped imports establish new destination baselines rather than transferring every source revision. Custom content and type-only settings have no Phase 3 prompt/index projection consumer; [Phase 4](mythengine-overhaul-plan-2026-09-21.md#phase-4--gm-context-modes-and-visibility-ui) owns their context resolution and invalidation. Canonical domain edits already use the existing transactional vault/index outbox. Agent write tools remain gated for their later phases.
