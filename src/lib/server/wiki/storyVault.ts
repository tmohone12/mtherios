import { asc, desc, eq } from 'drizzle-orm';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '$lib/server/db/client';
import {
	agreements,
	arcs,
	chapters,
	entities,
	entityAliases,
	factions,
	factionGoals,
	factionMemberships,
	factionProjects,
	factionResources,
	memoryNodes,
	npcBeliefs,
	relationships,
	sagas,
	stories,
	storyEntries,
	storyEvents,
	storyThreads,
} from '$lib/server/db/schema';
import {
	ensureServerDataDirs,
	getMtheriosAppConfig,
	resolveVaultPath,
	type MtheriosAppConfig,
} from '$lib/server/app/config';
import {
	buildCharacterProjectionMarkdown,
	CHARACTER_PROJECTION_SCHEMA_VERSION,
	resolveCharacterProjectionPath,
	scanCharacterProjectionPages,
	type ExistingCharacterProjectionRecord,
} from './characterProjection';

type StoryRow = typeof stories.$inferSelect;
type StoryEntryRow = typeof storyEntries.$inferSelect;
type EntityRow = typeof entities.$inferSelect;
type EntityAliasRow = typeof entityAliases.$inferSelect;
type RelationshipRow = typeof relationships.$inferSelect;
type FactionRow = typeof factions.$inferSelect;
type FactionMembershipRow = typeof factionMemberships.$inferSelect;
type FactionResourceRow = typeof factionResources.$inferSelect;
type FactionGoalRow = typeof factionGoals.$inferSelect;
type FactionProjectRow = typeof factionProjects.$inferSelect;
type NpcBeliefRow = typeof npcBeliefs.$inferSelect;
type AgreementRow = typeof agreements.$inferSelect;
type ThreadRow = typeof storyThreads.$inferSelect;
type ChapterRow = typeof chapters.$inferSelect;
type ArcRow = typeof arcs.$inferSelect;
type SagaRow = typeof sagas.$inferSelect;
type EventRow = typeof storyEvents.$inferSelect;
type MemoryNodeRow = typeof memoryNodes.$inferSelect;

export interface StoryVaultTargetInput {
	storyId?: string | null;
	vaultPath?: string | null;
	collection?: string | null;
}

export interface StoryVaultTarget {
	storyId?: string | null;
	vaultPath: string;
	collection: string;
}

export interface MaterializeStoryVaultInput {
	storyId: string;
	clean?: boolean;
}

export interface MaterializedStoryVault {
	ok: true;
	storyId: string;
	vaultPath: string;
	collection: string;
	counts: Record<string, number>;
	manifest: StoryVaultManifest;
	files: string[];
}

export interface StoryVaultManifest {
	schemaVersion: 1;
	storyId: string;
	storyTitle: string;
	serverVersion: number;
	generatedAt: string;
	vaultPath: string;
	collection: string;
	counts: Record<string, number>;
	index?: {
		collection: string;
		serverVersion: number;
		indexedAt: string;
		provider?: string | null;
		model?: string | null;
		recreate?: boolean;
		outputTail?: string;
	};
}

export interface StoryVaultLintRecord {
	schemaVersion: 1;
	storyId: string;
	serverVersion: number;
	lintedAt: string;
	report: unknown;
}

export interface StoryVaultLintStatus {
	exists: boolean;
	fresh: boolean;
	ok: boolean | null;
	issueCount: number | null;
	lintedAt: string | null;
	path: string;
	summary: Record<string, unknown> | null;
}

export interface StoryVaultStatus {
	storyId: string;
	storyTitle: string;
	serverVersion: number;
	manifestVersion: number | null;
	indexedVersion: number | null;
	vaultPath: string;
	collection: string;
	exists: boolean;
	vaultFresh: boolean;
	indexFresh: boolean;
	manifest: StoryVaultManifest | null;
	lint: StoryVaultLintStatus;
}

export interface StoryVaultFreshnessItem {
	storyId: string;
	storyTitle: string;
	serverVersion: number;
	manifestVersion: number | null;
	indexedVersion: number | null;
	exists: boolean;
	vaultFresh: boolean;
	indexFresh: boolean;
	lintExists: boolean;
	lintFresh: boolean;
	vaultPath: string;
	collection: string;
	updatedAt: string;
}

export interface StoryVaultFreshnessSummary {
	totalStories: number;
	vaultFresh: number;
	vaultStale: number;
	vaultMissing: number;
	indexFresh: number;
	indexStale: number;
	indexMissing: number;
	lintFresh: number;
	lintStale: number;
	lintMissing: number;
	attention: StoryVaultFreshnessItem[];
}

export interface StoryVaultArtifactCleanup {
	storyId: string;
	vaultPath: string;
	collection: string;
	vaultDeleted: boolean;
	qdrantDeleted: boolean | null;
	qdrantStatus: number | null;
	qdrantError: string | null;
}

export interface StoryVaultArchive {
	storyId: string;
	storyTitle: string;
	vaultPath: string;
	filename: string;
	bytes: Uint8Array;
	status: StoryVaultStatus;
	materialized: boolean;
}

const storyVaultLocks = new Map<string, Promise<void>>();

export async function withStoryVaultLock<T>(storyId: string, run: () => Promise<T>): Promise<T> {
	const cleanStoryId = storyId.trim();
	if (!cleanStoryId) throw new Error('storyId is required.');
	const previous = storyVaultLocks.get(cleanStoryId) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const active = previous.catch(() => undefined).then(() => current);
	storyVaultLocks.set(cleanStoryId, active);
	await previous.catch(() => undefined);
	try {
		return await run();
	} finally {
		release();
		if (storyVaultLocks.get(cleanStoryId) === active) {
			storyVaultLocks.delete(cleanStoryId);
		}
	}
}

export function resolveWikiTarget(
	input: StoryVaultTargetInput,
	config: MtheriosAppConfig = getMtheriosAppConfig(),
): StoryVaultTarget {
	if (input.storyId?.trim()) {
		const storyId = input.storyId.trim();
		return {
			storyId,
			vaultPath: input.vaultPath?.trim()
				? resolveVaultPath(input.vaultPath, config)
				: storyVaultPath(storyId, config),
			collection: input.collection?.trim() || storyVaultCollection(storyId, config),
		};
	}

	return {
		storyId: null,
		vaultPath: resolveVaultPath(input.vaultPath, config),
		collection: input.collection?.trim() || config.qdrantCollection,
	};
}

export function storyVaultPath(storyId: string, config: MtheriosAppConfig = getMtheriosAppConfig()): string {
	ensureServerDataDirs(config);
	return path.resolve(config.vaultRoot, 'stories', safeSegment(storyId));
}

export function storyVaultCollection(storyId: string, config: MtheriosAppConfig = getMtheriosAppConfig()): string {
	return `${config.qdrantCollection}_${safeSegment(storyId).replace(/-/g, '_')}`;
}

export async function materializeStoryVault(input: MaterializeStoryVaultInput): Promise<MaterializedStoryVault> {
	const storyId = input.storyId.trim();
	if (!storyId) throw new Error('storyId is required.');
	return withStoryVaultLock(storyId, () => materializeStoryVaultUnlocked({ ...input, storyId }));
}

async function materializeStoryVaultUnlocked(input: MaterializeStoryVaultInput): Promise<MaterializedStoryVault> {
	const config = getMtheriosAppConfig();
	const storyId = input.storyId.trim();
	if (!storyId) throw new Error('storyId is required.');
	const target = resolveWikiTarget({ storyId }, config);
	const vaultPath = target.vaultPath;
	assertPathInside(config.vaultRoot, vaultPath);

	const data = await loadStoryVaultData(storyId);
	const existingCharacterPages = input.clean === false
		? await scanCharacterProjectionPages(vaultPath)
		: new Map<string, ExistingCharacterProjectionRecord>();
	const previousManifest = await readStoryVaultManifest(storyId, config);
	if (input.clean !== false) {
		await fs.rm(vaultPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
	}
	await fs.mkdir(vaultPath, { recursive: true });

	const files = new Map<string, string>();
	const entityAliasMap = aliasesByEntity(data.aliases);
	const entityTitleMap = new Map(data.entities.map((entity) => [entity.id, entity.name]));

	addFile(files, 'README.md', renderReadme(data.story, data));
	addFile(files, 'AGENTS.md', renderAgents(data.story));
	addFile(files, 'index.md', renderIndex(data, entityAliasMap));
	addFile(files, 'log.md', renderLog(data.story));
	addFile(files, 'synthesis.md', renderSynthesis(data));
	addFile(files, 'world-database.md', renderWorldDatabase(data));

	for (const entry of data.entries) {
		addFile(files, `raw/transcript/${rawEntryFilename(entry)}`, renderRawEntry(entry));
	}

	for (const entity of data.entities) {
		if (entity.type === 'character') {
			const existing = existingCharacterPages.get(entity.id);
			const relativePath = resolveCharacterProjectionPath({
				canonicalName: entity.name,
				id: entity.id,
				existingPages: existingCharacterPages,
			});
			addFile(files, relativePath, renderCharacterProjection(entity, entityAliasMap.get(entity.id) ?? [], data, entityTitleMap, existing?.content ?? null));
			continue;
		}
		addFile(files, entityRelPath(entity), renderEntity(entity, entityAliasMap.get(entity.id) ?? [], data, entityTitleMap));
	}

	for (const faction of data.factions) {
		addFile(files, `wiki/factions/${pageFile(faction.name, faction.id)}`, renderFaction(faction, data, entityTitleMap));
	}

	for (const chapter of data.chapters) {
		addFile(files, `chapters/${String(chapter.number).padStart(3, '0')}-${slug(chapter.title || `chapter-${chapter.number}`)}.md`, renderChapter(chapter, entityTitleMap));
	}

	for (const arc of data.arcs) {
		addFile(files, `arcs/${String(arc.number).padStart(3, '0')}-${slug(arc.title || `arc-${arc.number}`)}.md`, renderArc(arc));
	}

	for (const saga of data.sagas) {
		addFile(files, `sagas/${String(saga.number).padStart(3, '0')}-${slug(saga.title || `saga-${saga.number}`)}.md`, renderSaga(saga));
	}

	for (const event of data.events) {
		addFile(files, `events/${pageFile(eventPageTitle(event), event.id)}`, renderEvent(event, entityTitleMap));
	}

	for (const node of data.memoryNodes) {
		addFile(files, `memory/${pageFile(memoryPageTitle(node), node.id)}`, renderMemoryNode(node, entityTitleMap));
	}

	if (data.agreements.length > 0) addFile(files, 'agreements/index.md', renderAgreements(data.agreements));
	addFile(files, 'threads.md', renderThreads(data.threads, entityTitleMap));
	addFile(files, 'relationships.md', renderRelationships(data.relationships, entityTitleMap));

	const counts = {
		files: files.size,
		entries: data.entries.length,
		entities: data.entities.length,
		factions: data.factions.length,
		factionMemberships: data.factionMemberships.length,
		factionResources: data.factionResources.length,
		factionGoals: data.factionGoals.length,
		factionProjects: data.factionProjects.length,
		npcBeliefs: data.npcBeliefs.length,
		chapters: data.chapters.length,
		arcs: data.arcs.length,
		sagas: data.sagas.length,
		events: data.events.length,
		memoryNodes: data.memoryNodes.length,
	};
	const manifest: StoryVaultManifest = {
		schemaVersion: 1,
		storyId,
		storyTitle: data.story.title,
		serverVersion: data.story.serverVersion,
		generatedAt: nowIso(),
		vaultPath,
		collection: target.collection,
		counts,
	};
	if (
		previousManifest?.index &&
		previousManifest.serverVersion === data.story.serverVersion &&
		previousManifest.index.serverVersion === data.story.serverVersion &&
		previousManifest.index.collection === target.collection
	) {
		manifest.index = previousManifest.index;
	}

	for (const [relPath, contents] of files) {
		const abs = path.join(vaultPath, relPath);
		assertPathInside(vaultPath, abs);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, contents, 'utf8');
	}
	await writeStoryVaultManifest(storyId, manifest, config);

	return {
		ok: true,
		storyId,
		vaultPath,
		collection: target.collection,
		counts,
		manifest,
		files: [...files.keys()].sort((a, b) => a.localeCompare(b)),
	};
}

export async function readStoryVaultManifest(
	storyId: string,
	config: MtheriosAppConfig = getMtheriosAppConfig(),
): Promise<StoryVaultManifest | null> {
	const manifest = storyVaultManifestPath(storyId, config);
	try {
		return JSON.parse(await fs.readFile(manifest, 'utf8')) as StoryVaultManifest;
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') return null;
		throw error;
	}
}

export async function readStoryVaultLintRecord(
	storyId: string,
	config: MtheriosAppConfig = getMtheriosAppConfig(),
): Promise<StoryVaultLintRecord | null> {
	const reportPath = storyVaultLintPath(storyId, config);
	try {
		return JSON.parse(await fs.readFile(reportPath, 'utf8')) as StoryVaultLintRecord;
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') return null;
		throw error;
	}
}

export async function writeStoryVaultLintReport(input: {
	storyId: string;
	report: unknown;
}, config: MtheriosAppConfig = getMtheriosAppConfig()): Promise<StoryVaultLintRecord> {
	const manifest = await readStoryVaultManifest(input.storyId, config);
	const record: StoryVaultLintRecord = {
		schemaVersion: 1,
		storyId: input.storyId,
		serverVersion: manifest?.serverVersion ?? 0,
		lintedAt: nowIso(),
		report: input.report,
	};
	const reportPath = storyVaultLintPath(input.storyId, config);
	assertPathInside(storyVaultPath(input.storyId, config), reportPath);
	await fs.mkdir(path.dirname(reportPath), { recursive: true });
	await fs.writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
	return record;
}

export async function getStoryVaultStatus(
	storyId: string,
	config: MtheriosAppConfig = getMtheriosAppConfig(),
): Promise<StoryVaultStatus> {
	const cleanStoryId = storyId.trim();
	if (!cleanStoryId) throw new Error('storyId is required.');
	const [story] = await getDb().select().from(stories).where(eq(stories.id, cleanStoryId)).limit(1);
	if (!story) throw new Error(`Story not found: ${cleanStoryId}`);
	const target = resolveWikiTarget({ storyId: cleanStoryId }, config);
	const manifest = await readStoryVaultManifest(cleanStoryId, config);
	const lintRecord = await readStoryVaultLintRecord(cleanStoryId, config);
	const exists = await pathExists(target.vaultPath);
	const vaultFresh = Boolean(manifest && manifest.serverVersion === story.serverVersion);
	const indexFresh = Boolean(
		vaultFresh &&
		manifest?.index &&
		manifest.index.serverVersion === story.serverVersion &&
		manifest.index.collection === target.collection,
	);
	return {
		storyId: cleanStoryId,
		storyTitle: story.title,
		serverVersion: story.serverVersion,
		manifestVersion: manifest?.serverVersion ?? null,
		indexedVersion: manifest?.index?.serverVersion ?? null,
		vaultPath: target.vaultPath,
		collection: target.collection,
		exists,
		vaultFresh,
		indexFresh,
		manifest,
		lint: storyVaultLintStatus(cleanStoryId, story.serverVersion, lintRecord, config),
	};
}

export async function getStoryVaultFreshnessSummary(
	config: MtheriosAppConfig = getMtheriosAppConfig(),
	limit = 12,
): Promise<StoryVaultFreshnessSummary> {
	const items = await listStoryVaultFreshnessItems(config);
	const attention = items
		.filter((item) => !item.vaultFresh || !item.indexFresh)
		.slice(0, Math.max(1, limit));

	return {
		totalStories: items.length,
		vaultFresh: items.filter((item) => item.vaultFresh).length,
		vaultStale: items.filter((item) => item.exists && !item.vaultFresh).length,
		vaultMissing: items.filter((item) => !item.exists).length,
		indexFresh: items.filter((item) => item.indexFresh).length,
		indexStale: items.filter((item) => item.indexedVersion != null && !item.indexFresh).length,
		indexMissing: items.filter((item) => item.indexedVersion == null).length,
		lintFresh: items.filter((item) => item.lintFresh).length,
		lintStale: items.filter((item) => item.lintExists && !item.lintFresh).length,
		lintMissing: items.filter((item) => !item.lintExists).length,
		attention,
	};
}

export async function listStoryVaultFreshnessItems(
	config: MtheriosAppConfig = getMtheriosAppConfig(),
	limit = 500,
): Promise<StoryVaultFreshnessItem[]> {
	ensureServerDataDirs(config);
	const rows = await getDb()
		.select()
		.from(stories)
		.orderBy(desc(stories.updatedAt))
		.limit(Math.max(1, limit));

	return Promise.all(rows.map(async (story): Promise<StoryVaultFreshnessItem> => {
		const target = resolveWikiTarget({ storyId: story.id }, config);
		const [manifest, lintRecord, exists] = await Promise.all([
			readStoryVaultManifest(story.id, config),
			readStoryVaultLintRecord(story.id, config),
			pathExists(target.vaultPath),
		]);
		const vaultFresh = Boolean(manifest && manifest.serverVersion === story.serverVersion);
		const indexFresh = Boolean(
			vaultFresh &&
			manifest?.index &&
			manifest.index.serverVersion === story.serverVersion &&
			manifest.index.collection === target.collection,
		);
		const lint = storyVaultLintStatus(story.id, story.serverVersion, lintRecord, config);
		return {
			storyId: story.id,
			storyTitle: story.title,
			serverVersion: story.serverVersion,
			manifestVersion: manifest?.serverVersion ?? null,
			indexedVersion: manifest?.index?.serverVersion ?? null,
			exists,
			vaultFresh,
			indexFresh,
			lintExists: lint.exists,
			lintFresh: lint.fresh,
			vaultPath: target.vaultPath,
			collection: target.collection,
			updatedAt: story.updatedAt,
		};
	}));
}

export async function ensureFreshStoryVault(
	storyId: string,
	config: MtheriosAppConfig = getMtheriosAppConfig(),
): Promise<{ materialized: boolean; status: StoryVaultStatus }> {
	const cleanStoryId = storyId.trim();
	if (!cleanStoryId) throw new Error('storyId is required.');
	return withStoryVaultLock(cleanStoryId, () => ensureFreshStoryVaultUnlocked(cleanStoryId, config));
}

export async function withFreshStoryVault<T>(
	storyId: string,
	config: MtheriosAppConfig,
	run: (freshness: { materialized: boolean; status: StoryVaultStatus }) => Promise<T>,
): Promise<T> {
	const cleanStoryId = storyId.trim();
	if (!cleanStoryId) throw new Error('storyId is required.');
	return withStoryVaultLock(cleanStoryId, async () => {
		const freshness = await ensureFreshStoryVaultUnlocked(cleanStoryId, config);
		return run(freshness);
	});
}

async function ensureFreshStoryVaultUnlocked(
	storyId: string,
	config: MtheriosAppConfig = getMtheriosAppConfig(),
): Promise<{ materialized: boolean; status: StoryVaultStatus }> {
	const status = await getStoryVaultStatus(storyId, config);
	if (status.exists && status.vaultFresh && await storyVaultTranscriptComplete(storyId, config)) {
		return { materialized: false, status };
	}
	await materializeStoryVaultUnlocked({ storyId, clean: true });
	return {
		materialized: true,
		status: await getStoryVaultStatus(storyId, config),
	};
}

export async function archiveStoryVault(
	storyId: string,
	config: MtheriosAppConfig = getMtheriosAppConfig(),
): Promise<StoryVaultArchive> {
	const cleanStoryId = storyId.trim();
	if (!cleanStoryId) throw new Error('storyId is required.');
	return withFreshStoryVault(cleanStoryId, config, async ({ materialized, status }) => {
		const target = resolveWikiTarget({ storyId: cleanStoryId }, config);
		assertPathInside(config.vaultRoot, target.vaultPath);

		const zip = new JSZip();
		await addDirectoryToZip(zip, target.vaultPath, target.vaultPath);
		const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
		const date = new Date().toISOString().slice(0, 10);
		const title = slug(status.storyTitle || cleanStoryId, 50);
		return {
			storyId: cleanStoryId,
			storyTitle: status.storyTitle,
			vaultPath: target.vaultPath,
			filename: `${title}-${date}.wiki.zip`,
			bytes,
			status,
			materialized,
		};
	});
}

export async function markStoryVaultIndexed(input: {
	storyId: string;
	collection: string;
	provider?: string | null;
	model?: string | null;
	recreate?: boolean;
	output?: string;
}, config: MtheriosAppConfig = getMtheriosAppConfig()): Promise<StoryVaultManifest | null> {
	const manifest = await readStoryVaultManifest(input.storyId, config);
	if (!manifest) return null;
	const updated: StoryVaultManifest = {
		...manifest,
		index: {
			collection: input.collection,
			serverVersion: manifest.serverVersion,
			indexedAt: nowIso(),
			provider: input.provider ?? null,
			model: input.model ?? null,
			recreate: input.recreate === true,
			outputTail: tailLines(input.output ?? '', 8),
		},
	};
	await writeStoryVaultManifest(input.storyId, updated, config);
	return updated;
}

export async function deleteStoryVaultArtifacts(
	storyId: string,
	config: MtheriosAppConfig = getMtheriosAppConfig(),
): Promise<StoryVaultArtifactCleanup> {
	const cleanStoryId = storyId.trim();
	if (!cleanStoryId) throw new Error('storyId is required.');
	return withStoryVaultLock(cleanStoryId, async () => {
		const target = resolveWikiTarget({ storyId: cleanStoryId }, config);
		assertPathInside(config.vaultRoot, target.vaultPath);

		const vaultDeleted = await pathExists(target.vaultPath);
		await fs.rm(target.vaultPath, { recursive: true, force: true });
		const qdrant = await deleteQdrantCollection(target.collection, config);
		return {
			storyId: cleanStoryId,
			vaultPath: target.vaultPath,
			collection: target.collection,
			vaultDeleted,
			qdrantDeleted: qdrant.deleted,
			qdrantStatus: qdrant.status,
			qdrantError: qdrant.error,
		};
	});
}

async function loadStoryVaultData(storyId: string) {
	const db = getDb();
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);

	const [
		entryRows,
		entityRows,
		aliasRows,
		relationshipRows,
		factionRows,
		factionMembershipRows,
		factionResourceRows,
		factionGoalRows,
		factionProjectRows,
		npcBeliefRows,
		agreementRows,
		threadRows,
		chapterRows,
		arcRows,
		sagaRows,
		eventRows,
		nodeRows,
	] = await Promise.all([
		db.select().from(storyEntries).where(eq(storyEntries.storyId, storyId)).orderBy(asc(storyEntries.position)).limit(10000),
		db.select().from(entities).where(eq(entities.storyId, storyId)).orderBy(asc(entities.type), asc(entities.name)).limit(5000),
		db.select().from(entityAliases).where(eq(entityAliases.storyId, storyId)).orderBy(asc(entityAliases.alias)).limit(10000),
		db.select().from(relationships).where(eq(relationships.storyId, storyId)).limit(10000),
		db.select().from(factions).where(eq(factions.storyId, storyId)).orderBy(desc(factions.pressure), asc(factions.name)).limit(1000),
		db.select().from(factionMemberships).where(eq(factionMemberships.storyId, storyId)).orderBy(asc(factionMemberships.factionId), asc(factionMemberships.role)).limit(10000),
		db.select().from(factionResources).where(eq(factionResources.storyId, storyId)).orderBy(asc(factionResources.factionId), asc(factionResources.kind), asc(factionResources.name)).limit(10000),
		db.select().from(factionGoals).where(eq(factionGoals.storyId, storyId)).orderBy(asc(factionGoals.factionId), desc(factionGoals.priority), asc(factionGoals.goal)).limit(5000),
		db.select().from(factionProjects).where(eq(factionProjects.storyId, storyId)).orderBy(asc(factionProjects.factionId), asc(factionProjects.status), desc(factionProjects.priority), asc(factionProjects.project)).limit(5000),
		db.select().from(npcBeliefs).where(eq(npcBeliefs.storyId, storyId)).orderBy(desc(npcBeliefs.updatedAt)).limit(5000),
		db.select().from(agreements).where(eq(agreements.storyId, storyId)).orderBy(desc(agreements.updatedAt)).limit(2000),
		db.select().from(storyThreads).where(eq(storyThreads.storyId, storyId)).orderBy(desc(storyThreads.updatedAt)).limit(2000),
		db.select().from(chapters).where(eq(chapters.storyId, storyId)).orderBy(asc(chapters.number)).limit(2000),
		db.select().from(arcs).where(eq(arcs.storyId, storyId)).orderBy(asc(arcs.number)).limit(1000),
		db.select().from(sagas).where(eq(sagas.storyId, storyId)).orderBy(asc(sagas.number)).limit(500),
		db.select().from(storyEvents).where(eq(storyEvents.storyId, storyId)).orderBy(desc(storyEvents.createdAt)).limit(5000),
		db.select().from(memoryNodes).where(eq(memoryNodes.storyId, storyId)).orderBy(desc(memoryNodes.importance), desc(memoryNodes.updatedAt)).limit(5000),
	]);

	return {
		story,
		entries: entryRows,
		entities: entityRows,
		aliases: aliasRows,
		relationships: relationshipRows,
		factions: factionRows,
		factionMemberships: factionMembershipRows,
		factionResources: factionResourceRows,
		factionGoals: factionGoalRows,
		factionProjects: factionProjectRows,
		npcBeliefs: npcBeliefRows,
		agreements: agreementRows,
		threads: threadRows,
		chapters: chapterRows,
		arcs: arcRows,
		sagas: sagaRows,
		events: eventRows,
		memoryNodes: nodeRows,
	};
}

function renderReadme(story: StoryRow, data: Awaited<ReturnType<typeof loadStoryVaultData>>): string {
	return [
		frontmatter({ title: `${story.title} Wiki`, storyId: story.id, generatedAt: nowIso(), type: 'vault_readme' }),
		`# ${story.title} Wiki`,
		'',
		'This vault is generated by the Mtherios terminal process from the terminal world database.',
		'',
		'## Contents',
		`- Transcript sources: ${data.entries.length}`,
		`- Entities: ${data.entities.length}`,
		`- Factions: ${data.factions.length}`,
		`- Faction memberships: ${data.factionMemberships.length}`,
		`- Faction goals: ${data.factionGoals.length}`,
		`- Faction resources: ${data.factionResources.length}`,
		`- NPC beliefs: ${data.npcBeliefs.length}`,
		`- Chapters: ${data.chapters.length}`,
		`- Arcs: ${data.arcs.length}`,
		`- Sagas: ${data.sagas.length}`,
		`- Events: ${data.events.length}`,
		`- Memory nodes: ${data.memoryNodes.length}`,
		'',
		'Raw transcript files are evidence. Derived wiki pages can be regenerated.',
	].join('\n');
}

function renderAgents(story: StoryRow): string {
	return [
		frontmatter({ title: 'Agent Maintainer Schema', storyId: story.id, type: 'agent_schema' }),
		'# Agent Maintainer Schema',
		'',
		'Use this vault as a persistent story knowledge base.',
		'',
		'## Rules',
		'- Treat `raw/` transcript files as immutable evidence.',
		'- Treat the terminal Postgres world database as the source of truth for characters, factions, relationships, beliefs, events, chapters, arcs, sagas, and memory nodes.',
		'- Treat `wiki/`, `chapters/`, `arcs/`, `sagas/`, `events/`, `memory/`, and synthesis pages as generated views.',
		'- Use [[world-database|World Database]] for the current database-to-wiki schema and dossier shape.',
		'- Prefer Obsidian wikilinks when connecting people, places, factions, concepts, chapters, events, and memories.',
		'- When claims conflict, prefer the terminal world database and the newest source entries.',
		'- Qdrant is an index, not canon. Rebuild it from markdown when needed.',
	].join('\n');
}

function renderLog(story: StoryRow): string {
	return [
		frontmatter({ title: 'Log', storyId: story.id, type: 'wiki_log' }),
		'# Log',
		'',
		'Chronological record of terminal wiki maintenance.',
		'',
		`## [${nowIso().slice(0, 10)}] sync | Generated from terminal world database`,
		`- Story: ${story.title}`,
		`- Terminal database version: ${story.serverVersion}`,
	].join('\n');
}

function renderIndex(data: Awaited<ReturnType<typeof loadStoryVaultData>>, aliasMap: Map<string, string[]>): string {
	const lines = [
		frontmatter({ title: 'Index', storyId: data.story.id, type: 'index' }),
		'# Index',
		'',
		'## Core',
		'- [[synthesis|Synthesis]]',
		'- [[world-database|World Database]]',
		'- [[log|Log]]',
		'- [[relationships|Relationships]]',
		'- [[threads|Threads]]',
		'',
		'## Entities',
		...data.entities.map((entity) => {
			const aliases = aliasMap.get(entity.id) ?? [];
			return `- [[${entity.name}]] (${entity.type})${aliases.length ? ` - aliases: ${aliases.join(', ')}` : ''}`;
		}),
		'',
		'## Factions',
		...data.factions.map((faction) => `- [[${faction.name}]] - pressure ${faction.pressure}`),
		'',
		'## Chapters',
		...data.chapters.map((chapter) => `- [[Chapter ${chapter.number}: ${chapter.title || 'Untitled'}]]`),
		'',
		'## Events',
		...data.events.slice(0, 300).map((event) => `- [[${eventPageTitle(event)}|${event.title || event.type}]] (${event.type})`),
		'',
		'## Memory Nodes',
		...data.memoryNodes.slice(0, 300).map((node) => `- [[${memoryPageTitle(node)}|${node.title}]] (${node.type}, importance ${node.importance})`),
	];
	return lines.join('\n');
}

function renderSynthesis(data: Awaited<ReturnType<typeof loadStoryVaultData>>): string {
	const activeThreads = data.threads.filter((thread) => thread.status === 'open').slice(0, 20);
	const highPressure = data.factions.filter((faction) => faction.pressure >= 25).slice(0, 20);
	return [
		frontmatter({ title: 'Synthesis', storyId: data.story.id, type: 'synthesis' }),
		`# ${data.story.title} Synthesis`,
		'',
		data.story.description ? `## Premise\n\n${data.story.description}` : '',
		'## Current Shape',
		`- Terminal database version: ${data.story.serverVersion}`,
		`- Transcript entries: ${data.entries.length}`,
		`- Known entities: ${data.entities.length}`,
		`- Faction memberships: ${data.factionMemberships.length}`,
		`- Faction goals: ${data.factionGoals.length}`,
		`- NPC beliefs: ${data.npcBeliefs.length}`,
		`- Memory nodes: ${data.memoryNodes.length}`,
		'',
		'## Active Threads',
		activeThreads.length ? activeThreads.map((thread) => `- ${thread.description} (${thread.significance})`).join('\n') : '- None recorded.',
		'',
		'## High Pressure Factions',
		highPressure.length ? highPressure.map((faction) => `- [[${faction.name}]]: pressure ${faction.pressure}`).join('\n') : '- None over threshold.',
		'',
		'## Canon Notes',
		'This synthesis is generated from the terminal world database, not browser cache. Use it as the current entry point for the story vault, then follow links into raw transcript entries, event pages, memory nodes, chapters, arcs, factions, and entity pages for evidence. When the story is still small, this page is intentionally sparse but remains the place where the broader shape of the campaign should accumulate.',
	].filter(Boolean).join('\n');
}

function renderWorldDatabase(data: Awaited<ReturnType<typeof loadStoryVaultData>>): string {
	const entityCounts = countBy(data.entities.map((entity) => entity.type || 'entity'));
	const openGoals = data.factionGoals.filter((goal) => goal.status !== 'closed').length;
	const activeMemberships = data.factionMemberships.filter((membership) => membership.status === 'active').length;
	return [
		frontmatter({ title: 'World Database', storyId: data.story.id, type: 'world_database' }),
		'# World Database',
		'',
		'This page describes the canon-to-wiki contract for this story vault. Postgres is the canon database. Markdown is a generated, searchable, link-followable projection. Qdrant is an index over that projection and can be rebuilt.',
		'',
		'## Current Counts',
		`- Story entries: ${data.entries.length}`,
		`- Entities: ${data.entities.length}${Object.keys(entityCounts).length ? ` (${Object.entries(entityCounts).map(([key, value]) => `${key}: ${value}`).join(', ')})` : ''}`,
		`- Factions: ${data.factions.length}`,
		`- Active faction memberships: ${activeMemberships}`,
		`- Open faction goals: ${openGoals}`,
		`- Faction resources: ${data.factionResources.length}`,
		`- NPC beliefs: ${data.npcBeliefs.length}`,
		`- Relationships: ${data.relationships.length}`,
		`- Story events: ${data.events.length}`,
		`- Memory nodes: ${data.memoryNodes.length}`,
		'',
		'## Canon Tables',
		'- `stories`: story shell, settings, current location, and server version.',
		'- `story_entries`: transcript evidence. These are the raw source pages under `raw/transcript/`.',
		'- `entities`: characters, locations, items, faction entities, events, and concepts.',
		'- `entity_aliases`: searchable alternate names for entities.',
		'- `factions`: political/social group records with pressure, legacy member IDs, and compatibility goal/resource fields.',
		'- `faction_memberships`: normalized membership edges from characters/entities into factions.',
		'- `faction_goals`: normalized active, closed, public, and secret faction objectives.',
		'- `faction_resources`: normalized military, social, economic, magical, territorial, or logistical resources.',
		'- `relationships`: durable edges between entities.',
		'- `npc_beliefs`: what a character believes about an entity, faction-linked entity, or situation.',
		'- `story_events`, `story_threads`, `agreements`, `memory_nodes`, `chapters`, and `arcs`: the living history and retrieval layer.',
		'',
		'## Character Dossier Shape',
		'- Identity: entity type, status, visibility, aliases, and source evidence.',
		'- Description: the canonical entity description.',
		'- Profile: personality, motivations, goals, pressures, known facts, secrets, current location, and disposition extracted from `entities.state`.',
		'- Factions: normalized `faction_memberships` plus legacy faction member IDs until all old imports are migrated.',
		'- Relationships: `relationships` rows touching the entity.',
		'- Beliefs: `npc_beliefs` the character holds, plus beliefs other characters hold about them.',
		'- Related memory/events: memory nodes and events that cite the entity.',
		'',
		'## Faction Dossier Shape',
		'- Pressure and linked faction entity.',
		'- Goals from normalized `faction_goals`, with legacy `factions.goals` as a compatibility fallback.',
		'- Members from normalized `faction_memberships`, with roles, ranks, status, visibility, and member links.',
		'- Resources from normalized `faction_resources`, with legacy `factions.resources` as a fallback.',
		'- Allies, enemies, relationships, beliefs, memory, events, and source evidence.',
		'',
		'## Exploration Workflow',
		'- Start at [[index|Index]] or this page for orientation.',
		'- Search the vault or Qdrant for the question.',
		'- Follow Obsidian links and backlinks into character, faction, event, chapter, arc, and raw transcript evidence pages.',
		'- If a generated page looks stale, regenerate the story vault from the terminal process instead of editing generated markdown by hand.',
	].join('\n');
}

function renderRawEntry(entry: StoryEntryRow): string {
	return [
		frontmatter({ title: rawEntryTitle(entry), storyId: entry.storyId, entryId: entry.id, position: entry.position, type: 'raw_source' }),
		`# ${rawEntryTitle(entry)}`,
		'',
		`- Type: ${entry.type}`,
		`- Position: ${entry.position}`,
		entry.branchId ? `- Branch: ${entry.branchId}` : '',
		'',
		'## Content',
		'',
		entry.content,
	].filter(Boolean).join('\n');
}

function renderEntity(entity: EntityRow, aliases: string[], data: Awaited<ReturnType<typeof loadStoryVaultData>>, entityTitleMap: Map<string, string>): string {
	const outgoing = data.relationships.filter((rel) => rel.sourceEntityId === entity.id || rel.targetEntityId === entity.id);
	const relatedFactionLines = factionLinesForEntity(entity, data, entityTitleMap);
	const profileLines = entityProfileLines(entity, entityTitleMap);
	const metadata = asRecord(entity.metadata);
	const resolver = asRecord(metadata.entityResolver);
	const confidence = typeof resolver.confidence === 'number' ? resolver.confidence : null;
	const sourceRefs = uniqueStrings([
		...(entity.sourceEntryIds ?? []),
		...(entity.sourceEventIds ?? []),
		...(entity.sourcePatchIds ?? []),
	]);
	const beliefsHeld = data.npcBeliefs.filter((belief) => belief.believerEntityId === entity.id).slice(0, 25);
	const beliefsAbout = data.npcBeliefs.filter((belief) => belief.subjectEntityId === entity.id).slice(0, 25);
	const relatedEvents = data.events
		.filter((event) =>
			event.actorEntityIds.includes(entity.id) ||
			event.targetEntityIds.includes(entity.id) ||
			event.locationId === entity.id
		)
		.slice(0, 20);
	const relatedMemory = data.memoryNodes.filter((node) => node.entityIds.includes(entity.id)).slice(0, 20);
	return [
		frontmatter({
			id: entity.id,
			type: entity.type,
			canonical_name: entity.name,
			aliases,
			status: entity.status,
			first_seen_entry_id: entity.sourceEntryIds[0] ?? null,
			source_refs: sourceRefs,
			confidence,
			schema_version: 1,
			title: entity.name,
			name: entity.name,
			storyId: entity.storyId,
			entityId: entity.id,
			visibility: entity.visibility,
		}),
		`# ${entity.name}`,
		'',
		'## Identity',
		`- Type: ${entity.type}`,
		`- Status: ${entity.status}`,
		`- Visibility: ${entity.visibility}`,
		aliases.length ? `- Aliases: ${aliases.join(', ')}` : '',
		'',
		'## Description',
		entity.description || '_No description yet._',
		'',
		profileLines.length ? `## Profile\n${profileLines.join('\n')}` : '',
		'',
		relatedFactionLines.length ? `## Factions\n${relatedFactionLines.join('\n')}` : '',
		'',
		outgoing.length ? `## Relationships\n${outgoing.map((rel) => relationshipLine(rel, entityTitleMap)).join('\n')}` : '',
		'',
		beliefsHeld.length ? `## Beliefs Held\n${beliefsHeld.map((belief) => beliefLine(belief, entityTitleMap)).join('\n')}` : '',
		'',
		beliefsAbout.length ? `## Beliefs About This Entity\n${beliefsAbout.map((belief) => beliefLine(belief, entityTitleMap)).join('\n')}` : '',
		'',
		relatedEvents.length ? `## Related Events\n${relatedEvents.map((event) => `- [[${eventPageTitle(event)}|${event.title || event.type}]] (${event.type}, ${event.visibility})`).join('\n')}` : '',
		'',
		relatedMemory.length ? `## Related Memory\n${relatedMemory.map((node) => `- [[${memoryPageTitle(node)}|${node.title}]] (${node.type}, importance ${node.importance})`).join('\n')}` : '',
		'',
		'## Canon State',
		codeJson(entity.state),
		'',
		sourceLinks(entity.sourceEntryIds, entity.sourceEventIds),
	].filter(Boolean).join('\n');
}

function renderCharacterProjection(
	entity: EntityRow,
	aliases: string[],
	data: Awaited<ReturnType<typeof loadStoryVaultData>>,
	entityTitleMap: Map<string, string>,
	existingContent: string | null,
): string {
	const outgoing = data.relationships.filter((rel) => rel.sourceEntityId === entity.id || rel.targetEntityId === entity.id);
	const relatedFactionLines = factionLinesForEntity(entity, data, entityTitleMap);
	const profileLines = entityProfileLines(entity, entityTitleMap);
	const metadata = asRecord(entity.metadata);
	const resolver = asRecord(metadata.entityResolver);
	const confidence = typeof resolver.confidence === 'number' ? resolver.confidence : null;
	const sourceRefs = uniqueStrings([
		...(entity.sourceEntryIds ?? []),
		...(entity.sourceEventIds ?? []),
		...(entity.sourcePatchIds ?? []),
	]);
	const beliefsHeld = data.npcBeliefs.filter((belief) => belief.believerEntityId === entity.id).slice(0, 25);
	const beliefsAbout = data.npcBeliefs.filter((belief) => belief.subjectEntityId === entity.id).slice(0, 25);
	const relatedEvents = data.events
		.filter((event) =>
			event.actorEntityIds.includes(entity.id) ||
			event.targetEntityIds.includes(entity.id) ||
			event.locationId === entity.id
		)
		.slice(0, 20);
	const relatedMemory = data.memoryNodes.filter((node) => node.entityIds.includes(entity.id)).slice(0, 20);

	return buildCharacterProjectionMarkdown({
		id: entity.id,
		canonicalName: entity.name,
		aliases,
		status: entity.status,
		firstSeenEntryId: entity.sourceEntryIds[0] ?? null,
		sourceRefs,
		confidence,
		description: entity.description || '_No description yet._',
		currentStateLines: characterCurrentStateLines(entity, entityTitleMap),
		profileLines,
		eventMemoryLines: characterEventMemoryLines(entity),
		relatedFactions: relatedFactionLines,
		relationships: outgoing.map((rel) => relationshipLine(rel, entityTitleMap)),
		beliefsHeld: beliefsHeld.map((belief) => beliefLine(belief, entityTitleMap)),
		beliefsAbout: beliefsAbout.map((belief) => beliefLine(belief, entityTitleMap)),
		relatedEvents: relatedEvents.map((event) => `- [[${eventPageTitle(event)}|${event.title || event.type}]] (${event.type}, ${event.visibility})`),
		relatedMemory: relatedMemory.map((node) => `- [[${memoryPageTitle(node)}|${node.title}]] (${node.type}, importance ${node.importance})`),
		sourceEntryIds: entity.sourceEntryIds,
		sourceEventIds: entity.sourceEventIds,
		canonState: entity.state,
		schemaVersion: CHARACTER_PROJECTION_SCHEMA_VERSION,
	}, existingContent);
}

function renderFaction(faction: FactionRow, data: Awaited<ReturnType<typeof loadStoryVaultData>>, entityTitleMap: Map<string, string>): string {
	const goals = data.factionGoals
		.filter((goal) => goal.factionId === faction.id)
		.sort((a, b) => (b.priority - a.priority) || a.goal.localeCompare(b.goal));
	const memberships = data.factionMemberships
		.filter((membership) => membership.factionId === faction.id)
		.sort((a, b) => membershipSortKey(a, entityTitleMap).localeCompare(membershipSortKey(b, entityTitleMap)));
	const resources = data.factionResources
		.filter((resource) => resource.factionId === faction.id)
		.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
	const projects = data.factionProjects
		.filter((project) => project.factionId === faction.id)
		.sort((a, b) => a.status.localeCompare(b.status) || b.priority - a.priority || a.project.localeCompare(b.project));
	const normalizedMemberIds = new Set(memberships.flatMap((membership) => [
		membership.entityId,
		asString(asRecord(membership.metadata).memberNameOrId),
	]).filter((id): id is string => Boolean(id)));
	const legacyMembers = faction.memberEntityIds
		.filter((id) => !normalizedMemberIds.has(id))
		.map((id) => entityTitleMap.get(id) ?? id);
	const factionEntityName = faction.entityId ? entityTitleMap.get(faction.entityId) ?? faction.entityId : null;
	const relationships = data.relationships.filter((rel) =>
		rel.sourceEntityId === faction.entityId ||
		rel.targetEntityId === faction.entityId
	);
	const beliefs = faction.entityId
		? data.npcBeliefs.filter((belief) => belief.subjectEntityId === faction.entityId || belief.believerEntityId === faction.entityId).slice(0, 25)
		: [];
	const relatedEvents = data.events
		.filter((event) =>
			(faction.entityId && (event.actorEntityIds.includes(faction.entityId) || event.targetEntityIds.includes(faction.entityId))) ||
			event.actorEntityIds.includes(faction.id) ||
			event.targetEntityIds.includes(faction.id)
		)
		.slice(0, 20);
	const relatedMemory = data.memoryNodes
		.filter((node) => node.factionIds.includes(faction.id) || node.factionIds.includes(faction.name) || (faction.entityId ? node.entityIds.includes(faction.entityId) : false))
		.slice(0, 20);
	const sourceEntryIds = uniqueStrings(
		faction.sourceEntryIds,
		...goals.map((goal) => goal.sourceEntryIds),
		...memberships.map((membership) => membership.sourceEntryIds),
		...resources.map((resource) => resource.sourceEntryIds),
		...projects.map((project) => project.sourceEntryIds),
	);
	const sourceEventIds = uniqueStrings(
		faction.sourceEventIds,
		...goals.map((goal) => goal.sourceEventIds),
		...memberships.map((membership) => membership.sourceEventIds),
		...resources.map((resource) => resource.sourceEventIds),
		...projects.map((project) => project.sourceEventIds),
	);
	return [
		frontmatter({ title: faction.name, name: faction.name, storyId: faction.storyId, factionId: faction.id, type: 'faction', pressure: faction.pressure }),
		`# ${faction.name}`,
		'',
		'## Canon Record',
		`- Pressure: ${faction.pressure}`,
		factionEntityName ? `- Linked entity: ${wikilink(factionEntityName)}` : '',
		'',
		goals.length ? `## Goals\n${goals.map(goalLine).join('\n')}` : sectionList('Goals', faction.goals),
		'',
		memberships.length || legacyMembers.length
			? `## Members\n${[
				...memberships.map((membership) => membershipLine(membership, entityTitleMap)),
				...legacyMembers.map((name) => `- ${entityReference(name, entityTitleMap)} (legacy member id)`),
			].join('\n')}`
			: '',
		'',
		resources.length ? `## Resources\n${resources.map((resource) => resourceLine(resource, entityTitleMap)).join('\n')}` : [
			'## Resources',
			codeJson(faction.resources),
		].join('\n'),
		'',
		projects.length ? `## Projects\n${projects.map(projectLine).join('\n')}` : '',
		'',
		faction.allies.length ? `## Allies\n${faction.allies.map((name) => `- ${factionLink(name, data)}`).join('\n')}` : '',
		'',
		faction.enemies.length ? `## Enemies\n${faction.enemies.map((name) => `- ${factionLink(name, data)}`).join('\n')}` : '',
		'',
		relationships.length ? `## Relationships\n${relationships.map((rel) => relationshipLine(rel, entityTitleMap)).join('\n')}` : '',
		'',
		beliefs.length ? `## Beliefs\n${beliefs.map((belief) => beliefLine(belief, entityTitleMap)).join('\n')}` : '',
		'',
		relatedEvents.length ? `## Related Events\n${relatedEvents.map((event) => `- [[${eventPageTitle(event)}|${event.title || event.type}]] (${event.type}, ${event.visibility})`).join('\n')}` : '',
		'',
		relatedMemory.length ? `## Related Memory\n${relatedMemory.map((node) => `- [[${memoryPageTitle(node)}|${node.title}]] (${node.type}, importance ${node.importance})`).join('\n')}` : '',
		'',
		Object.keys(asRecord(faction.metadata)).length ? `## Metadata\n${codeJson(faction.metadata)}` : '',
		'',
		sourceLinks(sourceEntryIds, sourceEventIds),
	].filter(Boolean).join('\n');
}

function renderChapter(chapter: ChapterRow, entityTitleMap: Map<string, string>): string {
	const title = `Chapter ${chapter.number}: ${chapter.title || 'Untitled'}`;
	return [
		frontmatter({ title, storyId: chapter.storyId, chapterId: chapter.id, type: 'chapter', number: chapter.number }),
		`# ${title}`,
		'',
		chapter.sceneOutcome,
		sectionList('Irreversible Changes', chapter.irreversibleChanges),
		sectionList('Promises, Debts, Oaths', chapter.promisesDebtsOaths),
		sectionList('Discovered Clues', chapter.discoveredClues),
		sectionList('Relationship Changes', chapter.relationshipChanges),
		sectionList('Faction Changes', chapter.factionChanges),
		sectionList('Open Threads', chapter.openThreads.map((id) => entityTitleMap.get(id) ?? id)),
		sourceLinks(chapter.sourceEntryIds, chapter.sourceEventIds),
	].filter(Boolean).join('\n');
}

function renderArc(arc: ArcRow): string {
	return [
		frontmatter({ title: `Arc ${arc.number}: ${arc.title}`, storyId: arc.storyId, arcId: arc.id, type: 'arc', number: arc.number }),
		`# Arc ${arc.number}: ${arc.title}`,
		'',
		arc.summary,
		sectionList('Chapters', arc.chapterIds),
		sectionList('Open Threads', arc.openThreadIds),
		sourceLinks([], arc.sourceEventIds),
	].filter(Boolean).join('\n');
}

function renderSaga(saga: SagaRow): string {
	return [
		frontmatter({ title: `Saga ${saga.number}: ${saga.title}`, storyId: saga.storyId, sagaId: saga.id, type: 'saga', number: saga.number }),
		`# Saga ${saga.number}: ${saga.title}`,
		'',
		saga.summary,
		sectionList('Arcs', saga.arcIds),
		sectionList('Key Faction Shifts', saga.keyFactionShifts),
		sectionList('Major Power Changes', saga.majorPowerChanges),
		sectionList('Lingering Threads', saga.lingeringThreads),
		saga.overallTone ? `## Overall Tone\n\n${saga.overallTone}` : '',
		sectionList('Open Threads', saga.openThreadIds),
		sourceLinks([], saga.sourceEventIds),
	].filter(Boolean).join('\n');
}

function renderEvent(event: EventRow, entityTitleMap: Map<string, string>): string {
	const title = eventPageTitle(event);
	return [
		frontmatter({ title, storyId: event.storyId, eventId: event.id, type: 'event', eventType: event.type, visibility: event.visibility }),
		`# ${title}`,
		'',
		`- Canon event title: ${event.title || event.type}`,
		`- Event type: ${event.type}`,
		'',
		event.body,
		sectionList('Actors', event.actorEntityIds.map((id) => wikilink(entityTitleMap.get(id) ?? id))),
		sectionList('Targets', event.targetEntityIds.map((id) => wikilink(entityTitleMap.get(id) ?? id))),
		sectionList('Threads', event.threadIds),
		sourceLinks(event.sourceEntryIds, []),
	].filter(Boolean).join('\n');
}

function renderMemoryNode(node: MemoryNodeRow, entityTitleMap: Map<string, string>): string {
	const title = memoryPageTitle(node);
	return [
		frontmatter({ title, storyId: node.storyId, memoryNodeId: node.id, type: 'memory', memoryType: node.type, importance: node.importance }),
		`# ${title}`,
		'',
		`- Canon memory title: ${node.title}`,
		`- Memory type: ${node.type}`,
		`- Importance: ${node.importance}`,
		'',
		node.content,
		node.summary ? `\n## Summary\n\n${node.summary}` : '',
		sectionList('Keywords', node.keywords),
		sectionList('Entities', node.entityIds.map((id) => wikilink(entityTitleMap.get(id) ?? id))),
		sourceLinks(node.sourceEntryIds, node.sourceEventIds),
	].filter(Boolean).join('\n');
}

function renderAgreements(rows: AgreementRow[]): string {
	return [
		frontmatter({ title: 'Agreements', type: 'agreement_index' }),
		'# Agreements',
		'',
		...rows.map((row) => [
			`## ${row.category}: ${row.parties.join(' / ') || row.id}`,
			`- Status: ${row.status}`,
			`- Secrecy: ${row.secrecy}`,
			'',
			row.terms,
			sectionList('Consequences', row.consequences),
			sourceLinks(row.sourceEntryIds, row.sourceEventIds),
		].filter(Boolean).join('\n')),
	].join('\n\n');
}

function renderThreads(rows: ThreadRow[], entityTitleMap: Map<string, string>): string {
	const body = rows.length > 0
		? rows.map((row) => [
			`## ${row.description}`,
			`- Status: ${row.status}`,
			`- Significance: ${row.significance}`,
			sectionList('Related Entities', row.relatedEntityIds.map((id) => wikilink(entityTitleMap.get(id) ?? id))),
			sectionList('Related Factions', row.relatedFactionIds),
			sourceLinks(row.sourceEntryIds, row.sourceEventIds),
		].filter(Boolean).join('\n'))
		: [
			'No open or resolved story threads are recorded yet.',
			'',
			'This page becomes the agenda of unresolved questions, promises, mysteries, threats, and plans once the terminal world database records them. The terminal process regenerates it from thread rows, so an agent can use it as a stable place to check what still matters before narrating or maintaining the wiki.',
		];
	return [
		frontmatter({ title: 'Threads', type: 'thread_index' }),
		'# Threads',
		'',
		...body,
	].join('\n\n');
}

function renderRelationships(rows: RelationshipRow[], entityTitleMap: Map<string, string>): string {
	const body = rows.length > 0
		? [
			'| Source | Type | Target | Strength | Label |',
			'| --- | --- | --- | ---: | --- |',
			...rows.map((row) => `| ${wikilink(entityTitleMap.get(row.sourceEntityId) ?? row.sourceEntityId)} | ${row.type} | ${wikilink(entityTitleMap.get(row.targetEntityId) ?? row.targetEntityId)} | ${row.strength} | ${escapeTable(row.label ?? '')} |`),
		]
		: [
			'No entity relationships are recorded yet.',
			'',
			'This page is reserved for durable links between characters, factions, places, items, and other entities once the terminal world database records them. It should become a quick map of alliances, rivalries, debts, kinship, ownership, trust, hostility, and other relationship edges that the narrator and wiki maintainer need to preserve.',
		];
	return [
		frontmatter({ title: 'Relationships', type: 'relationship_index' }),
		'# Relationships',
		'',
		...body,
	].join('\n');
}

function relationshipLine(row: RelationshipRow, entityTitleMap: Map<string, string>): string {
	return `- ${wikilink(entityTitleMap.get(row.sourceEntityId) ?? row.sourceEntityId)} ${row.type} ${wikilink(entityTitleMap.get(row.targetEntityId) ?? row.targetEntityId)} (${row.strength})`;
}

function factionLinesForEntity(
	entity: EntityRow,
	data: Awaited<ReturnType<typeof loadStoryVaultData>>,
	entityTitleMap: Map<string, string>,
): string[] {
	const factionById = new Map(data.factions.map((faction) => [faction.id, faction]));
	const lines: string[] = [];
	const seen = new Set<string>();

	for (const membership of data.factionMemberships) {
		const memberName = asString(asRecord(membership.metadata).memberNameOrId);
		const matches = membership.entityId === entity.id || normalizeLookup(memberName) === normalizeLookup(entity.name);
		if (!matches) continue;
		const faction = factionById.get(membership.factionId);
		const factionName = faction?.name ?? membership.factionId;
		seen.add(membership.factionId);
		lines.push(membershipLine(membership, entityTitleMap, factionName));
	}

	for (const faction of data.factions) {
		const isFactionEntity = faction.entityId === entity.id;
		const isLegacyMember = faction.memberEntityIds.includes(entity.id);
		if (!isFactionEntity && !isLegacyMember) continue;
		if (seen.has(faction.id) && !isFactionEntity) continue;
		lines.push(`- [[${faction.name}]]${isFactionEntity ? ' - linked faction entity' : ' - legacy member id'}; pressure ${faction.pressure}`);
	}

	return lines;
}

function entityProfileLines(entity: EntityRow, entityTitleMap: Map<string, string>): string[] {
	const state = asRecord(entity.state);
	const metadata = asRecord(entity.metadata);
	const lines: string[] = [];
	const type = String(state.type || entity.type);

	pushLabeledValue(lines, 'Appearance', firstString(state, ['appearance']));
	pushLabeledValue(lines, 'Background', firstString(state, ['background', 'bio']));
	pushLabeledValue(lines, 'Speech style', firstString(state, ['speechStyle', 'voice']));
	pushLabeledValue(lines, 'Disposition', firstString(state, ['currentDisposition', 'disposition', 'status']));
	pushLabeledValue(lines, 'Personality', firstString(state, ['personality', 'personalOpinion']));
	pushLabeledList(lines, 'Motivations', stringListFromKeys(state, ['motivations', 'goals', 'objectives']));
	pushLabeledList(lines, 'Pressures', stringListFromKeys(state, ['pressures', 'activePressures']));
	pushLabeledList(lines, 'Traits', stringListFromKeys(state, ['traits', 'tags']));
	pushLabeledList(lines, 'Faction tags', stringListFromKeys(state, ['factionTags', 'faction_tags']));
	pushLabeledList(lines, 'Known facts', stringListFromKeys(state, ['knownFacts', 'facts']));
	pushLabeledList(lines, 'Secrets', stringListFromKeys(state, ['revealedSecrets', 'secrets']));
	pushLabeledList(lines, 'Present characters', stringListFromKeys(state, ['presentCharacters']).map((value) => linkIfKnown(value, entityTitleMap)));
	pushLabeledList(lines, 'Present items', stringListFromKeys(state, ['presentItems']).map((value) => linkIfKnown(value, entityTitleMap)));

	const relationship = asRecord(state.relationship);
	if (Object.keys(relationship).length > 0) {
		const status = asString(relationship.status);
		const level = typeof relationship.level === 'number' ? relationship.level : null;
		pushLabeledValue(lines, 'Relationship to player', [status, level != null ? `level ${level}` : ''].filter(Boolean).join(', '));
	}

	if (type === 'faction') {
		pushLabeledValue(lines, 'Player standing', numberOrString(state.playerStanding));
		pushLabeledValue(lines, 'Faction status', firstString(state, ['status']));
		pushLabeledList(lines, 'Territory', stringListFromKeys(state, ['territory', 'territories']));
	}

	const legacyMetadata = asRecord(metadata.originalMetadata);
	pushLabeledValue(lines, 'Original source', asString(legacyMetadata.source));
	return lines;
}

function characterCurrentStateLines(entity: EntityRow, entityTitleMap: Map<string, string>): string[] {
	const state = asRecord(entity.state);
	const relationship = asRecord(state.relationship);
	const lines: string[] = [];
	if (typeof state.present === 'boolean') lines.push(`- Presence: ${state.present ? 'present in current scene' : 'not currently visible'}`);
	pushLabeledValue(lines, 'Status', asString(state.status, entity.status));
	pushLabeledValue(lines, 'Current location', linkIfKnown(firstString(state, ['currentLocation', 'currentLocationId', 'lastSeenLocation', 'location']), entityTitleMap));
	pushLabeledValue(lines, 'Current action', firstString(state, ['currentAction', 'activeTask']));
	pushLabeledValue(lines, 'Emotional state', firstString(state, ['emotionalState', 'emotionalPosture']));
	if (Object.keys(relationship).length > 0) {
		const status = asString(relationship.status);
		const level = typeof relationship.level === 'number' ? relationship.level : null;
		pushLabeledValue(lines, 'Relationship to player', [status, level != null ? `level ${level}` : ''].filter(Boolean).join(', '));
	} else {
		pushLabeledValue(lines, 'Relationship', firstString(state, ['relationship']));
	}
	return lines;
}

function characterEventMemoryLines(entity: EntityRow): string[] {
	const state = asRecord(entity.state);
	const memory = asRecord(state.eventMemory ?? state.npcEventMemory);
	const labels = [
		['did', 'Did'],
		['saw', 'Saw'],
		['knew', 'Knew'],
		['knows', 'Knows'],
	] as const;
	return labels.flatMap(([key, label]) =>
		asStringArray(memory[key]).slice(-8).map((item) => `- ${label}: ${compactText(item, 260)}`));
}

function membershipLine(
	membership: FactionMembershipRow,
	entityTitleMap: Map<string, string>,
	factionName?: string,
): string {
	const member = membership.entityId
		? entityTitleMap.get(membership.entityId) ?? membership.entityId
		: asString(asRecord(membership.metadata).memberNameOrId, 'unknown member');
	const parts = [
		factionName ? wikilink(factionName) : entityReference(member, entityTitleMap),
		membership.role,
		membership.rank ? `rank ${membership.rank}` : '',
		membership.status,
		membership.visibility !== 'player_known' ? membership.visibility : '',
	].filter(Boolean);
	return `- ${parts.join(' - ')}`;
}

function membershipSortKey(membership: FactionMembershipRow, entityTitleMap: Map<string, string>): string {
	const member = membership.entityId
		? entityTitleMap.get(membership.entityId) ?? membership.entityId
		: asString(asRecord(membership.metadata).memberNameOrId, '');
	return `${membership.role}:${member}:${membership.status}`;
}

function goalLine(goal: FactionGoalRow): string {
	const details = [
		`priority ${goal.priority}`,
		goal.status,
		goal.secrecy !== 'player_known' ? goal.secrecy : '',
	].filter(Boolean).join(', ');
	return `- ${goal.goal}${details ? ` (${details})` : ''}`;
}

function resourceLine(resource: FactionResourceRow, entityTitleMap: Map<string, string>): string {
	const location = resource.locationId ? linkIfKnown(resource.locationId, entityTitleMap) : '';
	const details = [
		resource.amount != null ? `amount ${resource.amount}` : '',
		resource.status,
		location ? `location ${location}` : '',
		resource.visibility !== 'player_known' ? resource.visibility : '',
	].filter(Boolean).join(', ');
	return `- ${resource.kind}: ${resource.name}${details ? ` (${details})` : ''}`;
}

function compactText(value: string, maxLength = 160): string {
	const text = value.replace(/\s+/g, ' ').trim();
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function projectLine(project: FactionProjectRow): string {
	const costs = Object.keys(asRecord(project.costs)).length ? `costs ${compactText(JSON.stringify(project.costs), 120)}` : '';
	const gains = Object.keys(asRecord(project.gains)).length ? `gains ${compactText(JSON.stringify(project.gains), 120)}` : '';
	const risks = project.risks.length ? `risks ${project.risks.slice(0, 3).join('; ')}` : '';
	const due = project.dueTurn != null ? `due turn ${project.dueTurn}` : '';
	const details = [
		project.status,
		`priority ${project.priority}`,
		`progress ${Math.round(project.progress * 100)}%`,
		due,
		costs,
		gains,
		risks,
		project.visibility !== 'player_known' ? project.visibility : '',
	].filter(Boolean).join(', ');
	return `- ${project.project}${details ? ` (${details})` : ''}`;
}

function beliefLine(belief: NpcBeliefRow, entityTitleMap: Map<string, string>): string {
	const believer = entityTitleMap.get(belief.believerEntityId) ?? belief.believerEntityId;
	const subject = belief.subjectEntityId ? entityTitleMap.get(belief.subjectEntityId) ?? belief.subjectEntityId : 'the situation';
	const confidence = Math.round(Math.max(0, Math.min(1, belief.confidence)) * 100);
	return `- ${wikilink(believer)} about ${wikilink(subject)}: ${belief.belief} (${confidence}% confidence, ${belief.visibility})`;
}

function factionLink(nameOrId: string, data: Awaited<ReturnType<typeof loadStoryVaultData>>): string {
	const normalized = normalizeLookup(nameOrId);
	const faction = data.factions.find((row) => row.id === nameOrId || normalizeLookup(row.name) === normalized);
	return wikilink(faction?.name ?? nameOrId);
}

function aliasesByEntity(rows: EntityAliasRow[]): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const row of rows) {
		const list = map.get(row.entityId) ?? [];
		list.push(row.alias);
		map.set(row.entityId, list);
	}
	return map;
}

function sourceLinks(entryIds: string[], eventIds: string[]): string {
	const lines = [
		...entryIds.map((id) => `- source entry: ${id}`),
		...eventIds.map((id) => `- source event: ${id}`),
	];
	return lines.length ? `## Sources\n${lines.join('\n')}` : '';
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => typeof item === 'string' ? item.trim() : '')
		.filter(Boolean);
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = asString(record[key]);
		if (value) return value;
	}
	return '';
}

function stringListFromKeys(record: Record<string, unknown>, keys: string[]): string[] {
	const values = keys.flatMap((key) => {
		const value = record[key];
		if (Array.isArray(value)) return asStringArray(value);
		const item = asString(value);
		return item ? [item] : [];
	});
	return uniqueStrings(values);
}

function pushLabeledValue(lines: string[], label: string, value: string): void {
	if (!value) return;
	lines.push(`- ${label}: ${value}`);
}

function pushLabeledList(lines: string[], label: string, values: string[]): void {
	const clean = values.map((value) => value.trim()).filter(Boolean);
	if (!clean.length) return;
	lines.push(`- ${label}: ${clean.join('; ')}`);
}

function linkIfKnown(value: string, entityTitleMap: Map<string, string>): string {
	if (!value) return '';
	const title = entityTitleMap.get(value) ?? value;
	return entityTitleMap.has(value) ? wikilink(title) : title;
}

function entityReference(value: string, entityTitleMap: Map<string, string>): string {
	if (!value) return '';
	return wikilink(entityTitleMap.get(value) ?? value);
}

function numberOrString(value: unknown): string {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return asString(value);
}

function uniqueStrings(...values: Array<string[] | undefined | null>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const list of values) {
		for (const item of list ?? []) {
			const clean = item.trim();
			if (!clean || seen.has(clean)) continue;
			seen.add(clean);
			out.push(clean);
		}
	}
	return out;
}

function normalizeLookup(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function countBy(values: string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}

function sectionList(title: string, rows: string[]): string {
	const clean = rows.filter(Boolean);
	return clean.length ? `\n## ${title}\n${clean.map((item) => `- ${item}`).join('\n')}` : '';
}

function addFile(files: Map<string, string>, relPath: string, contents: string): void {
	files.set(toSlashPath(relPath), `${contents.trim()}\n`);
}

function frontmatter(obj: Record<string, unknown>): string {
	const lines = ['---'];
	for (const [key, value] of Object.entries(obj)) {
		if (value == null || value === '') continue;
		lines.push(`${key}: ${JSON.stringify(value)}`);
	}
	lines.push('---', '');
	return lines.join('\n');
}

function entityRelPath(entity: EntityRow): string {
	const folder = entity.type === 'character'
		? 'characters'
		: entity.type === 'location'
			? 'locations'
			: entity.type === 'item'
				? 'items'
				: entity.type === 'faction'
					? 'factions'
					: entity.type === 'event'
						? 'events'
						: 'concepts';
	return `wiki/${folder}/${pageFile(entity.name, entity.id)}`;
}

function rawEntryFilename(entry: StoryEntryRow): string {
	return `${String(entry.position).padStart(6, '0')}-${slug(entry.type)}--${entry.id.slice(0, 8)}.md`;
}

function rawEntryTitle(entry: StoryEntryRow): string {
	return `Entry ${entry.position} - ${entry.type.replace(/_/g, ' ')}`;
}

function eventPageTitle(event: Pick<EventRow, 'title' | 'type'>): string {
	const title = cleanTitle(event.title || event.type);
	return title.toLowerCase().startsWith('event:') ? title : `Event: ${title}`;
}

function memoryPageTitle(node: Pick<MemoryNodeRow, 'title' | 'type'>): string {
	const title = cleanTitle(node.title || node.type);
	return title.toLowerCase().startsWith('memory:') ? title : `Memory: ${title}`;
}

function cleanTitle(value: string): string {
	return value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
}

function pageFile(title: string, id: string): string {
	return `${slug(title)}--${id.slice(0, 8)}.md`;
}

function safeSegment(value: string): string {
	return slug(value, 90).replace(/-/g, '_') || 'story';
}

function storyVaultManifestPath(storyId: string, config: MtheriosAppConfig = getMtheriosAppConfig()): string {
	return path.join(storyVaultPath(storyId, config), '.mtherios', 'story-vault.json');
}

function storyVaultLintPath(storyId: string, config: MtheriosAppConfig = getMtheriosAppConfig()): string {
	return path.join(storyVaultPath(storyId, config), '.mtherios', 'wiki-lint.json');
}

function storyVaultLintStatus(
	storyId: string,
	serverVersion: number,
	record: StoryVaultLintRecord | null,
	config: MtheriosAppConfig,
): StoryVaultLintStatus {
	const report = record?.report && typeof record.report === 'object'
		? record.report as Record<string, unknown>
		: null;
	const summary = report?.summary && typeof report.summary === 'object' && !Array.isArray(report.summary)
		? report.summary as Record<string, unknown>
		: null;
	const issueCount = typeof summary?.issueCount === 'number'
		? summary.issueCount
		: null;
	const ok = typeof report?.ok === 'boolean'
		? report.ok
		: null;
	return {
		exists: Boolean(record),
		fresh: Boolean(record && record.serverVersion === serverVersion),
		ok,
		issueCount,
		lintedAt: record?.lintedAt ?? null,
		path: storyVaultLintPath(storyId, config),
		summary,
	};
}

async function writeStoryVaultManifest(
	storyId: string,
	manifest: StoryVaultManifest,
	config: MtheriosAppConfig,
): Promise<void> {
	const manifestPath = storyVaultManifestPath(storyId, config);
	assertPathInside(storyVaultPath(storyId, config), manifestPath);
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function addDirectoryToZip(zip: JSZip, rootPath: string, currentPath: string): Promise<void> {
	const entries = await fs.readdir(currentPath, { withFileTypes: true });
	for (const entry of entries) {
		const absolutePath = path.join(currentPath, entry.name);
		assertPathInside(rootPath, absolutePath);
		const relativePath = toSlashPath(path.relative(rootPath, absolutePath));
		if (entry.isDirectory()) {
			await addDirectoryToZip(zip, rootPath, absolutePath);
		} else if (entry.isFile()) {
			zip.file(relativePath, await fs.readFile(absolutePath));
		}
	}
}

async function pathExists(value: string): Promise<boolean> {
	try {
		await fs.stat(value);
		return true;
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') return false;
		throw error;
	}
}

async function storyVaultTranscriptComplete(
	storyId: string,
	config: MtheriosAppConfig,
): Promise<boolean> {
	const target = resolveWikiTarget({ storyId }, config);
	const transcriptDir = path.join(target.vaultPath, 'raw', 'transcript');
	const rows = await getDb()
		.select({
			id: storyEntries.id,
			type: storyEntries.type,
			position: storyEntries.position,
		})
		.from(storyEntries)
		.where(eq(storyEntries.storyId, storyId))
		.orderBy(asc(storyEntries.position))
		.limit(10000);
	try {
		const files = await fs.readdir(transcriptDir);
		if (files.filter((file) => file.toLowerCase().endsWith('.md')).length < rows.length) return false;
		const fileSet = new Set(files);
		for (const row of rows) {
			if (!fileSet.has(rawEntryFilename(row as StoryEntryRow))) return false;
		}
		return true;
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') return false;
		throw error;
	}
}

async function deleteQdrantCollection(
	collection: string,
	config: MtheriosAppConfig,
): Promise<{ deleted: boolean | null; status: number | null; error: string | null }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2500);
	try {
		const response = await fetch(
			`${config.qdrantUrl.replace(/\/$/, '')}/collections/${encodeURIComponent(collection)}`,
			{ method: 'DELETE', signal: controller.signal },
		);
		const text = await response.text();
		if (response.status === 404) return { deleted: false, status: 404, error: null };
		if (!response.ok) {
			return {
				deleted: null,
				status: response.status,
				error: `Qdrant DELETE ${collection} failed (${response.status}): ${text.slice(0, 500)}`,
			};
		}
		return { deleted: true, status: response.status, error: null };
	} catch (error) {
		const reason = (error as { name?: string }).name === 'AbortError'
			? 'Qdrant delete timed out.'
			: error instanceof Error
				? error.message
				: String(error);
		return { deleted: null, status: null, error: reason };
	} finally {
		clearTimeout(timeout);
	}
}

function tailLines(value: string, count: number): string {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-count)
		.join('\n')
		.slice(0, 2000);
}

function slug(text: string, max = 80): string {
	return String(text || 'untitled')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, max) || 'untitled';
}

function wikilink(title: string): string {
	return `[[${title.replace(/\]/g, '')}]]`;
}

function codeJson(value: unknown): string {
	return `\`\`\`json\n${JSON.stringify(value ?? {}, null, 2)}\n\`\`\``;
}

function escapeTable(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function toSlashPath(value: string): string {
	return value.replace(/\\/g, '/');
}

function nowIso(): string {
	return new Date().toISOString();
}

function assertPathInside(parent: string, child: string): void {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
	throw new Error(`Refusing to write outside ${parent}: ${child}`);
}
