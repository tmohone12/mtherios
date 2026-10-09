# Location lore implementation plan — 2026-09-07

Status: implemented and verified in the production runtime after the user's "Execute the plan" instruction. See [release results and usage](location-lore-release-2026-09-07.md) for the final behavior, qualification evidence and deliberately unresolved lore identities.

Pilot evidence: [original Volantis inventory and findings](location-lore-pilot-audit-2026-09-07.md) and [applied reconciliation manifest](evidence/location-lore-reconciliation-manifest-2026-09-07.json). The original database snapshot contained 429 Veil locations, 31 normalization-equivalent chamber records, and a primary/parallel-POV anchor discrepancy. Thirty room duplicates are now retained as inactive redirects, the primary anchor is corrected, and the reviewed city hierarchy and scoped lore are applied.

**Goal**

Make Mtherios understand a location as a persistent place within a larger world. A scene in a Volantis courtyard, harbor, or private chamber should retain the applicable identity, government, social structure, customs, and rules of Volantis, together with the details and exceptions belonging to that particular place. Campaign changes must remain authoritative, and each character's knowledge and physical presence must remain distinct.

Success means that the engine can answer four questions from canonical records: Where is this scene? What larger places contain it? How does this place work at this point in the campaign? Which of that knowledge and which people belong in this scene?

The hierarchy supports the lore. The main outcome is that Volantis consistently behaves like the established Volantis of this campaign.

**What the current project establishes**

The following baseline records the initial read-only source and runtime inspection on September 7. Execution results are recorded separately in the linked release notes.

| Area | Current evidence | Consequence for the plan |
| --- | --- | --- |
| Location identity | `LocationEntryState` has visits, changes, occupants, connections, region, and terrain. The extraction location schema accepts a name, description, current flag, region, and connections. | Add a typed location contract and resolve stable IDs before applying updates. |
| Physical containment | Canonical relationships already support `part-of` and `located-in`; the Veil snapshot includes `part-of` links from Leng settlements to the island. There is no dedicated location hierarchy contract in the inspected paths. | Reuse location-to-location `part-of` relationships as the single containment representation. |
| Current location | `stories.currentLocationId` drives backend context and frontend hydration. `patchValidator.ts` can upsert a full narration-header location string. | Keep the canonical scene anchor, but distinguish a place ID from descriptive scene wording. |
| Context selection | The server compiler selects the current location and scene entities; retrieval anchors to the current location ID. | Add explicit ancestor-lore selection to this same compiler and retrieval path. |
| Lore foundation | Existing `facts`, `source_refs`, `patch_proposals`, belief records, and temporal memory handling provide provenance and correction machinery. | Extend these records; do not create another lore database. |
| Editing | World Explorer exposes location name/description and generic record editing; the preview has overview and a few location-related fields. | Add a focused location editor, inherited-lore view, and parent/child navigation. |
| Authoring documentation | `docs/lorebook-generation-prompt.md` currently instructs generation of characters and factions only. | Extend the supported authoring/import contract to locations and scoped lore after the backend contract exists. |

The bounded Veil bootstrap at server version 3291 loaded 200 of 825 entities, including 170 locations. Of those loaded locations, 79 matched Volantis or Belaerys Manse by name. These are sample counts, not a complete location inventory and not a claim that all matches are duplicates.

Observed examples include `Volantis — Belaerys Manse, Aurion's Chambers` and a separate record using `Aurion’s Chambers`; `The Old City, the black walls` and a longer version ending `seen from above as the dragon banks`; and a city-level Volantis record already containing substantial setting lore. These are identity/reconciliation candidates, not permission to merge them automatically.

The same snapshot's canonical current-location ID resolves to Yin's Hall of the Vermillion Steps, while the campaign header says Aurion's last personal scene is in Volantis. The correct latest position requires a transcript/POV audit; the discrepancy alone does not establish a bug or authorize relocation. Include it in the pilot audit.

The subsequent pilot audit identifies the latest primary narration at position 2495 in Volantis's eastern-palace courtyard, followed by explicit Mei-Lin POV entries at positions 2497 and 2499 in Yin. The old header's chamber reference is therefore insufficient for a repair. Preserve both POVs, fix their canonical anchor scope, and revalidate the current source/version before applying changes.

Veil's current header and city record explicitly establish Aurion as Archon over Volantis and the Three Daughters. Imported descriptions of an earlier government must not restore that earlier government. `Volantis: Black Walls Intrigue` is a separate campaign and must keep its own canon.

**Intended experience**

An illustrative hierarchy, with each actual link requiring source evidence:

```text
Volantis
  Black Walls / Old City
    Belaerys Manse
      Aurion's Chambers
      Compound Yard
  Harbor District
    Belaerys Wharf
  Long Bridge
    Eastern Approach
```

These labels illustrate navigation, not a migration manifest. Do not assume that every similarly named palace or chamber is the same site, or that every settlement ruled by Volantis is physically inside the city.

Opening **Volantis** should foreground how the city works: its identity and atmosphere; current government and offices; social ranks and institutions; economy and labor; customs, religion, language, and etiquette; laws and access restrictions; geography; and relevant historical changes. Sublocations appear as a navigable section of that city page.

Opening **Aurion's Chambers** should show the breadcrumb, the room's own description and established access details, applicable lore inherited from the manse and city, current scene conditions, and source/history controls. City lore should be linked and labelled as inherited, not copied into the room's saved description.

Narration should express this lore through what people do, expect, permit, trade, fear, and notice. It should not recite a city article every turn. Legal rules have enforcers and circumstances; customs admit individual variation. Neither guarantees an NPC response or forces a player outcome.

**Canonical design decisions**

1. **One stable entity per established place.** Keep `entities.type = location`, existing aliases, and original evidence. Store a small optional `locationKind` in typed entity state for region, city, district, site, building, room, wilderness, or other. Absence means unspecified; it must not block old records. Keep stable description separate from weather, crowds, posture, camera angle, and other scene conditions.

2. **One physical parent, represented once.** Use directional `part-of` relationships from child location to parent location. Parent IDs exposed to the UI are derived from those relationships, not a second persisted parent field. Validate same story, location endpoints, no self-parenting, no cycles, and at most one effective physical parent. Reuse the story transaction/lock and revision checks for concurrent edits. Legacy `located-in` links and region strings are evidence for reconciliation; do not silently treat all of them as equivalent containment.

3. **Containment, routes, and authority stay separate.** Existing connections describe travel/access between places. Faction relationships and established facts describe ownership or government. A wharf can be part of Volantis without owning the city's government. A conquered city is not physically contained inside its conqueror's capital. Being somewhere in Volantis does not place every Volantene NPC in the same room, and containment alone does not establish a travel time.

4. **Lore belongs to its subject and has explicit scope.** Use existing `facts`, with `subjectEntityId` identifying the owning location. Add a strict, versioned `metadata.locationLore` contract containing category, applicability (`self` or `descendants`), origin (`foundation` or `campaign`), salience (`core` or `situational`), and optional `exceptionToFactIds`. Categories cover identity, geography/environment, governance, law/access, social custom, economy, religion, and history. Use existing source references, visibility, status, and temporal fields rather than duplicating them inside this object. Scope alone is not proof that a claim is accepted canon.

5. **Reuse temporal validity and explicit corrections.** Normalize the existing `validFromTurn`, `validToTurn`, `temporalKey`, and `supersedesId(s)` conventions for location facts and their memory projections. The exact subject, scope, and claim identity matter: similar text must not cause an automatic replacement. Preserve original evidence and make the earlier rule available in historical queries. A later rumor cannot supersede an accepted rule merely because it is newer.

6. **Inheritance adds applicable context; exceptions require evidence.** Resolve time, acceptance, story/branch, and visibility first. Then collect the current place and ancestors, retaining only facts whose scope applies. A room rule does not erase an unrelated city law. A local exception affects only explicitly linked rules within its scope and conditions. An accepted campaign change takes precedence over a conflicting foundation claim. Unresolved contradictions remain labelled for review, not silently decided by a relevance score.

7. **Keep narrative nuance.** Full descriptions and source passages remain available. Structured claims capture durable operational facts; evocative atmosphere does not need to be atomized into dozens of records. Customs, institutions, belief, disputed interpretations, and enforced laws remain distinguishable. Do not invent social rules, punishments, fees, permission requirements, or universal hostility from genre expectations.

8. **Knowledge remains scoped.** Apply existing visibility and actor-knowledge rules before prompt rendering and every source-inspector read. Public culture is not a license to disclose a household secret. Hidden parent names and hidden child locations must not leak through breadcrumbs, inherited labels, counts, or receipts. Review the existing branch/POV contract before enabling inheritance there; do not infer unsupported branch semantics from old browser fields.

For a synthetic test, a city fact might say that admission to a restricted district requires sponsorship. Its subject is that district and its scope includes descendants. An established invitation is actor-specific evidence satisfying that condition; it is not a citywide repeal. An explicitly enacted campaign reform can replace the relevant rule. The test wording is invented fixture material and must not be imported into Veil as lore.

**Context assembly and location updates**

Extend the current server path with one deterministic location-context resolver, shared by narration preparation, context preview, and the existing scene-check GM tool. It loads the current canonical place by ID, then its validated ancestor chain and applicable accepted lore. Fetch required ancestors directly; do not depend on the first 200 entities in a bootstrap or the first page of search results.

The location section should contain: the exact scene anchor and breadcrumb; a compact identity/current-authority brief from the nearest relevant city or region; applicable law/custom/operation facts; the leaf's local distinctions and explicit exceptions; and relevant current events. Ordinary movement between rooms changes local detail while retaining applicable city context. Naming the city only preserves a broad location; the resolver must not invent an exact room.

Use a bounded traversal (initially at most eight ancestors, with cycle/depth diagnostics) and the existing total request budget. An initial measured allocation is up to 1,200 tokens within that budget, reserving a compact portion for city identity and current authority. Select whole claims, carry their source IDs, and distinguish loaded, selected, retained, superseded, hidden, conflicting, and omitted records in the receipt. Drop optional atmosphere/history before action-relevant rules. If required governing context cannot fit, expose incomplete context explicitly rather than cutting away a qualifier and presenting a false rule. These are implementation starting limits to validate against fixtures, not measured performance promises or a new global budget increase.

The hierarchy supplies spatial applicability. The player's action, scene actors, agreements, and events supply relevance: a harbor transaction should select relevant trade/customs information; an audience should select relevant office, authority, and etiquette. Avoid requiring literal city-name keywords to retrieve its core lore. Optional semantic/wiki retrieval can supplement this result; failure of an index must not remove the known city chain and canonical rules.

The extraction contract should accept exact location IDs and source-supported hierarchy/rule proposals. Resolve IDs, aliases, parent context, and known scene anchors before considering creation. Full headers containing commas or dashes are evidence strings, not automatically a list of new entities. An ambiguous name such as `the courtyard` leaves the prior anchor intact and produces a reviewable proposal. Unknown but durable places may be created through the existing validated backend path when supported; weather and viewpoint descriptions remain scene detail.

Primary POV, parallel POV, remembered scenes, hypothetical destinations, quoted travel plans, and OOC/GM directives must be classified before a location write. A cutaway to Yin does not itself move Aurion. Conversely, a confirmed primary-scene transition should update the canonical anchor even if an old header instruction names a previous scene. Keep `stories.currentLocationId` authoritative and derive legacy current flags consistently; parent locations are labelled containing places, not additional current scenes.

Use the existing story revision and cache invalidation path for parent, lore, authority, exception, alias, or location changes. Invalidate affected prepared context/checkpoints and rebuild derived projections through current jobs. A failed projection never rolls back valid canon or makes an old wiki article authoritative.

**Implementation sequence**

Each slice has a concrete completion gate. Prefer the existing TypeScript/Zod/Drizzle services and command routes. No new database service, vector dependency, autonomous lore agent, map renderer, or general legal simulator is required.

| Slice | Work | Completion gate |
| --- | --- | --- |
| 0. Pilot inventory | Record source/build identity; paginate the full relevant location/relationship/fact inventory for Veil and the separate Volantis campaign. Inspect exact evidence for identity candidates and primary/parallel location anchors. Record relevant extraction gaps. Produce a proposed mapping and a small fixture corpus. | Read-only audit distinguishes confirmed links, unresolved identities, scene labels, historical rules, and campaign corrections. No live merges or invented intermediate places. |
| 1. Location contract | Define the shared typed location/lore contracts and effective containment resolver. Route parent edits through canonical relationship writes with source refs, revisions, and cycle/uniqueness checks. Add only additive constraints/indexes justified by actual query plans and legacy cleanup. | Valid parent edits persist atomically; invalid graphs and cross-story links are rejected; old flat locations remain readable and editable. |
| 2. Scoped lore | Extend fact/proposal validation for location ownership, scope, origin, exceptions, and temporal validity. Implement current versus historical resolution and preserve beliefs separately. | A city rule applies to a child; a sourced local exception is limited correctly; a campaign reform survives summaries and retrieval without changing unrelated lore. |
| 3. Narrator context | Add the shared ancestor/lore selection to retrieval, turn context, final prompt assembly, receipts, and the scene-check tool. Use the canonical anchor and global budget. | A sublocation scene receives applicable city lore even when the action never names the city; preview and sent context agree; lexical fallback retains governing facts. |
| 4. Stable movement and extraction | Extend location extraction identity fields and bounded classifier context. Resolve known locations before upsert, separate scene wording from persistent identity, and guard primary-POV movement. Preserve omitted fields during partial updates. | Returning to a known room reuses its ID; cosmetic header changes create no new location; siblings do not become co-present; a cutaway does not move the protagonist. |
| 5. Location workspace | Add a searchable parent selector, breadcrumbs, paginated child list, focused local-lore editing, inherited-lore labels, effective current/historical views, and source/change/proposal controls in existing World Explorer and reader surfaces. | Users can manage Volantis and its children without raw JSON; inherited edits explicitly target the owning record; navigation never teleports the player. |
| 6. Pilot reconciliation and portability | Build a dry-run manifest for the existing Volantis records. Preserve IDs where possible; separately review aliases, containment, duplicates, and extraction of claims from descriptions. Apply agreed mappings through canonical commands with a recoverable backup/manifest, then refresh projections. Extend import/export, ID remapping, and authoring docs. | The pilot has one agreed city anchor and validated sublocation paths; references and history survive replay and remapped export/import; unrelated campaigns remain unchanged. |
| 7. Qualification and release | Run focused tests, disposable campaign scenarios, context inspection, browser acceptance, and appropriate project checks/build. Capture build identity, migration steps if any, and rollback procedure. Verify the running build before claiming activation. | All required acceptance cases pass with recorded evidence. Provider-backed narration quality, when run, is reported separately from deterministic pipeline success. |

The first useful end-to-end release combines slices 1–3 and the minimum slice-5 controls on a small disposable Volantis fixture: one city, a district/site, a room, a few governing facts, and one local exception. Add extraction repair and live reconciliation after that contract is proven. Do not gate this first release on a global memory backfill, redesigning every entity editor, or cleaning every legacy location.

**Existing integration points**

| Concern | Paths to extend or verify |
| --- | --- |
| Contracts and canonical state | `src/lib/contracts/memory.ts`, a small shared location contract if needed, `src/lib/types/index.ts`, `src/lib/server/db/schema.ts`, `src/lib/server/memory/canonical.ts` |
| Canonical editing and proposals | `src/lib/server/engine/worldRecords.ts`, `src/lib/server/engine/canonRepair.ts`, `src/lib/server/engine/command.ts`, `src/lib/services/canonicalWrites.ts` |
| Extraction and movement | `src/lib/services/ai/tools/schemas.ts`, `src/lib/server/turn/patchValidator.ts`, `src/lib/server/turn/orchestrator.ts`, `src/lib/server/jobs/processor.ts` |
| Location-aware context | `src/lib/server/turn/context.ts`, `src/lib/server/memory/retrieval.ts`, `src/lib/server/memory/ranking.ts`, `src/lib/server/turn/promptPacket.ts`, `src/lib/server/turn/promptReceipt.ts`, `src/lib/server/engine/gmTools.ts` |
| Scene/cache consistency | `src/lib/server/memory/sceneCheckpoint.ts`, `src/lib/contracts/sceneCheckpoint.ts`, `src/lib/server/engine/cache.ts`, existing outbox/projection jobs |
| User controls and hydration | `src/lib/components/database/WorldExplorer.svelte`, `src/lib/components/database/LoreEntryPreview.svelte`, `src/lib/components/story/WorldDrawer.svelte`, `src/lib/components/story/WorldSheet.svelte`, `src/lib/stores/story.svelte.ts` |
| Import and projections | `src/lib/contracts/worldSeed.ts`, `src/lib/server/db/worldDatabaseImport.ts`, `src/lib/server/db/importIds.ts`, `src/lib/services/lorebookImporter.ts`, `src/lib/services/wikiImport.ts`, `src/lib/server/wiki/storyVault.ts` |
| Authoring and evaluation | `docs/lorebook-generation-prompt.md`, `docs/database-seed-schema-prompt.md`, existing memory/replay/qualification harnesses and focused tests beside changed modules |

These are integration touchpoints, not a requirement to edit every listed file. Trace all canonical write entrances, including generic record patching, import, and AI refinement, so none bypass location invariants. Canonical JSONB can hold the small new typed fields initially; choose an additive database constraint only when its enforcement and legacy migration are concrete. Preserve unknown legacy state fields during round trips.

**Acceptance cases**

| Case | Required result |
| --- | --- |
| Room inside Volantis, city never named in the action | The packet carries the room path and applicable city identity/current-authority facts. |
| Change rooms within one manse | Leaf details change; city lore remains; unrelated occupants do not appear. |
| Move from Volantis to another city | Governing lore switches with the confirmed scene; relevant personal memory can remain. |
| Current scene known only as Volantis | Display and preserve the broad anchor; do not guess a district or room. |
| Governance changes during the campaign | Current Volantis context preserves Aurion's established office in the Veil fixture; old government remains historical. The separate Volantis campaign is unaffected. |
| District access rule and a valid personal invitation | Carry the rule and the invitation with their distinct scopes; do not repeal the rule for everybody. |
| Room custom conflicts with city law | No automatic most-specific-wins replacement; require a supported exception or show unresolved conflict. |
| Weather, camera angle, and punctuation change in a header | Reuse the known place after identity validation; retain descriptive scene evidence without generating duplicate places. |
| Same-named courtyards in different buildings | Resolve using exact IDs/parent context or leave ambiguity explicit; never merge by name alone. |
| Political control of several cities | Keep authority links distinct from physical containment. |
| NPC elsewhere in the same city | Do not mark the NPC present in the player's room or invent instantaneous travel. |
| Cutaway, memory, or planned journey | Do not change the primary location without a confirmed primary-scene transition. |
| Secret sublocation or household rule | No disclosure through the player view, breadcrumbs, child counts, sources, or receipts outside the permitted knowledge scope. |
| Parent rename, move, deletion, or concurrent edit | Atomic validation preserves a valid tree and invalidates stale prepared context; orphaning is explicit and deletion never cascades accidentally to children. |
| Old extraction/job replay after a rule change | Older sources cannot reinstate obsolete current state; retries remain idempotent. |
| Edited/deleted source, summary refresh, or restored backup | Derived lore is revalidated or marked stale; source history remains inspectable. |
| Parent outside the first bootstrap page | Direct ancestor lookup still supplies the correct containing city. |
| Export/import with new IDs | Parent edges, fact subjects, exception/supersession/source references, and the current location remap consistently. |
| Vector/wiki outage or tight prompt budget | Canonical applicable lore still has a deterministic path; omissions and incomplete context are explicit; no partial rule changes its meaning. |
| Generalization fixture | The same code handles a second fictional city, a wilderness hierarchy, and a flat legacy location without Volantis-specific branches. |

Use the existing replay harness for whole-turn checks, with disposable data and no provider calls by default. Extend focused tests for the shared resolver, validation, temporal conflict handling, extraction, import, and UI hydration. Verify the actual rendered editor and context preview in the browser; do not send a story turn merely to inspect UI.

For eventual narrator-quality qualification, use a fixed set of scenes and a declared model/settings/spend boundary. Score whether the narrator uses the relevant city rule, preserves current authority, respects knowledge/presence, and applies a local exception without exposition dumping. Offline packet retention and synthetic replay are separate evidence and must not be presented as measured open-ended narrator quality. Paid runs require their existing spend authorization.

**Pilot completion and rollout**

Implementation is complete when the accepted Volantis hierarchy and scoped lore are saved through canonical paths, exposed in the location workspace, used in the real current-build prompt/scene-check path, preserved through import/restart, and proven by the acceptance cases. A diagram, a folder tree, improved descriptions alone, or a larger prompt is not the completion criterion.

Before changing live data, make the reconciliation manifest concrete: exact existing IDs, proposed parent edges, claimed sources, aliases/merges, retained originals, changed fact scopes, and unresolved choices. Preserve backups and prior transcript entries. Apply only the agreed pilot mapping; do not silently repair every campaign. If an identity or lore judgment needs the user's input, present that specific conflict after completing independent work.

The original planning turn created this plan and goal. The subsequent execution instruction authorized implementation, reviewed pilot reconciliation and runtime activation. Provider-backed narrator-quality evaluation remains a separate qualification activity and was not used as a completion claim for this release.


**Implementation results**

- Source implementation now includes stable location IDs and ambiguous-name review, punctuation normalization, preserved omitted routes, primary/parallel scene guards, a shared bounded ancestor/lore resolver, whole-rule prompt budgeting and receipts, canonical location workspace commands, and focused UI controls.
- Parent and lore edits use the story lock/revision, source-linked state patches, historical validity and existing outbox projections. Full imports validate typed location lore and physical ancestry; ID-remap tests cover exceptions and revisions.
- Verification: 342 focused tests, zero Svelte diagnostics, successful production build, actual transactional rejection checks, a disposable second-city import/merge/export/import round trip, and desktop/mobile browser inspection.
- Veil's reviewed hierarchy and 12 city lore records are applied at final revision 3341. Thirty chamber duplicates retain inactive originals and redirects. The primary courtyard anchor and both location flags agree with source narration 2495; the later parallel POVs and transcript head 2499 remain intact.
- Production prompt inspection verifies inherited city authority for an action that never names Volantis, whole-rule source spans, and explicit omission reporting. Historical lore excludes today's entity government/prose. Canonical indexing and vault refreshes completed, with no pending pilot jobs or new pilot job failures.
- The final build is active on port 5173; the temporary port 5174 preview is stopped. The pre-execution production build and inverse pilot values remain available in the release evidence. Ambiguous district/wall/palace identities remain documented for review without guessed merges.
