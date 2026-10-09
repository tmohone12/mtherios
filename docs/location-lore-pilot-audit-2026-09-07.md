# Volantis location-lore pilot audit — 2026-09-07

The read-only pilot inventory and a draft reconciliation manifest are complete. Feature implementation and live data changes remain pending under the planning boundary in the active goal.

Evidence: [inventory](evidence/location-lore-inventory-2026-09-07.json), [proposed reconciliation manifest](evidence/location-lore-reconciliation-manifest-2026-09-07.json), and [implementation plan](location-lore-implementation-plan-2026-09-07.md).

**What the inventory proves**

| Campaign | Version | Location records | Relationship records | Fact records |
| --- | --- | --- | --- | --- |
| Veil | 3291 | 429 | 10 | 616 |
| Volantis: Black Walls Intrigue | 3203 | 74 | 3 | 1,177 |

These counts were confirmed in a PostgreSQL repeatable-read, read-only transaction and matched the API story identities/versions. Source-file hashes and Git HEAD are retained in the evidence. No canonical writes or model calls were made.

The initial API pagination pass repeated some fact IDs while the story version stayed unchanged. `world.records` orders by `updated_at` alone, so tied rows are unsuitable for a complete offset-paginated audit. Ordered SQL reads replaced that sample as the authoritative inventory. The earlier page counts remain labelled diagnostics. Implementation acceptance must cover stable pagination and cannot infer complete coverage from the number of returned rows.

Veil contains 109 location names matching Volantis or Belaerys Manse. This is a name filter, not proof of geographic containment: it includes viewpoints and places outside the city. None of Veil's existing containment edges belongs to Volantis; its three `part-of` links describe settlements on Leng. The separate Volantis campaign has no containment edges in the inspected relationship table.

**Volantis already has substantial lore**

The city entity in Veil is `veil_scratch_asoiaf_entity_asoiaf_volantis_0189`. Its description already covers daily life, the two riverbanks, the Black Walls and Old Blood, trade, slavery, faith, historical government, current government, and portrayal. Its state also records current ruler and political form. The work should make this established material available and scoped correctly throughout the city.

The separate campaign's city entity is `import_4544d29d-393a-4200-8051-9bbcbaf52a98`. Its description and state contain a different campaign baseline, including social rules, economy, political order, population, and landmarks. No existing fact in that campaign has a location as its subject. Much of its location lore is therefore in the entity state rather than location-owned facts.

Veil's city has eight directly owned imported facts. These use the legacy `awoiaf_lore` type, outside the narrow current `factTypeSchema` enum, and retain import/source metadata rather than transcript IDs. A strict new lore contract needs compatibility reads and explicit conversion; it must not discard this information or manufacture a transcript source. Current authority is also represented by `veil_fact_vaeron_triarch`, whose subject is a character. City context must follow relevant accepted authority relationships/facts, not only fetch facts whose subject is the city.

The Black Walls entry restriction belongs to the district/access context. It must not become a restriction on entering all of Volantis, and it must not restore the old Hall's authority over Aurion. The city article already distinguishes that historical government from the campaign's current Archonate. Preserve this distinction during claim extraction and inheritance.

**Stable identity requires attention before a live merge**

Veil has 31 active records whose names normalize to `Volantis — Belaerys Manse, Aurion's Chambers`, including typographic-apostrophe variation. They are review candidates, not 31 proven descriptions of distinct rooms and not an approved merge set.

Twenty-eight saved resolver receipts report a create decision even while listing exact-name candidates. Several show a fuzzy singular `chamber` candidate tied at score 1 ahead of exact `Chambers` matches. This is evidence of a historical identity-selection failure. Current source now filters location candidates before ranking, with a comment addressing that tie. Do not assume this historical trigger is still unfixed in the current source or duplicate the existing repair. Reproduce both the historical tie and the unresolved multiple-exact-match case in the new acceptance suite, then verify the activated build.

The manifest enumerates all 31 IDs and source references, leaves the survivor ID unset, and proposes their eventual parent as the existing Belaerys Manse (`entity_cd230b5e-9c11-4c86-aa0c-064e9088b850`). Before selecting a survivor, compare state, inbound references, original sources, and historical identity. A count of source references alone is not a merge policy.

Two Black Walls records point to the same source at position 1410; one adds `seen from above as the dragon banks`. That source is marked parallel POV. Treat the camera wording as a reconciliation candidate, while preserving the distinction between the wall structure, the enclosed district, and particular gates.

Some candidate source IDs no longer resolve: five in the Veil candidate set and one in the separate campaign. Their IDs are listed in the inventory. Do not treat this as proof that all content on those records is invalid; inspect remaining source refs/import evidence and label unresolved evidence before repair.

**Concrete parent proposals**

| Existing place | Proposed containing place | Evidence and limitation |
| --- | --- | --- |
| Belaerys Manse | Volantis | Source at position 1204 and room sources establish city context. Resolve the Black Walls/Old City intermediate record before choosing the immediate parent. |
| Compound Yard (`entity_aeaa7184-68ce-4d21-89cd-854a2cf9db2b`) | Belaerys Manse | Source `narration_cb81253b-e2ab-46f8-85c2-3c580a4844d0`, position 1706, names the yard within the manse. |
| Upper sickroom (`entity_b815d12f-b8b7-4f31-bebf-5c3d452eea3f`) | Belaerys Manse | Source `narration_13c5cd25-b950-4200-bd14-e0727ccbb49f`, position 1330, names the sickroom within the manse. |

The machine-readable manifest supplies exact IDs and source headers. It is explicitly unapplied. An eastern palace, the Hall of the Archons, and Belaerys Manse must not be collapsed together without evidence. Missing intermediate locations remain unresolved rather than being invented to complete a visually tidy tree.

**The POV discrepancy now has a specific reproduction case**

Veil's last primary narration in the inspected tail is position 2495, `narration_7a5e4d7b-13d7-4cc7-9fd0-55dda3ac32b6`, at the eastern palace's first great courtyard in Volantis. The corresponding location entity is `entity_f5e3952f-a9b9-4d89-9ed6-57d32effe587`.

Positions 2497 and 2499 are explicitly marked `actionType: pov` with Mei-Lin as the parallel character, and their scene headers are in Yin. The stored current-location ID resolves to Yin's Hall of the Vermillion Steps. This is a concrete case for separating the primary actor's location from the active parallel scene; it does not justify discarding the Yin scenes.

Current source skips scene-checkpoint scheduling for a parallel turn, but the later immediate `applyValidatedTurnUpdate` boundary is gated only on OOC mode and receives no POV argument. The shared patch validator parses the narration anchor, and deferred processing also needs a scope audit. The implementation should protect the primary anchor at the common write boundary and retain source-scoped location information for the parallel actor. Simply changing the drawer label would leave the persistence problem in place.

The old campaign header's reference to Aurion's chambers is also behind the latest primary courtyard scene. A repair must use the latest verified primary scene, not blindly restore that header text. Recheck transcript/version before any write.

**Next implementation steps**

First reproduce identity ties, multiple exact candidates, and the primary/parallel scene case on disposable data. Then add the shared containment/lore contract and the city-to-manse-to-room context example. Use existing Volantis prose and accepted campaign facts to test that the city continues to govern a sublocation scene without requiring its name in the action.

The initial implementation plan remains intact. This audit supplies real pilot IDs, source evidence, compatibility requirements, and concrete failure cases. Live reconciliation still requires reference/state review and the user's instruction to execute the plan; it has not been applied by this planning continuation.
