import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { searchVault } from './lib/search.mjs';
import { embedText } from './lib/embeddings.mjs';

test('scoped child search uses the exact parent vector and never embeds again, including a missing receipt', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-query-test-'));
  const file = path.join(directory, 'query.json'), query = 'Bridge promise';
  const originalFetch = globalThis.fetch;
  const oldFile = process.env.MYTHENGINE_WIKI_QUERY_EMBEDDING_FILE, oldLimit = process.env.MYTHENGINE_WIKI_EMBED_MAX_REQUESTS;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push(String(url)); assert.deepEqual(JSON.parse(options.body).vector, [1, 0]); return new Response(JSON.stringify({ result: [] })); };
  process.env.MYTHENGINE_WIKI_QUERY_EMBEDDING_FILE = file; process.env.MYTHENGINE_WIKI_EMBED_MAX_REQUESTS = '0';
  const pages = [{ relPath: 'bridge.md', title: 'Bridge', body: query, layer: 'wiki' }];
  const vault = { pages, byPath: new Map(pages.map(page => [page.relPath, page])) };
  try {
    await fs.writeFile(file, JSON.stringify({ queryHash: createHash('sha256').update(query).digest('hex'), vector: [1, 0] }));
    const found = await searchVault(vault, query, { followDepth: 0 });
    assert.equal(found.semanticError, null); assert.equal(calls.length, 1); assert.match(calls[0], /points\/search/);
    const mismatched = await searchVault(vault, 'Different query', { followDepth: 0 });
    assert.match(mismatched.semanticError, /does not match/); assert.equal(calls.length, 1);
    await fs.rm(file);
    const fallback = await searchVault(vault, query, { followDepth: 0 });
    assert.ok(fallback.semanticError); assert.equal(fallback.results[0].path, 'bridge.md'); assert.equal(calls.length, 1);
    await assert.rejects(embedText(query, { provider: 'openai', model: 'test', customUrl: 'https://custom.test' }), /no external/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldFile === undefined) delete process.env.MYTHENGINE_WIKI_QUERY_EMBEDDING_FILE; else process.env.MYTHENGINE_WIKI_QUERY_EMBEDDING_FILE = oldFile;
    if (oldLimit === undefined) delete process.env.MYTHENGINE_WIKI_EMBED_MAX_REQUESTS; else process.env.MYTHENGINE_WIKI_EMBED_MAX_REQUESTS = oldLimit;
    await fs.rm(file, { force: true }); await fs.rmdir(directory);
  }
});
