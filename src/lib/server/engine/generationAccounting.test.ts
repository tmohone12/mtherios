import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyServerGenerationUsage, type ServerGenerationAttempt, type ServerGenerationResult } from '$lib/server/turn/provider';
const logs = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('./apiCallLogs', () => ({ recordApiCallLog: logs.record }));
import { generationAttemptResult, recordGenerationApiCalls, reuseGenerationResult } from './generationAccounting';
const profile = { providerType: 'openai' as const, apiKey: 'fixture', customModels: [], fetchedModels: [], reasoningModels: [], hiddenModels: [], favoriteModels: [] };
const attempt = (id: string, cost: number | null = 0.02): ServerGenerationAttempt => ({ attemptId: id, providerRequestId: `provider-${id}`,
	requestHash: 'hash', attempt: 0, startedAt: '2026-10-03T00:00:00Z', model: 'fixture', endpoint: 'https://example.test', status: 'success', statusCode: 200,
	durationMs: 1, promptChars: 3, responseChars: 4, finishReason: 'stop', error: null,
	usage: { ...emptyServerGenerationUsage(), inputTokens: 10, requestTokens: 10, responseTokens: 5, outputTokens: 5, totalTokens: 15, providerCostUsd: cost } });
const result = (item: ServerGenerationAttempt): ServerGenerationResult => ({ ...generationAttemptResult(item), text: 'Done', responseChars: 4, usage: item.usage });
const options = { storyId: 'fixture', profile, serviceId: 'narrative', operation: 'turn.narration' };
beforeEach(() => { logs.record.mockReset().mockResolvedValue({ id: 'saved' }); });
describe('generation accounting', () => {
	it('keeps original and repaired responses as distinct calls and reconciles each callback/outcome by attempt ID', async () => {
		const rows = new Map<string, any>();
		logs.record.mockImplementation(async (row, identity) => { rows.set(identity.id, row); return row; });
		const bad = attempt('initial', 0.03), repaired = attempt('repair', 0.04);
		await recordGenerationApiCalls({ ...options, result: generationAttemptResult(bad), status: 'success' });
		await recordGenerationApiCalls({ ...options, result: result(bad), status: 'error', error: new Error('Invalid JSON'), metadata: { parseOutcome: 'error' } });
		await recordGenerationApiCalls({ ...options, operation: 'turn.state_extraction.repair', result: result(repaired), status: 'success' });
		expect(rows.size).toBe(2);
		expect([...rows.values()].reduce((sum, row) => sum + row.metadata.providerCostUsd, 0)).toBeCloseTo(0.07);
		expect(rows.get('initial')).toMatchObject({ status: 'error', error: 'Invalid JSON', metadata: { attemptId: 'initial', parseOutcome: 'error', providerRequestId: 'provider-initial' } });
	});
	it('preserves source usage but emits no duplicate billable row for reused Pi narration', async () => {
		const original = result(attempt('pi-investigation'));
		await recordGenerationApiCalls({ ...options, operation: 'turn.pi.investigation', result: original, status: 'success' });
		const reused = reuseGenerationResult(original, { operation: 'turn.pi.investigation', runId: 'run' });
		await recordGenerationApiCalls({ ...options, result: reused, status: 'success' });
		expect(logs.record).toHaveBeenCalledTimes(1);
		expect(reused.usage).toEqual(original.usage);
		expect(reused.accounting).toEqual({ kind: 'reuse', sourceOperation: 'turn.pi.investigation', sourceRunId: 'run', attemptIds: ['pi-investigation'] });
		await recordGenerationApiCalls({ ...options, result: result(attempt('fresh-narration')), status: 'success' });
		expect(logs.record).toHaveBeenCalledTimes(2);
	});
	it('keeps each retry and leaves unavailable provider fields null', async () => {
		const first = { ...attempt('failed', null), providerRequestId: null, status: 'error' as const, error: 'Temporary unavailable', statusCode: 503, usage: emptyServerGenerationUsage() };
		const last = attempt('ok');
		await recordGenerationApiCalls({ ...options, result: { ...result(last), attempts: [first, last] }, status: 'success' });
		expect(logs.record).toHaveBeenCalledTimes(2);
		expect(logs.record.mock.calls[0][0]).toMatchObject({ status: 'error', requestTokens: null, metadata: { providerRequestId: null, providerCostUsd: null, costSource: 'unavailable', usageAvailable: false } });
		expect(logs.record.mock.calls[1][0]).toMatchObject({ status: 'success', metadata: { providerCostUsd: 0.02 } });
	});
	it('does not claim a provider call for pre-dispatch rejection and surfaces receipt persistence failure', async () => {
		await recordGenerationApiCalls({ ...options, result: { ...result(attempt('unused')), attempts: [] }, status: 'error' });
		expect(logs.record).not.toHaveBeenCalled();
		logs.record.mockResolvedValue(null);
		await expect(recordGenerationApiCalls({ ...options, result: result(attempt('charged')), status: 'success' })).rejects.toThrow('receipt could not be saved');
	});
});
