import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeTitle, stripMarkdown } from './vault.mjs';

const CORE_FILES = ['index.md', 'log.md', 'AGENTS.md'];
const DERIVED_LAYERS = new Set(['wiki', 'chapter', 'arc', 'agreement']);

export async function lintVault(vault, {
	thinChars = 240,
	orphanLayer = 'derived',
} = {}) {
	const missingCoreFiles = coreFileReport(vault);
	const duplicateTitles = duplicateTitleReport(vault);
	const brokenLinks = brokenLinkReport(vault);
	const orphanPages = orphanPageReport(vault, orphanLayer);
	const thinPages = thinPageReport(vault, thinChars);
	const emptyPages = emptyPageReport(vault);
	const manifest = await manifestReport(vault);
	const issueCount =
		missingCoreFiles.filter((item) => !item.exists).length +
		duplicateTitles.length +
		brokenLinks.length +
		orphanPages.length +
		thinPages.length +
		emptyPages.length;

	return {
		ok: issueCount === 0,
		generatedAt: new Date().toISOString(),
		root: vault.root,
		summary: {
			pageCount: vault.pages.length,
			issueCount,
			missingCoreFiles: missingCoreFiles.filter((item) => !item.exists).length,
			duplicateTitles: duplicateTitles.length,
			brokenLinks: brokenLinks.length,
			orphanPages: orphanPages.length,
			thinPages: thinPages.length,
			emptyPages: emptyPages.length,
		},
		manifest,
		missingCoreFiles,
		duplicateTitles,
		brokenLinks,
		orphanPages,
		thinPages,
		emptyPages,
	};
}

function coreFileReport(vault) {
	const lowerPaths = new Set(vault.pages.map((page) => page.relPath.toLowerCase()));
	return CORE_FILES.map((file) => ({
		path: file,
		exists: lowerPaths.has(file.toLowerCase()),
	}));
}

function duplicateTitleReport(vault) {
	const byTitle = new Map();
	for (const page of vault.pages) {
		if (!page.titleKey) continue;
		const rows = byTitle.get(page.titleKey) ?? [];
		rows.push({ path: page.relPath, title: page.title, layer: page.layer });
		byTitle.set(page.titleKey, rows);
	}
	return [...byTitle.entries()]
		.filter(([, rows]) => rows.length > 1)
		.map(([titleKey, pages]) => ({ titleKey, pages }))
		.sort((a, b) => a.titleKey.localeCompare(b.titleKey));
}

function brokenLinkReport(vault) {
	const rows = [];
	for (const page of vault.pages) {
		for (const target of page.links ?? []) {
			if (!vault.titleToPath.has(normalizeTitle(target))) {
				rows.push({
					pagePath: page.relPath,
					pageTitle: page.title,
					target,
				});
			}
		}
	}
	return rows.sort((a, b) => a.pagePath.localeCompare(b.pagePath) || a.target.localeCompare(b.target));
}

function orphanPageReport(vault, mode) {
	return vault.pages
		.filter((page) => shouldCheckOrphan(page, mode))
		.filter((page) => (page.backlinks ?? []).length === 0)
		.map((page) => ({
			path: page.relPath,
			title: page.title,
			layer: page.layer,
			outboundLinks: (page.resolvedLinks ?? []).length,
			textChars: stripMarkdown(page.body).length,
		}))
		.sort((a, b) => layerSort(a.layer, b.layer) || a.title.localeCompare(b.title));
}

function thinPageReport(vault, thinChars) {
	return vault.pages
		.filter((page) => shouldCheckDerivedPage(page))
		.map((page) => ({
			path: page.relPath,
			title: page.title,
			layer: page.layer,
			textChars: stripMarkdown(page.body).length,
		}))
		.filter((page) => page.textChars > 0 && page.textChars < thinChars)
		.sort((a, b) => a.textChars - b.textChars || a.title.localeCompare(b.title));
}

function emptyPageReport(vault) {
	return vault.pages
		.filter((page) => shouldCheckDerivedPage(page))
		.map((page) => ({
			path: page.relPath,
			title: page.title,
			layer: page.layer,
			textChars: stripMarkdown(page.body).length,
		}))
		.filter((page) => page.textChars === 0)
		.sort((a, b) => a.title.localeCompare(b.title));
}

async function manifestReport(vault) {
	const manifestPath = path.join(vault.root, '.mtherios', 'story-vault.json');
	try {
		const raw = await readFile(manifestPath, 'utf8');
		const manifest = JSON.parse(raw);
		return {
			exists: true,
			path: '.mtherios/story-vault.json',
			storyId: typeof manifest.storyId === 'string' ? manifest.storyId : null,
			serverVersion: typeof manifest.serverVersion === 'number' ? manifest.serverVersion : null,
			materializedAt: typeof manifest.materializedAt === 'string'
				? manifest.materializedAt
				: typeof manifest.generatedAt === 'string'
					? manifest.generatedAt
					: null,
			indexedAt: typeof manifest.indexedAt === 'string'
				? manifest.indexedAt
				: typeof manifest.index?.indexedAt === 'string'
					? manifest.index.indexedAt
					: null,
			collection: typeof manifest.collection === 'string' ? manifest.collection : null,
		};
	} catch (error) {
		if (error?.code === 'ENOENT') {
			return {
				exists: false,
				path: '.mtherios/story-vault.json',
			};
		}
		return {
			exists: false,
			path: '.mtherios/story-vault.json',
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function shouldCheckOrphan(page, mode) {
	if (!shouldCheckDerivedPage(page)) return false;
	if (mode === 'all') return true;
	return DERIVED_LAYERS.has(page.layer);
}

function shouldCheckDerivedPage(page) {
	if (page.layer === 'raw') return false;
	const name = path.basename(page.relPath).toLowerCase();
	if (name === 'readme.md' || name === 'index.md' || name === 'log.md' || name === 'agents.md') return false;
	return true;
}

function layerSort(left, right) {
	return layerWeight(left) - layerWeight(right);
}

function layerWeight(layer) {
	switch (layer) {
		case 'wiki':
			return 0;
		case 'chapter':
			return 1;
		case 'arc':
			return 2;
		case 'agreement':
			return 3;
		case 'root':
			return 4;
		default:
			return 10;
	}
}
