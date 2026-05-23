import { json, type RequestHandler } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { getDb, isBackendDatabaseConfigured } from '$lib/server/db/client';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async () => {
	try {
		if (!isBackendDatabaseConfigured()) {
			return json({ ok: false, configured: false, error: 'DATABASE_URL is not set.' }, { status: 503 });
		}
		const db = getDb();
		const [row] = await db.execute(sql`
			select
				current_database() as database,
				(select count(*)::int from information_schema.tables where table_schema = 'public') as table_count
		`);
		return json({ ok: true, configured: true, ...row });
	} catch (error) {
		return apiError(error);
	}
};
