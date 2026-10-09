# MythEngine Phase 0: implementation and verification

Date: 2026-09-21. Phase 0 is implemented and running in `E:\DEV\Projects\MythEngine`, branch `codex/mythengine-overhaul`. [The overhaul plan](mythengine-overhaul-plan-2026-09-21.md) remains the specification for Phases 1–12; those phases are not implemented by this change.

## Result

The independent working copy now presents MythEngine in the package, application shell, story wizard, document title, PWA metadata, CLI/MCP banners and new story-export filename. The existing M icon artwork was retained after inspection, with new product-named asset paths; historical assets remain for compatibility. The generated default shelf description is corrected through migration `0020_mythengine_default_shelf.sql`, which changes only the exact inherited generated description and preserves custom descriptions.

The application is running at <http://127.0.0.1:5174/> with a fresh database, separate Qdrant and clone-local data/vault roots. PostgreSQL uses loopback 5433; Qdrant uses loopback 6335/6336. Compose owns project `mythengine`, containers `mythengine-mythengine-db-1` and `mythengine-qdrant-1`, and separate named volumes. Jobs, wiki auto-index and auto-lint remain disabled. No original campaign data, private configuration or provider keys were copied. No model request was submitted.

Original Mtherios remained running on port 5173 with PID 39068 throughout final verification. All 760 entries in the clone source manifest matched again: 740 existing source files and 20 expected deletions. The original database was not migrated or repaired. Its own running workers can continue changing live state; source preservation is not a claim that the live database was frozen.

## Shared runtime configuration

[runtime-config.mjs](../scripts/runtime-config.mjs) now owns path/service resolution across daemon, CLI/MCP, database helpers, Vite, server settings and wiki integration. Resolution is explicit CLI > `MYTHENGINE_*` > legacy/generic environment > selected file > defaults. The preferred file is `mythengine.config.json`; `mtherios.config.json` remains a fallback. Files are selected, never silently merged. The dotenv loader returns a copy rather than mutating its caller.

Guards reject known original local service targets, paths outside the clone and junction escapes. Deliberate compatibility use requires `MYTHENGINE_ALLOW_SHARED_RUNTIME=true` or the equivalent CLI switch. This is an accidental-target guard, not a network security boundary or a discovery system for arbitrary remote aliases. `app:config` reports sanitized targets without credentials. Story-specific wiki vault/collection settings propagate consistently through both environment aliases.

[backend.mjs](../scripts/backend.mjs) explicitly owns the Compose project and file for up/down/config. `backend:down` retains volumes. Migration helpers use the same database resolver. [build.mjs](../scripts/build.mjs) records source and built-artifact fingerprints; production startup verifies artifact integrity and exposes those fingerprints in runtime status. Editing source after building requires a rebuild to activate the change; the stamp identifies what was built, not an assertion that later source is identical.

## Compatibility decisions

- Existing database schema/IDs and `_mtherios_migrations` ledger are retained. All 21 migrations are applied on the fresh clone database without renaming the ledger or replaying old migrations.
- MCP discovery exposes 34 new `mythengine_*` tools and 34 equivalent `mtherios_*` aliases. Both status aliases were called through the real stdio server and reached the new runtime. No legacy alias removal date is scheduled; a future removal requires an explicit compatibility change and updated client discovery.
- Existing save payload discriminators, vault `.mtherios` readers, browser database names and stored identifiers remain unchanged. New story downloads use `.mythengine.json`; content/import semantics remain compatible. No new export schema is invented solely for a filename rename.
- The new browser origin isolates IndexedDB/local storage. New service-worker caches use MythEngine prefixes. Same-origin data migration and installed-mobile-PWA qualification remain outside this isolated-origin test; no browser database was deleted to rebrand it.
- The original config example and legacy entrypoint implementations remain compatibility references. New setup instructions use the MythEngine example and aliases. Historical documents and source-owned compatibility names are not globally replaced.

## Verification

| Check | Result |
| --- | --- |
| Dependency installation | `npm ci --no-audit --no-fund`, clone-owned dependencies |
| Runtime configuration | `npm run test:runtime`: 6 passed, including precedence, original-target rejection, junction escapes, redaction and Compose ownership |
| Focused application checks | 8 files, 78 tests passed: app config, MCP, engine/story CLI, LLM settings, campaign vault, canonical memory and story import/export |
| Types and Svelte | `npm run check`: 0 errors, 0 warnings |
| Production build | Passed; inherited chunk/dynamic-import warnings remain |
| Compose | Resolved config validates; PostgreSQL and Qdrant healthy on separate ports |
| Database | `mythengine`, user `mythengine`, 21 migrations; empty story catalog and job queue |
| Production identity | Runtime PID 57580 matches the validated build stamp |
| Browser | Title/sidebar, default shelf and new-story wizard show MythEngine; application-shell update activated and library reopened |
| Original checkout | 760 manifest entries match; original process remains PID 39068 |

Final focused command:

```sh
npm test -- src/lib/server/app/config.test.ts src/lib/server/engine/mcpTools.test.ts src/lib/server/engine/appEngineCli.test.ts src/lib/server/engine/appStoryCli.test.ts src/lib/server/engine/llmSettings.test.ts src/lib/server/engine/campaignVault.test.ts src/lib/server/memory/canonical.test.ts src/lib/services/storySync.test.ts
```

The broader suite, run before the final shelf/export adjustments, passed 1,484 of 1,487 tests. The three failures are all in `src/lib/server/turn/promptHarness.test.ts`:

1. Retains all nine full chapters while they await the next arc.
2. Omits an arc that cannot fit whole and reports the missing history.
3. Budgets rendered arc memory while retaining the newest covered chapter.

An untouched temporary snapshot of the original source reproduced exactly those three failures (53 passed / 56 tests). It used the clone's installed dependency versions and did not write to the original checkout. These are inherited prompt-budget expectations, not a green full-suite result. Investigate them in the context/receipt phase before declaring full overhaul qualification.

Build source SHA-256: `1093415fe1a92485bd02b23a42aa80122844527242fa4b055f40b2491a89e0e1`.

Built artifact SHA-256: `2fe5ea1a7ea210ab0ef10e3d4aa4b1cbfe70cd2f8c6c1a6962c2cfbcbbdeb2be`.

[Machine-readable verification](evidence/mythengine-overhaul/phase0-verification.json) records resolved targets, process/build identity, migrations, containers and MCP alias checks. [Phase 0 change manifest](evidence/mythengine-overhaul/phase0-changes.json) distinguishes these edits from the inherited dirty working tree. Runtime/build logs are under the clone's ignored `data/logs/` directory. No files were committed or pushed.

## Next work and limits

Phase 1 is next: shared role/tool contracts, server-owned defaults, revision conflicts and attributed canonical writes. Preserve the isolated runtime and inherited dirty baseline. Later phases still need content/history, context modes, durable tools and interactions, cited Research, Assistant/batch helpers, images and maps.

The clone has no copied provider credentials. Optional Ollama is unavailable, and no actual narrative/provider request or installed mobile PWA was qualified. A healthy empty application is the Phase 0 result, not completion of the overhaul or proof of campaign-generation behavior.
