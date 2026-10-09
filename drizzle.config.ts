import { defineConfig } from 'drizzle-kit';
import { databaseUrl } from './scripts/db-env.mjs';

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		url: databaseUrl(),
	},
});
