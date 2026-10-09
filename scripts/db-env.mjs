import { resolveRuntimeOptions, loadEnvFile as readEnv } from './runtime-config.mjs';

export function loadEnvFile() { Object.assign(process.env, readEnv()); }
export function databaseUrl() { return resolveRuntimeOptions().databaseUrl; }
