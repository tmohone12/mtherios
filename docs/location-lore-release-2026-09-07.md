# Location lore release — 2026-09-07

Locations now carry their containing places and applicable lore into scene context. A courtyard or room in Volantis receives the established city government, social customs and daily life from the city record. Sublocations keep their own details and conditional exceptions. The feature uses the existing canonical database, facts, relationships, source records, prompt compiler and World Explorer.

## Use it

Open **World explorer → Locations → Volantis → How this place works**. Core campaign lore appears first. Add or revise a rule, choose whether it applies only here or also in sublocations, and record its effective turn. The containing-place editor provides exact location search and rejects cycles or stale revisions. Breadcrumbs and sublocation links navigate records without moving the player.

A child's inherited rules identify the owner and offer **Open owner to edit**. A local exception retains its conditions alongside the containing place's rule. **Evidence** opens the saved change, fact or original source. **View at turn** selects dated lore and containment; the overview remains explicitly labeled as today's record, and current entity prose/government are excluded from historical context.

See [the authoring contract](location-lore-authoring.md) for full database imports, scoped metadata, examples and migration guidance. Flat legacy locations still work; untagged facts remain readable until their scope is assigned.

## Applied Veil pilot

- Canonical Volantis owns 12 scoped lore records: eight preserved imported facts and four unchanged paragraphs adopted from its accepted overview. Current authority, including Aurion's Archonate and Vaeron's administrative role, is retained. No new setting claims were generated.
- The reviewed hierarchy is Volantis → Belaerys Manse → Aurion's chambers, upper sickroom and compound yard. The eastern-palace courtyard is linked directly to Volantis as its nearest established containing record.
- Aurion's chambers now use `entity_f484d248-0ac5-4283-b77b-12bb8b9bbda6`. Thirty duplicate records remain as inactive redirects, with original contents and source histories retained. The keeper retains its travel connection and existing event references. Ordinary location lists omit merged redirects.
- The primary scene is the eastern-palace courtyard at **Day Twenty-Seventh, Moon 6, 299 AC | 09:33**. Source narration 2495 establishes it. The explicit Mei-Lin POVs at 2497 and 2499 remain unchanged, along with the actors' separate locations. The story ID and both current-location flags agree.
- Veil is at server revision **3341**, current turn **1253**, with transcript head **2499** unchanged. The separate **Volantis: Black Walls Intrigue** campaign remains at revision **3203**.

The [applied manifest](evidence/location-lore-reconciliation-manifest-2026-09-07.json) links exact IDs, source headers, decisions and receipts. [Pre-write scene values](evidence/location-lore-primary-scene-prewrite-2026-09-07.json), [room originals and merge receipts](evidence/location-lore-pilot-reconciliation-2026-09-07.json), and [original city lore](evidence/location-lore-pilot-prewrite-2026-09-07.json) retain the inverse values and provenance.

## Verification

- **342 focused tests passed**, covering identity resolution, ambiguous names, omitted routes, primary/parallel POVs, immediate/deferred extraction, temporal and inherited lore, local exceptions, visibility, graph validation, prompt budgets, imports, canonical writes and World Explorer integration.
- `npm run check`: **0 errors, 0 warnings**. Isolated production build succeeded; the qualified build is activated at **http://127.0.0.1:5173**.
- Actual database/API qualification rejects stale edits, cyclic parents and cyclic location merges. Merges remap the scene anchor, actor and route pointers, event locations, memory locations, faction territories and resources. Repeated merges are idempotent.
- A disposable Port Alder campaign passed import → location lookup → merge → export → import with new IDs. Ownership, containment, current location, redirects, exceptions, supersession and original sources survived. Current and historical results remained distinct, and secret rules/children stayed out of the location context. Disposable campaigns were purged afterward. [Qualification receipt](evidence/location-lore-roundtrip-qualification-2026-09-07.json).
- The actual production prompt for **“Continue walking through the courtyard.”** retains Volantis's government and applicable city lore without the query naming the city. Source spans identify the included facts; whole rules survive budget trimming, and omissions are explicit. The latest primary scene header is 09:33 in Volantis. [Runtime receipt](evidence/location-lore-live-runtime-2026-09-07.json).
- Browser checks exercised parent search/save, breadcrumbs, inherited ownership, current versus historical rules, evidence navigation, and desktop/mobile rendering. Final canonical indexing and vault synchronization completed without a new job failure. Repeated projection requests from the merge batch were consolidated into a final rebuild; their original job receipts remain in [the coalescing record](evidence/location-lore-projection-coalescing-2026-09-07.json).

These checks verify storage, retrieval, UI and the compiled prompt. They do not claim measured quality improvements from newly generated narrator turns; no provider-backed narration was requested for qualification.

## Deliberately unresolved lore identities

The Black Walls structure, enclosed Old City district, individual gates and the eastern palace have ambiguous or incomplete identity evidence. Their existing records remain available for review. The Manse uses Volantis as its nearest established parent until the intermediate district is resolved. Missing transcript source IDs are recorded as provenance gaps and are not presented as verified narration. This release applies only the reviewed Veil pilot.

The previous production build is retained at `output/runtime-backups/location-lore-before-20260907/build`. Source changes preserve the workspace's unrelated existing work; no broad reset or checkout was performed.
