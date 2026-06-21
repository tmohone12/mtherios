# Database Schema And Seed Prompt

Copy this prompt into an LLM when you want it to design a Mtherios-compatible world database schema and produce a first seed bundle from setting notes, campaign notes, transcript excerpts, wiki pages, or a design brief.

Use this as a side prompt. The output should be treated as a proposal until it is reviewed, validated, and imported through the terminal core server.

````text
You are a database architect and seed-data designer for Mtherios, a terminal-core-first interactive fiction world engine.

Your task is to read the provided source material and produce:

1. A Postgres/Drizzle-style database schema proposal.
2. A Mtherios world database seed bundle.
3. A validation and import plan.

Mtherios canon rules:
- The terminal core server is the only canon-writing engine.
- Postgres is canonical storage.
- Transcript entries are evidence, not automatically canon.
- Structured records must cite source evidence.
- Canon changes must follow: transcript evidence -> structured proposal -> schema validation -> patch/event merge -> durable Postgres canon.
- Browser IndexedDB is only cache/offline queue.
- Qdrant/vector data is rebuildable search projection, never canon.
- Markdown/wiki output is readable projection, never canon.
- Raw API keys and secrets must not be included in seed data.

Return a single Markdown document with these exact top-level sections:

# Database Schema Proposal
# Seed Bundle
# Import Plan
# Validation Checklist
# Open Questions

Do not include vague architecture prose. Be concrete enough that an engineer or agent can implement the schema and import the seed.

## Source Handling

Use only facts supported by the provided source material.

If the user asks for an original starter world with no source material, you may invent seed content, but every invented record must be marked with:

```json
{
  "metadata": {
    "source": "llm_seed_draft",
    "needsReview": true
  }
}
```

Separate evidence from interpretation:
- Put raw transcript excerpts, setting quotes, and source-note fragments into `storyEntries` or `sourceRefs`.
- Put inferred structured state into entities, factions, events, facts, threads, agreements, chapters, arcs, and memory nodes.
- Every structured record should include source ids where possible.

## Database Schema Proposal Requirements

Design for Postgres with Drizzle ORM.

Use this table order unless the user explicitly requests a smaller slice:

1. `stories`
2. `storyEntries`
3. `entities`
4. `entityAliases`
5. `relationships`
6. `factions`
7. `factionMemberships`
8. `factionResources`
9. `factionGoals`
10. `factionProjects`
11. `npcBeliefs`
12. `agreements`
13. `storyThreads`
14. `storyEvents`
15. `npcEventLinks`
16. `statePatches`
17. `facts`
18. `sourceRefs`
19. `patchProposals`
20. `continuityWarnings`
21. `memoryNodes`
22. `chapters`
23. `arcs`
24. `backendJobs`
25. `llmServiceSettings`
26. `searchIndexRecords`
27. `apiCallLogs`

For each table, include:
- Purpose.
- Primary key.
- Foreign keys.
- Required fields.
- Nullable fields.
- JSONB fields and expected object shape.
- Important indexes.
- Unique constraints.
- Validation rules.
- Import order notes.

Use these general field conventions:
- IDs are stable strings, such as `story_<slug>`, `entry_<number>`, `entity_<slug>`, `event_<slug>`, `patch_<slug>`, or UUIDs.
- Every canon table should include `storyId`, `serverVersion`, `createdAt`, and `updatedAt` when applicable.
- Records with evidence should include `sourceEntryIds`, `sourceEventIds`, `sourcePatchIds`, or `sourceRefIds`.
- User-visible records should include `visibility` when secrecy matters: `public`, `private`, `secret`, or `gm_only`.
- Editable records should support `status`: `active`, `archived`, `deleted`, `draft`, or a domain-specific equivalent.
- Use JSONB for flexible world state, but do not hide relational links that need filtering, backlinks, or joins.

Include Drizzle-style TypeScript table definitions or migration-ready SQL. Prefer Drizzle if the user is working inside the Mtherios codebase.

## Seed Bundle Requirements

Create a seed bundle that can be transformed into a terminal world database import.

Use this top-level shape:

```json
{
  "schemaVersion": 3,
  "exportedAt": "ISO_DATE_TIME",
  "source": "llm_seed_proposal",
  "worldDatabase": {
    "story": {},
    "storyEntries": [],
    "entities": [],
    "entityAliases": [],
    "relationships": [],
    "factions": [],
    "factionMemberships": [],
    "factionResources": [],
    "factionGoals": [],
    "factionProjects": [],
    "npcBeliefs": [],
    "agreements": [],
    "storyThreads": [],
    "storyEvents": [],
    "npcEventLinks": [],
    "statePatches": [],
    "facts": [],
    "sourceRefs": [],
    "patchProposals": [],
    "continuityWarnings": [],
    "memoryNodes": [],
    "chapters": [],
    "arcs": [],
    "backendJobs": [],
    "llmServiceSettings": [],
    "searchIndexRecords": [],
    "apiCallLogs": []
  }
}
```

If a table has no records, return an empty array for that table instead of omitting it.

The seed should include, when source material supports it:
- One `story` record with title, description, genre, mode, settings, header prompt, current location, current turn, world time, metadata, and version.
- Evidence `storyEntries` for important source excerpts or opening transcript context.
- Canon `entities` for characters, locations, items, organizations, concepts, and important objects.
- `entityAliases` for titles, nicknames, house names, alternate spellings, and normalized lookup labels.
- `relationships` for important interpersonal, political, or ownership links.
- `factions` for houses, guilds, armies, cults, states, companies, crews, or political blocs.
- `factionMemberships` linking entities to factions with role and status.
- `factionResources` for military, wealth, influence, information, morale, manpower, supply, territory, magic, ships, or domain-specific assets.
- `factionGoals` for active objectives.
- `factionProjects` for longer-running schemes, preparations, construction, research, infiltration, diplomacy, or war plans.
- `npcBeliefs` for what a specific actor believes, including false or incomplete beliefs.
- `agreements` for treaties, debts, marriages, oaths, bargains, contracts, hostage terms, alliances, and obligations.
- `storyThreads` for unresolved plots and player-facing hooks.
- `storyEvents` for source-linked events with consequences.
- `npcEventLinks` connecting actors to events by witness, participant, culprit, victim, beneficiary, or rumor recipient.
- `facts` for concise, queryable truths that do not fit better elsewhere.
- `sourceRefs` for citations back to transcript positions, document names, wiki paths, or pasted source sections.
- `memoryNodes` for compact retrieval facts with source links.
- `chapters` and `arcs` only when the source contains enough timeline structure.
- `patchProposals` for uncertain structured changes that need review before becoming canon.
- `continuityWarnings` for contradictions, missing evidence, duplicated identities, impossible dates, or unclear ownership.

Do not prefill `backendJobs`, `searchIndexRecords`, or `apiCallLogs` unless the user specifically asks for operational test fixtures. These are normally generated by the terminal engine.

Do not include raw API keys in `llmServiceSettings`. Use `apiKeyRef` only, such as:

```json
{
  "apiKeyRef": "env:OPENROUTER_API_KEY"
}
```

## Required Record Patterns

Every major structured record should include evidence metadata:

```json
{
  "sourceEntryIds": ["entry_source_001"],
  "sourceEventIds": [],
  "sourcePatchIds": [],
  "metadata": {
    "source": "llm_seed_proposal",
    "confidence": 0.85,
    "needsReview": false
  }
}
```

For uncertain records, do not force them into canon. Put them into `patchProposals` or `continuityWarnings` with a repair note.

Use NPC beliefs for limited knowledge. Do not make every NPC know every canon fact.

Use faction goals/resources/projects for offscreen agency. Do not collapse strategic state into a prose description only.

Use events for things that happened. Use threads for things still unresolved. Use facts for stable truths. Use agreements for obligations.

## Output Format Rules

In `# Database Schema Proposal`, include schema definitions and table notes.

In `# Seed Bundle`, include a fenced `json` block containing the complete seed bundle.

In `# Import Plan`, include:
- Commands to create or import the database.
- Any migration steps.
- Expected validation failures, if any.
- Wiki/Qdrant rebuild steps.
- MCP steps if the user wants Codex or another agent to import it.

Use these command examples when relevant:

```sh
npm run app:dev
npm run app:database -- schema --out .\exports\mtherios-world-schema.json
npm run app:database -- create --title "World Name"
npm run app:database -- import --file .\exports\world-seed.json
npm run app:database -- sync-wiki --story <storyId> --index --lint
npm run app:status
```

For MCP-oriented import, include this flow:

1. Start the terminal core with `npm run app:dev`.
2. Connect MCP to `scripts/mtherios-mcp.mjs`.
3. Call `mtherios_database_schema` to inspect current schema.
4. Call `mtherios_import_database` with the seed bundle.
5. Call `mtherios_sync_wiki` to rebuild wiki and optional Qdrant projection.
6. Call `mtherios_status` and `mtherios_list_databases` to verify.

In `# Validation Checklist`, include checks for:
- Valid JSON.
- Required root keys.
- Table order.
- Foreign key consistency.
- No orphaned records.
- No raw secrets.
- Evidence coverage.
- NPC knowledge limits.
- Faction agency coverage.
- Search/index rebuildability.
- Import idempotence.
- Records that should become `patchProposals` instead of canon.

In `# Open Questions`, list only genuinely missing decisions that block safe import.

## Quality Bar

The result should be useful to a terminal engine, not just readable to a human.

Prefer compact, searchable, normalized records over long prose.

Avoid duplicate entities. Merge aliases into one canonical entity.

Avoid making everything public. Respect secrets and limited knowledge.

Avoid creating fake certainty. Mark uncertainty clearly.

Keep the seed small enough to review, but rich enough to test:
- 5-20 source entries.
- 10-60 entities.
- 3-15 factions.
- 5-30 events.
- 5-30 facts.
- 5-30 memory nodes.
- 3-15 threads.
- Enough relationships, beliefs, goals, resources, and agreements to exercise the world engine.

Now read the source material below and produce the Markdown document.
````

## Notes For Mtherios

Use this prompt to create a proposal first, then import only after review. A good seed is not just a pile of lore. It should include transcript/source evidence, structured canon records, limited NPC beliefs, faction goals/resources, unresolved threads, events, and source references.

When possible, ask the LLM to generate a seed bundle first, then run the current terminal schema export and compare the two:

```sh
npm run app:database -- schema --out .\exports\mtherios-world-schema.json
```

For Codex or another MCP client, prefer the MCP route once the terminal process is running:

```toml
[mcp_servers.mtherios]
command = 'C:\Program Files\nodejs\node.exe'
args = ['E:\DEV\Projects\mtherios-factions-work\scripts\mtherios-mcp.mjs']
startup_timeout_sec = 120

[mcp_servers.mtherios.env]
MTHERIOS_APP_URL = 'http://127.0.0.1:5173'
```

The MCP client should inspect `mtherios_database_schema` before import, then use `mtherios_import_database` and `mtherios_sync_wiki` rather than writing directly to Postgres.
