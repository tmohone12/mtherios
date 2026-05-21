import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import postgres from 'postgres';
import { databaseUrl } from './db-env.mjs';

const migrationsDir = resolve(process.cwd(), 'drizzle');
if (!existsSync(migrationsDir)) {
	console.error('Missing drizzle migration directory.');
	process.exit(1);
}

const sql = postgres(databaseUrl(), { max: 1, prepare: false });

try {
	await sql`create table if not exists _mtherios_migrations (
		name text primary key,
		applied_at timestamptz not null default now()
	)`;

	const migrations = readdirSync(migrationsDir)
		.filter((file) => file.endsWith('.sql'))
		.sort();

	for (const file of migrations) {
		const name = basename(file);
		const [alreadyApplied] = await sql`select name from _mtherios_migrations where name = ${name}`;
		if (alreadyApplied) {
			console.log(`skip ${name}`);
			continue;
		}

		const body = readFileSync(resolve(migrationsDir, file), 'utf8');
		console.log(`apply ${name}`);
		await sql.begin(async (tx) => {
			await tx.unsafe(body);
			await tx`insert into _mtherios_migrations (name) values (${name})`;
		});
	}

	console.log('database migrations complete');
} finally {
	await sql.end({ timeout: 1 });
}
