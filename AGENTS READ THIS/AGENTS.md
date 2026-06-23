# Agents Read This First

This folder is the short handoff for future agents. Read these files before making architecture, prompt, memory, or model-routing changes.

## Prime Rule

Postgres backend canon is the source of truth.

Do not treat transcript text, generated markdown, Qdrant, or IndexedDB as canon. They are evidence, projections, indexes, and caches.

## Working Rules

- Check the current repo state before editing.
- Do not revert unrelated dirty files.
- Keep changes scoped to the requested slice.
- Prefer existing services, schemas, and route patterns.
- Add no new dependency for what TypeScript, Zod, Drizzle, or SvelteKit already does.
- Use strict schemas at trust boundaries.
- Keep AI output proposal-only unless a validated backend path commits it.
- If settings matter, expose them in the visible settings/control surface.

## Commands

Use PowerShell from the repo root.

```powershell
npm run app:status
npm run app:dev
npm run check
npm test
npm run build
```

For focused Vitest runs:

```powershell
npm test -- path/to/test.test.ts
```

## Runtime Truth

Fast checks:

- `npm run app:status`
- `http://127.0.0.1:5173/api/health`
- `http://127.0.0.1:5173/api/app/status`

If `app:status` says `fetch failed`, the app is usually not listening yet. Start `npm run app:dev`, wait for port `5173`, then retry.

## Canon Flow

```text
player action / import / backend edit
  -> transcript or source evidence
  -> AI proposes structured changes
  -> Zod/schema validation
  -> backend canon rows and source refs
  -> generated vault/search projections
  -> frontend projection
```

Never skip the validation boundary.

## Prompt Work

The desired direction is one canonical server prompt compiler:

- typed sections
- explicit budgets
- source IDs
- stable prefix hashing
- dynamic tail separation
- provider cache telemetry

Avoid adding another prompt kitchen. If an old browser-side generation path conflicts with server orchestration, prefer the server path for backend-bound stories.

## Context Work

Prefer scene-aware retrieval:

- present entities first
- active beliefs, relationships, goals
- relevant facts and memories
- small recent transcript window
- source-linked wiki material as untrusted data

Do not solve context bloat by raising token limits first. Measure what was included, skipped, truncated, and why.

## Model Work

Small models may draft, classify, compress, and critique. They do not own canon.

The expected pattern:

```text
small model result
  -> strict schema
  -> warnings/proposals
  -> human or backend validator
  -> canon only through existing validated write path
```

## Dirty Worktree Rule

This repo often has unrelated logs, evals, or active branch work. Stage intentionally:

```powershell
git status --short
git diff --cached --name-status
git diff --cached --check
```

Never broad-stage just because a task is done.

## Useful Docs In This Folder

- `VISION.md`: product and intelligence-layer direction
- `ARCHITECTURE.md`: compact runtime architecture
- `PROJECT_ABOUT.md`: plain-language overview

Top-level `ARCHITECTURE.md` remains the large reference. This folder is the quick-read agent entrance.
