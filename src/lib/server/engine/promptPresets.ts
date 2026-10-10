import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { promptPresetRevisions, promptPresets, stories, storyPromptPresets } from '$lib/server/db/schema';
import {
	promptPresetDocumentSchema,
	promptPresetExportSchema,
	type PromptPresetDocument,
	type PromptPresetSummary,
	type PromptPresetUse,
} from '$lib/contracts/promptPresets';
import { BUILT_IN_NARRATIVE_PRESET, compileNarrativePreset, narrativePresetContentHash, type NarrativePresetStory } from '$lib/server/turn/narrativePreset';

/**
 * Narrative preset storage and explicit selection. Revisions are immutable; a story uses its
 * selected revision, or the default preset's designated default revision. Saving a new revision
 * never changes a story's behaviour until that revision is applied explicitly.
 */

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select'>;

export interface ResolvedNarrativePreset {
	document: PromptPresetDocument;
	use: PromptPresetUse;
	name: string;
}

function summary(row: typeof promptPresets.$inferSelect): PromptPresetSummary {
	return {
		id: row.id, kind: 'narrative', name: row.name, description: row.description,
		currentRevision: row.currentRevision, defaultRevision: row.defaultRevision, isDefault: row.isDefault,
		archived: Boolean(row.archivedAt), updatedAt: row.updatedAt,
	};
}

async function readRevision(db: Reader, presetId: string, revision: number): Promise<PromptPresetDocument> {
	const [row] = await db.select().from(promptPresetRevisions)
		.where(and(eq(promptPresetRevisions.presetId, presetId), eq(promptPresetRevisions.revision, revision))).limit(1);
	if (!row) throw new Error(`Prompt preset ${presetId} revision ${revision} does not exist.`);
	return promptPresetDocumentSchema.parse(row.document);
}

/** The preset revision a story's turns use (read-only). Null when no preset storage exists yet. */
export async function resolveStoryNarrativePreset(storyId: string, db: Reader = getDb()): Promise<ResolvedNarrativePreset | null> {
	const [selection] = await db.select().from(storyPromptPresets).where(eq(storyPromptPresets.storyId, storyId)).limit(1);
	if (selection) {
		const [preset] = await db.select().from(promptPresets).where(eq(promptPresets.id, selection.presetId)).limit(1);
		const document = await readRevision(db, selection.presetId, selection.revision);
		return { document, name: preset?.name ?? selection.presetId,
			use: { presetId: selection.presetId, revision: selection.revision, contentHash: narrativePresetContentHash(document), source: 'story' } };
	}
	const [fallback] = await db.select().from(promptPresets).where(and(eq(promptPresets.kind, 'narrative'), eq(promptPresets.isDefault, true))).limit(1);
	if (!fallback?.defaultRevision) return null;
	const document = await readRevision(db, fallback.id, fallback.defaultRevision);
	return { document, name: fallback.name,
		use: { presetId: fallback.id, revision: fallback.defaultRevision, contentHash: narrativePresetContentHash(document), source: 'default' } };
}

export async function listPromptPresets(storyId?: string | null) {
	const db = getDb();
	const rows = await db.select().from(promptPresets).orderBy(asc(promptPresets.name));
	const selection = storyId ? (await db.select().from(storyPromptPresets).where(eq(storyPromptPresets.storyId, storyId)).limit(1))[0] ?? null : null;
	const effective = storyId ? await resolveStoryNarrativePreset(storyId) : null;
	return {
		presets: rows.map(summary),
		story: storyId ? {
			storyId,
			selection: selection ? { presetId: selection.presetId, revision: selection.revision, selectedAt: selection.selectedAt } : null,
			effective: effective?.use ?? null,
			// A newer revision of the story's preset exists but has not been applied.
			newerRevision: effective ? (rows.find(row => row.id === effective.use.presetId)?.currentRevision ?? 0) > effective.use.revision : false,
		} : null,
	};
}

export async function getPromptPreset(presetId: string, revision?: number) {
	const db = getDb();
	const [preset] = await db.select().from(promptPresets).where(eq(promptPresets.id, presetId)).limit(1);
	if (!preset) throw new Error(`Prompt preset ${presetId} does not exist.`);
	const revisions = await db.select({ revision: promptPresetRevisions.revision, note: promptPresetRevisions.note, createdAt: promptPresetRevisions.createdAt })
		.from(promptPresetRevisions).where(eq(promptPresetRevisions.presetId, presetId)).orderBy(asc(promptPresetRevisions.revision));
	const selected = revision ?? preset.currentRevision;
	return { preset: summary(preset), revision: selected, document: await readRevision(db, presetId, selected), revisions };
}

const saveSchema = z.object({
	presetId: z.string().min(1).optional(),
	/** Required when editing: the revision the edit started from. */
	expectedRevision: z.number().int().positive().optional(),
	name: z.string().trim().min(1).max(120),
	description: z.string().max(2000).default(''),
	note: z.string().max(500).default(''),
	document: promptPresetDocumentSchema,
}).strict();

async function lockPresets(tx: Tx): Promise<void> {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('prompt-presets', 0))`);
}

/** Create a preset, or append a new immutable revision to one. */
export async function savePromptPreset(raw: unknown) {
	const input = saveSchema.parse(raw);
	const presetId = await getDb().transaction(async (tx) => {
		await lockPresets(tx);
		const now = new Date().toISOString();
		if (!input.presetId) {
			const id = `narrative-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
			await tx.insert(promptPresets).values({ id, name: input.name, description: input.description, currentRevision: 1, defaultRevision: null, isDefault: false, metadata: { source: 'settings' }, createdAt: now, updatedAt: now });
			await tx.insert(promptPresetRevisions).values({ presetId: id, revision: 1, document: input.document, note: input.note, createdAt: now });
			return id;
		}
		const [current] = await tx.select().from(promptPresets).where(eq(promptPresets.id, input.presetId)).for('update').limit(1);
		if (!current) throw new Error(`Prompt preset ${input.presetId} does not exist.`);
		if (input.expectedRevision !== undefined && input.expectedRevision !== current.currentRevision) {
			throw new Error(`Prompt preset changed (now revision ${current.currentRevision}). Reload before saving.`);
		}
		const next = current.currentRevision + 1;
		await tx.insert(promptPresetRevisions).values({ presetId: current.id, revision: next, document: input.document, note: input.note, createdAt: now });
		await tx.update(promptPresets).set({ name: input.name, description: input.description, currentRevision: next, updatedAt: now }).where(eq(promptPresets.id, current.id));
		return current.id;
	});
	return getPromptPreset(presetId);
}

export async function duplicatePromptPreset(raw: unknown) {
	const input = z.object({ presetId: z.string().min(1), revision: z.number().int().positive().optional(), name: z.string().trim().min(1).max(120) }).strict().parse(raw);
	const source = await getPromptPreset(input.presetId, input.revision);
	return savePromptPreset({ name: input.name, description: source.preset.description, note: `Duplicated from ${source.preset.name} revision ${source.revision}.`, document: source.document });
}

/** Explicitly choose the preset revision a story uses; never touches another story or global settings. */
export async function selectStoryPromptPreset(raw: unknown) {
	const input = z.object({ storyId: z.string().min(1), presetId: z.string().min(1).nullable(), revision: z.number().int().positive().optional() }).strict().parse(raw);
	await getDb().transaction(async (tx) => {
		const [story] = await tx.select({ id: stories.id }).from(stories).where(eq(stories.id, input.storyId)).limit(1);
		if (!story) throw new Error(`Story ${input.storyId} does not exist.`);
		if (input.presetId === null) {
			await tx.delete(storyPromptPresets).where(eq(storyPromptPresets.storyId, input.storyId));
			return;
		}
		const [preset] = await tx.select().from(promptPresets).where(eq(promptPresets.id, input.presetId)).limit(1);
		if (!preset) throw new Error(`Prompt preset ${input.presetId} does not exist.`);
		const revision = input.revision ?? preset.currentRevision;
		await readRevision(tx, preset.id, revision);
		const selectedAt = new Date().toISOString();
		await tx.insert(storyPromptPresets).values({ storyId: input.storyId, presetId: preset.id, revision, selectedAt, metadata: { selectedBy: 'settings' } })
			.onConflictDoUpdate({ target: storyPromptPresets.storyId, set: { presetId: preset.id, revision, selectedAt } });
	});
	return listPromptPresets(input.storyId);
}

/** Choose which preset revision stories without a selection use. */
export async function setDefaultPromptPreset(raw: unknown) {
	const input = z.object({ presetId: z.string().min(1), revision: z.number().int().positive().optional() }).strict().parse(raw);
	await getDb().transaction(async (tx) => {
		await lockPresets(tx);
		const [preset] = await tx.select().from(promptPresets).where(eq(promptPresets.id, input.presetId)).for('update').limit(1);
		if (!preset) throw new Error(`Prompt preset ${input.presetId} does not exist.`);
		const revision = input.revision ?? preset.currentRevision;
		await readRevision(tx, preset.id, revision);
		await tx.update(promptPresets).set({ isDefault: false }).where(and(eq(promptPresets.kind, 'narrative'), eq(promptPresets.isDefault, true)));
		await tx.update(promptPresets).set({ isDefault: true, defaultRevision: revision, updatedAt: new Date().toISOString() }).where(eq(promptPresets.id, preset.id));
	});
	return listPromptPresets();
}

export async function exportPromptPreset(raw: unknown) {
	const input = z.object({ presetId: z.string().min(1), revision: z.number().int().positive().optional() }).strict().parse(raw);
	const preset = await getPromptPreset(input.presetId, input.revision);
	return promptPresetExportSchema.parse({ format: 'mythengine.prompt-preset', version: 1, name: preset.preset.name, description: preset.preset.description, document: preset.document });
}

export async function importPromptPreset(raw: unknown) {
	const input = promptPresetExportSchema.parse(raw);
	return savePromptPreset({ name: input.name, description: input.description, note: 'Imported.', document: input.document });
}

/** Rendered preview with per-section tokens and sources; reads only. */
export async function previewPromptPreset(raw: unknown) {
	const input = z.object({
		storyId: z.string().min(1).optional(),
		presetId: z.string().min(1).optional(),
		revision: z.number().int().positive().optional(),
		document: promptPresetDocumentSchema.optional(),
	}).strict().parse(raw);
	const db = getDb();
	const [storyRow] = input.storyId ? await db.select({ headerPrompt: stories.headerPrompt, metadata: stories.metadata, settings: stories.settings, genre: stories.genre, title: stories.title })
		.from(stories).where(eq(stories.id, input.storyId)).limit(1) : [];
	if (input.storyId && !storyRow) throw new Error(`Story ${input.storyId} does not exist.`);
	const story: NarrativePresetStory = storyRow ?? { headerPrompt: null, metadata: {}, settings: {}, genre: null, title: '' };
	const resolved = input.document ? { document: input.document, use: null }
		: input.presetId ? { document: (await getPromptPreset(input.presetId, input.revision)).document, use: null }
			: input.storyId ? await resolveStoryNarrativePreset(input.storyId) : null;
	const document = resolved?.document ?? BUILT_IN_NARRATIVE_PRESET;
	return { ...compileNarrativePreset(document, story), use: resolved?.use ?? null, contentHash: narrativePresetContentHash(document) };
}
