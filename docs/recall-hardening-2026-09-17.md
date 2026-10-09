# Recall hardening — 2026-09-17

Implemented in the existing server retrieval/ranking path; no new dependency, migration, or campaign rewrite.

- Weighted PostgreSQL lexical relevance now orders candidates before the 80-row cap. Individual meaningful terms can match instead of requiring every word of a long query.
- Retrieved candidates bring their explicit source-linked superseding records and revision-topic siblings, even when those records have low importance and different wording. Resolution is bounded to four passes and 1,000 matching rows per pass; overflow fails explicitly.
- Replacement facts inherit relevance through explicit links within the same story/belief owner. Existing visibility, temporal, control-text, and historical-query rules remain in force.
- Three required database regressions cover crowded candidates, differently worded corrections, and multi-hop corrections. The benchmark exits nonzero on missing answers, forbidden records, or budget failures for these cases.

## Verification

- 40 focused retrieval/ranking/temporal tests passed.
- `npm run check`: zero errors/warnings.
- `npm run build`: passed, with existing bundler chunk warnings.
- `npm run bench:memory -- 1`: 140 synthetic cases, 120 with expected answers, 20 exclusion-only cases. Default local-hash and text-only retained 119/120 answers; experimental hybrid retained 118/120. All modes passed the three required new regressions with zero forbidden-result and budget violations.
- [Database benchmark report](../evals/memory/results/2026-09-17T20-36-46-700Z.json). One measured repetition per case; not a load test or narrator-quality measurement. Temporary database removed; no paid provider calls or live campaign writes.
- Relevant tracked-file whitespace checks passed.

## Deployment and remaining boundaries

Build is ready, but the process restart was blocked by tool policy. Subsequent live status still reported the previous healthy PID 42800, with no running jobs. The two running turn records inspected were old records from August 22 and September 1, not new turns. No process was stopped.

Restart the existing app using the normal local process controls and `npm run app:start` to load the new build. Live request verification is still pending.

This honors explicit correction/topic links; it does not infer which unrelated prose in chapter summaries or character descriptions is semantically obsolete. It does not regenerate summaries, backfill campaign state, expand the 32-topic campaign brief, or replay failed extraction jobs. Runtime status showed pre-existing failed jobs and stale projections; those need a separately scoped repair. Synthetic packet retention is not proof that a live narrator will use the evidence correctly.
