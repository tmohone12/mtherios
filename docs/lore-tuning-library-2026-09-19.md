# Lore tuning and library navigation — 2026-09-19

Implemented in the existing server preparation and browser components; served by the production process at http://127.0.0.1:5173 (PID 43356, data root E:/DEV/Projects/mtherios-master/data).

## Behavior

- The home library displays shelf cards. Opening a shelf displays its stories, and All shelves returns to the shelf collection. The Shelves sidebar button also resets the library to its shelf view.
- Chapters and arcs are available inside the opened story, initially on Chapters and scoped to that story. The global Chapters and Canon review tabs are removed.
- The shared party/NPC portrait uploader accepts image files through 3,000,000 bytes and rejects larger files.
- Ordinary narrative preparation searches setting lore using the action, POV location and containing places. OOC instructions still bypass this step.
- Automatic context selects up to 8 world-lore seeds before the search result cap, follows linked pages up to 12 pages, allows 2,400 characters per page and 24,000 overall. Both retrieval and prompt assembly use the expanded allowance; final model budgeting still applies.
- Explicit GM searches continue to cover the full campaign vault and canonical records. The enabled Active Recall service can search lore, follow links and read a discovered page in a second round. Planner sanitization now retains canonical record types and wiki paths while excluding caller-supplied campaign/vault overrides. Observation limits are 12,000 characters per result and 24,000 total.

## Evidence

- 97 focused Vitest tests passed across turn orchestration, prompt assembly, library actions and workspace controls, including the exact 3 MB boundary and a search-then-read lore workflow.
- 2 Node tests passed for pre-cap world-lore selection and semantic layer filtering while preserving canonical-vector isolation.
- `npm run check`: 0 errors, 0 warnings. Production build passed. `git diff --check` passed.
- Browser verification: shelf cards at home; the selected shelf displays The Journey; its Chapters panel loads 28 chapters and 2 arcs without a cross-story selector. No Chapters or Canon review tab appears in the global sidebar.
- Read-only preview for The Journey, `I walk through the market.`: before tuning, 0 wiki blocks; after tuning, 1 fully retained block, no partial/omitted wiki block and no degraded-source warning. Preparation measured 1,209 ms before and 5,996 ms after in these individual runs, not a benchmark.
- Live context search using the production runtime: 8/8 seeds are world-lore pages, 12 linked pages, 22,114 characters, no semantic search error.
- Actual Active Recall settings were checked: enabled. No narrative turn was submitted to test these changes; preview demonstrates prepared context, while the deterministic tests establish the tool boundary and follow-up reading behavior.

Local run outputs: `.codex-run/lore-preview-before.json`, `lore-preview-final.json`, `lore-context-final.json`, `lore-ui-tests.log`, `lore-ui-check.log`, and `lore-ui-build.log`.
