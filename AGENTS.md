# Working in MythEngine

Repository-wide guidance for Codex. This file owns the working agreement; [ARCHITECTURE.md](ARCHITECTURE.md) owns the source map and system boundaries. Working agreement inherited from 2026-09-12; project identity updated 2026-09-21.

## Work from the requested outcome

Carry an implementation or repair through to the requested observable result. Choose routine implementation details from the current code and session context. Ask only when missing information materially changes the result or authorization; continue independent work while waiting. A plan request produces a plan, and a review remains read-only unless fixes are requested.

Treat follow-up corrections as steering for the active task. Keep completed work and relevant decisions when resuming a long task. Do not expand a focused fix into a subsystem rewrite, campaign repair, or release. Existing user authorization remains valid within its scope.

Keep updates concise: what was learned, what is changing, and what remains uncertain. Finish with the result, meaningful verification, and any unresolved limitation.

## Load only the context the task needs

Check `git status --short` before editing; this checkout often contains substantial unrelated work. Preserve it and stage only intentionally selected files when committing is requested.

Use [the task map](<AGENTS READ THIS/ARCHITECTURE.md>) when the owner is unclear, then read the relevant architecture section, implementation, callers, contracts, and tests. Do not load every Markdown file or dated report as a prerequisite. Use the current implementation to check documentation; an old report is evidence about its recorded run, not a current requirement or an active task.

For runtime-dependent work, use `npm run app:status`, the relevant API/record, persisted settings, and rendered behavior. For source-only or documentation work, inspect source directly; running services are not a prerequisite. The current working directory and returned runtime data root can differ: verify both before targeting data.

## Preserve these system boundaries

- PostgreSQL owns backend-bound campaign state. Transcript/import records are evidence; Markdown vaults, vector indexes, and browser storage are derived or compatibility layers.
- Keep accepted canon, NPC belief, historical evidence, future intent, and GM/OOC instructions distinct. Preserve source links, visibility, and parallel-POV boundaries.
- Use the existing server contracts and canonical writes across browser, CLI, and MCP. Validate model output before committing it; a draft is not applied state.
- Fix the shared owner of a behavior and check affected consumers. Backend turns use server preparation; browser-only prompt changes do not change that pipeline.
- Preserve explicit update semantics: omitted capability lists retain values, `[]` clears them; location containment uses directed `part-of` relationships and lore uses scoped, versioned facts.
- Preserve pending versus activated Director state. Snapshot import does not advance the world; transcript deletion does not rewind accepted canon; offline drafts do not authorize turn replay.

Use existing services and dependencies where they fit. Add a new abstraction or dependency only when the requested behavior has a concrete need the current stack does not meet.

## Verify the requested behavior

Choose the smallest sufficient set of checks, following any applicable repository/CI requirements:

| Change | Evidence to obtain |
| --- | --- |
| Markdown | Valid links, paths, examples, skill frontmatter where applicable, and `git diff --check` |
| Server logic or contracts | Relevant tests (`npm test -- <file>`), affected callers, and type checks when types change |
| UI or settings | Relevant tests/checks, rendered behavior, and saved server value when persistence matters |
| Prompt, retrieval, or provider routing | Built packet/effective settings, focused behavior tests, and retained-source or request evidence |
| Runtime artifact or release | Build, actual process/artifact identity, health and changed live behavior; recovery evidence as the scope requires |

`npm run check` runs Svelte/TypeScript checks; `npm run build` produces the application artifact. Passing focused tests is not proof of live deployment. Broaden or repeat checks when changes, failures, or unresolved concerns justify it; once sufficient checks pass, finish the task.

Use preview for preparation evidence. A completed turn's receipt/API logs establish the sent request. Coverage, checkpoint/consolidation freshness, vault freshness, and index freshness are separate signals. Benchmarks that submit turns, retry jobs, or import campaigns have side effects; inspect the mode and keep execution within the task's scope.

## Maintain the documentation at its owner

Change this file for working agreements, [ARCHITECTURE.md](ARCHITECTURE.md) for implementation responsibilities, [VISION.md](<AGENTS READ THIS/VISION.md>) for product priorities, and a dated report for run-specific evidence. Link between them instead of copying the same instructions. Keep plans labeled as plans and implementation claims tied to source.

The optional installed `mtherios-project` skill adds cross-checkout discovery and operational recipes. This repository must remain understandable without that machine-local skill. Session instructions and user scope govern tool availability, model choice, and delegation; these docs do not set model/provider defaults.
