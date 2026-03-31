/**
 * EmbeddingService — Mtherios
 *
 * Generates and caches text embeddings for semantic search.
 * Primary: API-based embeddings via the user's configured provider (/embeddings endpoint).
 * Fallback: TF-IDF cosine similarity (runs locally, no API needed).
 *
 * Embeddings are cached in IndexedDB with content hashing for invalidation.
 */

import { getSetting } from '$lib/services/database';
import { getEmbedding, putEmbedding, deleteEmbeddingsBySource } from '$lib/services/database';
import { uuid } from '$lib/utils/uuid';
import { PROVIDERS } from '../sdk/providers/config';
import { createLogger } from '../core/config';
import type { APIProfile, ProviderType, EmbeddingCacheEntry } from '$lib/types';

const log = createLogger('Embeddings');

// ── Embedding model map per provider ──
const EMBEDDING_MODELS: Partial<Record<ProviderType, string>> = {
	openai: 'text-embedding-3-small',
	anthropic: '', // no native embeddings
	google: 'text-embedding-004',
	openrouter: 'openai/text-embedding-3-small',
	deepseek: '', // no embeddings
	mistral: 'mistral-embed',
	'nvidia-nim': 'NV-Embed-QA',
	'openai-compatible': 'text-embedding-3-small',
};

// ── Content hashing ──
function hashContent(text: string): string {
	// Simple FNV-1a hash for cache invalidation
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = (hash * 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

// ── Cosine similarity ──
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;
	let dot = 0, magA = 0, magB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		magA += a[i] * a[i];
		magB += b[i] * b[i];
	}
	const denom = Math.sqrt(magA) * Math.sqrt(magB);
	return denom === 0 ? 0 : dot / denom;
}

// ── TF-IDF Fallback ──

const STOP_WORDS = new Set([
	'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
	'of', 'with', 'by', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
	'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
	'should', 'may', 'might', 'shall', 'can', 'it', 'its', 'this', 'that',
	'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him',
	'her', 'us', 'them', 'my', 'your', 'his', 'our', 'their', 'not', 'no',
	'so', 'if', 'as', 'from', 'into', 'up', 'out', 'about', 'then', 'than',
]);

function tokenize(text: string): string[] {
	return text.toLowerCase()
		.replace(/[^a-z0-9\s'-]/g, ' ')
		.split(/\s+/)
		.filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function termFrequency(tokens: string[]): Map<string, number> {
	const tf = new Map<string, number>();
	for (const t of tokens) {
		tf.set(t, (tf.get(t) ?? 0) + 1);
	}
	// Normalize
	const max = Math.max(...tf.values(), 1);
	for (const [k, v] of tf) {
		tf.set(k, v / max);
	}
	return tf;
}

/**
 * Compute TF-IDF cosine similarity between two texts.
 * Used as fallback when API embeddings aren't available.
 */
export function tfidfSimilarity(textA: string, textB: string): number {
	const tokensA = tokenize(textA);
	const tokensB = tokenize(textB);
	const tfA = termFrequency(tokensA);
	const tfB = termFrequency(tokensB);

	// Union of all terms
	const allTerms = new Set([...tfA.keys(), ...tfB.keys()]);

	let dot = 0, magA = 0, magB = 0;
	for (const term of allTerms) {
		const a = tfA.get(term) ?? 0;
		const b = tfB.get(term) ?? 0;
		dot += a * b;
		magA += a * a;
		magB += b * b;
	}
	const denom = Math.sqrt(magA) * Math.sqrt(magB);
	return denom === 0 ? 0 : dot / denom;
}

// ── Service ──

export class EmbeddingService {
	private apiAvailable: boolean | null = null; // null = unknown, true/false = tested
	private embeddingModel = '';

	/**
	 * Embed a single text. Returns cached result if available.
	 * Falls back to TF-IDF vector if API embeddings aren't available.
	 */
	async embed(
		text: string,
		sourceId: string,
		sourceType: EmbeddingCacheEntry['sourceType'],
	): Promise<number[] | null> {
		const contentHash = hashContent(text);

		// Check cache
		const cached = await getEmbedding(sourceType, sourceId);
		if (cached && cached.contentHash === contentHash) {
			return cached.vector;
		}

		// Try API embedding
		const vector = await this.embedViaApi(text);
		if (vector) {
			await putEmbedding({
				id: cached?.id ?? uuid(),
				sourceId,
				sourceType,
				contentHash,
				vector,
				model: this.embeddingModel,
				createdAt: Date.now(),
			});
			return vector;
		}

		return null; // API not available; caller should use tfidfSimilarity fallback
	}

	/**
	 * Embed multiple texts in a batch.
	 */
	async embedMany(
		items: Array<{ text: string; sourceId: string; sourceType: EmbeddingCacheEntry['sourceType'] }>,
	): Promise<Map<string, number[]>> {
		const results = new Map<string, number[]>();
		const toEmbed: Array<{ text: string; sourceId: string; sourceType: EmbeddingCacheEntry['sourceType']; contentHash: string }> = [];

		// Check cache for each item
		for (const item of items) {
			const contentHash = hashContent(item.text);
			const cached = await getEmbedding(item.sourceType, item.sourceId);
			if (cached && cached.contentHash === contentHash) {
				results.set(item.sourceId, cached.vector);
			} else {
				toEmbed.push({ ...item, contentHash });
			}
		}

		if (toEmbed.length === 0) return results;

		// Try batch API embedding
		const vectors = await this.embedBatchViaApi(toEmbed.map(i => i.text));
		if (vectors && vectors.length === toEmbed.length) {
			for (let i = 0; i < toEmbed.length; i++) {
				const item = toEmbed[i];
				const vector = vectors[i];
				results.set(item.sourceId, vector);

				// Cache
				const cached = await getEmbedding(item.sourceType, item.sourceId);
				await putEmbedding({
					id: cached?.id ?? uuid(),
					sourceId: item.sourceId,
					sourceType: item.sourceType,
					contentHash: item.contentHash,
					vector,
					model: this.embeddingModel,
					createdAt: Date.now(),
				});
			}
		}

		return results;
	}

	/**
	 * Compute similarity between a query and a set of items.
	 * Uses embeddings if available, falls back to TF-IDF.
	 */
	async scoreSimilarity(
		queryText: string,
		items: Array<{ id: string; text: string; sourceType: EmbeddingCacheEntry['sourceType'] }>,
	): Promise<Array<{ id: string; score: number }>> {
		// Try embedding-based scoring first
		const queryVec = await this.embed(queryText, 'query-' + hashContent(queryText), 'query');

		if (queryVec) {
			const itemVecs = await this.embedMany(
				items.map(i => ({ text: i.text, sourceId: i.id, sourceType: i.sourceType }))
			);

			return items.map(item => {
				const vec = itemVecs.get(item.id);
				return {
					id: item.id,
					score: vec ? cosineSimilarity(queryVec, vec) : 0,
				};
			}).sort((a, b) => b.score - a.score);
		}

		// Fallback to TF-IDF
		log('scoreSimilarity', 'Using TF-IDF fallback');
		return items.map(item => ({
			id: item.id,
			score: tfidfSimilarity(queryText, item.text),
		})).sort((a, b) => b.score - a.score);
	}

	/**
	 * Invalidate cache for a specific source.
	 */
	async invalidate(sourceType: string, sourceId: string): Promise<void> {
		await deleteEmbeddingsBySource(sourceType, sourceId);
	}

	/**
	 * Check if API embeddings are available.
	 */
	get isApiAvailable(): boolean {
		return this.apiAvailable === true;
	}

	// ── Private API methods ──

	private async embedViaApi(text: string): Promise<number[] | null> {
		try {
			const { baseUrl, apiKey, model } = await this.getEmbeddingConfig();
			if (!model) {
				this.apiAvailable = false;
				return null;
			}

			const response = await fetch(`${baseUrl}/embeddings`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model,
					input: text,
				}),
			});

			if (!response.ok) {
				log('embedViaApi', `API returned ${response.status}`);
				this.apiAvailable = false;
				return null;
			}

			const data = await response.json();
			const vector = data.data?.[0]?.embedding;
			if (Array.isArray(vector)) {
				this.apiAvailable = true;
				return vector;
			}

			this.apiAvailable = false;
			return null;
		} catch (e) {
			log('embedViaApi', `API failed: ${e}`);
			this.apiAvailable = false;
			return null;
		}
	}

	private async embedBatchViaApi(texts: string[]): Promise<number[][] | null> {
		try {
			const { baseUrl, apiKey, model } = await this.getEmbeddingConfig();
			if (!model) return null;

			const response = await fetch(`${baseUrl}/embeddings`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model,
					input: texts,
				}),
			});

			if (!response.ok) return null;

			const data = await response.json();
			const embeddings = data.data;
			if (Array.isArray(embeddings)) {
				this.apiAvailable = true;
				return embeddings
					.sort((a: any, b: any) => a.index - b.index)
					.map((e: any) => e.embedding);
			}

			return null;
		} catch {
			return null;
		}
	}

	private async getEmbeddingConfig(): Promise<{ baseUrl: string; apiKey: string; model: string }> {
		const profilesJson = await getSetting('apiProfiles');
		const activeProfileId = await getSetting('activeProfileId');

		if (!profilesJson) return { baseUrl: '', apiKey: '', model: '' };

		const profiles: APIProfile[] = JSON.parse(profilesJson);
		const profile = activeProfileId
			? profiles.find(p => p.id === activeProfileId) ?? profiles[0]
			: profiles[0];

		if (!profile) return { baseUrl: '', apiKey: '', model: '' };

		const providerConfig = PROVIDERS[profile.providerType as ProviderType];
		const baseUrl = profile.baseUrl || providerConfig?.baseUrl || 'https://api.openai.com/v1';

		// Get embedding model for this provider
		const model = EMBEDDING_MODELS[profile.providerType as ProviderType] ?? '';
		this.embeddingModel = model;

		return { baseUrl, apiKey: profile.apiKey, model };
	}
}
