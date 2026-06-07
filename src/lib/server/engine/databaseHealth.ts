import { sql } from 'drizzle-orm';
import { getDb, isBackendDatabaseConfigured } from '$lib/server/db/client';

export async function getDatabaseHealth(): Promise<Record<string, unknown>> {
	if (!isBackendDatabaseConfigured()) {
		return { ok: false, configured: false, error: 'DATABASE_URL is not set.' };
	}
	const db = getDb();
	const [row] = await db.execute(sql`
		select
			current_database() as database,
			(select count(*)::int from information_schema.tables where table_schema = 'public') as table_count
	`);
	return { ok: true, configured: true, ...row };
}
