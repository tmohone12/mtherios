import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '$lib/server/db/client';
import { emptyServerGenerationUsage, type ServerGenerationAttempt } from '$lib/server/turn/provider';
import { generationAttemptResult, recordGenerationApiCalls } from './generationAccounting';
const configured = process.env.SUMMARY_CHECKPOINT_TEST_DATABASE_URL;
const safe = Boolean(configured && /^mythengine_summary_repair_[a-z0-9_]+$/.test(new URL(configured).pathname.slice(1)) && ['localhost', '127.0.0.1'].includes(new URL(configured).hostname));
describe.skipIf(!safe)('provider ledger in disposable PostgreSQL', () => {
	beforeAll(async () => { const [row] = await getDb().execute(sql`select current_database() as name`); if (row.name !== new URL(configured!).pathname.slice(1)) throw new Error('Wrong disposable database'); });
	afterAll(async () => { await closeDb(); });
	it('concurrent receipt and later validation writes retain one stable charge row', async () => {
		const attempt: ServerGenerationAttempt = { attemptId: `provider_attempt_test_${randomUUID()}`, providerRequestId: 'provider-id',
			requestHash: 'identity', attempt: 0, startedAt: '2026-10-03T00:00:00Z', model: 'fixture', endpoint: 'https://example.test?secret=redact', status: 'success', statusCode: 200,
			durationMs: 1, promptChars: 3, responseChars: 4, finishReason: 'stop', error: null,
			usage: { ...emptyServerGenerationUsage(), requestTokens: 10, responseTokens: 5, totalTokens: 15, providerCostUsd: 0.01 } };
		const base = { profile: { providerType: 'openai' as const, apiKey: 'fixture', customModels: [], fetchedModels: [], reasoningModels: [], hiddenModels: [], favoriteModels: [] }, serviceId: 'classifier', operation: 'fixture.extraction', result: generationAttemptResult(attempt), status: 'success' as const };
		try {
			await Promise.all([recordGenerationApiCalls(base), recordGenerationApiCalls(base)]);
			await recordGenerationApiCalls({ ...base, status: 'error', error: new Error('Invalid JSON'), metadata: { parseOutcome: 'error' } });
			const rows = await getDb().execute(sql`select id,status,error,endpoint,request_tokens,metadata from api_call_logs where id=${attempt.attemptId}`);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ status: 'error', error: 'Invalid JSON', endpoint: 'https://example.test/', request_tokens: 10,
				metadata: { providerCostUsd: 0.01, providerRequestId: 'provider-id', providerCallCount: 1, parseOutcome: 'error' } });
		} finally { await getDb().execute(sql`delete from api_call_logs where id=${attempt.attemptId}`); }
	});
});
