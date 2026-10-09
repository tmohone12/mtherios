# Agent harness recall diagnostics — 2026-09-07

Implemented the next planned harness slice: a measured, separately scored held-out recall suite, followed by generic retrieval improvements for revisions, concentrated evidence, stem-aware transcript matches, and corpus-aware keyword rarity.

## Delivered

- Added 105 deterministic held-out queries in `evals/memory/heldout.mjs` across durable promises, aliases, callbacks, recurring NPC facts, corrections, relationships, history, long passages, and exclusion controls.
- Kept the existing 32-case regression fixture unchanged and scored it separately from the held-out suite.
- Extended the existing disposable benchmark to report suite-level recall, packet/answer retention, violations, budgets, and latency without introducing another evaluation runner.
- Added an opt-in local-hash hybrid-rank comparison that increases lexical contribution and reduces raw vector contribution; it does not change the default production ranking.
- Kept the default run offline: local-hash and text-only baselines use the production retrieval/ranking/packet path without provider calls.
- Added correction assertions that mark superseded records as forbidden for current queries, making stale-record co-selection visible.
- Aligned held-out correction records with the existing explicit supersession contract and marked historical lookups explicitly, so the benchmark tests the production lifecycle rather than guessing relationships from similar prose.

## Verification

- `npm run bench:memory -- 1`: passed; 137 cases, one warm-up plus one measured round per case.
- `npm test -- --run`: 130 files, 1,267 tests passed.
- `npm run check`: 0 errors, 0 warnings.
- Report: `evals/memory/results/2026-09-07T11-44-53-556Z.json`.
- Regression suite: 27/27 answer recall for local-hash and disabled modes; the opt-in hybrid retained 26/27; zero forbidden-result and budget violations.
- Held-out suite: 105 queries with 90 gold cases after exclusion controls; default local-hash reached 89/90 answer and packet recall, text-only reached 89/90, and the opt-in hybrid reached 88/90. Latency remained 22.5/26.9 ms p50/p95 for default local-hash and 21.9/27.4 ms p50/p95 for hybrid. The report records the exact working-tree build identity and source hashes.
- The opt-in hybrid was 1.1 percentage points below default local-hash answer retention, so it remains below the proposed 10-point or 95% promotion gate and is not the production default.
- Corpus: 274 synthetic memory records; disposable database removed; live database untouched.
- The fixture module loaded with 32 regression cases, 105 held-out cases, and 274 seeded memories.

## Boundary

This slice diagnoses retrieval generalization and correction handling. The hybrid comparison is opt-in and does not change production ranking, canon, provider settings, or the running app. Revision-aware candidate retrieval, compact evidence excerpts, stem-aware transcript markers, and corpus-aware rarity are generic production-path changes; no held-out fixture was tuned. Remaining misses are an indirect callback paraphrase and one opt-in hybrid ranking case; a learned-embedding comparison remains gated behind an explicit provider/spend decision.
