#!/usr/bin/env node
// @ts-nocheck
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveRuntimeOptions, buildRuntimeEnv } from './runtime-config.mjs';

export function composeCommand(action, options = resolveRuntimeOptions()) {
	if (!['up', 'down', 'config'].includes(action)) throw new Error('Use backend up, down or config.');
	const database = new URL(options.databaseUrl);
	const qdrant = new URL(options.qdrantUrl);
	if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) || !['localhost', '127.0.0.1', '[::1]'].includes(qdrant.hostname)) {
		throw new Error('Local Compose cannot manage remote services. Start configured remote services independently.');
	}
	return {
		args: ['compose', '--project-name', 'mythengine', '--file', path.join(options.cwd, 'docker-compose.yml'), ...(
			action === 'up' ? ['up', '-d', '--wait', 'mythengine-db', 'qdrant'] : action === 'config' ? ['config', '--quiet'] : ['down']
		)],
		env: {
			...buildRuntimeEnv(options),
			MYTHENGINE_DB_PORT: database.port || '5432',
			MYTHENGINE_DB_NAME: decodeURIComponent(database.pathname.slice(1)),
			MYTHENGINE_DB_USER: decodeURIComponent(database.username),
			MYTHENGINE_DB_PASSWORD: decodeURIComponent(database.password),
			MYTHENGINE_QDRANT_PORT: qdrant.port || '6333',
		},
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const action = process.argv[2] ?? 'config';
	const command = composeCommand(action, resolveRuntimeOptions(process.argv.slice(3)));
	const result = spawnSync('docker', command.args, { env: command.env, stdio: 'inherit', windowsHide: true });
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}
