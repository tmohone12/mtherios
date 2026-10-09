# Architecture task map

Use this index when choosing where to investigate. [Root AGENTS.md](../AGENTS.md) contains the working agreement; [ARCHITECTURE.md](../ARCHITECTURE.md) contains the maintained system reference. This file routes to those owners instead of maintaining a second source map.

## Find the relevant boundary

| Task or symptom | Read next | Establish before changing behavior |
| --- | --- | --- |
| Startup, wrong process, wrong data directory | [Runtime and entrypoints](../ARCHITECTURE.md#runtime-and-entrypoints) | Selected checkout, actual URL/data root, dependency health |
| Narration, context size, model/reasoning settings | [Server turn and prompt flow](../ARCHITECTURE.md#server-turn-and-prompt-flow) | Saved example, effective override/pack/provider, prepared versus sent request |
| Missing recall, stuck processing, summaries | [Memory and durable processing](../ARCHITECTURE.md#memory-retrieval-and-durable-processing) | Source coverage, retained records, stage/version of any gap |
| Character edits, player abilities, MCP consistency | [Canonical world editing](../ARCHITECTURE.md#canonical-world-editing) | Canonical ID, accepted update contract, persistence and projection |
| Containing places, city rules, inherited context | [Locations and inherited lore](../ARCHITECTURE.md#locations-and-inherited-lore) | Containment edges, scoped facts, campaign turn, revision |
| Repeated/ignored plot pressure, faction decisions | [Director and factions](../ARCHITECTURE.md#plot-director-and-autonomous-factions) | Pending/applied frame, lifecycle, source events, eligible actors |
| Wiki search, portable saves, historical imports | [Vaults and portability](../ARCHITECTURE.md#vaults-imports-and-portability) | Canon versus projection, embedding configuration, bundle identity mapping |
| UI cache, offline/PWA, mobile keyboard | [Browser boundaries](../ARCHITECTURE.md#browser-and-offline-boundaries) | Server value, client projection, rendered behavior/device evidence |
| Benchmarks, qualification, activation | [Evaluation and release](../ARCHITECTURE.md#development-evaluation-and-release-evidence) | Mode side effects, tested artifact, actual acceptance gates |

## Read documentation according to its role

- [PROJECT_ABOUT.md](PROJECT_ABOUT.md): what the product does and who it serves.
- [VISION.md](VISION.md): desired outcomes and tradeoffs; it is not an implementation queue.
- [Location authoring](../docs/location-lore-authoring.md): the specific authoring contract and examples.
- [Dated harness plan](../docs/agent-harness-implementation-plan-2026-09-06.md): historical planning scope.
- [Dated release evidence](../docs/agent-harness-release-path-2026-09-07.md): what a particular qualification run established.

Follow only the links relevant to the task. Verify a dated claim against current source/runtime before relying on it.
