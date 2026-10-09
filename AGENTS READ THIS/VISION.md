# Mtherios vision

Product direction reviewed 2026-09-12. This document describes desired outcomes and tradeoffs. [ARCHITECTURE.md](../ARCHITECTURE.md) describes current source; dated plans and release reports record specific work and evidence.

## The experience to build

A long campaign should retain its history, relationships, unresolved commitments, and consequences while the player remains free to act. The narrator should respond to what happened in the scene, keep characters distinct, and let factions pursue plausible interests without forcing a predetermined plot.

The user should be able to understand and edit the world through visible controls. When continuity fails, the system should reveal the source, accepted state, processing stage, and context that produced the response.

## Priorities for design decisions

1. **Durable continuity.** Preserve source-linked facts, commitments, relationships, and consequences across long campaigns, imports, retries, and repairs.
2. **Useful immediate context.** Retain the current action, scene, active actors, and relevant exchanges. Select older evidence deliberately. Choose dialogue and memory budgets from the scene, user settings, and model limits rather than a fixed number of exchanges.
3. **Player and NPC agency.** Keep narrator authority, player intent, NPC knowledge, private belief, and Director plans distinct. Make corrections affect behavior without turning OOC instructions into witnessed events.
4. **Editable, inspectable controls.** Let the user see what is saved, pending, selected, omitted, stale, or failed and act through the same validated data paths.
5. **Measured efficiency.** Improve latency, cost, and caching after identifying the expensive stage and preserving continuity quality.

These priorities guide choices within the user's requested scope. They do not authorize implementing the entire roadmap during a focused task.

## Architectural commitments

PostgreSQL remains the authority for backend-bound campaigns. Evidence and accepted state keep stable identity and provenance. Markdown vaults, embeddings, and browser caches remain rebuildable projections or compatibility layers.

Extend existing prompt, retrieval, extraction, consolidation, Director, and canonical-edit paths when they can express the behavior. Introduce an additional service, agent, model call, or abstraction only when a concrete requirement and evidence justify it.

Generation quality is not determined by model size alone. Resolve model/provider settings explicitly, validate structured outputs, and evaluate support-model work against its assigned task. Keep model-generated proposals separate from the backend decision to apply them.

## Current foundation and remaining proof

The source already includes shared server preparation, bounded prompt sections and receipts, scene checkpoints, extraction coverage, chapter/arc/saga processing, replay/benchmark tools, and inspection controls. Their presence is a foundation for improvement, not a declaration that all campaign behaviors or release gates pass.

Evaluate future changes with representative campaign scenarios: a recalled promise, a secret an NPC has not learned, a corrected fact, an inherited location rule, a pending Director frame, and recovery after interrupted processing. Compare the source evidence, saved result, context sent, and observable behavior. Record costs and latency when relevant, and separate simulated UI evidence from physical-device validation.
