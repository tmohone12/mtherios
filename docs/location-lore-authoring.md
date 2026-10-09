# Authoring locations and scoped lore

Use a location's **How this place works** panel in World Explorer for city identity, government, access, customs, economy, religion and historical rules. Its overview remains the readable article. Add important operational facts with an explicit scope so scenes inside its sublocations retain the same established world.

**Containing place** links a location to one physical parent. Opening a parent or child is navigation; it does not move the player. Routes, ownership and government remain separate relationships. Choose the nearest established containing place; do not invent an intermediate district or treat a conquered city as being physically inside its capital.

Each rule belongs to its location. Choose **This place and its sublocations** for inherited context or **This place only** for a local detail. **Campaign canon** describes events or reforms established in this campaign; **Setting foundation** describes sourced setting material. Historical imports never override a later campaign reform. Distinguish enforced law from social expectation and describe conditions explicitly.

An exception names the inherited rules it qualifies and states its conditions. Both the base rule and exception remain visible. An invitation may satisfy a restriction for a particular actor; it does not repeal the city's rule. Changing a rule creates a new fact with source links and closes the earlier version's validity interval. Effective dates use campaign turns, not transcript positions.

For full world database bundles, use these existing tables:

```json
{
  "entities": [
    { "id": "city", "type": "location", "name": "Example City", "description": "A sourced account of how this city works.", "state": { "locationKind": "city" } },
    { "id": "room", "type": "location", "name": "Example Reception Room", "state": { "locationKind": "room" } }
  ],
  "relationships": [
    { "id": "room_in_city", "sourceEntityId": "room", "targetEntityId": "city", "type": "part-of", "bidirectional": false }
  ],
  "facts": [
    {
      "id": "admission_rule", "subjectEntityId": "city", "type": "identity", "title": "Admission", "statement": "Illustrative fixture: entry requires sponsorship except for invited guests.",
      "status": "active", "visibility": "player_known", "sourceEntryIds": ["actual_source_entry"],
      "metadata": { "validFromTurn": 12, "locationLore": { "version": 1, "category": "access", "scope": "descendants", "origin": "campaign", "salience": "core", "exceptionToFactIds": [] } }
    }
  ]
}
```

This is a shape example, not Volantis canon. Replace illustrative statements and source IDs with actual evidence. Keep import provenance and URLs for setting sources; do not invent transcript IDs for books or wiki material. Full imports remap location IDs, containment endpoints, rule owners, `exceptionToFactIds`, `supersedesId(s)` and source IDs together. Legacy untagged facts remain readable and can be scoped through **Existing lore and history**.

Supported location kinds: region, city, district, site, building, room, wilderness, other. Lore categories: identity, geography, governance, law, access, custom, economy, religion, history. Scope and metadata are versioned and strictly validated. Do not persist another `parentId` inside location state.

The engine commands are `world.location.get` (location ID, optional historical turn and child cursor) and `world.location.save` (location ID, expected story revision, optional parent, kind or one lore revision). Writes reject stale revisions and invalid ancestry. The normal prompt uses a bounded chain and whole canonical rules; the context receipt reports containing places and location lore retained after the final token budget.
