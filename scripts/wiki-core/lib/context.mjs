import { followGraph, stripMarkdown } from './vault.mjs';

export function buildContextPack(vault, search, options) {
	const normalizedOptions = {
		followDepth: clampInt(options.followDepth, 0, 8, 2),
		pageLimit: clampInt(options.pageLimit, 1, 200, 24),
		pageChars: clampInt(options.pageChars, 300, 12000, 1800),
		maxChars: clampInt(options.maxChars, 1000, 160000, 24000),
	};
	const pageMap = new Map();
	const edgeMap = new Map();
	const seeds = search.results.map((row) => ({
		path: row.path,
		title: row.title,
		layer: row.layer,
		score: row.score ?? 0,
		semanticScore: row.semanticScore ?? 0,
		exactScore: row.exactScore ?? 0,
	}));
	const queryTokens = [...new Set(String(search.query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 4))];
	const ownScore = (page) => {
		const title = String(page.title ?? '').toLowerCase();
		const body = stripMarkdown(page.body).toLowerCase().slice(0, 2400);
		return queryTokens.reduce((score, token) => score + (title.includes(token) ? 3 : body.includes(token) ? 1 : 0), 0);
	};

	for (const seed of seeds) {
		const graph = followGraph(vault, seed.path, normalizedOptions.followDepth);
		for (const edge of graph.edges) {
			edgeMap.set(`${edge.from}->${edge.to}`, edge);
		}
		for (const node of graph.nodes) {
			const page = node.page;
			const current = pageMap.get(page.relPath) ?? {
				page,
				distance: node.distance,
				seedScore: seed.score,
				sourceSeedPaths: new Set(),
			};
			current.distance = Math.min(current.distance, node.distance);
			current.seedScore = Math.max(current.seedScore, seed.score);
			current.sourceSeedPaths.add(seed.path);
			pageMap.set(page.relPath, current);
		}
	}

	const ordered = [...pageMap.values()]
		.filter(item => item.distance === 0 || (ownScore(item.page) > 0
			&& item.page.layer !== 'root' && (item.page.backlinks?.length ?? 0) <= 30))
		.sort((a, b) =>
			a.distance - b.distance ||
			ownScore(b.page) - ownScore(a.page) ||
			b.seedScore - a.seedScore ||
			layerWeight(a.page.layer) - layerWeight(b.page.layer) ||
			a.page.title.localeCompare(b.page.title),
		)
		.slice(0, normalizedOptions.pageLimit)
		.map((item, index) => pageRecord(item, index + 1, normalizedOptions.pageChars));
	const retained = [];
	for (const page of ordered) {
		const candidate = [...retained, { ...page, citationId: retained.length + 1 }];
		if (contextMarkdown(search.query, candidate, Number.MAX_SAFE_INTEGER).length <= normalizedOptions.maxChars) {
			retained.push(candidate.at(-1));
		} else if (retained.length === 0) {
			const headerLength = contextMarkdown(search.query, [{ ...page, text: '' }], Number.MAX_SAFE_INTEGER).length;
			retained.push({ ...page, text: clipText(page.text, Math.max(0, normalizedOptions.maxChars - headerLength - 16)) });
		}
	}

	return {
		query: search.query,
		generatedAt: new Date().toISOString(),
		semanticError: search.semanticError,
		seedCount: seeds.length,
		pageCount: retained.length,
		seeds,
		pages: retained,
		edges: [...edgeMap.values()],
		citations: retained.map((page) => `[${page.citationId}] ${page.title} <${page.path}>`),
		contextMarkdown: contextMarkdown(search.query, retained, normalizedOptions.maxChars),
	};
}

export function pageRecord(item, citationId, pageChars) {
	const page = item.page;
	return {
		citationId,
		path: page.relPath,
		title: page.title,
		layer: page.layer,
		distance: item.distance,
		sourceSeedPaths: [...item.sourceSeedPaths].sort(),
		links: page.resolvedLinks ?? [],
		backlinks: page.backlinks ?? [],
		headings: page.headings ?? [],
		updatedAt: page.updatedAt,
		text: clipText(stripMarkdown(page.body), pageChars),
	};
}

export function contextMarkdown(query, pages, maxChars) {
	const lines = [
		`# Wiki Context`,
		``,
		`Query: ${query}`,
		``,
		`## Sources`,
		...pages.map((page) => `[${page.citationId}] ${page.title} (${page.path})`),
	];
	for (const page of pages) {
		lines.push(
			``,
			`## [${page.citationId}] ${page.title}`,
			`Path: ${page.path}`,
			`Layer: ${page.layer}; distance: ${page.distance}`,
			``,
			page.text || '(No text extracted.)',
		);
	}
	return clipText(lines.join('\n'), Math.max(1000, maxChars));
}

export function clipText(value, maxChars) {
	const clean = String(value ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
	if (clean.length <= maxChars) return clean;
	return `${clean.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n[truncated]`;
}

export function layerWeight(layer) {
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
		case 'raw':
			return 5;
		default:
			return 10;
	}
}

function clampInt(value, min, max, fallback) {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}
