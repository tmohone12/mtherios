import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';

export async function assertNoPendingAgentRun(gameId: string, runId?: string): Promise<void> {
  const [pending] = await getDb().execute(sql`select id from agent_runs where game_id = ${gameId} and status in ('running','awaiting_input','committing') and id <> ${runId ?? ''} limit 1`);
  if (pending) throw new Error(`Game ${gameId} has a pending agent run. Complete or cancel it before submitting another turn.`);
}

/** Hold the run row before canonical turn writes, using the same lock order as cancellation. */
export async function assertAgentRunCanCommit(tx: Pick<ReturnType<typeof getDb>, 'execute'>, gameId: string, runId?: string, signal?: AbortSignal, leaseOwner?: string, expectedStatus: 'committing' | 'running' = 'committing'): Promise<void> {
  signal?.throwIfAborted();
  if (!runId) return;
  const [run] = await tx.execute(sql`select status,continuation->>'runtime' as runtime,continuation->>'leaseOwner' as lease_owner,continuation->'state'->'budget' as budget
    from agent_runs where id=${runId} and game_id=${gameId} for update`);
  if (run?.status !== expectedStatus) throw new Error('Agent run stopped before the turn could commit.');
  if (leaseOwner && run.lease_owner !== leaseOwner) throw new Error('Agent run lease changed before the turn could commit.');
  const budget = run.budget && typeof run.budget === 'object' && !Array.isArray(run.budget) ? run.budget as Record<string, unknown> : null;
  if (budget?.stopReason) throw new Error(`Agent run cannot commit after ${String(budget.stopReason)}.`);
  if (run.runtime === 'pi-v1' && (!budget || !Number.isFinite(budget.deadlineAt))) throw new Error('Agent run lacks a valid durable deadline.');
  if (typeof budget?.deadlineAt === 'number' && Date.now() >= budget.deadlineAt) throw new Error('Agent run deadline exceeded before the turn could commit.');
  if (typeof budget?.elapsedMs === 'number' && budget.elapsedMs < 0) throw new Error('Agent run has an invalid elapsed budget.');
  signal?.throwIfAborted();
}
