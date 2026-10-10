import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { currentServerProviderHooks } from '$lib/server/turn/provider';
import { embedMemoryText, type MemoryEmbeddingConfig } from '$lib/server/memory/embeddings';

/** Keep the CLI's saved wiki embedding configuration; only the dispatch owner changes. */
export function wikiQueryEmbeddingConfig(args: string[], env: NodeJS.ProcessEnv): MemoryEmbeddingConfig {
  const flag = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const provider = flag('--provider') ?? env.WIKI_EMBED_PROVIDER ?? 'openrouter';
  const model = flag('--model') ?? env.WIKI_EMBED_MODEL ?? env.EMBED_MODEL ?? (provider === 'openrouter' ? 'openai/text-embedding-3-small' : 'nomic-embed-text');
  const openAi = ['openai', 'openai-compatible', 'openrouter'].includes(provider);
  return {
    provider: openAi || ['local', 'local-hash'].includes(provider) ? provider : 'ollama', model,
    baseUrl: openAi ? env.WIKI_EMBED_BASE_URL ?? env.OPENAI_BASE_URL ?? (provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'http://127.0.0.1:1234/v1') : env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    apiKey: env.WIKI_EMBED_API_KEY ?? (provider === 'openrouter' ? env.OPENROUTER_API_KEY : '') ?? env.OPENAI_API_KEY ?? '',
    customUrl: env.WIKI_EMBED_URL ?? '', batchSize: Number(env.WIKI_EMBED_BATCH ?? 8),
    dimensions: Math.max(1, Number(env.WIKI_EMBED_DIMENSIONS ?? 768)), requestDimensions: false,
  };
}

/** Parent reserves and records the query once; the child receives evidence, never a paid retry capability. */
export async function withWikiQueryEmbedding<T>(script: string, args: string[], env: NodeJS.ProcessEnv, work: (childEnv: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const hooks = currentServerProviderHooks();
  if (!hooks || !['search.mjs', 'context.mjs', 'brief.mjs'].includes(script) || args.includes('--exact')) return work(env);
  hooks.signal?.throwIfAborted();
  const query = args[1] ?? '';
  const receipt: { queryHash: string; vector?: number[]; error?: string } = { queryHash: createHash('sha256').update(query).digest('hex') };
  try {
    receipt.vector = await embedMemoryText(query, wikiQueryEmbeddingConfig(args, env), hooks.signal);
    if (!receipt.vector.length || receipt.vector.length > 65_536 || receipt.vector.some(value => !Number.isFinite(value))) throw new Error('Invalid query embedding.');
  } catch (error) {
    hooks.signal?.throwIfAborted();
    delete receipt.vector;
    const reason = error instanceof Error ? error.message : '';
    receipt.error = /^[a-z_]+$/.test(reason) ? reason : 'Wiki query embedding unavailable.';
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mythengine-wiki-query-'));
  const file = path.join(directory, 'embedding.json');
  try {
    await fs.writeFile(file, JSON.stringify(receipt), { encoding: 'utf8', mode: 0o600 });
    return await work({ ...env, MYTHENGINE_WIKI_QUERY_EMBEDDING_FILE: file, MYTHENGINE_WIKI_EMBED_MAX_REQUESTS: '0' });
  } finally {
    // Delete only the exact temporary file we created, then its now-empty directory.
    await fs.rm(file, { force: true });
    await fs.rmdir(directory);
  }
}
