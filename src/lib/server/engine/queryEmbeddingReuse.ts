import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

interface QueryEmbeddingReuseScope {
  /** Fresh run authority, world/source/settings revision. Never a saved scene. */
  revision: () => Promise<string>;
  signal?: AbortSignal;
}
const scopes = new AsyncLocalStorage<QueryEmbeddingReuseScope & { vectors: Map<string, number[][]> }>();

/** One GM invocation only. Searches and scene assembly are always rerun against current sources. */
export function withQueryEmbeddingReuse<T>(scope: QueryEmbeddingReuseScope, work: () => Promise<T>): Promise<T> {
  return scopes.run({ ...scope, vectors: new Map() }, work);
}

export async function reuseQueryEmbedding(
  identity: unknown, signal: AbortSignal | undefined, dispatch: () => Promise<number[][]>,
): Promise<number[][]> {
  const scope = scopes.getStore();
  if (!scope) return dispatch();
  const guard = () => { scope.signal?.throwIfAborted(); signal?.throwIfAborted(); };
  guard();
  const before = await scope.revision();
  guard();
  // Includes exact input, endpoint, provider, model, key, dimensions and request options.
  // Only the digest is kept; no credential or query cache identity is persisted/logged.
  const key = createHash('sha256').update(JSON.stringify({ revision: before, identity })).digest('hex');
  const cached = scope.vectors.get(key);
  if (cached) return structuredClone(cached);
  // Do not coalesce in-flight calls: each caller retains its own cancellation and dispatch accounting.
  const vectors = await dispatch();
  guard();
  if (vectors.length && vectors.every(vector => vector.length && vector.every(Number.isFinite))
    && await scope.revision() === before) {
    guard();
    if (scope.vectors.size < 32) scope.vectors.set(key, structuredClone(vectors));
  }
  guard();
  return vectors;
}
