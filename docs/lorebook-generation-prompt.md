# Lorebook Generation Prompt

Copy this prompt into an LLM when you want it to build a lorebook from story notes, chapters, wiki text, setting documents, or raw narrative.

```text
You are a lorebook architect for an interactive fiction app.

Your task is to read the provided source material and create a structured lorebook containing important characters and factions. The lorebook will be used by another AI narrator to maintain continuity over a long story, so the entries must be compact, factual, searchable, and useful during generation.

Return ONLY valid JSON. Do not include Markdown, comments, explanations, trailing commas, or prose outside the JSON.

Create this exact top-level shape:

{
  "lorebook_entries": []
}

Each entry in "lorebook_entries" must be either a character entry or a faction entry.

Do not create entries for every name. Create entries only for characters and factions that matter to continuity, politics, relationships, secrets, conflict, power, future consequences, or recurring scenes.

Do not duplicate entities. If one person or faction appears under multiple names, create one canonical entry and put the other names in aliases and keywords.

Use only facts supported by the source material. If a detail is unknown, use null, [], "unknown", 0, or a neutral default. Do not invent facts to fill the schema.

Keep secrets separate:
- Put public or protagonist-known facts in "description".
- Put narrator-only facts, hidden motives, unrevealed loyalties, and secrets in "hidden_info".
- If no hidden information is established, use null.

Character entry shape:

{
  "name": "Canonical character name",
  "type": "character",
  "description": "2-5 concise sentences. Include identity, role, visible traits, current situation, important relationships, and why this character matters.",
  "hidden_info": null,
  "aliases": ["Alternate name", "Title", "Nickname"],
  "keywords": ["canonical name", "alias", "faction", "location", "distinctive term"],
  "injection_mode": "keyword",
  "priority": 0,
  "state_overrides": {
    "isPresent": false,
    "lastSeenLocation": null,
    "currentDisposition": null,
    "relationship": {
      "level": 0,
      "status": "neutral",
      "history": []
    },
    "knownFacts": [],
    "revealedSecrets": [],
    "conversationTopics": [],
    "lastConversationAt": null,
    "personalOpinion": null,
    "bio": null,
    "motivations": [],
    "personality": null,
    "pressures": []
  }
}

Character field rules:
- "name" is the stable display name.
- "description" should be useful to an AI narrator during a scene.
- "aliases" should include titles, surnames, nicknames, false names, house names, or common references.
- "keywords" should be 3-8 searchable strings likely to appear in story text.
- "injection_mode" should usually be "keyword". Use "always" only for the protagonist, central companion, or main antagonist. Use "never" only for archived or intentionally inactive entries.
- "priority" should usually be 0. Use higher numbers only for central entities.
- "isPresent" means physically present in the current scene if the source material has a current scene; otherwise false.
- "lastSeenLocation" is a location name when known, otherwise null.
- "currentDisposition" is the current emotional or social posture, such as "loyal", "guarded", "afraid", "hostile", "curious", "grieving", "ambitious", or null.
- "relationship.level" is the character's relationship to the protagonist from -100 to 100.
- "relationship.status" is a short label such as "neutral", "ally", "enemy", "wary ally", "hostage", "rival", "family", "lover", "patron", "servant", or "unknown".
- "knownFacts" are facts known by the protagonist or generally established in narration.
- "revealedSecrets" are secrets already revealed to the protagonist.
- "bio" is a brief background summary.
- "motivations" are concrete wants, fears, ambitions, debts, loyalties, or needs.
- "personality" is a concise behavior summary.
- "pressures" are active problems or incentives that could make the character act offscreen.

Faction entry shape:

{
  "name": "Canonical faction name",
  "type": "faction",
  "description": "2-5 concise sentences. Include public identity, power base, leadership if known, current stakes, enemies/allies if known, and why this faction matters.",
  "hidden_info": null,
  "aliases": ["Alternate name", "Short name", "Title"],
  "keywords": ["canonical name", "alias", "leader", "region", "distinctive term"],
  "injection_mode": "keyword",
  "priority": 0,
  "state_overrides": {
    "playerStanding": 0,
    "status": "unknown",
    "knownMembers": [],
    "goals": [],
    "resources": {
      "military": 50,
      "wealth": 50,
      "influence": 50,
      "information": 50,
      "morale": 50
    },
    "disposition": "neutral",
    "interFactionRelations": {},
    "territory": []
  },
  "known_members": [],
  "faction_goals": [],
  "faction_resources": {
    "military": 50,
    "wealth": 50,
    "influence": 50,
    "information": 50,
    "morale": 50
  },
  "faction_disposition": "neutral",
  "territory": []
}

Faction field rules:
- "name" is the stable display name.
- "status" must be one of: "allied", "neutral", "hostile", "unknown".
- "playerStanding" is the faction's current stance toward the protagonist from -100 to 100.
- "knownMembers" and "known_members" should list character names when IDs are unavailable. Include leaders, rulers, agents, commanders, family members, envoys, champions, or public representatives.
- "faction_disposition" and state_overrides.disposition must be one of: "aggressive", "defensive", "scheming", "neutral", "desperate".
- "territory" should list controlled regions, castles, cities, institutions, routes, fleets, companies, offices, or bases of power.
- "faction_resources" scores are relative 0-100 values:
  - military: armed strength
  - wealth: money, supplies, economic depth
  - influence: political or social leverage
  - information: spies, intelligence, secrecy, awareness
  - morale: cohesion, loyalty, confidence, internal stability
- Use 50 as the neutral/default resource score when evidence is limited.

Faction goals must use this shape:

{
  "description": "Concrete objective the faction is pursuing",
  "priority": 5,
  "progress": 0,
  "type": "diplomatic",
  "deadline": null
}

Faction goal rules:
- "priority" is 1-10.
- "progress" is 0-100.
- "type" must be one of: "military", "diplomatic", "economic", "intelligence", "survival", "expansion".
- "deadline" is a narrative deadline such as "before winter", "before the coronation", "within three days", or null.
- Prefer 1-3 strong goals over many weak goals.

Inter-faction relation values may be simple numbers from -100 to 100, or objects:

{
  "standing": 0,
  "affinity": 0,
  "history": [
    {
      "event": "Short reason for the relation",
      "delta": 0,
      "chapter": 0
    }
  ]
}

Relation rules:
- standing is the current political temperature from -100 to 100.
- affinity is deeper trust or compatibility from -100 to 100.
- history should be short and only include established events.
- If relationships are unclear, leave "interFactionRelations" as {}.

Output quality rules:
- Write entries so a future AI can immediately use them in narration.
- Make descriptions dense but not bloated.
- Prefer durable facts over scene-by-scene detail.
- Include active consequences, debts, oaths, grudges, hostages, marriages, betrayals, wounds, titles, claims, and secrets when established.
- Keep known facts and hidden facts separate.
- Do not create placeholder entries.
- Do not create empty entries for irrelevant background names.
- Do not include locations, items, concepts, or events unless they are part of a character or faction description.
- If the source material is huge, prioritize central recurring characters, major factions, and entities with unresolved pressure.

Before finalizing, silently check:
1. Is the output valid JSON?
2. Does every entry have name, type, description, hidden_info, aliases, keywords, injection_mode, priority, and state_overrides?
3. Are all character entries type "character"?
4. Are all faction entries type "faction"?
5. Are status, disposition, and goal type enum values valid?
6. Are secrets kept out of public descriptions?
7. Are duplicate names merged into one entry?

SOURCE MATERIAL:
{{SOURCE_MATERIAL}}

OPTIONAL EXISTING LOREBOOK ENTRIES TO UPDATE OR AVOID DUPLICATING:
{{EXISTING_LOREBOOK_ENTRIES}}
```

## Short Version

```text
Create a character and faction lorebook from the source material. Return only valid JSON shaped as { "lorebook_entries": [...] }.

Each entry must be either type "character" or type "faction". Create entries only for important recurring or consequential entities. Merge duplicates under one canonical name and put alternate names in aliases and keywords. Use only established facts. Put public/protagonist-known facts in description and hidden narrator-only facts in hidden_info.

Character entries need: name, type, description, hidden_info, aliases, keywords, injection_mode, priority, state_overrides with isPresent, lastSeenLocation, currentDisposition, relationship { level, status, history }, knownFacts, revealedSecrets, conversationTopics, lastConversationAt, personalOpinion, bio, motivations, personality, pressures.

Faction entries need: name, type, description, hidden_info, aliases, keywords, injection_mode, priority, state_overrides with playerStanding, status, knownMembers, goals, resources, disposition, interFactionRelations, territory, plus known_members, faction_goals, faction_resources, faction_disposition, territory.

Valid faction status: allied, neutral, hostile, unknown.
Valid faction disposition: aggressive, defensive, scheming, neutral, desperate.
Valid goal type: military, diplomatic, economic, intelligence, survival, expansion.
Relationship and standing scores are -100 to 100. Resources are 0 to 100.

SOURCE MATERIAL:
{{SOURCE_MATERIAL}}

EXISTING ENTRIES:
{{EXISTING_LOREBOOK_ENTRIES}}
```
