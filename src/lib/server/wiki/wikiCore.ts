import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
	getMtheriosAppConfig,
	wikiRuntimeEnv,
	type MtheriosAppConfig,
} from '$lib/server/app/config';
import { markStoryVaultIndexed, resolveWikiTarget, withFreshStoryVault } from './storyVault';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024;

export interface WikiSearchInput {
	query: string;
	storyId?: string | null;
	vaultPath?: string | null;
	collection?: string | null;
	limit?: number;
	followDepth?: number;
	exact?: boolean;
	provider?: string | null;
	model?: string | null;
}

export interface WikiContextInput extends WikiSearchInput {
	pageLimit?: number;
	pageChars?: number;
	maxChars?: number;
}

export interface WikiBriefInput extends WikiContextInput {
	mode?: string | null;
	inventoryLimit?: number;
	thinChars?: number;
	orphanLayer?: 'derived' | 'all';
}

export interface WikiLintInput {
	storyId?: string | null;
	vaultPath?: string | null;
	thinChars?: number;
	orphanLayer?: 'derived' | 'all';
}

export interface WikiFollowInput {
	page?: string | null;
	path?: string | null;
	title?: string | null;
	storyId?: string | null;
	vaultPath?: string | null;
	depth?: number;
}

export interface WikiPageInput {
	page?: string | null;
	path?: string | null;
	title?: string | null;
	storyId?: string | null;
	vaultPath?: string | null;
}

export interface WikiPagesInput {
	storyId?: string | null;
	vaultPath?: string | null;
	layer?: string | null;
	type?: string | null;
	tag?: string | null;
	orphans?: boolean;
	limit?: number;
	sort?: string | null;
}

export interface WikiWriteInput {
	storyId?: string | null;
	vaultPath?: string | null;
	path?: string | null;
	title?: string | null;
	folder?: string | null;
	mode?: 'create' | 'replace' | 'append' | string | null;
	markdown?: string | null;
	body?: string | null;
	content?: string | null;
	log?: string | null;
	allowRaw?: boolean;
}

export interface WikiIngestInput {
	storyId?: string | null;
	vaultPath?: string | null;
	title?: string | null;
	sourceName?: string | null;
	sourceUrl?: string | null;
	sourceType?: string | null;
	author?: string | null;
	published?: string | null;
	date?: string | null;
	tags?: string[] | string | null;
	markdown?: string | null;
	body?: string | null;
	content?: string | null;
	path?: string | null;
	note?: string | null;
	index?: boolean;
	log?: boolean;
	force?: boolean;
}

export interface WikiInitInput {
	storyId?: string | null;
	vaultPath?: string | null;
	title?: string | null;
	description?: string | null;
	owner?: string | null;
	force?: boolean;
	status?: boolean;
}

export interface WikiIndexInput {
	storyId?: string | null;
	vaultPath?: string | null;
	collection?: string | null;
	recreate?: boolean;
	dryRun?: boolean;
	provider?: string | null;
	model?: string | null;
	maxChars?: number;
	overlapChars?: number;
}

async function runWithFreshStoryVault<T>(
	storyId: string | null | undefined,
	config: MtheriosAppConfig,
	run: () => Promise<T>,
): Promise<T> {
	if (!storyId) return run();
	return withFreshStoryVault(storyId, config, run);
}

export async function searchWiki(input: WikiSearchInput): Promise<unknown> {
	if (!input.query?.trim()) throw new Error('Missing wiki search query.');
	const config = getMtheriosAppConfig();
	const target = resolveWikiTarget(input, config);
	const args = [
		target.vaultPath,
		input.query.trim(),
		'--json',
		'--limit',
		String(clampInt(input.limit, 1, 30, 8)),
		'--follow-depth',
		String(clampInt(input.followDepth, 0, 4, 1)),
		'--collection',
		target.collection,
	];
	if (input.exact) args.push('--exact');
	if (input.provider) args.push('--provider', input.provider);
	if (input.model) args.push('--model', input.model);

	return runWithFreshStoryVault(target.storyId, config, () => runJsonScript('search.mjs', args, config));
}

export async function contextWiki(input: WikiContextInput): Promise<unknown> {
	if (!input.query?.trim()) throw new Error('Missing wiki context query.');
	const config = getMtheriosAppConfig();
	const target = resolveWikiTarget(input, config);
	const args = [
		target.vaultPath,
		input.query.trim(),
		'--json',
		'--limit',
		String(clampInt(input.limit, 1, 20, 5)),
		'--follow-depth',
		String(clampInt(input.followDepth, 0, 4, 2)),
		'--page-limit',
		String(clampInt(input.pageLimit, 1, 80, 24)),
		'--page-chars',
		String(clampInt(input.pageChars, 300, 8000, 1800)),
		'--max-chars',
		String(clampInt(input.maxChars, 2000, 120000, 24000)),
		'--collection',
		target.collection,
	];
	if (input.exact) args.push('--exact');
	if (input.provider) args.push('--provider', input.provider);
	if (input.model) args.push('--model', input.model);

	return runWithFreshStoryVault(target.storyId, config, () => runJsonScript('context.mjs', args, config));
}

export async function briefWiki(input: WikiBriefInput): Promise<unknown> {
	if (!input.query?.trim()) throw new Error('Missing wiki brief task or query.');
	const config = getMtheriosAppConfig();
	const target = resolveWikiTarget(input, config);
	const args = [
		target.vaultPath,
		input.query.trim(),
		'--json',
		'--limit',
		String(clampInt(input.limit, 1, 20, 5)),
		'--follow-depth',
		String(clampInt(input.followDepth, 0, 4, 2)),
		'--page-limit',
		String(clampInt(input.pageLimit, 1, 80, 24)),
		'--page-chars',
		String(clampInt(input.pageChars, 300, 8000, 1800)),
		'--max-chars',
		String(clampInt(input.maxChars, 2000, 120000, 36000)),
		'--inventory-limit',
		String(clampInt(input.inventoryLimit, 4, 100, 24)),
		'--thin-chars',
		String(clampInt(input.thinChars, 40, 4000, 240)),
		'--orphan-layer',
		input.orphanLayer === 'all' ? 'all' : 'derived',
		'--collection',
		target.collection,
	];
	if (input.mode) args.push('--mode', input.mode);
	if (input.exact) args.push('--exact');
	if (input.provider) args.push('--provider', input.provider);
	if (input.model) args.push('--model', input.model);

	return runWithFreshStoryVault(target.storyId, config, () => runJsonScript('brief.mjs', args, config));
}

export async function lintWiki(input: WikiLintInput = {}): Promise<unknown> {
	const config = getMtheriosAppConfig();
	const target = resolveWikiTarget(input, config);
	const args = [
		target.vaultPath,
		'--json',
		'--thin-chars',
		String(clampInt(input.thinChars, 40, 4000, 240)),
		'--orphan-layer',
		input.orphanLayer === 'all' ? 'all' : 'derived',
	];

	return runWithFreshStoryVault(target.storyId, config, () => runJsonScript('lint.mjs', args, config));
}

export async function followWiki(input: WikiFollowInput): Promise<unknown> {
	const page = input.page?.trim() || input.path?.trim() || input.title?.trim();
	if (!page) throw new Error('Missing wiki page title or path.');
	const config = getMtheriosAppConfig();
	const target = resolveWikiTarget(input, config);
	const args = [
		target.vaultPath,
		page,
		'--json',
		'--depth',
		String(clampInt(input.depth, 0, 5, 2)),
	];

	return runWithFreshStoryVault(target.storyId, config, () => runJsonScript('follow.mjs', args, config));
}

export async function pageWiki(input: WikiPageInput): Promise<unknown> {
	const page = input.page?.trim() || input.path?.trim() || input.title?.trim();
	if (!page) throw new Error('Missing wiki page title or path.');
	const config = getMtheriosAppConfig();
	const target = resolveWikiTarget(input, config);
	const args = [
		target.vaultPath,
		page,
		'--json',
	];

	return runWithFreshStoryVault(target.storyId, config, () => runJsonScript('page.mjs', args, config));
}

export async function pagesWiki(input: WikiPagesInput = {}): Promise<unknown> {
	const config = getMtheriosAppConfig();
	const target = resolveWikiTarget(input, config);
	const args = [
		target.vaultPath,
		'--json',
		'--limit',
		String(clampInt(input.limit, 1, 2000, 200)),
	];
	if (input.layer) args.push('--layer', input.layer);
	if (input.type) args.push('--type', input.type);
	if (input.tag) args.push('--tag', input.tag);
	if (input.orphans) args.push('--orphans');
	if (input.sort) args.push('--sort', input.sort);

	return runWithFreshStoryVault(target.storyId, config, () => runJsonScript('pages.mjs', args, config));
}

export async function writeWiki(input: WikiWriteInput): Promise<unknown> {
	if (input.storyId?.trim()) {
		throw new Error('Generated story vaults are read-only. Mutate the terminal world database or use a standalone vault.');
	}
	const markdown = input.markdown ?? input.content ?? input.body ?? '';
	if (!markdown.trim()) throw new Error('Missing markdown content for wiki write.');
	const config = getMtheriosAppConfig();
	const target = resolveWikiTarget(input, config);
	if (isInside(path.join(config.vaultRoot, 'stories'), target.vaultPath)) {
		throw new Error('Generated story vault paths are read-only. Mutate the terminal world database or use a standalone vault.');
	}
	const mode = normalizeWriteMode(input.mode);
	const tempDir = path.join(config.dataRoot, 'tmp', 'wiki-write');
	const tempPath = path.join(tempDir, `${randomUUID()}.md`);
	await fs.mkdir(tempDir, { recursive: true });
	await fs.writeFile(tempPath, markdown, 'utf8');
	try {
		const args = [
			target.vaultPath,
			'--json',
			'--mode',
			mode,
			'--content-file',
			tempPath,
		];
		const pagePath = input.path?.trim();
		const title = input.title?.trim();
		if (pagePath) args.push('--path', pagePath);
		else if (title) args.push('--title', title);
		else throw new Error('Missing wiki page path or title.');
		if (input.folder?.trim()) args.push('--folder', input.folder.trim());
		if (input.log?.trim()) args.push('--log', input.log.trim());
		if (input.allowRaw) args.push('--allow-raw');
		return await runJsonScript('write.mjs', args, config);
	} finally {
		await fs.rm(tempPath, { force: true });
	}
}

export async function ingestWiki(input: WikiIngestInput): Promise<unknown> {
	if (input.storyId?.trim()) {
		throw new Error('Generated story vaults are read-only. Add story evidence through the terminal world database or use a standalone vault.');
	}
	const markdown = input.markdown ?? input.content ?? input.body ?? '';
	if (!markdown.trim()) throw new Error('Missing source content for wiki ingest.');
	const config = getMtheriosAppConfig();
	const target = resolveWikiTarget(input, config);
	if (isInside(path.join(config.vaultRoot, 'stories'), target.vaultPath)) {
		throw new Error('Generated story vault paths are read-only. Add story evidence through the terminal world database or use a standalone vault.');
	}
	const tempDir = path.join(config.dataRoot, 'tmp', 'wiki-ingest');
	const tempPath = path.join(tempDir, `${randomUUID()}.md`);
	await fs.mkdir(tempDir, { recursive: true });
	await fs.writeFile(tempPath, markdown, 'utf8');
	try {
		const args = [
			target.vaultPath,
			'--json',
			'--source-file',
			tempPath,
		];
		const title = input.title?.trim();
		if (title) args.push('--title', title);
		if (input.sourceName?.trim()) args.push('--source-name', input.sourceName.trim());
		if (input.sourceUrl?.trim()) args.push('--source-url', input.sourceUrl.trim());
		if (input.sourceType?.trim()) args.push('--source-type', input.sourceType.trim());
		if (input.author?.trim()) args.push('--author', input.author.trim());
		if (input.published?.trim()) args.push('--published', input.published.trim());
		if (input.date?.trim()) args.push('--date', input.date.trim());
		if (input.path?.trim()) args.push('--path', input.path.trim());
		if (input.note?.trim()) args.push('--note', input.note.trim());
		const tags = normalizeTagsInput(input.tags);
		if (tags) args.push('--tags', tags);
		if (input.index === false) args.push('--no-index');
		if (input.log === false) args.push('--no-log');
		if (input.force) args.push('--force');
		return await runJsonScript('ingest.mjs', args, config);
	} finally {
		await fs.rm(tempPath, { force: true });
	}
}

export async function initWiki(input: WikiInitInput = {}): Promise<unknown> {
	if (input.storyId?.trim()) {
		throw new Error('Generated story vaults are initialized by terminal database sync. Use standalone vault init for editable wiki vaults.');
	}
	const config = getMtheriosAppConfig();
	const target = resolveWikiTarget(input, config);
	if (isInside(path.join(config.vaultRoot, 'stories'), target.vaultPath)) {
		throw new Error('Generated story vault paths are initialized by terminal database sync. Use a standalone vault.');
	}
	const args = [
		target.vaultPath,
		'--json',
	];
	if (input.status) args.push('--status');
	if (input.force) args.push('--force');
	if (input.title?.trim()) args.push('--title', input.title.trim());
	if (input.description?.trim()) args.push('--description', input.description.trim());
	if (input.owner?.trim()) args.push('--owner', input.owner.trim());

	return runJsonScript('init.mjs', args, config);
}

export async function indexWiki(input: WikiIndexInput): Promise<{ ok: boolean; output: string }> {
	const config = getMtheriosAppConfig();
	const target = resolveWikiTarget(input, config);
	const args = [
		target.vaultPath,
		'--collection',
		target.collection,
		'--max-chars',
		String(clampInt(input.maxChars, 400, 8000, 2400)),
		'--overlap-chars',
		String(clampInt(input.overlapChars, 0, 1200, 280)),
	];
	if (input.recreate) args.push('--recreate');
	if (input.dryRun) args.push('--dry-run');
	if (input.provider) args.push('--provider', input.provider);
	if (input.model) args.push('--model', input.model);

	return runWithFreshStoryVault(target.storyId, config, async () => {
		const output = await runScript('index.mjs', args, config, 10 * 60_000);
		if (target.storyId && !input.dryRun) {
			await markStoryVaultIndexed({
				storyId: target.storyId,
				collection: target.collection,
				provider: input.provider,
				model: input.model,
				recreate: input.recreate,
				output,
			}, config);
		}
		return { ok: true, output };
	});
}

async function runJsonScript(scriptName: string, args: string[], config: MtheriosAppConfig): Promise<unknown> {
	const output = await runScript(scriptName, args, config, 90_000);
	try {
		return JSON.parse(output);
	} catch {
		throw new Error(`wiki-core ${scriptName} returned non-JSON output: ${output.slice(0, 600)}`);
	}
}

async function runScript(scriptName: string, args: string[], config: MtheriosAppConfig, timeout: number): Promise<string> {
	const scriptPath = path.resolve(process.cwd(), 'scripts', 'wiki-core', scriptName);
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args], {
			cwd: process.cwd(),
			env: wikiRuntimeEnv(config),
			maxBuffer: MAX_BUFFER,
			timeout,
			windowsHide: true,
		});
		if (stderr.trim()) console.warn(`[wiki-core:${scriptName}] ${stderr.trim()}`);
		return stdout.trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const stdout = typeof (error as { stdout?: unknown }).stdout === 'string'
			? (error as { stdout: string }).stdout
			: '';
		const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
			? (error as { stderr: string }).stderr
			: '';
		throw new Error([`wiki-core ${scriptName} failed: ${message}`, stdout, stderr].filter(Boolean).join('\n'));
	}
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

function normalizeWriteMode(value: WikiWriteInput['mode']): 'create' | 'replace' | 'append' {
	if (value == null || value === '') return 'create';
	if (value === 'create' || value === 'replace' || value === 'append') return value;
	throw new Error('mode must be create, replace, or append.');
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeTagsInput(value: WikiIngestInput['tags']): string | null {
	if (!value) return null;
	if (Array.isArray(value)) return value.map((tag) => String(tag).trim()).filter(Boolean).join(',');
	const clean = String(value).trim();
	return clean || null;
}
