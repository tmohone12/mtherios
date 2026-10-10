import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelProfileSchema, modelRoleSettingSchema, modelTaskOverrideSchema, type ModelRoleId } from '$lib/contracts/modelTasks';

vi.mock('$lib/server/db/client', () => ({ getDb: () => { throw new Error('Database access is not expected in resolver unit tests.'); } }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { planLegacyServicePatches, resolveModelTaskFromSnapshot, type ModelSettingsSnapshot } from './modelSettings';

const profile = (id: string, model: string, extra: Record<string, unknown> = {}) => modelProfileSchema.parse({
	id, name: id, providerType: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKeyRef: null, model,
	generation: { temperature: 0.8, maxTokens: 8192, reasoningEffort: 'low' }, ...extra,
});

function snapshot(input: { profiles?: ReturnType<typeof profile>[]; roles?: Partial<Record<ModelRoleId, string>>; overrides?: Array<Record<string, unknown>> } = {}): ModelSettingsSnapshot {
	const profiles = input.profiles ?? [profile('gm', 'gm-model'), profile('cls', 'cls-model', { generation: { temperature: 0.3, maxTokens: 4096, reasoningEffort: 'high' } })];
	return {
		profiles: new Map(profiles.map(row => [row.id, row])),
		roles: new Map(Object.entries(input.roles ?? { gameMaster: 'gm', classifier: 'cls', summaries: 'cls' })
			.map(([role, profileId]) => [role as ModelRoleId, modelRoleSettingSchema.parse({ role, profileId })])),
		overrides: new Map((input.overrides ?? []).map(row => [String(row.taskId), modelTaskOverrideSchema.parse(row)])),
		revision: 'test',
	};
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('model task resolution', () => {
	it('inherits the role profile and layers task defaults, recording provenance', () => {
		const resolved = resolveModelTaskFromSnapshot('smallBrain', snapshot());
		expect(resolved.profile?.id).toBe('gm');
		expect(resolved.generation).toEqual({ model: 'gm-model', temperature: 0.3, maxTokens: 1200, reasoningEffort: 'low' });
		expect(resolved.provenance).toMatchObject({ source: 'role', role: 'gameMaster', profileId: 'gm', status: 'ready', enabledSource: 'task_default', overriddenParameters: [] });
	});

	it('keeps an explicit override when the role profile changes', () => {
		const base = snapshot({ profiles: [profile('gm', 'gm-model'), profile('cls', 'cls-model'), profile('nano', 'nano-model')],
			overrides: [{ taskId: 'storySetupAssist', profileId: 'nano', parameters: { temperature: 0.5 } }] });
		const changed: ModelSettingsSnapshot = { ...base, profiles: new Map([...base.profiles, ['gm', profile('gm', 'gm-model-2')]]) };
		expect(resolveModelTaskFromSnapshot('smallBrain', changed).generation.model).toBe('gm-model-2');
		const explicit = resolveModelTaskFromSnapshot('storySetupAssist', changed);
		expect(explicit.generation).toMatchObject({ model: 'nano-model', temperature: 0.5 });
		expect(explicit.provenance).toMatchObject({ source: 'task_override', overriddenParameters: ['temperature'] });
	});

	it('never lets Decisions inherit a text model, even when enabled', () => {
		const inherited = resolveModelTaskFromSnapshot('actorDecision', snapshot({ overrides: [{ taskId: 'actorDecision', enabled: true }] }));
		expect(inherited.profile).toBeNull();
		expect(inherited.provenance).toMatchObject({ status: 'needs_configuration', enabled: true, source: 'none' });
		const textModel = resolveModelTaskFromSnapshot('actorDecision', snapshot({ roles: { gameMaster: 'gm', decisions: 'gm' }, overrides: [{ taskId: 'actorDecision', enabled: true }] }));
		expect(textModel.provenance.status).toBe('needs_configuration');
		expect(textModel.missingReason).toMatch(/^Model configuration needed: Decisions needs a supported decision model/);
		const local = resolveModelTaskFromSnapshot('actorDecision', snapshot({ profiles: [profile('gm', 'gm-model'), profile('kev', 'kev-latest')],
			roles: { gameMaster: 'gm', decisions: 'kev' }, overrides: [{ taskId: 'actorDecision', enabled: true }] }));
		expect(local.provenance.status).toBe('ready');
	});

	it('reports optional tasks as disabled by default without changing anything', () => {
		const settings = snapshot();
		for (const taskId of ['dialogue', 'continuityReview', 'actorDecision', 'assistant', 'activeRecall']) {
			const resolved = resolveModelTaskFromSnapshot(taskId, settings);
			expect(resolved.profile).toBeNull();
			expect(resolved.provenance.enabled).toBe(false);
		}
		expect(settings.overrides.size).toBe(0);
	});

	it('uses an environment default only for core roles without a saved profile', () => {
		vi.stubEnv('MTHERIOS_LLM_PROVIDER', 'openai-compatible');
		vi.stubEnv('MTHERIOS_LLM_MODEL', 'env-model');
		vi.stubEnv('MTHERIOS_LLM_BASE_URL', 'http://127.0.0.1:9/v1');
		const empty = snapshot({ profiles: [], roles: {} });
		expect(resolveModelTaskFromSnapshot('classifier', empty).provenance).toMatchObject({ source: 'environment', model: 'env-model', status: 'ready', profileId: null });
		expect(resolveModelTaskFromSnapshot('assistant', { ...empty, overrides: new Map([['assistant', modelTaskOverrideSchema.parse({ taskId: 'assistant', enabled: true })]]) }).provenance)
			.toMatchObject({ source: 'none', status: 'needs_configuration' });
	});
});

describe('legacy per-service saves', () => {
	it('stores a value equal to the inherited one as inheritance, not an explicit copy', () => {
		const plan = planLegacyServicePatches([{ serviceId: 'smallBrain', providerType: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKeyRef: null, model: 'gm-model', temperature: 0.3, maxTokens: 1200 }], snapshot());
		expect(plan.profiles).toEqual([]);
		expect(plan.tasks).toEqual([expect.objectContaining({ taskId: 'smallBrain', profileId: null, parameters: {} })]);
	});

	it('reassigns a role rather than editing a profile another role shares', () => {
		const plan = planLegacyServicePatches([{ serviceId: 'classifier', model: 'cls-model-2' }], snapshot());
		expect(plan.profiles).toHaveLength(1);
		expect(plan.profiles[0]).toMatchObject({ model: 'cls-model-2', generation: { temperature: 0.3, maxTokens: 4096, reasoningEffort: 'high' } });
		expect(plan.roles).toEqual([expect.objectContaining({ role: 'classifier', profileId: plan.profiles[0].id })]);
		expect(plan.profiles.some(row => row.id === 'cls')).toBe(false);
	});

	it('clears an override on an explicit inherit request', () => {
		const plan = planLegacyServicePatches([{ serviceId: 'storySetupAssist', metadata: { inherit: true } }],
			snapshot({ overrides: [{ taskId: 'storySetupAssist', parameters: { temperature: 0.1 } }] }));
		expect(plan.clearTaskIds).toEqual(['storySetupAssist']);
		expect(plan.tasks).toEqual([]);
	});
});
