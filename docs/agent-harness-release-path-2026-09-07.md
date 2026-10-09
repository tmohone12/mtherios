# Agent harness release path — 2026-09-07

## Release identity

Every qualification artifact records the working-tree build identity, Git HEAD, dirty-status fingerprint, and selected source hashes. The current source identity is `mtherios@0.0.1`; the isolated runtime verification used `local-checkout` / `runtime` on port 5177 with jobs disabled.

Do not treat a Git commit alone as the running artifact. Before activation, verify all three values from the same process:

```powershell
npm run app:status -- --json
Invoke-RestMethod http://127.0.0.1:<port>/api/app/status
Invoke-RestMethod http://127.0.0.1:<port>/api/health
```

## Backup and isolated restore

The first harness release backup remains under `.cache-backups/harness-first-release-20260906/`; its PostgreSQL custom dump was restored successfully into a disposable pgvector database. Exact hash, restored counts, and the source identity are recorded in [agent-harness-backup-restore-2026-09-07.json](evidence/agent-harness-backup-restore-2026-09-07.json). The campaign-persistence qualification also performs export/import and disposable-database restoration without model calls.

For a new release candidate:

1. Capture `git status --short`, configuration with credentials removed, `npm run app:status -- --json`, and the benchmark reports.
2. Take a native PostgreSQL dump before migrations or campaign repair. Store it outside the generated build output and record its SHA-256.
3. Restore into a disposable database using the local operator’s existing PostgreSQL credentials, then run the normal additive migrations against that disposable target.
4. Verify table counts, one bounded story read, export/import, and the campaign-persistence harness before considering the backup usable.

Whole-database restore is a data-recovery operation, not the normal application rollback path. Never overwrite the canonical database merely to undo an application artifact.

## Activation sequence

Activation is intentionally separate from this source checkout. After a permitted restart path is available:

1. Build into an isolated production-output directory so the running artifact is not replaced underneath the current process.
2. Apply additive migrations and verify health before enabling background workers.
3. Start the candidate with the recorded configuration, then verify `/api/app/status`, `/api/health`, one `turn.preview`, one completed turn with its saved receipt, and one durable processing cycle.
4. Inspect job status by story, stage, source version, and failure cause. Do not batch-retry permanent provider/account failures.
5. Record the exact process identity, artifact identity, build hash, migration state, and rollback target.

The 2026-09-07 port-5177 run completed only steps applicable to an isolated worker-disabled check: health returned 200 with 35 tables, app status reported the current runtime identity, `turn.preview` succeeded, and bounded source evidence was returned. The process was stopped afterward. No production deployment or provider-backed completed turn is claimed.

## Rollback

If the candidate application is unhealthy, stop the candidate through the permitted operator path and restore the prior application artifact and configuration. Keep newly written canonical data and additive schema changes in place. Re-run health, app-status identity, and a bounded read before re-enabling workers.

Rebuild derived scene/chapter/arc/saga projections, retrieval indexes, and wiki projections from canonical data when needed. Use the verified database backup only for justified canonical-data recovery, with a recorded restore decision and post-restore integrity checks.

The rollback path was exercised against the saved prior production artifact at `.cache-backups/harness-scene-slice-20260906/production-build` on port 5178 with workers disabled. The probe used only read routes: `/api/health` returned successfully, `/api/engine/command story.list` returned 10 stories, and no write-capable or job-run command was submitted. The candidate was stopped after the check; ports 5178 and the normal verification ports were clear.

## Current gate status

Offline source, retrieval, consolidation, budgeting, cancellation, idempotency, import/export, deterministic 1,000-turn qualification, 5,000-turn/10,000-entry long-campaign control-surface, serial preview p95, concurrent preview-load behavior, and simulated desktop/mobile UI evidence are present. Active-promise coalescing now covers retrieval, story context, timeline, and wiki inspection reads; the stored transcript search-vector projection also removes the dominant per-row FTS cost. On the reference Veil corpus (2,405 entries and 2,233 memory nodes), the warm four-way preview run measured 922/975 ms preparation p50/p95 and the serial comparison measured 718/750 ms ([reports](../evals/performance/results/20260907T112110Z-4x.json), [serial](../evals/performance/results/20260907T112121Z-1x.json)). The earlier post-build four-way run was 1,017 ms p95, so the 1-second preparation target is treated as met on the warm comparison but still subject to host/run variance. The post-migration fresh 10,000-entry retrieval gate completed at 72 ms p95 with four bounded nodes and no degraded sources ([report](../evals/performance/results/20260907T111059Z-db-memory-5000t-4x.json)); the mixed gateway completed in 164 ms ([report](../evals/performance/results/20260907T104834Z-db-5000t.json)). Physical-device keyboard validation, provider-backed completed-turn qualification, and permitted activation remain open gates.
