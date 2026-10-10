import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import fs from 'node:fs';
export default defineConfig({ cacheDir: '.vite-test-cache', plugins: [sveltekit()],
 define:{__SUMMARY_RECOVERY_SQL__:JSON.stringify(fs.readFileSync('drizzle/0052_summary_recovery.sql','utf8'))},
 test: { include: ['src/**/*.test.ts'], environment: 'node',setupFiles:['./scripts/test-no-network.mjs'] } });
