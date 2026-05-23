import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnvFile() {
	for (const file of ['.env.local', '.env']) {
		const path = resolve(process.cwd(), file);
		if (!existsSync(path)) continue;
		const lines = readFileSync(path, 'utf8').split(/\r?\n/);
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
			if (!match) continue;
			const [, key, rawValue] = match;
			if (process.env[key] !== undefined) continue;
			process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
		}
	}
}

export function databaseUrl() {
	loadEnvFile();
	return process.env.DATABASE_URL ?? 'postgres://mtherios:mtherios@localhost:5432/mtherios';
}
