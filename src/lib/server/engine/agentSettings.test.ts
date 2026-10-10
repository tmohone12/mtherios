import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getAgentSettings, saveAgentSettings } from './agentSettings';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), modelSettings: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('./modelSettings', async original => ({ ...await original<typeof import('./modelSettings')>(), loadModelSettings: mocks.modelSettings }));
const emptyModelSettings = () => ({ profiles: new Map(), roles: new Map(), overrides: new Map(), revision: 'empty' });
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
		const execute = vi.fn().mockResolvedValueOnce([{ id: 'p', settings: {} }]);
		mocks.getDb.mockReturnValue({ execute });
		mocks.modelSettings.mockResolvedValue(emptyModelSettings());
		const result = await getAgentSettings({ projectId: 'p' });
		expect(result).toMatchObject({ effective: { gmResearch: true, gmQuestions: false, gmImages: false, assistantSubagents: true }, toolsAvailable: false, profiles: [] });
	});
	it('inherits a legacy Active Recall opt-in until an explicit adaptive preference wins', async () => {
		const { modelProfileSchema, modelTaskOverrideSchema } = await import('$lib/contracts/modelTasks');
		const recall = modelProfileSchema.parse({ id: 'recall', name: 'recall', providerType: 'openai-compatible', model: 'old-recall-model' });
		mocks.modelSettings.mockResolvedValue({ ...emptyModelSettings(), profiles: new Map([['recall', recall]]),
			overrides: new Map([['activeRecall', modelTaskOverrideSchema.parse({ taskId: 'activeRecall', profileId: 'recall', enabled: true })]]) });
		const execute = vi.fn()
			.mockResolvedValueOnce([{ id: 'p', settings: {} }])
			.mockResolvedValueOnce([{ id: 'p', settings: { agentTools: { schemaVersion: 1, revision: 1, overrides: { gmAdaptiveResearch: false } } } }]);
		mocks.getDb.mockReturnValue({ execute });
		const inherited = await getAgentSettings({ projectId: 'p' });
		expect(inherited).toMatchObject({ effective: { gmAdaptiveResearch: true }, sources: { gmAdaptiveResearch: 'legacy' } });
		const overridden = await getAgentSettings({ projectId: 'p' });
		expect(overridden).toMatchObject({ effective: { gmAdaptiveResearch: false }, sources: { gmAdaptiveResearch: 'project' } });
	});
});
