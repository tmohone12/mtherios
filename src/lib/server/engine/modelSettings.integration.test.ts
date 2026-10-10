import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { closeDb, getDb } from '$lib/server/db/client';
import { modelProfiles, modelRoles, modelTaskOverrides } from '$lib/server/db/schema';
import { loadModelSettings, resolveModelTask, saveModelSettings } from './modelSettings';
import { resolveServiceGeneration } from './llmSettings';

const databaseUrl = process.env.MODEL_SETTINGS_TEST_DATABASE_URL;
const integration = databaseUrl && /test/i.test(new URL(databaseUrl).pathname) ? describe : describe.skip;

// Both settings suites change global (not story-scoped) rows; serialize them across files.
let settingsLock: ReturnType<typeof postgres> | null = null;
beforeAll(async () => {
	if (!databaseUrl) return;
	settingsLock = postgres(databaseUrl, { max: 1, onnotice: () => {} });
	await settingsLock`select pg_advisory_lock(hashtext('mythengine-global-settings-tests'))`;
});
afterAll(async () => {
	if (!settingsLock) return;
	await settingsLock`select pg_advisory_unlock(hashtext('mythengine-global-settings-tests'))`;
	await settingsLock.end();
});

afterAll(async () => { if (databaseUrl) await closeDb(); });

const profile = (id: string, model: string) => ({ id, name: id, providerType: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKeyRef: null, model,
	contextWindowTokens: null, capabilities: {}, generation: { temperature: 0.7, maxTokens: 2048, reasoningEffort: 'low' }, metadata: {} });

/** Runs with empty model tables and restores the disposable database's rows afterwards. */
async function isolatedModelTables(run: () => Promise<void>) {
	const db = getDb();
	const [current] = await db.execute(sql`select current_database() as name`);
	if (current.name !== decodeURIComponent(new URL(databaseUrl!).pathname.slice(1))) throw new Error('Database target differs from the disposable test database');
	const saved = { profiles: await db.select().from(modelProfiles), roles: await db.select().from(modelRoles), overrides: await db.select().from(modelTaskOverrides) };
	await db.delete(modelTaskOverrides); await db.delete(modelRoles); await db.delete(modelProfiles);
	try { await run(); } finally {
		await db.delete(modelTaskOverrides); await db.delete(modelRoles); await db.delete(modelProfiles);
		if (saved.profiles.length) await db.insert(modelProfiles).values(saved.profiles);
		if (saved.roles.length) await db.insert(modelRoles).values(saved.roles);
		if (saved.overrides.length) await db.insert(modelTaskOverrides).values(saved.overrides);
	}
}

const counts = async () => {
	const [row] = await getDb().execute(sql`select (select count(*) from model_profiles)::int as profiles, (select count(*) from model_roles)::int as roles,
		(select count(*) from model_task_overrides)::int as overrides, (select count(*) from llm_service_settings)::int as legacy`);
	return row;
};

integration('model settings in disposable PostgreSQL', () => {
	it('propagates a shared profile change to inheriting tasks after save and reload, leaving explicit overrides unchanged', async () => {
		await isolatedModelTables(async () => {
			const first = await saveModelSettings({
				profiles: [profile('shared_gm', 'gm-v1'), profile('nano', 'nano-v1')],
				roles: [{ role: 'gameMaster', profileId: 'shared_gm', fallbackProfileIds: [], metadata: {} }],
				tasks: [{ taskId: 'storySetupAssist', profileId: 'nano', enabled: null, parameters: { temperature: 0.9 }, systemPromptOverride: null, fallbackProfileIds: [], budget: {}, metadata: {} }],
			});
			expect((await resolveModelTask('smallBrain')).generation.model).toBe('gm-v1');
			await saveModelSettings({ expectedRevision: first.revision, profiles: [profile('shared_gm', 'gm-v2')] });
			// A fresh load is the reload; nothing is cached between saves.
			const reloaded = await loadModelSettings();
			expect(reloaded.profiles.get('shared_gm')).toMatchObject({ model: 'gm-v2', revision: 2 });
			for (const taskId of ['narrative', 'smallBrain', 'suggestions', 'strategicWorldBrain']) {
				expect((await resolveModelTask(taskId)).provenance).toMatchObject({ model: 'gm-v2', source: 'role', profileRevision: 2 });
			}
			const explicit = await resolveModelTask('storySetupAssist');
			expect(explicit.generation).toMatchObject({ model: 'nano-v1', temperature: 0.9 });
			expect(explicit.provenance.source).toBe('task_override');
			await expect(saveModelSettings({ expectedRevision: first.revision, profiles: [profile('shared_gm', 'gm-v3')] })).rejects.toThrow(/changed since they were loaded/);
		});
	}, 30_000);

	it('checks absent optional services without creating or enabling them', async () => {
		await isolatedModelTables(async () => {
			await saveModelSettings({ profiles: [profile('shared_gm', 'gm-v1')], roles: [{ role: 'gameMaster', profileId: 'shared_gm', fallbackProfileIds: [], metadata: {} }] });
			const before = await counts();
			for (const taskId of ['actorDecision', 'dialogue', 'continuityReview', 'assistant', 'batchAuthoring', 'imageGeneration', 'activeRecall']) {
				const resolved = await resolveServiceGeneration(taskId);
				expect(resolved.profile).toBeNull();
			}
			expect(await counts()).toEqual(before);
			expect((await resolveModelTask('actorDecision')).provenance).toMatchObject({ enabled: false, status: 'disabled' });
		});
	}, 30_000);
});

integration('model settings migration 0054', () => {
	it('converts legacy rows into roles, deduplicated profiles and difference-only overrides', async () => {
		const schema = `model_migration_${randomUUID().replace(/-/g, '')}`;
		const client = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
		const migration = fs.readFileSync('drizzle/0054_model_roles.sql', 'utf8');
		try {
			await client.begin(async tx => {
				await tx.unsafe(`create schema ${schema}; set local search_path to ${schema}, pg_temp;`);
				await tx.unsafe(`create table llm_service_settings (service_id text primary key, provider_type text not null, base_url text, model text, temperature real not null default 1,
					max_tokens integer not null default 4096, top_p real, frequency_penalty real, presence_penalty real, reasoning_effort text, context_budget integer,
					context_window_tokens integer, enabled boolean not null default true, system_prompt_override text, api_key_ref text, metadata jsonb not null default '{}', updated_at timestamptz not null default now())`);
				const row = (id: string, model: string, values: Record<string, unknown> = {}) => ({ service_id: id, provider_type: 'openrouter', base_url: 'https://openrouter.ai/api/v1',
					api_key_ref: 'env:OPENROUTER_API_KEY', model, temperature: 0.3, max_tokens: 4096, reasoning_effort: 'high', enabled: true, metadata: { source: 'frontend_settings' }, ...values });
				for (const value of [
					row('narrative', 'flash', { temperature: 0.8, max_tokens: 8192, reasoning_effort: 'low', system_prompt_override: 'House style' }),
					row('classifier', 'flash'), row('memory', 'flash'), row('arcCondensation', 'flash'),
					row('sagaCondensation', 'flash', { temperature: 0.25 }),
					row('suggestions', 'flash', { temperature: 0.8, max_tokens: 2048, enabled: false }),
					row('smallBrain', 'glm', { provider_type: 'nanogpt', base_url: 'https://nano-gpt.com/api/v1', api_key_ref: 'env:NANOGPT_API_KEY', max_tokens: 1200 }),
					row('characterUpdate', 'glm', { provider_type: 'nanogpt', base_url: 'https://nano-gpt.com/api/v1', api_key_ref: 'env:NANOGPT_API_KEY', temperature: 0.2 }),
					row('dialogue', 'glm47', { enabled: false, temperature: 0.7, max_tokens: 2048, metadata: { source: 'frontend_settings', dialogueMode: 'important' } }),
					// Created by the old resolver merely checking availability: not a user setting.
					row('continuityReview', 'flash', { metadata: { source: 'terminal_default' } }),
					row('worldSimulation', 'retired'),
				]) await tx`insert into llm_service_settings ${tx(value as unknown as Record<string, string>)}`;
				await tx.unsafe(migration);
				const profiles = await tx`select id, model, generation from model_profiles order by model, id`;
				const roles = Object.fromEntries((await tx`select role, profile_id from model_roles`).map(r => [r.role, r.profile_id]));
				const overrides = Object.fromEntries((await tx`select task_id, profile_id, enabled, parameters, system_prompt_override, metadata from model_task_overrides`).map(r => [r.task_id, r]));
				expect(profiles.map(p => p.model)).toEqual(['flash', 'flash', 'glm', 'glm47']);
				expect(roles.classifier).toBe(roles.summaries);
				expect(roles.gameMaster).not.toBe(roles.classifier);
				expect(roles.decisions).toBeUndefined();
				// Identical copies are inheritance; differences survive as explicit parameters.
				expect(overrides.classifier).toBeUndefined();
				expect(overrides.memory).toBeUndefined();
				expect(overrides.arcCondensation).toBeUndefined();
				expect(overrides.sagaCondensation).toBeUndefined();
				expect(overrides.suggestions).toMatchObject({ profile_id: null, enabled: false, parameters: { reasoningEffort: 'high' } });
				expect(overrides.narrative).toMatchObject({ system_prompt_override: 'House style', parameters: {} });
				expect(overrides.smallBrain.profile_id).toBe(overrides.characterUpdate.profile_id);
				expect(overrides.smallBrain.parameters).toEqual({});
				expect(overrides.characterUpdate.parameters).toEqual({});
				expect(overrides.dialogue).toMatchObject({ enabled: null, metadata: expect.objectContaining({ dialogueMode: 'important' }) });
				expect(overrides.continuityReview).toBeUndefined();
				expect(overrides.worldSimulation).toBeUndefined();
				expect((await tx`select count(*)::int as n from llm_service_settings`)[0].n).toBe(11);
				throw new RollbackFixture();
			}).catch(error => { if (!(error instanceof RollbackFixture)) throw error; });
		} finally {
			await client.end();
		}
	}, 30_000);
});

class RollbackFixture extends Error {}
