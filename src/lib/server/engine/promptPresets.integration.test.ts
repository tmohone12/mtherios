import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { closeDb, getDb } from '$lib/server/db/client';
import { promptPresetRevisions, promptPresets, shelves, stories, storyPromptPresets } from '$lib/server/db/schema';
import { BUILT_IN_NARRATIVE_PRESET, compileNarrativePreset } from '$lib/server/turn/narrativePreset';
import { applyNarrativePromptOverride } from '$lib/services/ai/context/gmAuthority';
import { loadModelSettings } from './modelSettings';
import {
	exportPromptPreset, importPromptPreset, listPromptPresets, previewPromptPreset, resolveStoryNarrativePreset,
	savePromptPreset, selectStoryPromptPreset,
} from './promptPresets';

const databaseUrl = process.env.MODEL_SETTINGS_TEST_DATABASE_URL;
const integration = databaseUrl && /test/i.test(new URL(databaseUrl).pathname) ? describe : describe.skip;

afterAll(async () => { if (databaseUrl) await closeDb(); });

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

async function twoStories(run: (ids: { first: string; second: string }) => Promise<void>) {
	const db = getDb();
	const [current] = await db.execute(sql`select current_database() as name`);
	if (current.name !== decodeURIComponent(new URL(databaseUrl!).pathname.slice(1))) throw new Error('Database target differs from the disposable test database');
	const suffix = randomUUID();
	const shelfId = `shelf_presets_${suffix}`;
	const first = `story_presets_a_${suffix}`, second = `story_presets_b_${suffix}`;
	const created: string[] = [];
	await db.insert(shelves).values({ id: shelfId, name: 'Preset fixture', slug: shelfId });
	await db.insert(stories).values([{ id: first, shelfId, title: 'First', headerPrompt: 'The first story preamble.' }, { id: second, shelfId, title: 'Second' }]);
	try { await run({ first, second }); } finally {
		await db.delete(shelves).where(eq(shelves.id, shelfId));
		const fixturePresets = (await db.select({ id: promptPresets.id }).from(promptPresets).where(sql`${promptPresets.metadata}->>'source' = 'settings' and ${promptPresets.name} like 'Fixture %'`)).map(row => row.id);
		created.push(...fixturePresets);
		if (created.length) {
			await db.delete(storyPromptPresets).where(inArray(storyPromptPresets.presetId, created));
			await db.delete(promptPresetRevisions).where(inArray(promptPresetRevisions.presetId, created));
			await db.delete(promptPresets).where(inArray(promptPresets.id, created));
		}
	}
}

const terse = { ...BUILT_IN_NARRATIVE_PRESET, sections: BUILT_IN_NARRATIVE_PRESET.sections.map(section =>
	section.id === 'prose' && section.kind === 'text' ? { ...section, template: 'Keep prose terse and concrete.' } : section) };

integration('narrative prompt presets in disposable PostgreSQL', () => {
	it('keeps presets independent per story and applies newer revisions only explicitly', async () => {
		await twoStories(async ({ first, second }) => {
			const modelRevision = (await loadModelSettings()).revision;
			const secondBefore = await resolveStoryNarrativePreset(second);
			const created = await savePromptPreset({ name: 'Fixture terse', document: terse });
			await selectStoryPromptPreset({ storyId: first, presetId: created.preset.id });
			expect((await resolveStoryNarrativePreset(first))?.use).toMatchObject({ presetId: created.preset.id, revision: 1, source: 'story' });
			expect((await resolveStoryNarrativePreset(second))?.use).toEqual(secondBefore?.use);

			const edited = { ...terse, sections: terse.sections.map(section => section.id === 'pacing' ? { ...section, enabled: false } : section) };
			await savePromptPreset({ presetId: created.preset.id, expectedRevision: 1, name: 'Fixture terse', document: edited });
			// Saving a new revision does not change the campaign's behaviour.
			expect((await resolveStoryNarrativePreset(first))?.use.revision).toBe(1);
			expect((await listPromptPresets(first)).story).toMatchObject({ newerRevision: true, effective: { revision: 1 } });
			await expect(savePromptPreset({ presetId: created.preset.id, expectedRevision: 1, name: 'Fixture terse', document: edited })).rejects.toThrow(/Reload before saving/);

			await selectStoryPromptPreset({ storyId: first, presetId: created.preset.id, revision: 2 });
			const applied = await resolveStoryNarrativePreset(first);
			expect(applied?.use).toMatchObject({ revision: 2, source: 'story' });
			expect(compileNarrativePreset(applied!.document, { headerPrompt: 'The first story preamble.', metadata: {}, settings: {}, genre: null, title: 'First' }).system)
				.not.toContain('For travel, repairs, waiting');
			expect((await resolveStoryNarrativePreset(second))?.use).toEqual(secondBefore?.use);
			expect((await loadModelSettings()).revision).toBe(modelRevision);

			const preview = await previewPromptPreset({ storyId: first });
			expect(preview.use).toMatchObject({ presetId: created.preset.id, revision: 2 });
			expect(preview.sections.find(section => section.id === 'story-preamble')).toMatchObject({ included: true, source: 'preset' });
			expect(preview.sections.find(section => section.id === 'pacing')).toMatchObject({ included: false, omittedReason: 'disabled' });

			const exported = await exportPromptPreset({ presetId: created.preset.id });
			const imported = await importPromptPreset({ ...exported, name: 'Fixture imported' });
			expect(imported.document).toEqual(exported.document);
			expect(imported.preset.id).not.toBe(created.preset.id);
		});
	}, 30_000);

	it('serves the migrated default preset as the previous effective narrator instructions', async () => {
		await twoStories(async ({ second }) => {
			const [override] = await getDb().execute(sql`select system_prompt_override as text from model_task_overrides where task_id = 'narrative'`);
			const resolved = await resolveStoryNarrativePreset(second);
			const story = { headerPrompt: null, metadata: {}, settings: {}, genre: null, title: 'Second' };
			const legacy = typeof override?.text === 'string' && override.text.trim()
				? applyNarrativePromptOverride('unused', override.text)
				: compileNarrativePreset(BUILT_IN_NARRATIVE_PRESET, story).system;
			expect(resolved?.use.source).toBe('default');
			expect(compileNarrativePreset(resolved!.document, story).system).toBe(legacy);
		});
	}, 30_000);
});
