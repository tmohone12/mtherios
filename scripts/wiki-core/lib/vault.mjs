import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

export function toSlashPath(value) {
	return value.replace(/\\/g, '/');
}

export function slugTitle(value) {
	return value
		.toLowerCase()
		.replace(/--[a-f0-9]{8}$/i, '')
		.replace(/\.md$/i, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

export function normalizeTitle(value) {
	return String(value ?? '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

export function hashToUuid(value) {
	const hex = createHash('sha1').update(value).digest('hex').slice(0, 32).split('');
	hex[12] = '5';
	hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
	return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`;
}

export function parseFrontmatter(markdown) {
	const match = markdown.match(FRONTMATTER_RE);
	if (!match) return { frontmatter: {}, body: markdown.replace(/^\uFEFF/, '') };

	const frontmatter = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colon = line.indexOf(':');
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const raw = line.slice(colon + 1).trim();
		if (!key || raw === '') continue;
		try {
			frontmatter[key] = JSON.parse(raw);
		} catch {
			frontmatter[key] = raw.replace(/^["']|["']$/g, '');
		}
	}

	return { frontmatter, body: markdown.slice(match[0].length) };
}

export function extractWikilinks(markdown) {
	const links = [];
	const seen = new Set();
	let match;
	while ((match = WIKILINK_RE.exec(markdown)) !== null) {
		const title = match[1].trim();
		const key = normalizeTitle(title);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		links.push(title);
	}
	return links;
}

export function extractHeadings(markdown) {
	return [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
		match[1].replace(/\s+#*$/, '').trim(),
	);
}

export function titleFromMarkdown(relPath, body, frontmatter) {
	const fmTitle = frontmatter.name ?? frontmatter.title;
	if (typeof fmTitle === 'string' && fmTitle.trim()) return fmTitle.trim();
	const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (heading) return heading;
	return slugTitle(path.basename(relPath));
}

export function inferLayer(relPath) {
	const first = relPath.split('/')[0];
	if (first === 'raw') return 'raw';
	if (first === 'wiki') return 'wiki';
	if (first === 'chapters') return 'chapter';
	if (first === 'arcs') return 'arc';
	if (first === 'agreements') return 'agreement';
	return 'root';
}

export function stripMarkdown(markdown) {
	return markdown
		.replace(FRONTMATTER_RE, '')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
		.replace(/\[\[([^\]]+)\]\]/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/[*_>#~-]/g, ' ')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function chunkMarkdown(page, { maxChars = 2400, overlapChars = 280 } = {}) {
	const text = stripMarkdown(page.body);
	if (!text) return [];
	if (text.length <= maxChars) return [makeChunk(page, text, 0, 1)];

	const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
	const chunks = [];
	let current = '';
	const overlapSize = Math.max(0, Math.min(overlapChars, maxChars - 1));
	const stepSize = Math.max(1, maxChars - overlapSize);

	for (const paragraph of paragraphs) {
		if (paragraph.length > maxChars) {
			if (current) {
				chunks.push(current);
				current = '';
			}
			for (let i = 0; i < paragraph.length; i += stepSize) {
				chunks.push(paragraph.slice(i, i + maxChars));
			}
			continue;
		}

		const next = current ? `${current}\n\n${paragraph}` : paragraph;
		if (next.length > maxChars && current) {
			chunks.push(current);
			const overlap = current.slice(Math.max(0, current.length - overlapSize));
			const overlapped = `${overlap}\n\n${paragraph}`.trim();
			current = overlapped.length <= maxChars ? overlapped : paragraph;
		} else {
			current = next;
		}
	}
	if (current) chunks.push(current);

	return chunks.map((content, index) => makeChunk(page, content, index, chunks.length));
}

function makeChunk(page, content, chunkIndex, chunkCount) {
	return {
		id: hashToUuid(`${page.relPath}:${chunkIndex}`),
		content,
		payload: {
			path: page.relPath,
			title: page.title,
			layer: page.layer,
			type: page.frontmatter.type ?? null,
			headings: page.headings,
			links: page.links,
			backlinks: page.backlinks ?? [],
			chunkIndex,
			chunkCount,
			text: content,
			updatedAt: page.updatedAt,
		},
	};
}

export async function walkMarkdownFiles(rootDir) {
	const files = [];

	async function walk(dir) {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith('.') && entry.name !== '.obsidian') continue;
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === '.git') continue;
				await walk(abs);
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
				files.push(abs);
			}
		}
	}

	await walk(rootDir);
	return files.sort((a, b) => a.localeCompare(b));
}

export async function loadVault(rootDir) {
	const root = path.resolve(rootDir);
	const files = await walkMarkdownFiles(root);
	const pages = [];

	for (const absPath of files) {
		let raw;
		let info;
		try {
			raw = await readFile(absPath, 'utf8');
			info = await stat(absPath);
		} catch (error) {
			if (error?.code === 'ENOENT') continue;
			throw error;
		}
		const relPath = toSlashPath(path.relative(root, absPath));
		const { frontmatter, body } = parseFrontmatter(raw);
		const title = titleFromMarkdown(relPath, body, frontmatter);
		pages.push({
			absPath,
			relPath,
			raw,
			body,
			frontmatter,
			title,
			titleKey: normalizeTitle(title),
			layer: inferLayer(relPath),
			headings: extractHeadings(body),
			links: extractWikilinks(body),
			backlinks: [],
			updatedAt: info.mtime.toISOString(),
		});
	}

	const titleToPath = new Map();
	for (const page of pages) {
		titleToPath.set(page.titleKey, page.relPath);
		titleToPath.set(normalizeTitle(slugTitle(path.basename(page.relPath))), page.relPath);
	}

	const backlinkMap = new Map(pages.map((page) => [page.relPath, []]));
	for (const page of pages) {
		page.resolvedLinks = page.links
			.map((title) => titleToPath.get(normalizeTitle(title)))
			.filter(Boolean);
		for (const target of page.resolvedLinks) {
			backlinkMap.get(target)?.push(page.relPath);
		}
	}
	for (const page of pages) {
		page.backlinks = [...new Set(backlinkMap.get(page.relPath) ?? [])].sort();
	}

	return {
		root,
		pages,
		titleToPath,
		byPath: new Map(pages.map((page) => [page.relPath, page])),
	};
}

export function resolvePage(vault, query) {
	const normalizedQuery = normalizeTitle(query);
	const directPath = toSlashPath(query);
	if (vault.byPath.has(directPath)) return vault.byPath.get(directPath);
	if (vault.titleToPath.has(normalizedQuery)) return vault.byPath.get(vault.titleToPath.get(normalizedQuery));

	const candidates = vault.pages.filter((page) =>
		page.titleKey.includes(normalizedQuery) ||
		page.relPath.toLowerCase().includes(query.toLowerCase()),
	);
	return candidates.sort((a, b) => a.title.length - b.title.length)[0] ?? null;
}

export function followGraph(vault, seed, depth = 1) {
	const start = resolvePage(vault, seed);
	if (!start) return { start: null, nodes: [], edges: [] };

	const nodes = new Map([[start.relPath, { page: start, distance: 0 }]]);
	const edges = [];
	const queue = [{ page: start, distance: 0 }];

	while (queue.length > 0) {
		const { page, distance } = queue.shift();
		if (distance >= depth) continue;
		const neighbors = [...(page.resolvedLinks ?? []), ...(page.backlinks ?? [])];
		for (const relPath of neighbors) {
			const next = vault.byPath.get(relPath);
			if (!next) continue;
			edges.push({ from: page.relPath, to: relPath });
			if (!nodes.has(relPath)) {
				nodes.set(relPath, { page: next, distance: distance + 1 });
				queue.push({ page: next, distance: distance + 1 });
			}
		}
	}

	return {
		start,
		nodes: [...nodes.values()].sort((a, b) => a.distance - b.distance || a.page.title.localeCompare(b.page.title)),
		edges,
	};
}

export function exactSearch(vault, query, limit = 10) {
	const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
	if (tokens.length === 0) return [];

	return vault.pages
		.map((page) => {
			const title = page.title.toLowerCase();
			const pathText = page.relPath.toLowerCase();
			const body = stripMarkdown(page.body).toLowerCase();
			let score = 0;
			for (const token of tokens) {
				if (title.includes(token)) score += 8;
				if (pathText.includes(token)) score += 4;
				const matches = body.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
				score += Math.min(matches?.length ?? 0, 10);
			}
			return { page, score };
		})
		.filter((row) => row.score > 0)
		.sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title))
		.slice(0, limit);
}
