# MythEngine overhaul: complete implementation plan

Date: 2026-09-21; updated 2026-09-23. Status: **Phases 0–5, 7, 9 and 11 complete; Phases 6, 8 and 10 partially implemented; Phase 12 open.** See the [Phase 7 completion evidence](mythengine-phase7-gameplay-interactions-2026-09-22.md), [Phase 8 progress](mythengine-phase8-assistant-2026-09-22.md), [Phase 9 batch evidence](mythengine-phase9-batches-2026-09-23.md), [Phase 10 image progress](mythengine-phase10-images-2026-09-23.md), and [Phase 11 completion evidence](mythengine-phase11-maps-2026-09-23.md).

The product name is **MythEngine**. This plan turns the capabilities in [NEWFEATURES.md](<../AGENTS READ THIS/NEWFEATURES.md>) into an overhaul of the current Mtherios application: a game-running GM, a separate authoring assistant, editable project content, progressive context disclosure, compact research, interactive tools, and controlled parallel authoring. The reference's “Orbit” is called **Assistant** in MythEngine; “Craft,” its credits, named model recommendations, and advertised speed/cost figures are reference material, not MythEngine requirements or verified results.

The requested working copy exists at `E:\DEV\Projects\MythEngine`, on `codex/mythengine-overhaul`. It is an independent local Git clone of `E:\DEV\Projects\mtherios-master`, with current development changes overlaid. Phase 0 now supplies application branding, installed dependencies and an isolated runtime at `http://127.0.0.1:5174`, with fresh PostgreSQL/Qdrant services. No original campaign data or provider credentials were copied.

## 1. Handoff contract and completed preparation

Read [AGENTS.md](../AGENTS.md) and [ARCHITECTURE.md](../ARCHITECTURE.md) before implementation. This plan owns the proposed change; architecture documentation describes the inherited domains plus the Phase 0 runtime changes. Preserve the cloned uncommitted baseline. Do not reset it, clean it, stage it wholesale, or replace it with the older committed tree.

| Preparation | Verified result |
| --- | --- |
| Source commit | `e283fbcf1fd69a0a9d6384f82c791e1cb580925f` |
| Source branch | `codex/mtherios-runtime-and-plot-brain` |
| New branch | `codex/mythengine-overhaul` |
| Source snapshot | 740 existing files copied and SHA-256 verified; 20 tracked deletions preserved |
| Development files | Current tracked state plus non-ignored development files, including untracked source, tests, migrations, docs, and the feature brief |
| Excluded material | 2,730 untracked generated/local artifacts under the exclusions recorded in the manifest; ignored dependencies, builds, runtime data, vaults, and private local configuration were not copied |
| Git independence | Local clone used `--no-hardlinks`; no alternates file; source history retained |
| Source protection | Source file hashes and Git status matched before and after the clone |
| Remote | `source-mtherios` points to the original local checkout; no remote repository was created or pushed |

See [working-copy manifest](evidence/mythengine-overhaul/working-copy-manifest.json) and [source status](evidence/mythengine-overhaul/source-status-before.txt). These record the inherited baseline, not a clean application release. Clone changes are unstaged; the original index is unchanged.

**Runtime isolation requires requalification.** The intended split is original Mtherios on port 5173 and isolated MythEngine on port 5174. A later 2026-09-23 check found MythEngine serving 5173 from a changed local config, with Mtherios no longer running there. Inspect `npm run app:config` and both actual processes before changing targets. The MythEngine database contains a user-imported campaign; preserve it and remove only explicitly recorded disposable fixtures. Jobs remain disabled; overhaul checks have not qualified provider generation. See the [Phase 12 runtime observation](mythengine-phase12-portability-2026-09-23.md).

Deliver the overhaul as small, reviewable vertical slices with evidence per phase. Phases 0–3 are complete. See the [Phase 3 acceptance evidence](mythengine-phase3-complete-2026-09-22.md). An initial useful milestone is content/context/research; the **full requested overhaul** also includes the assistant, subagents, interactive dice/questions, images/covers, history, and maps. Do not call the early milestone the completed overhaul.

## 2. Required product behavior and traceability

The feature brief describes capabilities, not a requirement to adopt another product's infrastructure. Every requested capability is included here.

| ID | Required behavior | Delivery phase | Acceptance evidence |
| --- | --- | --- | --- |
| F01 | MythEngine product identity and independent working copy | Preparation, 0 | Clone manifest; branded app, package, PWA, CLI and compatibility audit |
| F02 | Distinct GM and Assistant roles with independently enforced tools/settings | 1, 5, 8 | Server capability matrix plus browser saved-setting checks |
| F03 | `read`: one item, batch items, folder/type/settings listings; recent game messages for Assistant | 1, 2, 8 | Typed reads, bounded pagination, source IDs, project/game scope tests |
| F04 | `write` creates/replaces; `update` changes only specified fields | 1, 2, 8 | Revision conflicts, nested partial edits, provenance, validation, UI/CLI/MCP parity |
| F05 | `bash` functionality: search, move, copy, delete, create content types | 2, 5, 8 | Canonical project operations, logical paths, deletion/recovery and scope checks |
| F06 | Editable content types with schemas, layouts, settings and history | 2, 3 | Custom Gear type, layout preview, type revision and migration fixtures |
| F07 | Pinned/Partial/Searchable at type and item level; item > type > Searchable | 4 | Initial packet inclusion, inheritance, clearing override, cache invalidation |
| F08 | Progressive disclosure; GM policies do not control Assistant context | 4, 8 | GM payload boundaries and independent Assistant read behavior |
| F09 | Read-only Research: files, rules/stats, locations, full history; short cited answers | 6 | Old-event search → neighboring entries → validated answer → final receipt |
| F10 | Research switch on for new games; direct reads when off | 1, 6 | Defaults/migration, disabled and provider-failure fallback fixtures |
| F11 | `askUserQuestion`: one/several multiple-choice questions with custom text; durable wait | 5, 7, 8 | GM off by default, Assistant on, reload/restart/resume exactly once |
| F12 | `askPlayerToRoll`: reason/expression/optional skill/character; player-controlled pause | 5, 7 | Pending card, authoritative roll on click, one result after retry/restart |
| F13 | `gmRollDice`: immediate GM roll, optional record portrait; unaffected by player-roll switch | 7 | Separate toggle behavior and persisted structured roll card |
| F14 | Dice notation: modifiers, keep-high/low, labeled pools, challenge groups, Fate and subtraction | 7 | All seven brief examples and negative/tied/malformed cases |
| F15 | `generateNames`: genre/cultural blends and naming instructions | 10 | Bounded candidates, no accidental entity creation, persisted retry result |
| F16 | `generateImage`: both roles, chat-enabled gate and project style | 10 | Server provider/job, correct originating chat, cost and failure display |
| F17 | Automatic covers on new-file creation and GM `generateFileImage` | 10 | Project switch, deduplication, late completion does not replace newer cover |
| F18 | `map`: location regions, pins, tokens and links | 11 | Visible map editing, agent parity, persistence, conflict and import/export |
| F19 | Assistant-only `revert` for item/type schema/layout/settings; approval before revert/layout clear | 3, 8 | Concrete diff confirmation, new restore revision, no campaign rewind |
| F20 | Assistant batch subagents: plan/sample/batch/parallel edit/spot-check/report | 9 | 97-record disposable fixture, controlled writes, all outcomes shown |
| F21 | Child tool limits, separate model/enable settings, no inherited parent conversation | 1, 9 | Negative permission tests and inspected child request packet |
| F22 | Live expandable child rows and message cost breakdown including Subagents | 8, 9, 12 | Durable progress after restart; usage aggregation without double counting |

The reference's 1–3 Pinned and roughly 1–15 Partial recommendations become UI guidance and load indicators, not arbitrary hard limits. The brief does not define a history retention duration, multiplayer service, pricing system, full rules engine, arbitrary host shell, or image-map generation quality target. Do not silently add those projects.

## 3. Current implementation: reuse and gaps

These findings were checked against the current working tree, including uncommitted files. Source presence is not deployment evidence.

| Boundary | Existing owner and behavior | Change required |
| --- | --- | --- |
| Runtime | [server.js](../server.js), [mtheriosd.mjs](../scripts/mtheriosd.mjs), [package.json](../package.json), [Compose](../docker-compose.yml) | MythEngine identity, isolated defaults, compatibility aliases and consistent config resolution |
| Engine gateway | [engine contract](../src/lib/contracts/engine.ts), [command dispatch](../src/lib/server/engine/command.ts), [MCP script](../scripts/mtherios-mcp.mjs) | Add typed content, agent, interaction and tool operations at this shared boundary |
| Canonical persistence | [schema](../src/lib/server/db/schema.ts), [worldRecords](../src/lib/server/engine/worldRecords.ts), [canonicalWrites](../src/lib/services/canonicalWrites.ts) | Existing record tables remain owners; add revision checks, actor attribution, content registry and immutable versions |
| Author edits | [WorldExplorer](../src/lib/components/database/WorldExplorer.svelte) sends changed top-level fields | Preserve that fix; add typed nested partial edits and conflict-aware UI |
| Turn pipeline | [turn orchestrator](../src/lib/server/turn/orchestrator.ts), [context](../src/lib/server/turn/context.ts), [prompt compiler](../src/lib/server/turn/promptPacket.ts) | Durable tool-call continuation and user wait states; shared context policy resolution |
| Provider | [provider.ts](../src/lib/server/turn/provider.ts) transports text/structured JSON/streaming | Add normalized tool-call/result messages without breaking extraction, narration or existing provider profiles |
| Research foundation | Active Recall already performs up to two planner rounds/four calls when configured and enabled; [gmTools](../src/lib/server/engine/gmTools.ts) supplies read-only tools | Keep the working investigator; return compact cited answers rather than raw observation bundles |
| Search | [retrieval](../src/lib/server/memory/retrieval.ts), [ranking](../src/lib/server/memory/ranking.ts), [canonicalSearch](../src/lib/server/engine/canonicalSearch.ts) include transcript FTS and canonical search | Expose reliable typed research adapters; do not add a new search engine |
| Cited synthesis | [smallBrain](../src/lib/server/engine/smallBrain.ts) and [schema](../src/lib/services/ai/sdk/schemas/smallBrain.ts) validate source-linked atomic evidence | Reuse its validation/brief compilation for research, without a redundant broad retrieval pass |
| Context receipts | [promptReceipt](../src/lib/server/turn/promptReceipt.ts), [memory contracts](../src/lib/contracts/memory.ts), [ContextWindow](../src/lib/components/story/ContextWindow.svelte) | Add resolved content modes, research citations and each final continuation request |
| Settings | [llmSettings](../src/lib/server/engine/llmSettings.ts), [terminalSettings](../src/lib/services/terminalSettings.ts), [settings store](../src/lib/stores/settings.svelte.ts) | Keep server-owned profiles and secret references; add separate GM/Assistant controls |
| Jobs/events/usage | [outbox](../src/lib/server/jobs/outbox.ts), [processor](../src/lib/server/jobs/processor.ts), [events](../src/lib/server/engine/events.ts), [apiCallLogs](../src/lib/server/engine/apiCallLogs.ts) | Reuse workers; persist agent/tool progress and attribution, because in-memory SSE replay is not durable |
| Dice | [dice utility](../src/lib/utils/dice.ts), [narrative renderer](../src/lib/utils/narrativeHtml.ts), existing server roll continuation | Extend beyond one `NdS` group/d20 assumptions; replace auto-player-roll behavior with durable interaction |
| Images | [ImageGenerationService](../src/lib/services/ai/image/ImageGenerationService.ts) currently relies on browser settings/state | Extract provider logic for server jobs, chat gates, canonical assets and covers |
| Locations | [location contract](../src/lib/contracts/locationLore.ts), [locationRecords](../src/lib/server/engine/locationRecords.ts), [LocationWorkspace](../src/lib/components/database/LocationWorkspace.svelte) | Add map data/editing without confusing geometry with physical containment |
| Workspace | [AppShell](../src/lib/components/layout/AppShell.svelte) has library/database/engine/terminal surfaces | Add project content workspace and persistent Assistant panel; no conversational Assistant exists today |
| Portability | [worldDatabase contract](../src/lib/contracts/worldDatabase.ts), [importer](../src/lib/server/db/worldDatabaseImport.ts), [vault projection](../src/lib/server/wiki/storyVault.ts) | Version and round-trip new authoring metadata, references, assets and history |

Specific inherited issues the implementation must address:

1. `patchWorldRecord` locks rows and increments versions, but has no caller `expectedVersion` check. It also hardcodes `manual_edit`/human provenance. A row lock alone does not prevent a stale Assistant patch from replacing newer values.
2. State-patch operations do not guarantee prior values. They cannot reconstruct complete item/type history. Campaign checkpoint restore rewinds whole canonical tables and time; it is not a single-item revert.
3. The Active Recall argument adapter drops numeric `position`, `radius`, `beforePosition`, and branch information, and treats `cursor` as text. Its allowlisted transcript commands need typed per-command adapters and boundary tests.
4. Current dice markers trigger immediate rolls/continuation. The legacy renderer expects nonnegative integer d20/DC/pass-fail fields; generalized parsing alone will not make Fate/negative/grouped results render correctly.
5. Image generation is browser-owned, and completion depends on originating UI state. New jobs must retain their original project/game/chat/record independently of navigation.
6. Manual edit projection jobs are queued after commit and can fail with only a warning. New history, accepted edits and durable outbox work must commit together.
7. Existing Active Recall is default-disabled in inherited service settings. New-project product defaults need an explicit migration/resolution policy; do not silently overwrite an existing off choice.

## 4. Target architecture and ownership

Keep SvelteKit/Svelte 5, TypeScript, Zod, PostgreSQL/Drizzle, existing provider transport, and the outbox. No additional agent framework, database, vector service or general workflow platform is required for this plan.

```text
Project workspace / game reader / Assistant / CLI / MCP
  -> typed engine gateway + server-derived role/scope/capabilities
  -> content/domain reads OR durable agent run + tool dispatcher
  -> validated revision-checked domain mutation + history + outbox transaction
  -> PostgreSQL canon and authored content
  -> disposable prompt views / vaults / indexes / UI projections

GM turn -> required scene/continuity + content visibility -> bounded research
        -> model/tool loop -> optional durable player interaction -> final narration
Assistant conversation -> explicit project/game scope -> authoring tools
                       -> optional bounded batch jobs -> checked edits and report
```

### 4.1 Project, game and content identity

Use an existing **shelf as the initial project boundary** and a **story as a game**. This is a UI/domain mapping, not a mass rewrite of storage IDs. Project settings/content types belong to the shelf ID. Game settings and instantiated world canon belong to the story ID. A project-level Assistant never receives implicit `__app__` access to every story. Migrate legacy unshelved stories deterministically to the existing `shelf_default` project, creating that ID transactionally if absent; repair invalid references explicitly and report the mapping. Do not derive ownership from a display name.

Moving a game between projects becomes an explicit migration operation: preview its type/shared-document dependencies, copy/remap needed definitions and references into the destination or select compatible existing ones, then atomically change ownership. Preserve game/entity IDs and source attribution; avoid leaving cross-project pointers. Block the move with actionable conflicts if dependencies cannot be resolved, rather than keeping the old unvalidated shelf-ID patch path. Moving a game must not silently transfer an entire shared library or expose another game's private content.

The project tree contains logical database-backed items. A “file” is an authoring item or view over an existing canonical record; its folder, slug and extension are presentation metadata. Moving a logical file must not change entity identity or require editing generated Markdown. `read` resolves stable IDs; slugs/paths are user conveniences resolved within an explicit scope.

Existing characters, locations, items and factions stay in their current domain tables. Shared project rules, lore and templates may be authored without a game. A game's eligible catalog is its project's shared items plus its own game-owned items, after authority/branch/POV filtering; sharing is automatic within this scope and does not require an unspecified binding table. A project conversation sees shared content plus explicitly selected game adapters, not every game's private record. Instantiating a shared character template creates a game-owned canonical character with a source-template ID/revision; playing one game never mutates another game's character. Shared-document edits may affect future requests in eligible games, with version-based prompt invalidation. They do not replay or rewrite past turns. Existing foundation/overlay relationships retain their established scope; migration must resolve them explicitly rather than infer ownership from names.

### 4.2 Proposed canonical records

Names below are proposed additions, not existing files or tables. Add only the structures used by an implemented phase.

| Record | Fields and invariant |
| --- | --- |
| `content_types` | ID, project ID, stable key/extension, display name, built-in adapter kind or custom kind, versioned field schema, declarative layout, defaults/settings, default GM context mode, revision. Unique key/extension in project. |
| `content_items` | ID, project ID, optional game ID, type ID, logical folder/slug, context override or null, cover asset reference, revision, and exactly one canonical target reference or custom document payload. Built-in title/body/stats and authority resolve from their owner; do not store competing copies. Custom items own title/description/body/typed fields plus secrecy/audience and optional branch/POV scope here. |
| `content_revisions` | Immutable target kind/ID, revision, complete authored snapshot, schema version, prior revision, actor/reason/source IDs, run/tool/job identity, timestamp. Type revisions include schema/layout/settings; item revisions include envelope plus authored domain fields needed for restoration. |
| `agent_conversations` / `agent_messages` | Project/game scope, role, settings version, message order, content/parts, source references and linked run ID. Assistant messages are not `story_entries`. |
| `agent_runs` | Role, project/game/branch, parent/message IDs, state, scoped instruction/snapshot, durable continuation, context/settings fingerprint, cancellation/lease, budget and usage rollups. GM runs link the existing `clientTurnId`/reservation rather than creating a second turn identity. |
| `agent_tool_calls` | Run ID + provider/normalized call ID unique, tool name, validated argument hash, state, expected revisions, durable result/error, side-effect references, usage attribution. This is the retry ledger. |
| `agent_interactions` | Run/tool ID, kind `question` or `player_roll` or explicit author approval, bounded prompt/options/roll request, revision, status, accepted response/result, responder identity and timestamps. |
| `assets` or existing suitable asset owner | Stable project/game asset ID, relative storage key, media type/size, origin job, hash, provider/model/prompt-style revision and usage. Reuse existing upload storage where it can meet the contract. |

Batch parents/children reuse `agent_runs` linked to existing `backend_jobs`; do not invent a second job scheduler. The current job table requires a story ID, so extend it with project scope before project-only authoring: backfill `project_id` from each story's shelf, allow nullable `story_id` for explicitly project-capable job types, enforce a project owner and same-project story when present, and retain required story scope for existing campaign jobs. Update claim/dedupe/status/retry/event filters and deletion lifecycle accordingly. Project Assistant, schema-migration and cover jobs must work before any game exists; do not fabricate a dummy gameplay story. Map documents use versioned location-owned state through a map-specific command, unless existing asset/state limits require a narrow dedicated table. Avoid a generic entity-attribute-value database.

A content read returns a composite revision token containing item metadata revision, target canonical revision and type revision. For updates, lock and compare all affected revisions before mutation. Require `item.project_id = type.project_id`, and for game items `story.shelf_id = item.project_id`; canonical adapter identity is unique per owning game/target kind/target ID. Enforce project/game reference consistency in the server and database where feasible; a polymorphic target must be resolved through a finite adapter registry, never a model-supplied table name.

Type schemas initially support text/long text, number, boolean, enum, arrays, structured objects and typed references. Layouts are allowlisted sections, labels and field ordering. No executable JavaScript, arbitrary HTML or SQL. Defaults do not retroactively overwrite user fields. Type schema changes produce an impact preview and explicit migration of incompatible existing records. Preserve unknown/legacy payloads during migration rather than silently dropping them.

### 4.3 Canonical writes and history

One shared mutation boundary must validate role/scope, record type, expected revision, changed fields and domain invariants; append the new revision and actor/source provenance; apply accepted changes; bump versions; and enqueue projection work in one transaction.

Use existing domain owners for player capabilities, containment/location lore, plot/commitments and other special records. Do not make a generic tool bypass their semantics. Omitted capability arrays still preserve values; `[]` still clears them. Partial updates preserve unrelated nested keys. Full replacement requires a full valid authored snapshot and expected revision; system-owned IDs, evidence, versions and derived fields are not replaceable by the model.

GM/Assistant/child actions record their actual actor plus the initiating user's instruction/run. Do not label model validation as human review. Routine edits explicitly requested by a user may apply through the validated path; unrelated speculative discoveries remain proposals. GM writes in play may create notes/documents and submit state changes through existing validators; the tool cannot grant itself authority to overwrite historical evidence or force NPC beliefs.

Define writer coverage before advertising version history: human UI, CLI/MCP, Assistant, children, GM tools, imports and automatic extraction/character updates that change editable domain fields. Maintain a checked inventory of create/update/delete call sites, including template instantiation and cover/map writes. New entities must receive their content envelope and baseline revision in the creation transaction, not lazily when first opened in the UI. Seed one baseline revision for existing items; do not fabricate pre-migration history. Each subsequent supported writer must capture a restorable snapshot atomically, linked to the exact corresponding type-schema revision. History retains all versions initially; no automatic pruning is part of this request. Large binary assets are referenced by immutable asset IDs, not copied into every JSON snapshot.

Restore creates a **new revision**. It requires a concrete diff and explicit confirmation in the product, as the brief specifies, and rechecks the current revision on confirmation. Type layout clear has the same confirmation rule. Restore checks current schema/reference compatibility and restores editable fields through their domain owner while preserving current system identity and source/provenance fields. It never deletes later history, rewinds world time/transcript/Director state, or invokes campaign checkpoint restore. Restore of a type may require record migrations; show and validate the impact before accepting it.

### 4.4 Server tool contract and capability matrix

Implement proposed `contracts/agentTools.ts` and a small server dispatcher beside the existing engine gateway. Inputs/results use strict discriminated schemas. Every call has a server-derived role, project/game/branch, conversation/run/call ID, capability snapshot, idempotency key, limits and cancellation. The model may supply task arguments, not its authority or another project's credentials.

| Tool | GM | Assistant | Research helper | Batch child |
| --- | --- | --- | --- | --- |
| Read/search/list | Yes, scoped | Yes, scoped | Read-only allowlist | Assigned targets and permitted references |
| Write/update/create | Validated domain operations | Authorized authoring operations | No | Only assigned/create scope; validated operations |
| Organize/copy/delete/type creation (`bash` compatibility) | Scoped typed operations | Scoped typed operations | No | No |
| Map | Yes | Yes | Read only if needed | No |
| `askUserQuestion` | Setting, default off | Default available | No | No; report ambiguity to parent |
| `askPlayerToRoll` | Setting, default on | No | No | No |
| `gmRollDice` | Always available | No | No | No |
| `generateNames` | Setting, default on | No | No | No |
| `research` | Setting, default on for new projects/games | No dedicated research tool in initial parity scope | No recursive research | No |
| `generateImage` | Chat image gate | Chat image gate | No | No |
| `generateFileImage` | Chat image gate | No | No | No |
| `revert` / clear type layout | No | Explicit product confirmation | No | No |
| `subagent` | No | Separate enable setting, default on | No | No recursive spawning |

Enforce the same matrix when advertising tools **and** executing them. Settings changes invalidate future dispatch immediately; completed effects stay recorded. A player-roll toggle does not disable GM dice. Assistant availability never depends on GM tool switches. Expose resolved inheritance and unavailable-provider reasons in settings.

The brief's `bash` surface describes search/organize/copy/delete/type creation. Implement those with structured, project-scoped canonical operations and optionally a compatibility tool label. Do not expose a host OS shell that could bypass PostgreSQL, read private machine files or manage processes. Physical asset paths resolve under the project asset root, rejecting traversal/symlink escape. Custom-item deletion is a tombstone/archive with reference checks and explicit recovery, preserving history; agent workers cannot delete. For built-in records, distinguish “hide/remove catalog view” from “delete underlying canonical item”: hiding changes workspace presentation only and leaves gameplay content intact; deleting requires the explicit domain operation and disclosed impact. Never translate a folder/tree cleanup into deleting a character/location or erasing unrelated accepted facts.

### 4.5 Settings and defaults

Resolve engine safety/capability limits first, then explicit game override, project default, and shipped default. Service provider/model routing remains in the existing server profile system. Authoring Assistant and batch-worker models are separate service profiles; use the user's configured providers, not models copied from the reference text.

New projects/games default to Research, Names and Player Rolls on; GM Questions off; Assistant Questions available and Subagents on. Image generation uses an explicit chat gate and a separately displayed project automatic-cover setting. Proposed initial defaults for both image spending switches are off until the user enables them. Preserve all explicitly saved legacy settings, including Research off and existing image choices. If a legacy value's origin cannot distinguish an untouched default from an explicit off choice, preserve it and offer the new preset visibly.

Do not silently create credentials or fall back to an unrelated paid provider. An enabled capability without a configured service shows “configuration required” and uses its defined non-model fallback where one exists. New model/settings keys round-trip through server settings, browser mirrors, exports and diagnostics; secrets remain server references.

## 5. Context visibility and progressive disclosure

Use a distinct `gmContextMode: pinned | partial | searchable`. Do not overload secret/player-known visibility, chapter-memory pins, retrieval relevance, or NPC knowledge. Effective value is item override > type default > Searchable; `null` means “Use type default.” Authorization and branch/POV filters apply before content is serialized, counted, searched or returned.

| Mode | Initial GM request | Lookup behavior |
| --- | --- | --- |
| Pinned | Entire authored, permitted content, stable source ID/revision and brief framing | No additional fetch needed for included body |
| Partial | Stable ID, title and description only; no hidden body/stat excerpt | Full permitted content fetched when relevant |
| Searchable | No title/body preload from the content catalog | Discovered through scoped search/read/research |

Required engine context—current scene, selected actors, current canonical state, campaign continuity, recent dialogue and established memory guarantees—retains its own policy. Making a historical character sheet Searchable must not erase a present actor's necessary current state. Label these inclusions separately so users can understand why a Searchable character still contributes a required scene fact. Deduplicate authored body content already supplied through domain views.

Compile this once on the server for prepare, preview and actual generation. Apply it to every preload path, including existing automatic wiki-prefetch/catalogue and character/domain body renderers, so a Partial or Searchable authored body cannot leak back through an older inclusion path. Query-driven automatic retrieval may include a Searchable result when relevant, but must be recorded as a bounded retrieval with its query/source/reason; it cannot be an exemption for unconditional preload. Preserve separately identified required scene facts. Include project/type/item/canonical revisions and effective model/settings in prepared-context freshness keys. A shared type-policy edit invalidates affected games without rewriting every item. Revalidate revisions before sending the provider request and after a paused turn resumes.

Budget required engine context, pinned full text, partial directory entries, selected history/research and output allowance as distinct sections of the existing complete request budget. The 1–3/1–15 recommendations are guidance. If pinned text plus required context cannot fit, return a useful preflight error listing contributions and remedies; never silently truncate a promised full pinned item. If all permitted Partial titles/descriptions cannot fit after required and Pinned material, fail the same preflight with per-item contributions and remedies; do not silently omit selected directory entries. Final receipts record complete/partial/omitted items and source spans for every sent request, including tool continuations.

Project tree icons support mouse, keyboard and touch, show inherited versus explicit mode, and expose a “Use type default” choice. Type settings show impacted items and estimated context load. Context inspection links to source revisions and identifies required engine material, authored preload, direct reads and research separately. Assistant ignores GM preload modes but still obeys scope, secrecy appropriate to the authorized author, and its own context budget.

## 6. Research behavior

Extend the existing Active Recall path; do not run a second independent investigator beside it. Fix its argument adapters first. Reuse PostgreSQL transcript FTS and canonical search; full history means all eligible historical entries can be searched, not that the entire transcript is injected or exhaustively scanned in one turn.

Proposed request: focused questions, originating GM run, server-bound project/game/branch/POV, story/source version, maximum rounds/calls/input/output, deadline and cancellation. Proposed result: `answered | insufficient_evidence | unavailable`, compact atomic statements with exact source IDs/revisions and bounded supporting quotations, unresolved questions, source coverage/degraded sources and usage.

Flow:

1. Start from the prepared scene and known references; decide which questions need lookup.
2. Search authored content/canonical records/full eligible transcript. Rank/filter before limits; follow selected record IDs and neighboring transcript with typed numeric positions/cursors.
3. Separate current canonical facts, historical statements, GM/OOC instructions and actor beliefs. A superseded promise is not current truth; an OOC instruction is not a fictional event.
4. Reuse smallBrain's supported-statement/source validation to compile a concise answer from gathered observations. Do not launch broad retrieval again merely to summarize them.
5. Validate that every citation belongs to a permitted returned source and still matches its revision. Reject invented sources; identify unresolved conflicts or missing evidence. A citation's existence alone does not prove the claim; retain bounded supporting excerpts and validate against them.
6. Send the compact answer to the GM; retain source receipts and bounded diagnostics separately. Do not copy every raw helper read into all subsequent messages.

Retain the current starting ceiling of two investigative rounds/four tool calls and bounded observations; make final brief size and call/latency budgets explicit in the service contract. Tune only after fixtures demonstrate a need. User cancellation or budget exhaustion stops new calls and prevents late results from being applied to a changed run. Sources are untrusted data, never new tool authority.

With Research off, ordinary bounded direct GM reads, required scene context and deterministic retrieval continue to work. On research timeout/unavailable provider, use already validated evidence, record the gap, and do not invent an answer. Failed vectors/vault indexes must not prevent PostgreSQL lexical recall. Secret GM evidence never becomes universal NPC knowledge or leaks through a player-facing citation/card. The Assistant can use its own scoped direct read/search tools; the GM switch does not affect it.

## 7. Durable agent execution and user interactions

Build one small run/tool ledger for the needed behaviors, integrated with existing turn reservation and jobs. State transitions:

```text
queued -> running -> awaiting_input -> running -> completed
                  -> failed / cancelled
awaiting_input -> cancelled / expired (explicit policy, never silently answered)
failed -> explicit retry of unfinished work under the same operation identity
```

Persist normalized continuation messages/tool calls/results, emitted segments, scope, settings/source fingerprint, accepted effects and pending interactions before sending the corresponding event. Do not persist provider hidden reasoning. SSE is a live notification channel; reconnect reads durable run state and resumes from a cursor. Do not hold an open transaction or provider request while a human considers a question/roll.

Normalize provider-native tool calling and a strict JSON action fallback into the same server dispatcher. Parse complete arguments before execution; never execute partial streamed JSON or regex-matched prose as a command. Capability probes/configuration choose supported transport, with explicit unsupported errors. Preserve current structured extraction and narration output policies. Bound tools, rounds, total time and usage; parallelize independent reads, serialize dependent writes and interactions.

The tool-call ledger reserves each side effect by run/call identity and normalized arguments. On retry, return its recorded result. A reused ID with different arguments is a conflict. Provider disconnect after a committed write, roll or image-job enqueue must not repeat it. Record terminal errors and reconcile uncertain external jobs before retrying.

For a GM turn, link the existing `clientTurnId` and `syncOps` reservation. A pending question/roll is not a completed gameplay turn, must not increment chapter completion, and must not schedule extraction/world/Director processing as if narration were finished. Save final accepted narration and queue downstream work once. Preserve the fixed **20 completed turns per chapter and 10 chapters per arc**, with no trailing buffer. Assistant conversations and worker reports never enter that cadence.

While a gameplay run waits, reject a second advancing turn in the same branch with its pending-run reference. Permit reads and independent author edits. If an edit changes relevant revisions, resume must rebuild/revalidate context and retain already accepted tool outcomes; do not silently continue a stale request or reroll. Settings can disable a pending unaccepted operation, producing a clear cancellation/replan state. A UI disconnect alone is not user cancellation.

Question cards support stable question/option IDs, labels/descriptions, one or several questions, custom text, pending/answered/cancelled status and source run. The response endpoint binds identity, run, interaction revision and allowed answers. Duplicate submission returns the original accepted response; a conflicting second answer fails. Render resolved cards in history and provide keyboard/mobile operation. Product confirmation for revert/layout clear uses this durable interaction pattern and a revision-bound diff.

## 8. Dice, names, images and maps

### 8.1 General dice and two roll modes

One typed parser/result format serves both player and GM rolls. Parse signed additive sequences of `NdS` or `NdF` groups with optional `khN`/`klN` and optional `[Label]`, plus signed labeled integer modifiers. Do not use `eval`. Reject trailing tokens, malformed labels, unsupported syntax, zero/negative die counts, impossible keep counts and resource-limit violations.

Return expression, stable roll ID, each group's sign/label/type, every die face and kept/discarded flag, raw kept sum and signed contribution, each modifier, total, originating actor/tool/run and timestamp. Fate faces are -1/0/+1. Tie selection is deterministic for kept flags. Pool/challenge systems use groups/faces, not an imposed success label. The engine does not default every game to d20; game rules instruct the GM how to interpret results. Existing d20 DC/critical behavior remains an explicit legacy/game-rule adapter.

Required fixture expressions:

| Expression | Required evidence |
| --- | --- |
| `2d6+3` | Two bounded d6 faces, flat modifier, correct total |
| `4d6kh3` | Exactly three kept dice, stable tie behavior |
| `2d20kl1` | Exactly one lowest kept die |
| `6d6[Pool]` | Labeled group retains all individual faces for success counting |
| `1d6[Action]+2d10[Challenge]+3[Wits]` | Independent action/challenge groups and labeled modifier |
| `4dF+2` | Fate faces and possibly negative total |
| `1d20-1d6` | Subtracted group with correct signed contribution |

Set explicit safe expression/group/dice/sides limits in the contract, with tests at each boundary; use an injectable RNG for deterministic tests and server-authoritative random outcomes in production. No browser-submitted die values are authoritative.

`askPlayerToRoll` stores reason, expression, optional skill and resolved same-game character ID; render the roller and wait. Clicking Roll atomically accepts one server-generated outcome, then resumes. Retry/reload returns that result without rerolling. `gmRollDice` executes immediately through the same ledger and shows a structured card, with optional resolved NPC portrait. It remains available with player rolls off. Roll cards support negative totals, multiple groups and accessible kept/discarded details. Continue reading saved legacy `{{dice:...}}` markers without rewriting historical entries.

### 8.2 Names

Add a bounded GM tool accepting count, entity/place intent, genre presets, style/cultural blends, exclusions and campaign naming instructions. Persist returned candidates under the tool call. No candidate becomes canon until an authorized creation operation selects it. Reuse configured generation transport; validate count/length/duplicates and provide a clear unavailable response. Do not add an external name service or hardcode the reference's model choices.

### 8.3 Images and covers

Extract reusable provider logic from the browser image service into server-owned generation with existing credential/settings resolution. Use durable jobs, bounded prompts and project style revision, stable origin IDs, immutable asset records, usage/error reporting and explicit image-enabled chat checks before spend. Frontend selection changes cannot redirect the result to another story.

On committed file creation, enqueue at most one automatic-cover request if the project setting is enabled and image capability/provider is available. File creation succeeds even if the cover job fails. Deduplicate by creation/item revision and style settings; do not queue covers during migration/import/retry unless explicitly requested. Late completion attaches only if the expected cover revision still matches; otherwise keep the asset as an unapplied result. `generateFileImage` is the GM's explicit remake tool; `generateImage` can be used by GM or Assistant when that chat is enabled. Keep controls independent as in the brief: automatic covers follow the project automatic-cover switch for manual, GM and Assistant creation, even if that chat's explicit image tool is off. Explain that scope in settings so users can separately disable automatic cover spending. The proposed chat gate for explicit `generateFileImage` is an implementation default, not a reason to suppress enabled automatic covers.

Asset access and exports must honor project/game/secrecy scope, and validate uploaded/generated MIME, size and storage paths. Preserve current upload support and its limits unless a feature requires a documented change. Client receives asset URLs/status and safe provider errors, never credentials.

### 8.4 Maps

Add a location map document with background asset/reference, normalized coordinate system, dimensions, versioned layers, regions/polygons, pins and tokens. Every object has stable ID, label/style, optional same-project/game permitted location/entity link, layer/order and appropriate visibility. Bound geometry size and coordinates; validate finite values, references and revision conflicts.

Provide a visible map editor in the location workspace with select/pan/zoom, add/edit/remove regions/pins/tokens, label/link editing and an accessible object list. Use native SVG/HTML and existing UI dependencies initially; add a map dependency only if a demonstrated interaction requirement warrants it. Agent `map` operations use exactly the same server save path and revision semantics.

Map navigation does not move the player. Region links do not invent containment or measured distances. Physical child-to-parent `part-of`, travel relations and map geometry remain distinct. Save/export/import the geometry and background assets; remap referenced IDs on import. Restore maps through item history, preserving unrelated location lore and current player position.

## 9. Assistant and parallel authoring

### 9.1 Assistant experience

Add a persistent Assistant side panel reachable from project workspace and active game. Show a clear project/game scope selector; existing project and game conversations stay separate when navigating. The panel reads current project content and bounded recent game messages with source links. It does not pretend to know a full transcript unless its own scoped search/read actually retrieves it.

Persist Assistant messages, tool cards, questions, summaries and costs separately from gameplay. Compact long conversations into bounded summaries with source references and recent raw messages; do not keep every edited file in all future model requests. The parent receives concise tool results/diffs, not whole files by default. Assistant replies, instructions and planned edits are author control, not fictional events or accepted canon on their own.

Implement the requested create/replace/update/search/organize operations, custom type editing, maps/images and approved restore through existing domain ownership. Display affected record links, before/after summaries, conflicts, failures and applied versus proposed status. Dirty editors require normal unsaved-change handling. Give a clear stop control and durable retry of unfinished work. Avoid confirmation on every routine authorized edit; reserve mandatory confirmations for revert/layout clear and any truly destructive operation whose scope is not yet explicit.

### 9.2 Batch planning and child isolation

For wide repetitive jobs, the parent reads the type/schema and a representative sample, then creates a durable bounded plan: user objective, transformation rules/examples, allowed fields, target IDs and expected revisions, completion criteria, creation namespace where needed, and budget. List/sample before dispatch; pagination must enumerate the intended target set, not silently process the first page only.

Split into nonoverlapping assignments, each with explicit instructions and scoped references. Children do not receive the parent's conversation or unbounded project dump. Their server capability allows only read/search/create/update within assignment and necessary permitted references. They cannot delete, change settings/types, generate images, run shell commands, spawn children, or ask the user directly. Ambiguities become per-item reports for the parent.

A parent may change a schema once through its authorized tool before dispatching workers; children cannot each race to add the same field. Workers then validate against the resulting type revision. Use current provider service settings and existing jobs; suggested initial concurrency is two workers with a small hard ceiling (four) and provider-aware backpressure. Make model and enabled state visible; use the same serial flow when subagents are disabled or a task is too small.

Track each target as pending/running/applied/conflict/failed/skipped/cancelled with source revision, committed revision and error. Commit each record atomically with revision/history/outbox; a 97-item task may partially finish. Do not imply batch-wide rollback. No automatic retry may overwrite a new human edit; reread and replan or return a conflict. Resume unfinished items only. Check cancellation/lease and schema revision again immediately before committing. A stopped worker must not later attach a stale result.

Parent validates every output schema and expected-target receipt, checks coverage/counts and spot-checks representative actual edits. Report applied, skipped, failed and conflicted counts with links. Never report success from child prose alone. A batch ID on each revision supports inspection and a separately approved compensating restore when needed; it does not erase history.

### 9.3 Progress and cost

Under the initiating Assistant message, render one durable row per child with status, progress, elapsed time, changed items and expandable sanitized tool activity/final report. Reconnect/restart reads the same rows from PostgreSQL. SSE updates them but is not their source of truth. Show task/tool summaries and outputs, not hidden model reasoning or secrets.

Attribute every provider request to parent message/run/child/tool and attempt. Aggregate parent, Research where applicable, Subagents and Images separately. Preserve provider-reported cost, calculated estimates and unknown cost as distinct values; do not represent unknown as zero or double-count a child's usage in both parent and child totals. Reasoning usage already included in completion usage must not be added twice.

Reserve budget before each request **and retry**, then reconcile actual usage. Use configured price information only when available; an enforceable money ceiling needs known conservative pricing or must stop further calls with “cost unknown.” Token/call/time caps still apply. Cancellation prevents new dispatch; it cannot undo already committed edits or already billed requests. No credit product or promised percentage saving is introduced by this overhaul.

## 10. Implementation phases and gates

Dependencies: `0 → 1 → 2 → 3 → 4`; Phase 5 can follow 1 alongside 2–4 after interfaces settle; Phase 6 follows 4 and the read-only portion of 5; Phase 7 follows 5; Phase 8 follows 2/3/5; Phase 9 follows 8; Phase 10 follows 2/5/8; Phase 11 follows 2/3/5; Phase 12 integrates all. Keep one owner for shared contract/schema changes and coordinate migrations before parallel edits.

### Phase 0 — Establish the MythEngine development identity and isolate runtime

**Completed 2026-09-21.** [Evidence and compatibility limits](mythengine-phase0-2026-09-21.md). The list below retains the implementation requirements for auditability.

1. Record current clone status and preserve the manifest baseline. Use the existing lockfile. Install dependencies into the clone only; no junction to original writable dependency/build folders.
2. Rebrand package name (`mythengine`) and corresponding lockfile root/package metadata; document/product headings, visible app title/navigation/onboarding/settings/empty states, PWA manifest/icon labels, terminal banners, default vault title and generated new-export branding. Audit original SVG/icon assets before changing artwork; retain historical/source attribution where appropriate.
3. Prefer `mythengine.config.json` and `MYTHENGINE_*`; accept old config/env names explicitly as compatibility aliases. Define precedence: explicit CLI > new env > legacy env > selected config > default. A new config file wins over a legacy file; do not merge secret-bearing files silently. Report source keys without printing secrets.
4. Audit runtime, DB migration helper, status, CLI, MCP, wiki scripts, build tooling and examples for consistent resolution. Existing scripts may remain as wrappers/aliases while new `mythengine-*` entrypoints are introduced. Neutral API route names need no cosmetic change.
5. Give the clone separate Compose project/service/container/volume identities, database, data/vault/upload/export roots, vector collection namespace and bind ports. Proposed local defaults: app 5174, PostgreSQL 5433, Qdrant 6335/6336, database/user `mythengine`, collection prefix `mythengine`. Check port availability before use. Avoid fixed container-name collisions. Use fresh local-only credentials/config; never copy source API secrets automatically. Keep jobs and auto-index disabled until a disposable database is verified.
6. Update all startup/status/migration scripts to the isolated configuration, including `backend:up`/`backend:down` Compose project selection. An implementation dry run must prove commands cannot target the original Compose project/data/database. Test effective config under inherited environment variables and reject an accidental source target unless deliberately configured later.
7. Preserve compatibility-sensitive identities: existing database table/column names, `_mtherios_migrations` ledger, imported IDs, bundle discriminators, `.mtherios` vault manifest readers, browser storage and old MCP tool names. Introduce new MCP aliases with a documented deprecation path; refresh tool discovery in compatibility tests. Never globally replace `mtherios` in stored IDs or rerun old migrations under a newly named empty ledger.
8. For a new origin, use isolated browser storage/cache namespaces. For an existing same-origin upgrade, version/migrate or retain old Dexie/local settings keys with explicit tests; changing a database name alone loses visible history. Read legacy saves and export the new version with compatibility metadata. PWA cache cleanup targets only owned prefixes.

**Gate:** package/lockfile consistency; startup/config resolution tests; `docker compose ... config` for the isolated configuration; secret-free effective target report; `npm run check`/build baseline (failures documented, not claimed fixed); disposable health/build identity and data-root proof before workers run. Original checkout, running process and databases remain unchanged. Write the clone README and architecture naming notes; mark any retained legacy names as intentional compatibility.

### Phase 1 — Shared contracts, permissions, settings and mutation safety

**Completed 2026-09-21.** [Implementation scope and evidence](mythengine-phase1-2026-09-21.md). Model tool dispatch remains gated for Phase 5; preferences and permission foundations do not advertise unfinished tools.

Owners: engine/memory contracts, server settings, gateway, canonical/domain writers, provider/logging boundaries. Add role/tool/context-setting contracts and versioned defaults. Introduce caller revision checks and actor/run attribution at shared writes; validate structured data and partial-update semantics. Establish the transaction/outbox/history hooks that Phase 3 will use and project-scoped job support with tests before a game exists. Do not advertise mutating agent tools yet.

**Gate:** stale/concurrent updates produce a structured conflict with no partial write; invalid types/references fail; cross-project/game/tool-role requests fail; source attribution is accurate; location/plot/player-capability regressions pass. Project-only jobs can be queued/claimed/retried with zero games, while existing campaign jobs still require their story. New default-on versus preserved legacy-off settings round-trip from server after reload.

### Phase 2 — Canonical content workspace and types

**Complete:** custom types/documents, canonical authoring, folders, layouts/context defaults and revision-safe move/copy/archive/recovery are live. Built-in types now support validated extension fields and reviewed default migration through the shared canonical writer. Archive recovery receipts survive compatible content transfer and remapped full-campaign import. Game moves preview and copy the transitive shared-document dependencies, preserve game/canonical identities, and reject stale previews or conflicts atomically. See the [completion report and acceptance evidence](mythengine-phase2-complete-2026-09-22.md), which links the earlier vertical slices.

Add content/type records and adapters for existing domain records. Build project tree, folders, type editor, generic custom-item editor and existing record navigation. Implement read/list/batch/search/create/replace/update/move/copy/tombstone through the gateway. Add a small Gear example with custom fields and a Rules document; avoid a wholesale visual rewrite before the workflow works. Preserve existing library/story navigation and domain editors.

**Gate:** UI/CLI/MCP read the same canonical item; create type/item; edit a nested field without loss; move/copy keeps valid identities/references; stale save preserves human changes; type layout preview and invalid schema errors work. Project shared docs and game-owned records remain distinct. Export/remapped import retains types, item metadata and source links.

### Phase 3 — Complete item/type revisions and approved restore

**Complete:** retained custom item/type, built-in type and canonical record history can be listed and reviewed; server-bound restore appends a version and rejects stale or incompatible requests. Saved layout clearing requires reviewed confirmation. [Completion and writer-coverage evidence](mythengine-phase3-complete-2026-09-22.md).

Capture a baseline revision and new versions across every identified editable writer; finish atomic history/outbox integration. Add history listing/diff and restore commands, type layout clear and approval interaction contract. History UI can use an ordinary confirmation until the durable shared card from Phase 5 is available, but the confirmed revision/diff must already be server-bound.

**Gate:** reconstruct any retained post-cutover version; failed transaction creates neither mutation nor revision; restore creates a new revision and preserves later history; stale confirmation fails; type/schema restore handles incompatible records; world time, transcript and Director state are unchanged. Record writer-coverage evidence rather than assuming generic patch coverage includes automatic updates/imports.

### Phase 4 — GM context modes and visibility UI

**GM path implemented and live-verified:** mode precedence, scoped preload, server preparation and freshness, budget preflight, receipts and browser controls. [Evidence and remaining Assistant gate](mythengine-phase4-gm-context-2026-09-22.md).

Implement precedence/resolver, metadata controls, project/type/item revision invalidation, server prompt integration and final receipts. Migrate existing campaigns conservatively without reinterpreting chapter pins or dropping required scene/continuity. Existing authored rules do not become pinned merely because their description contains “important.”

**Gate:** exact full Pinned versus title/description-only Partial versus absent Searchable initial content; inheritance/reset; type edit affects next request; assistant independence; secret/branch/POV filters before counts and payload; useful oversize-pinned error. Browser saved-value proof and actual sent-request receipt must match preview after accounting for tool additions.

### Phase 5 — Server tool loop, durable runs and interactions

**Completed 2026-09-22 for the server GM path.** [Implementation scope and live evidence](mythengine-phase5-server-tool-loop-2026-09-22.md). Gameplay question/dice cards remain Phase 7; the project-only Assistant remains Phase 8.

Add normalized provider tool transport/fallback and dispatcher, run/call/interaction records, status/respond/cancel gateway commands and durable stream projection. Integrate existing turn reservation/completion without duplicate turn identities. Implement basic read and question tools first, then validated mutation calls. Bound contexts, rounds, retries and resource use. Keep existing non-tool service paths functioning.

**Gate:** restart while awaiting input; reconnect a stream; duplicate/conflicting response; timeout; cancellation; forged role/scope/tool; provider failure after committed tool effect. All reuse or reject correctly with no duplicated writes/narration/jobs. Pending turns do not advance chapter cadence. Changing relevant canon during a wait forces context refresh while preserving accepted tool outcomes.

### Phase 6 — Compact Research over existing recall

Fix argument adapters, attach typed full-history/file reads, compact supported answer synthesis and citations, settings migration/fallback and diagnostics. Reuse existing Active Recall and smallBrain primitives rather than expanding all observations in the narrator's context.

**Gate:** old event outside recent window found without vectors; numeric neighbor-read path exercised; corrections beat stale facts; rules/stat/location queries answered from permitted current records; missing answers remain unknown; fabricated/deleted/cross-story citations fail. Research off and timeouts still allow direct reads; measured token/latency/usage comparisons use the same fixtures. The [local Research record](mythengine-phase6-local-research-2026-09-22.md) now includes live user-facing quotation cards and a current-visibility redaction test; provider-backed secret synthesis remains outside authorized scope.

### Phase 7 — Questions and system-neutral dice in gameplay

Complete reusable pending/resolved question UI for GM and Assistant; implement parser/result format, both roll tools and new structured cards with legacy rendering. Add settings and rule-prompt guidance. Route backend games through server tools; browser legacy helpers remain compatibility adapters only.

**Completed 2026-09-23.** The server dice tools, player question/roll cards, backend run routing, disposable player and GM rolls, same-game character portrait, multi-question refresh, accepted-roll recovery after a server restart, and a completed GM roll with a scoped public document cover have [live evidence](mythengine-phase7-gameplay-interactions-2026-09-22.md). Saved cards appear beside their matching narration after reload. The multi-question run exposed a provider repeat of an already answered choice; the server now reuses its accepted answer when the choice-specific option IDs repeat. The pre-fix duplicate remains in that disposable run as historical evidence.

**Gate:** all required dice expressions; negative/tied results; bounded parser; only server RNG accepted; restart after roll before narration does not reroll; player-roll off leaves GM roll available; refresh preserves multi-question responses. Complete a disposable player-roll turn and verify one narration/turn/downstream job set.

### Phase 8 — Authoring Assistant end to end

Build durable conversations/context and visible workspace/game panel. Connect scoped content/settings reads, authorized write/update/organize, questions and history restore. Show source links/diffs/applied-vs-proposed state. Add separate service settings and correct usage attribution. Compaction must preserve references without retaining all edited bodies.

**In progress 2026-09-23.** Separate durable conversations/messages/runs, scoped provider-backed replies, and a visible content-workspace/game panel have [live disposable evidence](mythengine-phase8-assistant-2026-09-22.md). The Assistant has server-scoped document read/list/write/update, folder list/create/preview-move/preview-copy/move/copy, project-wide custom-type save, persisted questions and revisioned approval proposals. Project-only document move/copy, type create/additive edit, question answer after reload, a human-approved item restore and an approved layout clear were verified. Folder-tree move/copy has isolated PostgreSQL integration coverage for exact snapshot, scope, replay and actor history; live provider create and UI activity are verified. Human edits after either proposal made approval fail without overwriting newer revisions; decline gets a server-authored result. Incremental conversation compaction recovered an older marker and cited document ID in a live provider reply while keeping full bodies in PostgreSQL. The saved Assistant service model and reasoning setting were exercised; a provider rejection persisted as a failed run with unknown usage and no content write, visible after reload. Factual source links now require an exact quote from current-run material and a scoped current revision; a disposable provider-backed gameplay answer persisted and rendered one verified narration source. Saved story-entry refs open and focus the exact narration or player action from both the game reader and the game-scoped Project content Assistant; the cross-workspace narration jump was exercised in the live browser. A live cancellation during provider dispatch aborted the request, persisted the cancelled run without a reply, and kept interrupted-call usage unknown. A localhost-provider PostgreSQL run now verifies mixed reported/missing-cost aggregation and the real 60-second Assistant timeout without external spend. Real-provider mixed-cost behavior, arbitrary-paraphrase semantic validation and the remaining gate checks are open.

**Gate:** ask about recent gameplay; create and refine a file/type; answer a persisted question after reload; restore only an approved item revision; handle concurrent human edit/cancel/provider error. Switching games does not redirect running writes. Assistant transcripts never appear in story extraction or summary cadence. Mobile/keyboard flows and dirty-editor handling are verified.

### Phase 9 — Bounded Assistant subagents and durable progress

Add planning/target enumeration, nonoverlapping child assignments, existing outbox workers, per-item revisioned application, parent validation, child panel, model/enable controls and message cost breakdown. Reuse the serial transformation path so disabled subagents remain functional.

**Gate complete 2026-09-23.** The [Phase 9 evidence](mythengine-phase9-batches-2026-09-23.md) covers durable plan/worker ledgers, restart and two-process budget fixtures, a 97-item real-provider serial/two-lane comparison, and a ten-document grouped versus individual-request sample. Per-message Assistant, Subagents and Images lines are live. A three-document real-provider worker recovery test killed the first process after one commit and completed the remainder in a fresh process that forbade a second provider call. Provider-reported zero cost leaves billed savings unproven; the gate requires honest timing and cost reporting, including unknown cost, rather than a paid-savings claim.

**Gate:** run the 97-item Gear fixture serially and in parallel with equivalent instructions/data/provider; every target accounted for, no double writes or scope escape; concurrent human edit becomes conflict; restart/resume touches unfinished items only; budget before retries; cancel prevents late commits; all statuses/usage visible after reconnect. Record real timing/cost, including unknown cost, without adopting the reference's numbers.

### Phase 10 — Naming, server images and covers

Add naming tool and server image provider/job/asset path, shared project style, chat gates, automatic cover behavior and explicit GM file-image tool. Preserve original chat/item identity on completion and protect newer cover selections.

**Naming and server images in progress 2026-09-23.** The bounded GM name tool, persisted candidates, setting gate and one provider-backed disposable turn have [implementation and live evidence](mythengine-phase10-names-2026-09-23.md). [Image evidence](mythengine-phase10-images-2026-09-23.md) covers immutable scoped assets, project-capable jobs, automatic-cover enqueue, revision-checked attachment, explicit GM/Assistant image queue tools, a revisioned project style editor, live asset serving and cover preview, and cover-asset round trips through content and campaign bundles with remapped identities. Public GM chat images have durable turn cards and portable bytes across campaign import and game migration; a seeded completed card rendered in the browser after narration ID remapping. Retained type/item revisions and historical covers now round-trip through fresh-project import. Backend story scenes and portraits now queue scoped server jobs, and generated portraits keep current and historical assets across campaign copy and game move. A local same-origin private-image preview rendered a disposable Assistant image in the browser; the app still has no multi-user account authentication. The manual scene button rendered queued and completed states, and navigating to another game before completion did not redirect the result. Stale image jobs replay a saved asset without another provider call, while jobs lacking an asset receipt fail safely; an already applied cover or portrait is not selected again. Provider-backed image success and navigation checks for the other image origins remain open.

**Gate:** names obey bounded request and do not create canon; images-off rejects before provider call; provider failure leaves file intact; retry creates one job/asset attachment; navigation and concurrent cover edit are safe; status/cost and exported assets work. Provider-backed image verification occurs only in the isolated fixture with its configured budget.

### Phase 11 — Location maps

Implement versioned geometry/asset/link contract, shared map operations and location editor. Add map history and portable references. Maintain separate containment and player movement operations.

**Gate:** create/edit regions, pins and tokens through both UI and agent; reload; stale save; map restore; invalid/cross-project links; mobile selection and accessible object list; remapped import/export with assets. Navigating a map does not move the player or rewrite containment.

### Phase 12 — Migration, qualification, rollout and final documentation

Finish portability/compatibility tests, accessibility/responsive pass, context/cost diagnostics and end-to-end fixtures. Update maintained README/ARCHITECTURE/product docs at their owners; retain NEWFEATURES as the input reference. Remove abandoned/duplicate paths only after caller/compatibility evidence, not through a broad cleanup during feature work.

**Portability in progress 2026-09-23.** Content and campaign bundles now carry retained type/item revisions and historical cover assets. Fresh-project copy import remaps snapshots and keeps them restorable; game migration updates moved snapshots and historical shared dependencies. Generated character portraits now carry current and historical image bytes with remapped scoped URLs through campaign copy and game move. [Image/history evidence](mythengine-phase10-images-2026-09-23.md) includes isolated database tests and live content and campaign export routes. Map import/export includes revisions and background bytes, with [map evidence](mythengine-phase11-maps-2026-09-23.md) including failed-import asset recovery. Project copy now assigns a distinct project ID and slug even when the source ID or slug already exists; merging requires explicit source and selected destination IDs. [Portability evidence](mythengine-phase12-portability-2026-09-23.md) records both paths, a small version-1 `backendCanon` compatibility round trip, and transactional type/path collision rejection with source and destination identities through the live import API. Project content and library campaign imports now offer read-only type/path conflict review and require explicit confirmation. The library can select an existing destination project for merge; the importer revalidates the complete bundle at application time. Reusing an existing compatible destination type keeps that type's timeline and reports skipped source type history. A new-project campaign copy and a content-snapshot conflict review now pass in the rendered in-app browser, with accurate copy counts and source/destination IDs. The browser also rejects a conflicting existing-project merge with source and destination IDs. A successful browser merge, broader compatibility and release qualification remain open.

**Gate:** all F01–F22 acceptance rows pass or are explicitly identified as unfinished; full relevant test/type/build checks; disposable provider-backed completed GM and Assistant runs with receipts; recovery/rollback exercise; no secret/cross-project leakage; original Mtherios runtime unchanged until a separately scoped migration/cutover. A running MythEngine artifact is identified by build/source fingerprint, health, ports/data roots and exercised behavior, not package name alone.

The default regression suite currently passes 1,646 tests (28 skipped) after restoring chapter-ending detail and bounded arc selection in the prompt packet. A disposable live prompt-packet fixture confirmed both facts and an explicit omitted-arc receipt on the built app. [Phase 12 evidence](mythengine-phase12-portability-2026-09-23.md) records this qualification; the remaining release gates below are still open.

A fresh isolated PostgreSQL archive and asset copy restored to a disposable database with matching key counts, ordered content digests, migration ledger and referenced-asset hash. The built app also booted against a second restored copy on port 5175, read recovered games and a prompt packet, and served the referenced image bytes. The temporary server/database were removed; derived-index rebuild and rollback under active runs remain open. The temporary recovery data directory remains because automatic approval review blocked its deletion.

The disposable completed GM/Assistant run evidence is in the [Phase 12 provider record](evidence/mythengine-overhaul/phase12-provider-2026-09-23.md); the runs did not exercise Research and were purged after receipt checks. This satisfies that narrow gate without closing the remaining Phase 12 matrix.

## 11. Data migration, portability and rollback

Use additive, numbered Drizzle/SQL migrations first. Preserve the inherited migration ledger and sequence; generate the next number from the actual clone at implementation time. Take a PostgreSQL backup and an asset/data-root copy for an explicitly selected migration source. Copying `data/` alone is not a database backup. Rehearse on an isolated restored database; do not clone live volumes or use the source connection string as a test default.

Migration order: project mapping and content types → stable adapters/envelopes and initial revisions → policy/settings defaults → agent/interaction/tool ledger → asset/map/batch additions as phases arrive. Store migration/checkpoint versions and make backfills restartable. Validate counts, IDs, references, authored text hashes, player capabilities, branch scope, history and old bundle compatibility. Do not generate covers, replay turns, advance factions, activate Director drafts or rebuild unrelated canon as a side effect.

Extend bundle contracts/schema/import-ID remapping before claiming portability. Include type/item revisions and authored metadata, project/game ownership, map references, assets/manifests and relevant user settings. A game-only export includes the transitive shared types/documents/assets needed to use it independently; remap references inside historical snapshots as well as current rows. The existing import shelf resolver matches by ID or slug; new project imports must not silently merge unrelated libraries/types on matching display slugs. Default to a new remapped project ID/unique slug; merge requires explicit source identity and a user-selected destination, with conflict review and transactional remapping. Never export credentials. Default campaign exports need not include private Assistant conversations; define an explicit author-project bundle option for those. Durable pending runs export as inert suspended/cancelled records, not jobs that automatically resume and spend on import. Research/tool receipts export only according to visibility and user-selected diagnostics policy.

Old Mtherios bundles remain readable. New bundles carry explicit format/version and reject unsupported future versions with an actionable message. Unknown optional content fields are preserved where safe; invalid required structures fail transactionally. A failed import must not leave half a project or silently drop conflicts.

Rollback is phase-aware. Feature switches can disable new agent execution and stop new jobs while preserving completed history. Before new-format writes, a code rollback may be enough if schema changes are additive. After new records exist, use a documented compatible build or restore the isolated pre-migration database/assets together; do not drop new tables and call it rollback. Cancel active runs, drain/stop workers safely and preserve receipts. Reverting a user's item is a different operation from deployment rollback.

## 12. Verification matrix and release evidence

Keep tests focused on behavior and real failure modes. Extend current suites rather than creating a second harness. Existing useful owners include:

- `src/lib/server/engine/{command,worldRecords,locationRecords,smallBrain,canonicalSearch,mcpTools}.test.ts` for shared contract/domain boundaries.
- `src/lib/server/turn/{orchestrator,provider,promptHarness}.test.ts` and prompt-packet/receipt suites for preparation, tool transport, retention and continuation.
- `src/lib/server/memory/{retrieval,ranking,canonical}.test.ts` for recall, current truth and visibility.
- `src/lib/server/jobs/{outbox,processor,summaryRebuild}.test.ts` for atomic jobs, restart/retry patterns and non-replay guarantees.
- `src/lib/components/database/WorldExplorer.gateway.test.ts`, story gateway tests and settings tests for backend-owned UI behavior.
- `src/lib/utils/__tests__/dice.test.ts`, narrative-rendering tests, AI tool schema/executor tests and database-import tests for compatibility.

Add focused suites beside new content, agent/run, interaction, batch and map owners. Confirm exact suite filenames in the clone before invoking them; proposed owners are not proof of preexisting coverage.

| Area | Minimum behavioral qualification |
| --- | --- |
| Rebrand/isolation | New names visible; legacy config/MCP/save paths work; independent containers/DB/data/vector/browser roots; source runtime remains untouched |
| Scope/permissions | Cross-project, cross-game, hidden source, branch/POV and forbidden-role calls rejected at server; content instructions cannot expand privileges |
| Mutation/history | Partial edits preserve fields; stale versions conflict; actor attribution correct; atomic revision/outbox; approved restore does not rewind campaign |
| Context | All precedence/inherit cases; full/partial/searchable bounds; required state retained; useful overload error; actual sent receipt and invalidation |
| Research | Old event, corrected fact, exact stat/rule, location relation, unavailable index, no evidence, invalid citation, timeout/cancel and disabled fallback |
| Interactive runs | Restart while waiting; duplicate/conflicting responses; one accepted roll; stale-context resume; no premature cadence/jobs |
| Assistant | Recent-game references, safe create/update/organize, separate conversation/context/settings, game switch during run, approved revert |
| Batches | 97 targets; page enumeration; nonoverlap; mixed failures; changed schema/human edit; cancellation/lease; crash/retry; accurate child costs |
| Images/maps | Gates before spend, durable origin, cover race, asset paths, geometry bounds, stable links, restore and remapped export/import |
| UX | Empty/loading/error/conflict states; keyboard/touch; narrow mobile viewport; active form/dirty state; screen-reader labels and status updates |
| Campaign regression | Canon/NPC belief/intent separation, 20-turn/10-chapter cadence, retained summary coverage, pending Director activation, import no replay |

At each slice run its relevant `npm test -- <file...>` checks, `npm run check` when contracts/UI/types change, and build when preparing an artifact. Run `git diff --check` against intentionally changed files; inherited dirty files may have preexisting findings, which must be separated from this work. At integration run the broader suite once, classify failures against the recorded baseline, and fix overhaul regressions. Do not mask failures by rewriting unrelated tests.

Browser validation must use the isolated MythEngine URL and verify the saved server value after reload. Prepared prompt preview proves preparation only; a completed disposable turn's request receipt/API usage and canonical records prove the sent request and applied result. Viewport emulation is useful but does not prove physical iOS keyboard behavior; include physical-device verification only when claiming that support is qualified.

Build a small disposable qualification project containing: one Pinned GM instruction, one Partial NPC, several Searchable rules/lore records, a secret and parallel-POV pair, a corrected old event beyond the recent window, seven dice examples, a custom Gear type with 97 items, two linked map locations and an image target. Include simultaneous human edits, duplicate requests, provider failures and restart points. Use generated fixture stories and stubbed providers for deterministic suites; real provider qualification has a separate bounded spend and must never target an existing campaign by default.

For each phase record source/branch/dirty fingerprint, commands/results, migration version, fixture IDs, expected/actual behavior, browser evidence, prepared versus sent receipts, model/provider/usage when exercised, and remaining limitations under `docs/evidence/mythengine-overhaul/`. Performance comparison uses identical dataset/model/settings: successful supported-answer rate, citation correctness, narrator/helper tokens, p50/p95 elapsed time, tool/retry counts and reported/estimated/unknown cost. Accuracy, isolation and recovery are release gates; savings percentages require measurements.

## 13. Practical work allocation and completion checklist

The critical path is isolation → shared mutation/contracts → content/history → context → research, with durable tool execution enabling interactive play and the Assistant. After shared contracts settle, parallel work can be split into content/history UI, context/research, and run/provider/interactive tooling. Batch execution, images and maps then proceed against stable owners. One integration owner controls schema numbering, gateway contracts, shared prompt budgets and final qualification; avoid parallel edits to the same large orchestrator without explicit ownership.

Do not estimate calendar completion from the reference's single batch benchmark. Size phases after Phase 0 baseline and the first end-to-end content/interaction slices. Each phase is deliverable independently behind an appropriate feature gate; the required full-scope checklist is:

- [x] Phase 0: MythEngine application branding and safe independent runtime.
- [x] Phase 1: shared contracts, defaults, permissions, revisioned attributed writes.
- [x] Phase 2: canonical content workspace and types, built-in schema/default extensions, portable archive recovery and dependency-aware project migration.
- [x] Phase 3: complete retained history and approved item/type restore.
- [x] Phase 4: Pinned/Partial/Searchable with truthful request receipts.
- [x] Phase 5: durable server tools and user-input continuation.
- [ ] Phase 6: compact cited Research and direct-read fallback. The [local extractive slice](mythengine-phase6-local-research-2026-09-22.md) now has a completed disposable GM turn using old-entry neighbor reads and cited narration; provider synthesis over GM-only evidence and the remaining qualification gate are open.
- [x] Phase 7: questions plus generalized player/GM dice and history cards. [Player/GM roll, question, restart, history and portrait evidence](mythengine-phase7-gameplay-interactions-2026-09-22.md) passes the gate in the isolated disposable game.
- [ ] Phase 8: persistent authoring Assistant. [Provider-backed conversations, revisioned document/type authoring, question/resume, approved item restore and layout clear, and bounded conversation compaction](mythengine-phase8-assistant-2026-09-22.md) work in the isolated fixture; the remaining qualification is open.
- [x] Phase 9: bounded batch helpers, restartable progress and cost breakdown. [The durable plan, worker, panel and benchmark evidence](mythengine-phase9-batches-2026-09-23.md) includes a 97-record isolated database fixture, real-provider serial/parallel and ten-document grouped/individual comparisons, conservative budget caps, a real-provider worker-process recovery, and per-message cost lines. Billed savings are unproven and are not claimed.
- [ ] Phase 10: names, server images, automatic/explicit covers. The [bounded GM name tool](mythengine-phase10-names-2026-09-23.md) has one completed provider-backed disposable turn; [image infrastructure, explicit queue tools, portable covers, retained history and public GM chat cards](mythengine-phase10-images-2026-09-23.md) have source/build verification plus live asset, project-style, bundle API, cover-preview and seeded chat-card rendering evidence. A backend-bound manual scene request also passed the rendered button, cross-game navigation and seeded completion check. A completed provider-backed chat image and broader origin/navigation qualification remain open.
- [x] Phase 11: linked location maps and shared editing tools. The [canonical map/editor/GM-tool slice](mythengine-phase11-maps-2026-09-23.md) has source/build, live API/browser, deterministic GM-agent execution and isolated failed-import recovery evidence, including historical background-byte portability and a mobile keyboard save.
- [ ] Phase 12: portability, compatibility, recovery and complete product qualification.

Suggested implementation handoff:

> Work only in `E:\DEV\Projects\MythEngine` on `codex/mythengine-overhaul`. Phases 0–5, 7 and 11 have acceptance evidence. Read the latest phase evidence and current source before advancing Phases 6, 8–10 and 12. Preserve the user-imported campaign, cloned uncommitted baseline and original Mtherios checkout. Prove isolated runtime/database/vector/data targets before starting services. Reuse canonical domain owners and existing recall/jobs/provider infrastructure. Keep planned, source-tested, built and live-verified status distinct. Do not call the overhaul complete until F01–F22 and the phase checklist are satisfied. Provider-backed secret Research is outside current authorization.
