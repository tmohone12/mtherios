import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchVault } from './lib/search.mjs';
import { searchPoints } from './lib/qdrant.mjs';
import { buildContextPack } from './lib/context.mjs';

test('automatic lore seeds search the whole lore collection before capping, while explicit search includes history', async () => {
	const pages = Array.from({ length: 20 }, (_, index) => ({
		relPath: `chapters/${index}.md`, title: `Volantis fleet ${index}`, layer: 'chapter', body: 'Volantis fleet '.repeat(20),
	}));
	pages.push({ relPath: 'wiki/volantis.md', title: 'Volantis', layer: 'wiki', body: 'The fleet guards the sea lanes.' });
	const vault = { pages, byPath: new Map(pages.map(page => [page.relPath, page])) };
	const lore = await searchVault(vault, 'Volantis fleet', { exact: true, layer: 'wiki', limit: 1, followDepth: 0 });
	assert.equal(lore.results[0].path, 'wiki/volantis.md');
	const all = await searchVault(vault, 'Volantis fleet', { exact: true, limit: 30, followDepth: 0 });
	assert.equal(all.results.length, 21);
});

test('semantic lore filtering keeps canonical-vector isolation and applies before the result cap', async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (_url, init) => {
		request = JSON.parse(init.body);
		return new Response(JSON.stringify({ result: [] }));
	};
	try {
		await searchPoints([1, 0], { url: 'http://qdrant.test', collection: 'campaign' }, { limit: 8, layer: 'wiki' });
		assert.deepEqual(request.filter, {
			must_not: [{ key: 'kind', match: { value: 'canonical_record' } }],
			must: [{ key: 'layer', match: { value: 'wiki' } }],
		});
		assert.equal(request.limit, 8);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('automatic lore keeps relevant local expansion and cites only retained page bodies', () => {
	const pages = [
		{ relPath: 'wiki/qarth.md', title: 'Qarth harbor', layer: 'wiki', body: 'Qarth harbor customs and gates. '.repeat(18), resolvedLinks: ['wiki/customs.md', 'wiki/index.md', 'wiki/volantis.md'] },
		{ relPath: 'wiki/customs.md', title: 'Qarth customs', layer: 'wiki', body: 'Harbor customs officials inspect arrivals. '.repeat(18) },
		{ relPath: 'wiki/index.md', title: 'Index', layer: 'root', body: 'Every place in the world.' },
		{ relPath: 'wiki/volantis.md', title: 'Volantis', layer: 'wiki', body: 'The old city and its walls.' },
	];
	const vault = { pages, byPath: new Map(pages.map(page => [page.relPath, page])) };
	const pack = buildContextPack(vault, { query: 'Qarth harbor customs', results: [{ path: 'wiki/qarth.md', title: 'Qarth harbor', layer: 'wiki', score: 10 }] },
		{ followDepth: 1, maxChars: 1000, pageChars: 600 });
	assert.equal(pack.pages[0].title, 'Qarth harbor');
	assert.ok(pack.pages.every(page => page.title !== 'Index' && page.title !== 'Volantis'));
	assert.equal(pack.citations.length, pack.pages.length);
	for (const page of pack.pages) assert.ok(pack.contextMarkdown.includes(`## [${page.citationId}] ${page.title}`));
	assert.ok(pack.contextMarkdown.length <= 1000);
});
