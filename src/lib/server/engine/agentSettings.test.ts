import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getAgentSettings, saveAgentSettings } from './agentSettings';

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
beforeEach(() => vi.clearAllMocks());

describe('persisted agent settings', () => {
	it('rejects a game outside the named project before writes', async () => {
		const execute = vi.fn().mockResolvedValueOnce([{ id: 'p', settings: {} }]).mockResolvedValueOnce([]);
		const tx = { execute };
		mocks.getDb.mockReturnValue({ transaction: (fn: (value: typeof tx) => Promise<unknown>) => fn(tx) });
		await expect(saveAgentSettings({ projectId: 'p', gameId: 'foreign', expectedRevision: 0, changes: { gmResearch: true } })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
		expect(execute).toHaveBeenCalledTimes(2);
		expect(new PgDialect().sqlToQuery(execute.mock.calls[1][0]).params).toEqual(['foreign', 'p']);
	});
	it('locks settings and rejects a stale revision without a write', async () => {
		const execute = vi.fn().mockResolvedValue([{ id: 'p', settings: { agentTools: { schemaVersion: 1, revision: 3, overrides: { gmResearch: false } } } }]);
		const tx = { execute }; mocks.getDb.mockReturnValue({ transaction: (fn: (value: typeof tx) => Promise<unknown>) => fn(tx) });
		await expect(saveAgentSettings({ projectId: 'p', expectedRevision: 2, changes: { gmResearch: true } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
		expect(execute).toHaveBeenCalledTimes(1);
		expect(new PgDialect().sqlToQuery(execute.mock.calls[0][0]).sql).toContain('for update');
	});
	it('returns shipped defaults without creating provider credentials or claiming tools are enabled', async () => {
		const execute = vi.fn().mockResolvedValueOnce([{ id: 'p', settings: {} }]).mockResolvedValueOnce([]);
		mocks.getDb.mockReturnValue({ execute });
		const result = await getAgentSettings({ projectId: 'p' });
		expect(result).toMatchObject({ effective: { gmResearch: true, gmQuestions: false, gmImages: false, assistantSubagents: true }, toolsAvailable: false, profiles: [] });
	});
	it('inherits a legacy Active Recall opt-in until an explicit adaptive preference wins', async () => {
		const profiles = [{ service_id: 'activeRecall', enabled: true, model: 'old-recall-model' }];
		const execute = vi.fn()
			.mockResolvedValueOnce([{ id: 'p', settings: {} }]).mockResolvedValueOnce(profiles)
			.mockResolvedValueOnce([{ id: 'p', settings: { agentTools: { schemaVersion: 1, revision: 1, overrides: { gmAdaptiveResearch: false } } } }]).mockResolvedValueOnce(profiles);
		mocks.getDb.mockReturnValue({ execute });
		const inherited = await getAgentSettings({ projectId: 'p' });
		expect(inherited).toMatchObject({ effective: { gmAdaptiveResearch: true }, sources: { gmAdaptiveResearch: 'legacy' } });
		const overridden = await getAgentSettings({ projectId: 'p' });
		expect(overridden).toMatchObject({ effective: { gmAdaptiveResearch: false }, sources: { gmAdaptiveResearch: 'project' } });
	});
});
