#!/usr/bin/env node

import { parseArgs, readIntFlag, requireVaultAndRest } from './lib/cli.mjs';
import { embedInBatches, embeddingConfig } from './lib/embeddings.mjs';
import { prepareAndSyncWikiIndex, qdrantConfig } from './lib/qdrant.mjs';
import { chunkMarkdown, loadVault } from './lib/vault.mjs';

const usage = `Usage:
  node scripts/wiki-core/index.mjs <vaultPath> [--collection name] [--recreate] [--dry-run]

Environment:
  QDRANT_URL=http://127.0.0.1:6335
  QDRANT_COLLECTION=mythengine_wiki
  WIKI_EMBED_PROVIDER=openrouter|openai-compatible|ollama
  WIKI_EMBED_MODEL=openai/text-embedding-3-small
  OLLAMA_URL=http://127.0.0.1:11434
  WIKI_EMBED_BASE_URL=https://openrouter.ai/api/v1
  WIKI_EMBED_API_KEY=...`;

const { flags, positional } = parseArgs(process.argv.slice(2));
const [vaultPath] = requireVaultAndRest(positional, usage);

const maxChars = readIntFlag(flags, 'max-chars', 2400);
const overlapChars = readIntFlag(flags, 'overlap-chars', 280);
const qdrant = qdrantConfig({ collection: flags.collection });
const embeddings = embeddingConfig({ provider: flags.provider, model: flags.model });

async function loadWikiChunks() {
	const vault = await loadVault(vaultPath);
	const chunks = vault.pages.flatMap((page) => chunkMarkdown(page, { maxChars, overlapChars }));
	console.log(`Vault: ${vault.root}`);
	console.log(`Pages: ${vault.pages.length}`);
	console.log(`Chunks: ${chunks.length}`);
	console.log(`Collection: ${qdrant.collection}`);
	console.log(`Embedding: ${embeddings.provider} / ${embeddings.model}`);
	return { vault, chunks };
}

if (flags['dry-run']) {
	const { vault, chunks } = await loadWikiChunks();
	const byLayer = chunks.reduce((acc, chunk) => {
		acc[chunk.payload.layer] = (acc[chunk.payload.layer] ?? 0) + 1;
		return acc;
	}, {});
	console.log(JSON.stringify({ pages: vault.pages.length, chunks: chunks.length, byLayer }, null, 2));
	process.exit(0);
}

let chunkCount = 0;
const result = await prepareAndSyncWikiIndex(async () => {
	const { chunks } = await loadWikiChunks();
	chunkCount = chunks.length;
	if (chunks.length === 0) return { vectorSize: null, points: [] };

	const vectors = await embedInBatches(
		chunks.map((chunk) => `${chunk.payload.title}\n${chunk.content}`),
		embeddings,
		({ done, total }) => console.log(`Embedded ${done}/${total}`),
	);
	const vectorSize = vectors[0]?.length;
	if (!vectorSize) throw new Error('Embedding provider returned an empty vector.');
	return {
		vectorSize,
		points: chunks.map((chunk, index) => ({
			id: chunk.id,
			vector: vectors[index],
			payload: chunk.payload,
		})),
	};
}, qdrant);

if (chunkCount === 0) {
	console.log(`No markdown content found to index. Removed ${result.removed} obsolete wiki chunks.`);
	process.exit(0);
}
console.log(
	`Indexed ${result.upserted} chunks and removed ${result.removed} obsolete wiki chunks ` +
		`from Qdrant collection "${qdrant.collection}".`,
);
