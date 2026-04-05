/**
 * LoreRAGService — Mtherios
 *
 * Universal RAG service for external lore databases.
 * Queries a vector DB (Qdrant, etc.) for relevant world lore based on
 * semantic similarity to the current narrative context.
 *
 * Key design: This does NOT create lorebook Entry records. Lore chunks
 * are injected as transient context blocks in the Retrieved tier only.
 * The lorebook stays clean; the RAG provides deep background knowledge.
 *
 * Universal: Works with any world's lore — ASOIAF, Forgotten Realms,
 * custom settings. Each "lore source" is a named collection in the vector DB.
 */

import { BaseAIService } from '../BaseAIService';
import { createLogger } from '../core/config';
import { getSetting } from '$lib/services/database';

const log = createLogger('LoreRAG');

// ── Types ──

export interface LoreChunk {
	id: string;
	content: string;
	metadata: LoreChunkMetadata;
	score: number;
}

export interface LoreChunkMetadata {
	source: string;        // e.g. "awoiaf", "fire-and-blood", "custom"
	title: string;         // article/chapter title
	category: string;      // e.g. "character", "house", "location", "event", "culture"
	tags: string[];        // e.g. ["targaryen", "dragons", "conquest"]
	url?: string;          // source URL if scraped
	chunkIndex?: number;   // position within the source article
}

export interface LoreRAGResult {
	chunks: LoreChunk[];
	contextBlock: string;
	queryUsed: string;
	source: string;
	totalFound: number;
}

export interface LoreRAGConfig {
	enabled: boolean;
	endpoint: string;      // Qdrant REST endpoint (e.g. "http://localhost:6333")
	collection: string;    // Qdrant collection name (e.g. "westeros_lore")
	embeddingEndpoint: string;  // embedding API (e.g. "http://localhost:11434")
	embeddingModel: string;     // e.g. "nomic-embed-text"
	maxChunks: number;     // max chunks to return per query (default 8)
	minScore: number;      // minimum similarity threshold (default 0.3)
	maxContextTokens: number; // max tokens for RAG context block (default 2000)
}

const DEFAULT_CONFIG: LoreRAGConfig = {
	enabled: true,
	endpoint: 'http://localhost:6333',
	collection: 'rise_lore',
	embeddingEndpoint: 'http://localhost:11434',
	embeddingModel: 'nomic-embed-text',
	maxChunks: 8,
	minScore: 0.3,
	maxContextTokens: 2000,
};

export class LoreRAGService extends BaseAIService {
	constructor() {
		super('loreRAG');
	}

	/**
	 * Load RAG configuration from IndexedDB settings.
	 * Falls back to defaults if not configured.
	 */
	async getConfig(): Promise<LoreRAGConfig> {
		try {
			const raw = await getSetting('loreRAGConfig');
			if (raw) {
				const parsed = JSON.parse(raw);
				return { ...DEFAULT_CONFIG, ...parsed };
			}
		} catch (e) {
			log('getConfig', `Failed to load config: ${e}`);
		}
		return { ...DEFAULT_CONFIG };
	}

	/**
	 * Save RAG configuration to IndexedDB.
	 */
	async saveConfig(config: Partial<LoreRAGConfig>): Promise<void> {
		const current = await this.getConfig();
		const merged = { ...current, ...config };
		const { setSetting } = await import('$lib/services/database');
		await setSetting('loreRAGConfig', JSON.stringify(merged));
	}

	/**
	 * Generate an embedding vector for the query text using the configured
	 * embedding model (Ollama by default).
	 */
	private async embed(text: string, config: LoreRAGConfig): Promise<number[] | null> {
		try {
			const response = await fetch(`${config.embeddingEndpoint}/api/embed`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: config.embeddingModel,
					input: text,
				}),
			});

			if (!response.ok) {
				log('embed', `Ollama returned ${response.status}`);
				return null;
			}

			const data = await response.json();
			// Ollama /api/embed returns { embeddings: [[...]] }
			if (data.embeddings?.[0]) return data.embeddings[0];
			// Ollama /api/embeddings returns { embedding: [...] }
			if (data.embedding) return data.embedding;

			log('embed', 'Unexpected response shape');
			return null;
		} catch (e) {
			log('embed', `Embedding failed: ${e}`);
			return null;
		}
	}

	/**
	 * Query Qdrant for similar lore chunks.
	 */
	private async queryQdrant(
		vector: number[],
		config: LoreRAGConfig,
		filter?: Record<string, unknown>,
	): Promise<LoreChunk[]> {
		try {
			const body: Record<string, unknown> = {
				vector,
				limit: config.maxChunks,
				score_threshold: config.minScore,
				with_payload: true,
			};

			if (filter) {
				body.filter = filter;
			}

			const response = await fetch(
				`${config.endpoint}/collections/${config.collection}/points/search`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				},
			);

			if (!response.ok) {
				log('queryQdrant', `Qdrant returned ${response.status}`);
				return [];
			}

			const data = await response.json();
			const results = data.result ?? [];

			return results.map((point: any) => ({
				id: String(point.id),
				content: point.payload?.content ?? '',
				metadata: {
					source: point.payload?.source ?? 'unknown',
					title: point.payload?.title ?? '',
					category: point.payload?.category ?? '',
					tags: point.payload?.tags ?? [],
					url: point.payload?.url,
					chunkIndex: point.payload?.chunk_index,
				},
				score: point.score ?? 0,
			}));
		} catch (e) {
			log('queryQdrant', `Query failed: ${e}`);
			return [];
		}
	}

	/**
	 * Build a Qdrant filter object for category/tag filtering.
	 */
	private buildFilter(options?: {
		categories?: string[];
		tags?: string[];
		source?: string;
	}): Record<string, unknown> | undefined {
		if (!options) return undefined;

		const must: Record<string, unknown>[] = [];

		if (options.source) {
			must.push({
				key: 'source',
				match: { value: options.source },
			});
		}

		if (options.categories?.length) {
			must.push({
				key: 'category',
				match: { any: options.categories },
			});
		}

		if (options.tags?.length) {
			must.push({
				key: 'tags',
				match: { any: options.tags },
			});
		}

		return must.length > 0 ? { must } : undefined;
	}

	/**
	 * Main retrieval method. Takes a natural language query, embeds it,
	 * searches Qdrant, and returns formatted context.
	 */
	async retrieve(
		query: string,
		options?: {
			categories?: string[];
			tags?: string[];
			source?: string;
			maxChunks?: number;
		},
	): Promise<LoreRAGResult> {
		const config = await this.getConfig();

		if (!config.enabled) {
			return { chunks: [], contextBlock: '', queryUsed: query, source: config.collection, totalFound: 0 };
		}

		log('retrieve', { query: query.slice(0, 100), collection: config.collection });

		// Embed the query
		const vector = await this.embed(query, config);
		if (!vector) {
			log('retrieve', 'Embedding failed, returning empty');
			return { chunks: [], contextBlock: '', queryUsed: query, source: config.collection, totalFound: 0 };
		}

		// Build filter
		const filter = this.buildFilter(options);

		// Query with optional chunk override
		const effectiveConfig = options?.maxChunks
			? { ...config, maxChunks: options.maxChunks }
			: config;
		const chunks = await this.queryQdrant(vector, effectiveConfig, filter);

		// Build context block
		const contextBlock = this.buildContextBlock(chunks, config);

		log('retrieve', { found: chunks.length, topScore: chunks[0]?.score ?? 0 });

		return {
			chunks,
			contextBlock,
			queryUsed: query,
			source: config.collection,
			totalFound: chunks.length,
		};
	}

	/**
	 * Multi-query retrieval. Runs multiple queries and deduplicates results.
	 * Useful when the agentic retriever generates multiple search terms.
	 */
	async retrieveMulti(
		queries: string[],
		options?: {
			categories?: string[];
			tags?: string[];
			source?: string;
			maxTotalChunks?: number;
		},
	): Promise<LoreRAGResult> {
		const config = await this.getConfig();

		if (!config.enabled) {
			return { chunks: [], contextBlock: '', queryUsed: queries.join(' | '), source: config.collection, totalFound: 0 };
		}

		const allChunks = new Map<string, LoreChunk>();

		for (const query of queries) {
			const result = await this.retrieve(query, {
				...options,
				maxChunks: Math.ceil(config.maxChunks / queries.length),
			});

			for (const chunk of result.chunks) {
				const existing = allChunks.get(chunk.id);
				if (!existing || chunk.score > existing.score) {
					allChunks.set(chunk.id, chunk);
				}
			}
		}

		// Sort by score, cap total
		const maxTotal = options?.maxTotalChunks ?? config.maxChunks;
		const sorted = [...allChunks.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, maxTotal);

		const contextBlock = this.buildContextBlock(sorted, config);

		return {
			chunks: sorted,
			contextBlock,
			queryUsed: queries.join(' | '),
			source: config.collection,
			totalFound: sorted.length,
		};
	}

	/**
	 * Format retrieved chunks as a context block for injection into the narrative prompt.
	 * Groups by category for readability.
	 */
	private buildContextBlock(chunks: LoreChunk[], config: LoreRAGConfig): string {
		if (chunks.length === 0) return '';

		// Group by category
		const grouped = new Map<string, LoreChunk[]>();
		for (const chunk of chunks) {
			const cat = chunk.metadata.category || 'general';
			if (!grouped.has(cat)) grouped.set(cat, []);
			grouped.get(cat)!.push(chunk);
		}

		let block = '\n[WORLD LORE — Reference knowledge. Use to maintain consistency but do not dump exposition.]\n';
		let tokensSoFar = estimateTokens(block);

		for (const [category, catChunks] of grouped) {
			const catHeader = `\n### ${category.charAt(0).toUpperCase() + category.slice(1)}\n`;
			tokensSoFar += estimateTokens(catHeader);
			if (tokensSoFar > config.maxContextTokens) break;
			block += catHeader;

			for (const chunk of catChunks) {
				const entry = `**${chunk.metadata.title}**: ${chunk.content}\n\n`;
				const entryTokens = estimateTokens(entry);

				if (tokensSoFar + entryTokens > config.maxContextTokens) {
					// Truncate this entry to fit remaining budget
					const remaining = (config.maxContextTokens - tokensSoFar) * 4;
					if (remaining > 100) {
						block += `**${chunk.metadata.title}**: ${chunk.content.slice(0, remaining - 50)}...\n\n`;
					}
					break;
				}

				block += entry;
				tokensSoFar += entryTokens;
			}
		}

		return block;
	}

	/**
	 * Check if the RAG backend (Qdrant + embeddings) is healthy.
	 */
	async healthCheck(): Promise<{ qdrant: boolean; embeddings: boolean; collection: boolean; pointCount: number }> {
		const config = await this.getConfig();
		const result = { qdrant: false, embeddings: false, collection: false, pointCount: 0 };

		// Check Qdrant
		try {
			const resp = await fetch(`${config.endpoint}/collections`);
			result.qdrant = resp.ok;
		} catch { /* noop */ }

		// Check collection exists
		if (result.qdrant) {
			try {
				const resp = await fetch(`${config.endpoint}/collections/${config.collection}`);
				if (resp.ok) {
					const data = await resp.json();
					result.collection = true;
					result.pointCount = data.result?.points_count ?? 0;
				}
			} catch { /* noop */ }
		}

		// Check embeddings
		try {
			const resp = await fetch(`${config.embeddingEndpoint}/api/tags`);
			result.embeddings = resp.ok;
		} catch { /* noop */ }

		return result;
	}

	/**
	 * List available lore collections (Qdrant collections).
	 */
	async listCollections(): Promise<string[]> {
		const config = await this.getConfig();
		try {
			const resp = await fetch(`${config.endpoint}/collections`);
			if (!resp.ok) return [];
			const data = await resp.json();
			return (data.result?.collections ?? []).map((c: any) => c.name);
		} catch {
			return [];
		}
	}
}

// ── Utility ──

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
