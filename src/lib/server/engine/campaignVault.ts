import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { getMtheriosAppConfig, type MtheriosAppConfig } from '$lib/server/app/config';
import { getDb } from '$lib/server/db/client';
import { campaignFiles } from '$lib/server/db/schema';
import type { CampaignVaultStatus } from '$lib/contracts/engine';

type JsonRecord = Record<string, unknown>;

export type CampaignFileKind =
	| 'manifest'
	| 'raw_turn'
	| 'raw_event'
	| 'character_page'
	| 'faction_page'
	| 'lore_page'
	| 'rules_page'
	| 'schedule_page'
	| 'chapter_page'
	| 'arc_page'
	| 'memory_page'
	| 'projection';

export interface CampaignStoryRef {
	id: string;
	title?: string | null;
	serverVersion?: number | null;
}

export interface CampaignFileIndexRecord {
	storyId: string;
	relativePath: string;
	kind: CampaignFileKind;
	contentHash: string;
	byteLength: number;
	serverVersion: number;
	metadata?: JsonRecord;
}

export interface AppendTurnEvidenceInput {
	story: CampaignStoryRef;
	clientTurnId: string;
	position: number;
	playerText: string;
	narration: string;
	eventIds?: string[];
	statePatchIds?: string[];
	retrievedMemoryIds?: string[];
	memoryNodeIds?: string[];
	warnings?: string[];
	generationTimings?: Array<Record<string, unknown>>;
	metadata?: JsonRecord;
}

export interface WriteCampaignPageInput {
	story: CampaignStoryRef;
	kind: string;
	name: string;
	title?: string | null;
	body: string;
	tags?: string[];
	entityIds?: string[];
	factionIds?: string[];
	sourceEntryIds?: string[];
	sourceEventIds?: string[];
	sourcePatchIds?: string[];
	relativePath?: string | null;
	metadata?: JsonRecord;
}

export interface CampaignVaultWriteResult {
	files: Array<{
		absolutePath: string;
		relativePath: string;
		kind: CampaignFileKind;
		contentHash: string;
		byteLength: number;
	}>;
}

export interface CampaignVaultWriteOptions {
	config?: MtheriosAppConfig;
	indexFile?: (record: CampaignFileIndexRecord) => Promise<void>;
}

export interface CampaignPageReadResult {
	storyId: string;
	kind: string;
	relativePath: string;
	content: string;
	contentHash: string;
	updatedAt: string | null;
	byteLength: number;
	missing?: boolean;
}

const VAULT_DIRECTORIES = [
	'.mtherios',
	'raw/turns',
	'raw/events',
	'characters',
	'factions',
	'lore',
	'rules',
	'schedules',
	'chapters',
	'arcs',
	'memory',
	'projections',
];

const PAGE_KIND_DIRECTORIES: Record<string, string> = {
	raw_turn: 'raw/turns',
	raw_turns: 'raw/turns',
	raw_event: 'raw/events',
	raw_events: 'raw/events',
	character: 'characters',
	character_page: 'characters',
	characters: 'characters',
	faction: 'factions',
	faction_page: 'factions',
	factions: 'factions',
	lore: 'lore',
	lore_page: 'lore',
	rule: 'rules',
	rules: 'rules',
	rules_page: 'rules',
	schedule: 'schedules',
	schedules: 'schedules',
	schedule_page: 'schedules',
	chapter: 'chapters',
	chapters: 'chapters',
	chapter_page: 'chapters',
	arc: 'arcs',
	arcs: 'arcs',
	arc_page: 'arcs',
	memory: 'memory',
	memory_page: 'memory',
};

const PAGE_KIND_FILE_KINDS: Record<string, CampaignFileKind> = {
	raw_turn: 'raw_turn',
	raw_turns: 'raw_turn',
	raw_event: 'raw_event',
	raw_events: 'raw_event',
	character: 'character_page',
	character_page: 'character_page',
	characters: 'character_page',
	faction: 'faction_page',
	faction_page: 'faction_page',
	factions: 'faction_page',
	lore: 'lore_page',
	lore_page: 'lore_page',
	rule: 'rules_page',
	rules: 'rules_page',
	rules_page: 'rules_page',
	schedule: 'schedule_page',
	schedules: 'schedule_page',
	schedule_page: 'schedule_page',
	chapter: 'chapter_page',
	chapters: 'chapter_page',
	chapter_page: 'chapter_page',
	arc: 'arc_page',
	arcs: 'arc_page',
	arc_page: 'arc_page',
	memory: 'memory_page',
	memory_page: 'memory_page',
};

function nowIso(): string {
	return new Date().toISOString();
}

function hashText(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function campaignFileId(storyId: string, relativePath: string): string {
	return `campaign_file_${hashText(`${storyId}:${relativePath}`).slice(0, 32)}`;
}

function slug(value: string, fallback = 'item'): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
	return normalized || fallback;
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveVaultFile(vaultRoot: string, relativePath: string): string {
	const absolutePath = path.resolve(vaultRoot, relativePath);
	if (!isInside(vaultRoot, absolutePath)) {
		throw new Error(`Campaign vault path escapes root: ${relativePath}`);
	}
	return absolutePath;
}

function yamlScalar(value: unknown): string {
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (value === null || value === undefined) return 'null';
	return JSON.stringify(value);
}

function yamlFrontmatter(record: JsonRecord): string {
	const lines = ['---'];
	for (const [key, value] of Object.entries(record)) {
		if (Array.isArray(value)) {
			lines.push(`${key}:`);
			if (value.length === 0) {
				lines.push('  []');
			} else {
				for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
			}
			continue;
		}
		lines.push(`${key}: ${yamlScalar(value)}`);
	}
	lines.push('---');
	return `${lines.join('\n')}\n`;
}

function normalizeStringArray(value: string[] | undefined): string[] {
	return Array.isArray(value) ? value.map((item) => item.trim()).filter(Boolean) : [];
}

function campaignPageFileKind(kind: string): CampaignFileKind {
	const fileKind = PAGE_KIND_FILE_KINDS[kind];
	if (!fileKind) throw new Error(`Unsupported campaign page kind: ${kind}`);
	return fileKind;
}

function campaignPageRelativePath(options: {
	kind: string;
	name?: string | null;
	relativePath?: string | null;
}): string {
	const directory = PAGE_KIND_DIRECTORIES[options.kind];
	if (!directory) throw new Error(`Unsupported campaign page kind: ${options.kind}`);
	const relativePath = options.relativePath?.trim()
		? options.relativePath.trim().replace(/\\/g, '/').replace(/^\/+/, '')
		: `${directory}/${slug(options.name ?? options.kind)}.md`;
	if (!relativePath.startsWith(`${directory}/`) || !relativePath.endsWith('.md')) {
		throw new Error(`Campaign page path must be a markdown file under ${directory}/.`);
	}
	return relativePath;
}

function renderCampaignPageMarkdown(input: WriteCampaignPageInput, fileKind: CampaignFileKind): string {
	const timestamp = nowIso();
	const serverVersion = Math.max(1, Math.trunc(input.story.serverVersion ?? 1));
	const title = input.title?.trim() || input.name.trim();
	const frontmatter = yamlFrontmatter({
		type: fileKind,
		storyId: input.story.id,
		name: input.name,
		title,
		tags: normalizeStringArray(input.tags),
		entityIds: normalizeStringArray(input.entityIds),
		factionIds: normalizeStringArray(input.factionIds),
		sourceEntryIds: normalizeStringArray(input.sourceEntryIds),
		sourceEventIds: normalizeStringArray(input.sourceEventIds),
		sourcePatchIds: normalizeStringArray(input.sourcePatchIds),
		serverVersion,
		updatedAt: timestamp,
		metadata: input.metadata ?? {},
	});
	const body = input.body.trim() || '(empty maintained page)';
	return [
		frontmatter,
		`# ${title}`,
		'',
		body,
		'',
	].join('\n');
}

async function writeIfMissing(filePath: string, content: string): Promise<void> {
	try {
		await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return;
		throw error;
	}
}

export function campaignVaultPath(storyId: string, config = getMtheriosAppConfig()): string {
	return path.join(config.vaultRoot, 'campaigns', slug(storyId, 'story'));
}

export async function ensureCampaignVault(story: CampaignStoryRef, config = getMtheriosAppConfig()): Promise<string> {
	const vaultRoot = campaignVaultPath(story.id, config);
	for (const directory of VAULT_DIRECTORIES) {
		await mkdir(resolveVaultFile(vaultRoot, directory), { recursive: true });
	}
	const manifest = {
		layout: 'hybrid-markdown-db',
		version: 1,
		storyId: story.id,
		title: story.title ?? story.id,
		directories: VAULT_DIRECTORIES.filter((directory) => directory !== '.mtherios'),
		sourceOfTruth: {
			rawEvidence: 'raw/',
			derivedPages: ['characters/', 'factions/', 'lore/', 'rules/', 'schedules/', 'chapters/', 'arcs/', 'memory/'],
			queryLayer: 'postgres',
			uiRole: 'control_surface',
		},
		updatedAt: nowIso(),
	};
	await writeFile(
		resolveVaultFile(vaultRoot, '.mtherios/campaign.json'),
		`${JSON.stringify(manifest, null, 2)}\n`,
		'utf8',
	);
	await writeIfMissing(
		resolveVaultFile(vaultRoot, 'README.md'),
		`# ${story.title ?? story.id}\n\nThis campaign vault stores append-only RPG evidence and maintained derived pages. The backend owns canon; the UI reads bounded projections.\n`,
	);
	await writeIfMissing(
		resolveVaultFile(vaultRoot, 'AGENTS.md'),
		[
			'# Campaign Agent Notes',
			'',
			'- Treat raw/ as append-only evidence.',
			'- Keep character, faction, lore, rule, schedule, chapter, arc, and memory pages concise.',
			'- Postgres indexes these files for query, locking, and current-state projections.',
			'',
		].join('\n'),
	);
	return vaultRoot;
}

export function renderTurnEvidenceMarkdown(input: AppendTurnEvidenceInput): string {
	const serverVersion = Math.max(1, Math.trunc(input.story.serverVersion ?? 1));
	const frontmatter = yamlFrontmatter({
		type: 'raw_turn',
		storyId: input.story.id,
		clientTurnId: input.clientTurnId,
		position: Math.max(0, Math.trunc(input.position)),
		serverVersion,
		eventIds: input.eventIds ?? [],
		statePatchIds: input.statePatchIds ?? [],
		retrievedMemoryIds: input.retrievedMemoryIds ?? [],
		memoryNodeIds: input.memoryNodeIds ?? [],
		warnings: input.warnings ?? [],
		recordedAt: nowIso(),
	});
	const timings = input.generationTimings?.length
		? `\n## Generation Timings\n\n\`\`\`json\n${JSON.stringify(input.generationTimings, null, 2)}\n\`\`\`\n`
		: '';
	const metadata = input.metadata && Object.keys(input.metadata).length > 0
		? `\n## Metadata\n\n\`\`\`json\n${JSON.stringify(input.metadata, null, 2)}\n\`\`\`\n`
		: '';

	return [
		frontmatter,
		`# Turn ${Math.max(0, Math.trunc(input.position))}`,
		'',
		'## Player Action',
		'',
		input.playerText.trim() || '(empty player action)',
		'',
		'## Narration',
		'',
		input.narration.trim() || '(empty narration)',
		timings,
		metadata,
	].join('\n');
}

async function defaultIndexFile(record: CampaignFileIndexRecord): Promise<void> {
	const timestamp = nowIso();
	await getDb()
		.insert(campaignFiles)
		.values({
			id: campaignFileId(record.storyId, record.relativePath),
			storyId: record.storyId,
			path: record.relativePath,
			kind: record.kind,
			contentHash: record.contentHash,
			byteLength: record.byteLength,
			serverVersion: record.serverVersion,
			metadata: record.metadata ?? {},
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.onConflictDoUpdate({
			target: campaignFiles.id,
			set: {
				kind: record.kind,
				contentHash: record.contentHash,
				byteLength: record.byteLength,
				serverVersion: record.serverVersion,
				metadata: record.metadata ?? {},
				updatedAt: timestamp,
			},
		});
}

export async function appendTurnEvidence(
	input: AppendTurnEvidenceInput,
	options: CampaignVaultWriteOptions = {},
): Promise<CampaignVaultWriteResult> {
	const config = options.config ?? getMtheriosAppConfig();
	const indexFile = options.indexFile ?? defaultIndexFile;
	const vaultRoot = await ensureCampaignVault(input.story, config);
	const safeTurnId = slug(input.clientTurnId, 'turn');
	const turnPosition = Math.max(0, Math.trunc(input.position));
	const relativePath = `raw/turns/${String(turnPosition).padStart(6, '0')}-${safeTurnId}.md`;
	const absolutePath = resolveVaultFile(vaultRoot, relativePath);
	const content = renderTurnEvidenceMarkdown(input);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, { encoding: 'utf8', flag: 'wx' });
	const byteLength = Buffer.byteLength(content, 'utf8');
	const contentHash = hashText(content);
	const serverVersion = Math.max(1, Math.trunc(input.story.serverVersion ?? 1));
	await indexFile({
		storyId: input.story.id,
		relativePath,
		kind: 'raw_turn',
		contentHash,
		byteLength,
		serverVersion,
		metadata: {
			clientTurnId: input.clientTurnId,
			position: turnPosition,
			eventIds: input.eventIds ?? [],
			statePatchIds: input.statePatchIds ?? [],
			retrievedMemoryIds: input.retrievedMemoryIds ?? [],
		},
	});

	return {
		files: [{
			absolutePath,
			relativePath,
			kind: 'raw_turn',
			contentHash,
			byteLength,
		}],
	};
}

export async function writeCampaignPage(
	input: WriteCampaignPageInput,
	options: CampaignVaultWriteOptions = {},
): Promise<CampaignVaultWriteResult> {
	const config = options.config ?? getMtheriosAppConfig();
	const indexFile = options.indexFile ?? defaultIndexFile;
	const fileKind = campaignPageFileKind(input.kind);
	if (fileKind === 'raw_turn' || fileKind === 'raw_event' || fileKind === 'manifest' || fileKind === 'projection') {
		throw new Error(`Campaign page kind is not a maintained derived page: ${input.kind}`);
	}
	const vaultRoot = await ensureCampaignVault(input.story, config);
	const relativePath = campaignPageRelativePath({
		kind: input.kind,
		name: input.name,
		relativePath: input.relativePath,
	});
	const absolutePath = resolveVaultFile(vaultRoot, relativePath);
	const content = renderCampaignPageMarkdown(input, fileKind);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, { encoding: 'utf8' });
	const byteLength = Buffer.byteLength(content, 'utf8');
	const contentHash = hashText(content);
	const serverVersion = Math.max(1, Math.trunc(input.story.serverVersion ?? 1));
	await indexFile({
		storyId: input.story.id,
		relativePath,
		kind: fileKind,
		contentHash,
		byteLength,
		serverVersion,
		metadata: {
			name: input.name,
			title: input.title ?? input.name,
			tags: normalizeStringArray(input.tags),
			entityIds: normalizeStringArray(input.entityIds),
			factionIds: normalizeStringArray(input.factionIds),
			sourceEntryIds: normalizeStringArray(input.sourceEntryIds),
			sourceEventIds: normalizeStringArray(input.sourceEventIds),
			sourcePatchIds: normalizeStringArray(input.sourcePatchIds),
			...(input.metadata ?? {}),
		},
	});

	return {
		files: [{
			absolutePath,
			relativePath,
			kind: fileKind,
			contentHash,
			byteLength,
		}],
	};
}

export async function getCampaignVaultStatus(storyId: string): Promise<CampaignVaultStatus> {
	const config = getMtheriosAppConfig();
	const vaultPath = campaignVaultPath(storyId, config);
	const db = getDb();
	const [summary] = await db
		.select({
			fileCount: sql<number>`count(*)::int`,
			lastIndexedVersion: sql<number>`coalesce(max(${campaignFiles.serverVersion}), 0)::int`,
		})
		.from(campaignFiles)
		.where(sql`${campaignFiles.storyId} = ${storyId}`);
	let manifestHash: string | null = null;
	let updatedAt: string | null = null;
	try {
		const manifestPath = resolveVaultFile(vaultPath, '.mtherios/campaign.json');
		const manifest = await readFile(manifestPath, 'utf8');
		const manifestStat = await stat(manifestPath);
		manifestHash = hashText(manifest);
		updatedAt = manifestStat.mtime.toISOString();
	} catch {
		manifestHash = null;
		updatedAt = null;
	}
	return {
		vaultPath,
		fileCount: Number(summary?.fileCount ?? 0),
		lastIndexedVersion: Number(summary?.lastIndexedVersion ?? 0),
		manifestHash,
		updatedAt,
	};
}

export function campaignFileContentHash(value: unknown): string {
	return hashText(stableJson(value));
}

export async function readCampaignPage(options: {
	storyId: string;
	kind: string;
	name?: string | null;
	relativePath?: string | null;
	missingOk?: boolean;
	config?: MtheriosAppConfig;
}): Promise<CampaignPageReadResult> {
	const config = options.config ?? getMtheriosAppConfig();
	const vaultRoot = campaignVaultPath(options.storyId, config);
	const relativePath = campaignPageRelativePath({
		kind: options.kind,
		name: options.name,
		relativePath: options.relativePath,
	});
	const absolutePath = resolveVaultFile(vaultRoot, relativePath);
	let content: string;
	try {
		content = await readFile(absolutePath, 'utf8');
	} catch (error) {
		if (options.missingOk && isFileNotFound(error)) {
			return {
				storyId: options.storyId,
				kind: options.kind,
				relativePath,
				content: '',
				contentHash: '',
				updatedAt: null,
				byteLength: 0,
				missing: true,
			};
		}
		throw error;
	}
	const fileStat = await stat(absolutePath).catch(() => null);
	return {
		storyId: options.storyId,
		kind: options.kind,
		relativePath,
		content,
		contentHash: hashText(content),
		updatedAt: fileStat?.mtime.toISOString() ?? null,
		byteLength: Buffer.byteLength(content, 'utf8'),
	};
}

function isFileNotFound(error: unknown): boolean {
	return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}
