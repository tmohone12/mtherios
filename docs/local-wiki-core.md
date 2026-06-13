# Local Wiki Core

Mtherios is moving toward a terminal/core-first lore architecture:

- Obsidian vault: readable lore and synthesis.
- `raw/`: immutable evidence from transcript exports.
- Qdrant: rebuildable semantic index over markdown chunks.
- Terminal scripts: search, link traversal, and future LLM-maintenance tools.
- Frontend: a client, not the owner of long-term lore operations.

## Start The App Process

The preferred full-system command is:

```sh
npm run app:dev
```

This starts Postgres and Qdrant, runs migrations, initializes the local `data/` root, launches the frontend under the Mtherios terminal process, and drains due terminal jobs through `/api/app/jobs/run`. The job worker now creates terminal-owned chapter checkpoints and arc rollups from world database rows, updates faction pressure from database events, converts high-pressure factions into deterministic world-tick events, then writes matching memory nodes for retrieval. `npm run dev` is still available for quick frontend-only work.

Check the running terminal process from another shell:

```sh
npm run app:status -- --url http://127.0.0.1:5173
npm run app:jobs -- status --url http://127.0.0.1:5173
npm run app:jobs -- run --until-empty --url http://127.0.0.1:5173
```

`app:jobs` is the manual terminal drain for the job outbox. The daemon normally runs this loop for you, but the CLI is useful after importing, syncing devices, changing wiki settings, or debugging a failed queue. Add `--story <storyId>` when you want both the reported backlog and claimed jobs scoped to one story; without it, the drain is global.

Operate terminal world databases directly through the daemon:

```sh
npm run app:story -- list --url http://127.0.0.1:5173
npm run app:story -- create --title "Glassmarket Campaign" --url http://127.0.0.1:5173
npm run app:story -- export --story <storyId> --out .\exports\glassmarket.mtherios.json --url http://127.0.0.1:5173
npm run app:story -- import --file .\exports\glassmarket.mtherios.json --no-preserve-ids --url http://127.0.0.1:5173
npm run app:story -- bootstrap --story <storyId> --url http://127.0.0.1:5173
npm run app:story -- entries --story <storyId> --limit 20 --url http://127.0.0.1:5173
npm run app:story -- memory --story <storyId> "what is unresolved?" --url http://127.0.0.1:5173
npm run app:story -- turn --story <storyId> "I ask who holds the debt marker." --url http://127.0.0.1:5173
npm run app:story -- turn --story <storyId> "I follow the hidden account trail." --wiki --lint-wiki --index-wiki --url http://127.0.0.1:5173
```

`app:story` is the terminal-side story control surface. It creates and deletes terminal world databases, imports and exports world database bundles, reads bootstrap/entry pages, retrieves memory packets, and can submit `/api/turn` commands without the browser. If no provider profile is supplied for `turn`, the terminal process still records the player turn and a fallback narration so the database path can be tested without an API key. Add `--provider-type`, `--api-key-env`, `--base-url`, and `--model` when you want the daemon to generate narration. Add `--wiki` to refresh the generated Obsidian vault after a turn, `--lint-wiki` to health-check it immediately, and `--index-wiki` to push the refreshed vault into the story-specific Qdrant collection.

`app:story export` writes a full world database bundle from the terminal database, not the browser cache: transcript entries, entities, relationships, factions, threads, events, patches, memory nodes, chapters, arcs, and compatibility arrays for re-import. `app:story import` posts a `.mtherios.json` bundle back through the terminal import route and queues projection jobs. Use `--no-preserve-ids` when importing a copy onto a machine that may already have the same story id.

The explicit world-database CLI wraps the schema, import, export, and wiki projection services:

```sh
npm run app:database -- schema --out .\exports\mtherios-world-schema.json
npm run app:database -- list
npm run app:database -- create --title "Glassmarket Campaign"
npm run app:database -- export --story <storyId> --out .\exports\glassmarket.world-db.json
npm run app:database -- import --file .\exports\glassmarket.world-db.json --replace-existing
npm run app:database -- sync-wiki --story <storyId> --index --lint
```

Agents can use the same services through the MCP server:

```json
{
  "mcpServers": {
    "mtherios-terminal-database": {
      "command": "node",
      "args": ["E:\\DEV\\Projects\\mtherios-factions\\scripts\\mtherios-mcp.mjs"],
      "env": {
        "MTHERIOS_APP_URL": "http://127.0.0.1:5173"
      }
    }
  }
}
```

The MCP exposes `mtherios_status`, `mtherios_database_schema`, `mtherios_list_databases`, `mtherios_create_database`, `mtherios_import_database`, `mtherios_export_database`, and `mtherios_sync_wiki`. It talks to the already-running terminal process, so a phone or second browser is only another client; it does not create another story/runtime instance.

Operate story wiki vaults through the running daemon:

```sh
npm run app:wiki -- stories --url http://127.0.0.1:5173
npm run app:wiki -- status --story <storyId> --url http://127.0.0.1:5173
npm run app:wiki -- sync --all --index --url http://127.0.0.1:5173
npm run app:wiki -- archive --story <storyId> --out .\exports\glassmarket.wiki.zip --url http://127.0.0.1:5173
npm run app:wiki -- pages --story <storyId> --layer wiki --url http://127.0.0.1:5173
npm run app:wiki -- search --story <storyId> "Balaerys debts" --follow-depth 1 --url http://127.0.0.1:5173
npm run app:wiki -- follow --story <storyId> "Memory: Balaerys debt marker" --depth 2 --url http://127.0.0.1:5173
npm run app:wiki -- page --story <storyId> "Memory: Balaerys debt marker" --url http://127.0.0.1:5173
npm run app:wiki -- lint --story <storyId> --url http://127.0.0.1:5173
npm run app:wiki -- context --story <storyId> "Balaerys debts" --follow-depth 2 --url http://127.0.0.1:5173
npm run app:wiki -- brief --story <storyId> "who knows about the debt marker?" --mode answer --url http://127.0.0.1:5173
```

`app:wiki` is the terminal control surface for the wiki brain. It calls the local app process instead of reading browser cache, so it sees the terminal world database, generated story vaults, persisted lint reports, and the same followed-link context packs used by the GM `search_wiki` tool. `archive` refreshes the generated story vault if needed and writes a `.wiki.zip` from terminal-owned markdown, `pages` lists the vault inventory and graph metadata, `search` returns ranked seed pages plus linked/backlinked neighbors, `follow` walks the Obsidian graph from a page title or path, `page` reads one exact markdown page by title or path, `context` builds the compact prompt-ready bundle an LLM agent should read before answering or maintaining lore, and `brief` wraps all of that into an LLM-maintainer briefing with health, hubs, relevant context, runbook, and suggested next commands.

The browser export buttons now follow the same ownership rule. Terminal-bound story JSON downloads call `/api/export/<storyId>` and wiki downloads call `/api/wiki/story-vault/archive?storyId=<storyId>`, so exported files come from the terminal database and generated vault instead of whatever IndexedDB last cached. Pure local/offline stories still use the older browser exporters until they are imported into the terminal world database.

Use `app:wiki sync --all` after a device sync, import, or long offline session to enqueue terminal jobs for story vaults whose markdown or Qdrant index is stale or missing. Add `--index` to rebuild stale story-specific Qdrant collections and `--lint` to refresh lint reports. Bulk sync queues jobs by default; follow it with `app:jobs run --until-empty` to drain those jobs through the terminal process, or add `--run-now` when you intentionally want the wiki CLI call itself to process them immediately.

The same commands can operate on a standalone Obsidian vault under `data/vaults/` without a terminal-bound story:

```sh
npm run app:wiki -- init --vault data/vaults/default --title "Mtherios Default Vault" --url http://127.0.0.1:5173
npm run app:wiki -- init --vault data/vaults/default --status --url http://127.0.0.1:5173
npm run app:wiki -- lint --vault data/vaults/default --url http://127.0.0.1:5173
npm run app:wiki -- index --vault data/vaults/default --collection mtherios_wiki_default --url http://127.0.0.1:5173
npm run app:wiki -- ingest --vault data/vaults/default --source-file .\clips\glassmarket-ledger.md --title "Glassmarket Ledger Notes" --tags glassmarket,debt --url http://127.0.0.1:5173
npm run app:wiki -- pages --vault data/vaults/default --sort backlinks --url http://127.0.0.1:5173
npm run app:wiki -- write --vault data/vaults/default --title "House Sythar" --content-file .\drafts\house-sythar.md --mode replace --log "updated faction synthesis" --url http://127.0.0.1:5173
npm run app:wiki -- search --vault data/vaults/default "Glassmarket debt marker" --follow-depth 2 --url http://127.0.0.1:5173
npm run app:wiki -- follow --vault data/vaults/default "House Sythar" --depth 2 --url http://127.0.0.1:5173
npm run app:wiki -- page --vault data/vaults/default "House Sythar" --url http://127.0.0.1:5173
npm run app:wiki -- context --vault data/vaults/default "who knows about the hidden route?" --url http://127.0.0.1:5173
npm run app:wiki -- brief --vault data/vaults/default "repair weak pages about the hidden route" --mode maintain --url http://127.0.0.1:5173
```

If neither `--story` nor `--vault` is provided, the daemon uses `MTHERIOS_DEFAULT_VAULT`, which defaults to `data/vaults/default`. External vault paths are intentionally blocked unless the app process is started with `MTHERIOS_ALLOW_EXTERNAL_VAULTS=true`; keeping vaults under `data/vaults/` makes them syncable with the rest of the terminal-owned app data.

`app:wiki init` bootstraps a standalone/default vault with `AGENTS.md`, `index.md`, `log.md`, `raw/sources/`, `raw/assets/`, `wiki/`, a starter synthesis page, and a `.mtherios/wiki-vault.json` manifest. The terminal app process runs this initializer automatically for the default vault on startup, so a fresh synced data root has the schema layer the LLM maintainer expects. The command is idempotent by default and keeps existing pages; pass `--force` only when you deliberately want to replace the scaffold files.

`app:wiki write` intentionally refuses `--story` and generated `data/vaults/stories/...` vaults. Those vaults are projections from the terminal world database and can be overwritten by the next sync. Use `app:story`, terminal database APIs, or the browser story tools to change world data; use `app:wiki write` for standalone/default Obsidian vaults where the markdown is itself the durable knowledge base.

`app:wiki ingest` is the matching raw-source path for standalone/default vaults. It writes immutable evidence into `raw/sources/`, adds source metadata and a content hash, appends a log entry, and adds a Raw Sources entry to `index.md`. After ingesting a source, an agent should read/search/follow the source page, then use `app:wiki write` to update derived wiki pages such as entity pages, topic pages, comparisons, and synthesis notes.

## Start Qdrant

```sh
docker compose up -d qdrant
```

Qdrant listens on `http://127.0.0.1:6333`.

## Start A Local Embedding Model

The scripts default to Ollama:

```sh
ollama pull nomic-embed-text
ollama serve
```

Useful environment variables:

```sh
set QDRANT_URL=http://127.0.0.1:6333
set QDRANT_COLLECTION=mtherios_wiki
set WIKI_EMBED_PROVIDER=ollama
set WIKI_EMBED_MODEL=nomic-embed-text
set OLLAMA_URL=http://127.0.0.1:11434
```

For an OpenAI-compatible local server such as LM Studio:

```sh
set WIKI_EMBED_PROVIDER=openai-compatible
set WIKI_EMBED_BASE_URL=http://127.0.0.1:1234/v1
set WIKI_EMBED_MODEL=text-embedding-nomic-embed-text-v1.5
```

## Index A Vault

Initialize a standalone vault before the first ingest:

```sh
npm run wiki:init -- C:\path\to\vault --title "Research Wiki"
```

This creates the schema/index/log files and the raw/wiki folders without needing the browser. It refuses generated story vaults because those are projections from the terminal world database.

Export a Mtherios wiki zip, unzip it somewhere, then run:

```sh
npm run wiki:index -- C:\path\to\vault --recreate
```

`--recreate` deletes and rebuilds the target Qdrant collection. Omit it for incremental upserts.

Dry-run without embeddings or Qdrant:

```sh
npm run wiki:index -- C:\path\to\vault --dry-run
```

## Materialize A Terminal Story Vault

Terminal-bound stories can now be projected directly from the Postgres world database into an Obsidian-style markdown vault. This avoids the old manual zip/export step for normal local use:

```powershell
$body = @{
  storyId = "23d7df4e-2b3a-4376-95bb-4d333eb0baad"
  index = $true
  recreate = $true
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:5173/api/wiki/story-vault" `
  -ContentType "application/json" `
  -Body $body
```

The route writes `data/vaults/stories/<storyId>/` and, when `index` is true, indexes the generated pages into a story-specific Qdrant collection. The terminal Postgres world database is the source of truth; the markdown vault is a generated lore projection, and Qdrant can be deleted and rebuilt from it.

Generated story vaults include `world-database.md`, a compact schema page that explains how the vault maps database records into Obsidian pages. Character/entity pages are dossier views over `entities`, `faction_memberships`, `relationships`, `npc_beliefs`, `story_events`, and `memory_nodes`. Faction pages are dossier views over `factions`, normalized `faction_goals`, `faction_memberships`, `faction_resources`, relationships, beliefs, events, memory, and source evidence. Legacy lorebook/wiki imports should be migrated into these terminal tables first; after that, the vault is regenerated from the database rather than maintained as an independent source of truth.

Deleting a terminal-bound story through `/api/stories/:id` removes the world database row first, then removes the generated story vault and attempts to delete the matching story-specific Qdrant collection. That cleanup is best-effort because Qdrant is an index, not the source of truth.

Each generated story vault includes `.mtherios/story-vault.json`. The manifest records the database `serverVersion` that produced the markdown, counts of generated pages, and the Qdrant collection/version after a successful index. Agents and UI can use it to detect stale vaults without scanning the whole tree.

The same work can run through the terminal job outbox:

```powershell
$body = @{
  storyId = "23d7df4e-2b3a-4376-95bb-4d333eb0baad"
  runNow = $true
  index = $false
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:5173/api/app/jobs/wiki" `
  -ContentType "application/json" `
  -Body $body
```

Turn, import, sync, and direct database edits enqueue `sync_story_vault` automatically. By default that job rewrites the markdown vault only; set `wikiAutoIndexStoryVaults: true` in `mtherios.config.json` or `MTHERIOS_WIKI_AUTO_INDEX=true` to also rebuild the story-specific Qdrant index from the job loop. That is the recommended mode once Qdrant and the local embedding model are stable, because it lets the terminal process keep semantic lore search current without browser involvement.

Set `wikiAutoLintStoryVaults: true` or `MTHERIOS_WIKI_AUTO_LINT=true` if the daemon should also write `.mtherios/wiki-lint.json` after each story-vault sync. Manual `/api/app/jobs/wiki` calls can pass `"lint": true` to write the same report for one story.

Terminal-side story wiki search, follow, and index requests also ensure the generated vault exists and matches the current database `serverVersion` before they read it. That keeps the GM `search_wiki` tool usable even if the background job loop has not drained yet.

For terminal-bound stories, the World State drawer exposes the same terminal-owned path as a `Terminal Wiki` panel. It shows vault/index/lint freshness from `.mtherios/story-vault.json` and `.mtherios/wiki-lint.json`, and can run `Sync vault`, `Index Qdrant`, or `Lint` through the terminal job processor.

## Search

Semantic search with exact keyword fallback:

```sh
npm run wiki:search -- C:\path\to\vault "what does House Sythar know about Balaerys?"
```

Search and include the first layer of linked/backlinked pages:

```sh
npm run wiki:search -- C:\path\to\vault "Balaerys debts" --follow-depth 2
```

Build an LLM-ready context pack from search results plus followed links/backlinks:

```sh
npm run wiki:context -- C:\path\to\vault "Balaerys debts" --follow-depth 2 --json
```

The context pack returns ranked seed pages, followed pages with extracted text, graph edges, source labels like `[1] Title <path>`, and a compact `contextMarkdown` block that can be pasted directly into an agent prompt.

Build a full maintainer brief for an LLM agent:

```sh
npm run wiki:brief -- C:\path\to\vault "who knows about the hidden route?" --mode answer --json
```

`wiki:brief` is the one-command orientation loop. It reads the vault, runs semantic/keyword search, follows links and backlinks, lints the vault, inventories hubs/recent/raw pages, includes core schema pages, and emits `briefMarkdown` plus structured JSON. Use it when an LLM needs to answer, maintain, ingest, lint, or explore without guessing which terminal commands to run first.

List the vault inventory before choosing where to search:

```sh
npm run wiki:pages -- C:\path\to\vault --sort backlinks --json
```

The pages command returns every page title/path, layer, frontmatter type/tags, headings, resolved wikilinks, backlinks, and text size. An agent can use this as the orientation step: list pages, inspect hubs or orphans, search promising terms, follow graph neighborhoods, then read exact pages.

Ingest a raw source into a standalone vault:

```sh
npm run wiki:ingest -- C:\path\to\vault --source-file .\clips\glassmarket-ledger.md --title "Glassmarket Ledger Notes" --source-type article --tags glassmarket,debt
```

The source ingest command writes under `raw/sources/`, records SHA-256 provenance, updates `index.md`, and appends to `log.md`. Re-ingesting the same content returns the existing source path instead of overwriting it unless `--force` is provided. Generated story vaults reject source ingest; their raw evidence comes from terminal transcript/database sync.

Exact-only search:

```sh
npm run wiki:search -- C:\path\to\vault "Glassmarket" --exact
```

JSON output for another agent/tool:

```sh
npm run wiki:search -- C:\path\to\vault "war pressure" --json
```

Read one resolved page by title or path:

```sh
npm run wiki:page -- C:\path\to\vault "House Sythar" --json
```

The page command returns frontmatter, headings, wikilinks, resolved links, backlinks, raw markdown, body text, and stripped plain text. In practice, an agent should search first, follow promising graph neighborhoods, then call `page` for the exact pages it needs to inspect or cite.

Write or replace a standalone wiki page through the same terminal-owned path:

```sh
npm run wiki:write -- C:\path\to\vault --title "House Sythar" --content-file .\drafts\house-sythar.md --mode replace --log "refreshed after source ingest"
```

`wiki:write` and `app:wiki write` are for maintained pages in standalone/default vaults. They refuse hidden/system paths, `raw/` source paths, and generated story vaults by default. This keeps the current rule simple: raw sources are ingested by a source workflow, generated story vaults are regenerated from the terminal world database, and durable handoff pages in standalone vaults can be updated by an agent.

## Follow Links

Trace Obsidian wikilinks and backlinks from a page title or path:

```sh
npm run wiki:follow -- C:\path\to\vault "House Sythar" --depth 2
```

This is the terminal-side version of the wiki browser. It lets an LLM start from `index.md`, search semantically, then follow the graph through `[[wikilinks]]`, source trails, chapters, arcs, and raw transcript evidence.

## Lint A Vault

Run a deterministic terminal health check before asking an LLM to repair the wiki:

```sh
npm run wiki:lint -- C:\path\to\vault --json
```

The lint pass reports missing `index.md`/`log.md`/`AGENTS.md`, broken wikilinks, duplicate titles, derived pages with no inbound links, thin pages, empty pages, and the generated story-vault manifest when present. It does not mutate files; it gives an agent a concrete repair list.

## Server API

When the app is running through `server.js`, the same wiki core is available through local API routes:

```sh
GET  /api/wiki/status
POST /api/wiki/story-vault
GET  /api/wiki/story-vault/status?storyId=<id>
GET  /api/wiki/story-vault/archive?storyId=<id>
GET  /api/export/<storyId>
POST /api/wiki/init
POST /api/wiki/index
POST /api/wiki/ingest
POST /api/wiki/pages
POST /api/wiki/search
POST /api/wiki/context
POST /api/wiki/brief
POST /api/wiki/follow
POST /api/wiki/page
POST /api/wiki/write
POST /api/wiki/lint
DELETE /api/stories/<id>
GET  /api/app/status
POST /api/app/jobs/run
POST /api/app/jobs/wiki
POST /api/app/jobs/world-sim
```

`GET /api/app/status` is the terminal-process health endpoint. It returns runtime identity (`pid`, uptime, timestamp), configured data/vault/Qdrant/Ollama/job settings, service probes, Qdrant collection inventory with point counts and orphaned story-collection detection, a story-wiki freshness summary, and a terminal job summary with total/ready/delayed/running/failed counts, per-type counts, recent failures, and running job previews. `npm run app:status` prints vault and Qdrant fresh/stale/missing counts plus the first few stories that need sync or indexing. `POST /api/app/jobs/wiki` accepts either one `storyId` or `"all": true`; bulk mode selects stale/missing vaults and indexes, enqueues `sync_story_vault` jobs, and only runs them inline when `runNow` is explicitly true.

`POST /api/app/jobs/run` is the daemon drain endpoint used by `mtheriosd` and `app:jobs`. When `storyId` is present, the endpoint now claims only jobs for that story; otherwise it drains the global ready queue. This keeps a manual story repair from unexpectedly processing another campaign's queued work.

## Terminal Memory Jobs

The daemon reads these optional values from `mtherios.config.json`, CLI flags, or environment variables:

```json
{
  "jobWorker": true,
  "jobIntervalMs": 5000,
  "chapterThreshold": 20,
  "postChapterBuffer": 10,
  "chaptersPerArc": 5,
  "wikiAutoIndexStoryVaults": false,
  "wikiAutoLintStoryVaults": false
}
```

Equivalent flags are `--job-worker`, `--no-job-worker`, `--job-interval-ms`, `--chapter-threshold`, `--post-chapter-buffer`, `--chapters-per-arc`, `--wiki-auto-index`, and `--wiki-auto-lint`. The browser can still cache story state, but terminal-bound stories get durable checkpoints and generated markdown story vaults from the terminal process. The daemon includes the remaining ready/retry/running/delayed/failed backlog in its `[jobs]` log line whenever it claims work.

Database memory-node embeddings are optional and separate from the Qdrant wiki index. Configure them only with a model whose vector size matches the Postgres column:

```json
{
  "memoryEmbeddingProvider": "openai-compatible",
  "memoryEmbeddingModel": "text-embedding-3-small",
  "memoryEmbeddingBaseUrl": "http://127.0.0.1:1234/v1",
  "memoryEmbeddingDimensions": 1536
}
```

Equivalent flags are `--memory-embedding-provider`, `--memory-embedding-model`, `--memory-embedding-base-url`, `--memory-embedding-url`, `--memory-embedding-batch`, and `--memory-embedding-dimensions`. If the provider is not configured or returns the wrong vector size, text retrieval still works and vector retrieval is skipped.

## Offline Command Queue

Terminal-bound stories keep Dexie as a cache and offline command queue. If the terminal process is unavailable during a turn, the frontend writes an optimistic local user entry and queues a `turn_command` sync op. When the story reloads, refreshes projection, or submits the next terminal turn, the frontend pushes queued commands before pulling database changes so the terminal world database catches up before new narration is generated.

Sync op IDs are idempotency keys. The terminal process records applied sync operations in `sync_ops`, ignores exact already-applied ops on retry, rejects op-id collisions with different command content as repair items, and then returns database changes for the client cache to mirror. The browser stores rejected repair payloads on the local sync outbox and exposes them in the World State drawer so conflicts are visible instead of silently living in IndexedDB. From that drawer, a repair item can be retried into the terminal queue or discarded, which keeps the terminal world database current and removes matching optimistic queued-turn entries from the local transcript cache.

Example search payload:

```json
{
  "storyId": "23d7df4e-2b3a-4376-95bb-4d333eb0baad",
  "query": "Vaeron debt",
  "limit": 8,
  "followDepth": 1
}
```

Example freshness check:

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:5173/api/wiki/story-vault/status?storyId=23d7df4e-2b3a-4376-95bb-4d333eb0baad"
```

Example follow payload. `page`, `path`, or `title` are accepted, so an agent can pass back the `path` returned by search:

```json
{
  "storyId": "23d7df4e-2b3a-4376-95bb-4d333eb0baad",
  "path": "wiki/factions/house-belaerys--7ada44b3.md",
  "depth": 1
}
```

The in-narration GM `search_wiki` tool uses the terminal context route first. Its tool result includes matching seed pages, followed page text, graph citations, and a compact context block from the Obsidian graph. The companion `brief_wiki` tool calls the terminal brief route for broader orientation, health, hubs, runbook guidance, and linked-page context before complex scenes or maintenance passes. If the terminal wiki cannot answer, these tools fall back to the browser lorebook cache so existing stories remain playable while the vault is being built or re-indexed.

Terminal-side `/api/turn` generation also asks the terminal wiki for a compact followed-link context pack before building the narration prompt. This keeps database-backed turns aligned with the same Obsidian/Qdrant lore graph even when the browser is only acting as a client shell. Wiki lookup failures are reported as turn warnings and do not block the turn.

By default the server only indexes vaults under `data/vaults`. Set `MTHERIOS_ALLOW_EXTERNAL_VAULTS=true` if you deliberately want it to access an outside Obsidian vault.

## Design Rule

Qdrant is not canon. It is an index.

If Qdrant is deleted, the system should recover by re-indexing the Obsidian vault. Durable knowledge lives in markdown and, later, structured core storage such as SQLite/Postgres.
