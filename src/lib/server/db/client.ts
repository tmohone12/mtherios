import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { BackendNotConfiguredError, getServerMemoryConfig } from '$lib/server/env';
import { schema } from './schema';

let sqlClient: Sql | null = null;
let dbClient: PostgresJsDatabase<typeof schema> | null = null;

export function isBackendDatabaseConfigured(): boolean {
	return Boolean(getServerMemoryConfig().databaseUrl);
}

export function getDb(): PostgresJsDatabase<typeof schema> {
	const { databaseUrl } = getServerMemoryConfig();
	if (!databaseUrl) throw new BackendNotConfiguredError();

	if (!sqlClient) {
		sqlClient = postgres(databaseUrl, {
			max: 8,
			prepare: false,
		});
		dbClient = drizzle(sqlClient, { schema });
	}

	if (!dbClient) throw new BackendNotConfiguredError();
	return dbClient;
}

export async function closeDb(): Promise<void> {
	if (sqlClient) {
		await sqlClient.end({ timeout: 1 });
		sqlClient = null;
		dbClient = null;
	}
}
