import postgres from 'postgres';
import { databaseUrl } from './db-env.mjs';

const sql = postgres(databaseUrl(), { max: 1, prepare: false });

try {
	const [row] = await sql`
		select
			current_database() as database,
			current_user as user,
			(select count(*)::int from information_schema.tables where table_schema = 'public') as table_count,
			(select installed_version from pg_available_extensions where name = 'vector') as vector_available
	`;
	console.log(JSON.stringify(row, null, 2));
} finally {
	await sql.end({ timeout: 1 });
}
