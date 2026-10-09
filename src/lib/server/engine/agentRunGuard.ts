import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';

export async function assertNoPendingAgentRun(gameId: string, runId?: string): Promise<void> {
  const [pending] = await getDb().execute(sql`select id from agent_runs where game_id = ${gameId} and status in ('running','awaiting_input','committing') and id <> ${runId ?? ''} limit 1`);
  if (pending) throw new Error(`Game ${gameId} has a pending agent run. Complete or cancel it before submitting another turn.`);
}
