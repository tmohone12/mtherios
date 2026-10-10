# Summary retry and provider accounting repair

This change prevents unchanged exhausted summary windows from buying the same
failed work through multiple queued jobs. It retains validated subwindows and
individual provider attempts, and counts a reused Pi narration once. It does not
rewrite historical usage, repair existing campaign facts, or reset a campaign.

## Durable work and failure handling

Migration `0049_summary_generation_checkpoints.sql` adds a campaign-owned summary
checkpoint table. Completed results are reusable only when their full input,
prompt policy, supporting context, and effective generation configuration match,
and they pass validation again. A separate failure identity covers the primary
ordered sources and generation policy/configuration; unrelated changes to current
facts or supporting catalogs do not reopen an exhausted window.

Provider attempts have durable claims before dispatch. Concurrent jobs cannot
dispatch the same claimed work. Expired orchestration claims may resume through
their guarded children, but an expired provider claim has an uncertain outcome
and stays blocked. This deliberately distinguishes a recorded transient failure
from an interrupted request that may already have incurred a charge.

Known transient provider/network failures retain automatic retries. Exhausted
output/coverage failures and unclassified failures stop automatic retry. Completed
subwindows remain available when a later subwindow fails. Canonical chapter
commit still validates source coverage and locks/rechecks the selected source
rows; a cached draft does not by itself become saved history.

## Accounting

Provider receipts retain a local attempt ID, provider request ID when supplied,
request hash, status, available usage, cache/reasoning counters, and reported cost.
Unavailable provider fields remain null. Stable attempt IDs prevent duplicate
ledger rows, while validation outcomes can update the same retained attempt.
Extraction's original and repair attempts remain separately visible. A Pi direct
draft reused as narration records its source relationship without another billed
request or duplicate cost row.

No historical charges are rewritten. Older summary records without usage or
provider request IDs cannot be reconstructed from this migration.

## Activation and queue recovery

The implementation was prepared separately from the active checkout. Activation,
production migration, restarts, and worker resume require their own approved
release step. Before that step, verify the actual app process, artifact, data root,
worker state, and any source changes made since the candidate snapshot.

1. Preserve a verified database backup and the current source/build/configuration.
2. Apply migration 0049 only to the intended production database during the
   approved release. It adds a table and indexes; do not clear existing jobs.
3. Activate the verified artifact with explicit original data/configuration paths
   and the process worker override disabled. Verify health, artifact, data root,
   and effective worker state. Do not silently change the normal launcher.
4. Review the existing queue before a separately approved worker resume. Old jobs
   have no new checkpoints yet: deploying this code does not retroactively stop
   their first new provider attempt or prove their historical costs.

A repeated permanent failure remains blocked for the same primary source and
generation policy. Requeuing its job alone does not bypass the guard. A deliberate
source/model/prompt-policy correction changes identity and may authorize new work;
incidental context changes do not. Do not change settings merely to bypass a
failure guard.

For an uncertain provider claim, reconcile the exact checkpoint with its retained
provider-attempt receipts and the provider's outcome. Do not delete the claim or
infer that a dead worker means the request was unpaid. This change provides no
automatic force-reset command; any targeted reconciliation or explicit paid retry
requires a reviewed recovery action. Keep unrelated completed checkpoints intact.

The worker pause applies to background jobs. Interactive story requests can still
use their configured model and incur ordinary generation charges.
