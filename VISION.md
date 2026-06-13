# Mtherios Vision

Mtherios is a local-first, terminal-owned text RPG engine for long campaigns that should feel alive without becoming bloated, fragile, or dependent on a browser tab holding the whole world in memory.

The goal is not to build another chat wrapper. The goal is to build a game engine where AI agents, world state, rules, factions, NPC memory, lore, and continuity all operate through a durable backend runtime. The browser is important, but it is only the control surface: a place to play, inspect, steer, and debug the campaign. The terminal Node process is the owner of canon.

## North Star

Mtherios should let a player run a long-form text RPG campaign for thousands of turns while the world keeps moving.

Characters should have stable personalities, appearances, relationships, beliefs, secrets, and changing motives. Factions should hold resources, pursue projects, make alliances, betray rivals, lose territory, recover from setbacks, and act on delayed plans. The game master should not need to stuff the entire past into every prompt. Instead, the engine should query compact, evidence-backed state from a campaign database, event log, timeline, lore graph, memory index, and generated markdown vault.

The player-facing experience should remain simple: type what you do, say, think, or inspect, then receive first-person RPG narration that respects the campaign. The machinery behind that moment can be complex, but it should serve one purpose: keep the fiction coherent, responsive, and playable.

## Core Belief

Canon belongs in the backend.

The transcript is evidence. Markdown vaults are readable projections. Qdrant is a rebuildable search index. Browser IndexedDB is a cache and command queue. None of those should become the true source of the campaign. The source of truth is the terminal-owned campaign database plus append-only evidence and explicit state transitions.

This distinction matters because long campaigns fail when everything becomes one giant blob: one huge JSON file, one giant prompt, one frontend store, one pile of memories, or one vague lorebook. Mtherios should move in the opposite direction: small records, indexed events, bounded projections, source-linked memories, and background jobs that keep derived views fresh.

## Desired Architecture

The long-term shape is:

```text
Frontend control surface
        |
        v
API gateway / WebSocket stream
        |
        v
Terminal Node runtime
        |
        +--> CLI and shell tools
        +--> AI orchestrator
        +--> DM / narrator agent
        +--> rules referee agent
        +--> state scribe agent
        +--> lorekeeper agent
        +--> faction simulator agent
        +--> NPC memory agent
        +--> continuity auditor agent
        |
        v
Campaign database and vault
        |
        +--> event log
        +--> current state snapshots
        +--> lore graph
        +--> vector memory index
        +--> rules packs
        +--> character sheets
        +--> faction projects and resources
        +--> timers, clocks, and schedules
```

The frontend should not duplicate the engine. It should send commands, render streamed narration, show current projections, expose diagnostics, and let the player inspect or repair state. The same backend should serve the browser, CLI tools, shell commands, and future agents.

## Game Feel

Mtherios should remain a text RPG first.

Narration should be first-person POV, immediate, playable, and grounded in what the protagonist can perceive. It should not sound like a writing assistant explaining prose decisions. NPCs should not act on secret knowledge unless they have a source for it. Factions should not move randomly just to create noise. The world should feel causal: people act because they want things, fear things, know things, or misread things.

A good turn should answer the player action, show consequences, preserve agency, and leave the next choice clear.

## Living World Model

The world should be event-based, not memory-bloated.

Important happenings become canonical events. Events can be immediate, delayed, scheduled, proposed, hidden, public, local, or faction-linked. NPCs and factions attach to events as actors, witnesses, targets, knowers, beneficiaries, victims, or rumor carriers. This creates memory without dumping the whole transcript into the prompt.

Examples:

- A faction starts a marriage pact that becomes due in two turns.
- A spy learns partial information but misidentifies the patron.
- A merchant house spends coin and influence to blockade a harbor.
- An NPC changes loyalty because of a witnessed betrayal.
- A rumor spreads slowly through locations and factions instead of appearing everywhere instantly.

The game master agent should query the timeline and current state, not inhale the whole campaign.

## Continuity

Continuity should be enforced through evidence, not vibes.

Every important state change should answer: what caused this, who knows it, where is the source, and whether it is player-known or secret. If the narrator says a lord is dead, married, exposed, promoted, wounded, or betrayed, that claim should become an event or be checked against existing canon. If a character changes belief or loyalty, the change should cite an event or transcript entry.

The continuity auditor should eventually become a real background agent. It should compare narration, extracted state, current canon, NPC knowledge, faction projects, and timeline receipts. It should flag contradictions before they become permanent, or create repair proposals when the campaign has already moved on.

Continuity must be led by a patch proposal ledger:

- Every extracted fact, event, belief, relationship, and warning should create a `patchProposals` record with operation paths, affected entities, confidence, reason, and source reference pointers.
- Canonical rows stay as the runtime truth, but reviewable proposals remain the human-facing surface for continuity audits.
- The engine should never treat continuity changes as silently accepted facts; proposals and warnings must be visible before they are considered merged in narrative decisions.

## Factions

Factions should be actors, not flavor text.

Each faction needs durable resources, pressure, goals, members, territory, relationships, and projects. A faction project is a delayed or ongoing plan with costs, gains, risks, progress, priority, visibility, and due turns. This lets the world move between player actions without turning every faction into a giant prompt paragraph.

Faction behavior should be constrained by resources and knowledge. A poor faction should not buy armies from nowhere. A secret alliance should not influence an NPC who never learned of it. A desperate faction should take different risks than a stable one.

## Efficiency

The engine should generate now and reconcile richly later.

The player-facing turn path should stay small:

1. Validate and reserve the turn.
2. Load only required context.
3. Start narration as quickly as possible.
4. Persist the result.
5. Return a minimal projection.

Everything else should orbit the turn in background jobs: state extraction, vault sync, timeline promotion, memory refresh, projection rebuilds, faction simulation, wiki indexing, and continuity audits.

Context should be budgeted and inspectable. Each turn should be able to report what was included, what was skipped, what was truncated, and why. Stable prompt segments, rules, character sheets, lore briefs, tool schemas, and retrieved chunks should be cacheable by hash. Provider prompt caching can help, but the system should not depend on any one provider feature.

The first performance target is a campaign with 10,000 turns where the frontend still opens quickly and the backend still assembles bounded prompts.

## Markdown And Database

The campaign store should be hybrid.

Postgres should own queryable canon, indexes, locks, snapshots, jobs, and command idempotency. Markdown should make the campaign inspectable and portable: append-only raw evidence, generated character pages, faction pages, lore pages, rule pages, chapter pages, arc pages, and timeline pages. The markdown vault should be readable by humans and agents, but generated story vaults should remain projections from backend canon.

This is the compromise that fits the project: the database gives correctness and query speed; markdown gives transparency, portability, and long-term maintainability.

## Agent Philosophy

The multi-agent layer should be practical, not theatrical.

Agents should exist when they own a distinct job:

- The narrator resolves the immediate player-facing scene.
- The rules referee checks mechanics and constraints.
- The state scribe extracts durable changes.
- The lorekeeper maintains world knowledge and markdown pages.
- The faction simulator advances strategic actors.
- The NPC memory agent updates beliefs and personal continuity.
- The continuity auditor catches contradictions.

These agents should communicate through backend tools, events, jobs, and database records. They should not all talk in the critical path of every turn. The orchestrator decides what must happen now and what can happen later.

## Campaign Forge

Mtherios should eventually include a campaign creation and audit layer inspired by World-Forge, adapted to Mtherios' backend-canon architecture instead of SillyTavern's card-and-lorebook runtime.

The useful lesson is not to copy SillyTavern exports. The useful lesson is process architecture: take a rough world idea, refine it into structured canon, separate permanent truths from temporary arc state, validate the result, and only then let the narrator play inside it.

A Campaign Forge flow should produce:

- A World Seed that captures the premise, tone, protagonist role, core conflict, major factions, locations, secrets, constraints, and test scenarios.
- A Style Contract that defines POV, tense, narration register, formatting rules, dialogue behavior, and any per-story narrator constraints.
- Tiered canon records: world truths, character truths, player identity references, faction doctrine, current arc state, and sandbox standing state.
- NPC voice sheets that preserve behavior, psychology, relationships, trigger responses, knowledge limits, and verbal texture.
- Faction doctrine and starting projects so political actors begin with goals, resources, risks, timelines, and pressure.
- Initial arcs, clocks, rumors, unresolved hooks, and hidden information boundaries.
- Audit reports for continuity, voice distinctiveness, arc transition risk, tier integrity, prompt risk, and missing world structure.

The tiering model should map cleanly onto the backend database:

- Tier 1: permanent, arc-agnostic world canon such as cosmology, rules, history, geography, cultures, factions, institutions, species, and major concepts.
- Tier 2: permanent actor canon such as character baselines, relationships, reputation, psychology, physical traits, secrets, and knowledge boundaries.
- Tier 3: current play state such as active arcs, faction projects, local tensions, temporary NPC states, recent consequences, active rumors, and scheduled events.

For sandbox campaigns, Tier 3 can collapse into an always-active standing state instead of a sequence of planned arcs. The important part is that current situation stays separate from permanent identity.

Campaign Forge should use specialized backend jobs rather than one giant generation pass:

- The Interviewer asks for missing playable details and pushes back on thin material.
- The Refiner classifies the seed into tiers, finds contradictions, and locks the design.
- The Architect drafts database-ready canon records, faction plans, NPC sheets, and initial timeline events.
- The Editor checks tier integrity, duplicate facts, weak entries, and runtime usability.
- The Voice Auditor samples NPC dialogue and checks whether characters remain distinct under pressure.
- The Arc Transition Auditor checks continuity across chapter and arc boundaries.
- The Prompt Auditor checks whether generated canon will fit the narrator prompt without leaking secrets, bloating context, or overriding engine rules.

This should remain terminal-owned. The browser can provide a guided creation UI, progress view, inspector, and repair controls, but the backend owns the records, audit state, and final commit into canon.

## What This Project Is Not

Mtherios is not a frontend-only Svelte app.

It is not a SillyTavern clone with a larger memory box. It is not a single prompt that pretends to be a game engine. It is not a giant JSON save file that grows until the app breaks. It is not a place where browser IndexedDB becomes the limit of the world.

Mtherios should use the browser beautifully, but the soul of the system is the local terminal runtime.

## What Success Looks Like

Success is a campaign that can run for months.

The player can return to a story and the world still makes sense. NPCs remember what they should remember and remain ignorant of what they never learned. Factions act from resources, pressure, and strategy. The narrator can write a vivid first-person scene without losing the thread. The frontend loads bounded projections instead of swallowing the whole campaign. The terminal process can explain what it used, what it skipped, what it cached, and what changed.

The final feeling should be this:

You are not chatting with a model.

You are playing inside a persistent world, and the machine under the table is quietly keeping score.
