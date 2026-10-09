# About Mtherios

Mtherios is a local-first AI text RPG engine for persistent campaigns. The player acts through a browser workspace; a terminal Node process owns backend-bound story state, generation, background processing, and local service integrations.

## What the player can do

Play a story, inspect characters and world records, edit lore and player capabilities, review memory and prompt context, and manage Plot Director pressure. The intended experience combines responsive narration with a world whose history and consequences remain inspectable.

## How a turn becomes durable

The server prepares scene and memory context, runs generation, saves transcript evidence, and processes validated state changes. Background jobs maintain retrieval projections, scene checkpoints, larger summaries, and readable wiki vaults. Records retain links to their sources.

PostgreSQL holds authoritative campaign records. Qdrant and pgvector support search; Markdown provides a readable projection; IndexedDB supports client caching and compatibility. The browser displays and edits state through server contracts. Offline shell/content access does not imply offline narrative generation.

## Technology and documentation

The stack uses SvelteKit/Svelte 5, Node, TypeScript, Zod, Drizzle, PostgreSQL/pgvector, Qdrant, Dexie, and Vitest. Model routing is configurable; project documentation does not select a narrator provider or model.

- [AGENTS.md](../AGENTS.md): how to work in the repository.
- [Architecture task map](ARCHITECTURE.md): where to investigate a specific task.
- [Main architecture](../ARCHITECTURE.md): current source responsibilities and system boundaries.
- [Vision](VISION.md): product priorities and evaluation goals.
- [README](../README.md): setup and user-facing project introduction.

This overview was reviewed on 2026-09-12. Feature existence in source and behavior verified in a running release are separate claims.
