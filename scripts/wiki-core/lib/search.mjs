import { embedText, embeddingConfig } from './embeddings.mjs';
import { qdrantConfig, searchPoints } from './qdrant.mjs';
import { exactSearch, followGraph, stripMarkdown } from './vault.mjs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function searchVault(vault, query, {
	limit = 8,
	followDepth = 1,
	exact = false,
	provider = null,
	model = null,
	collection = null,
	layer = null,
} = {}) {
	const searchPages = layer ? vault.pages.filter(page => page.layer === layer) : vault.pages;
	const searchView = layer ? { ...vault, pages: searchPages, byPath: new Map(searchPages.map(page => [page.relPath, page])) } : vault;
	const exactRows = exactSearch(searchView, query, limit);
	let semanticRows = [];
	let semanticError = null;

	if (!exact) {
		try {
			const vector = await queryEmbedding(query, embeddingConfig({ provider, model }));
			semanticRows = await searchPoints(vector, qdrantConfig({ collection }), { limit, layer });
		} catch (error) {
			semanticError = error instanceof Error ? error.message : String(error);
		}
	}

	const merged = mergeResults(searchView, semanticRows, exactRows, limit);
	const results = merged.map((row) => {
		const graph = followGraph(vault, row.path, followDepth);
		return {
			path: row.path,
			title: row.title,
			score: row.score,
			semanticScore: row.semanticScore,
			exactScore: row.exactScore,
			layer: row.layer,
			links: graph.start?.resolvedLinks ?? [],
			backlinks: graph.start?.backlinks ?? [],
			neighbors: graph.nodes
				.filter((node) => node.page.relPath !== row.path)
				.map((node) => ({ path: node.page.relPath, title: node.page.title, distance: node.distance })),
			text: row.text,
		};
	});

	return {
		query,
		semanticError,
		results,
	};
}

async function queryEmbedding(query, config) {
	const file = process.env.MYTHENGINE_WIKI_QUERY_EMBEDDING_FILE;
	if (!file) return embedText(query, config);
	// Scoped server queries may consume only the parent's bounded query-bound embedding.
	if ((await fs.stat(file)).size > 2_000_000) throw new Error('Query embedding receipt exceeds its limit.');
	const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
	if (receipt.queryHash !== createHash('sha256').update(query).digest('hex')) throw new Error('Query embedding receipt does not match this query.');
	if (receipt.error) throw new Error(String(receipt.error).slice(0, 200));
	if (!Array.isArray(receipt.vector) || !receipt.vector.length || receipt.vector.length > 65_536 || receipt.vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Query embedding receipt has no valid vector.');
	return receipt.vector;
}

export function mergeResults(vault, semanticRows, exactRows, limit) {
	const byPath = new Map();

	for (const row of semanticRows) {
		const payload = row.payload ?? {};
		const path = payload.path;
		if (!path) continue;
		if (!vault.byPath.has(path)) continue;
		const current = byPath.get(path) ?? {
			path,
			title: payload.title ?? path,
			layer: payload.layer ?? 'unknown',
			text: payload.text ?? '',
			semanticScore: 0,
			exactScore: 0,
		};
		current.semanticScore = Math.max(current.semanticScore, row.score ?? 0);
		if (!current.text && payload.text) current.text = payload.text;
		byPath.set(path, current);
	}

	for (const row of exactRows) {
		const current = byPath.get(row.page.relPath) ?? {
			path: row.page.relPath,
			title: row.page.title,
			layer: row.page.layer,
			text: '',
			semanticScore: 0,
			exactScore: 0,
		};
		current.exactScore = Math.max(current.exactScore, row.score / 20);
		if (!current.text) current.text = row.page.body.replace(/\s+/g, ' ').slice(0, 800);
		byPath.set(row.page.relPath, current);
	}

	return [...byPath.values()]
		.map((row) => ({
			...row,
			title: vault.byPath.get(row.path)?.title ?? row.title,
			layer: vault.byPath.get(row.path)?.layer ?? row.layer,
			text: vault.byPath.has(row.path)
				? stripMarkdown(vault.byPath.get(row.path).body).replace(/\s+/g, ' ').slice(0, 800)
				: row.text,
			score: row.semanticScore + row.exactScore,
		}))
		.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
		.slice(0, limit);
}
