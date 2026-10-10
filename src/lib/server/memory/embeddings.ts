import { createHash } from 'node:crypto';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { reuseQueryEmbedding } from '$lib/server/engine/queryEmbeddingReuse';
import { getServerMemoryConfig } from '$lib/server/env';
import { currentServerProviderHooks, normalizeServerProviderUsage } from '$lib/server/turn/provider';
import { countTokens } from '$lib/utils/tokens';

const MEMORY_EMBEDDING_TEXT_CHAR_LIMIT = 6000;
const MEMORY_EMBEDDING_SUMMARY_CHAR_LIMIT = 2200;
const MEMORY_EMBEDDING_CONTENT_CHAR_LIMIT = 3400;

export interface MemoryEmbeddingConfig {
	provider: string;
	model: string;
	baseUrl: string;
	apiKey: string;
	customUrl: string;
	batchSize: number;
	dimensions: number;
	/** Wiki collections historically select dimensions through their model, not a request field. */
	requestDimensions?: boolean;
}

export function memoryEmbeddingConfig(): MemoryEmbeddingConfig | null {
	const config = getServerMemoryConfig();
	if (!config.embeddingProvider || !config.embeddingModel) return null;
	const provider = config.embeddingProvider;
	const baseUrl = config.embeddingBaseUrl
		?? (provider === 'openrouter'
			? 'https://openrouter.ai/api/v1'
			: provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234/v1');
	return {
		provider,
		model: config.embeddingModel,
		baseUrl,
		apiKey: config.embeddingApiKey ?? '',
		customUrl: config.embeddingCustomUrl ?? '',
		batchSize: config.embeddingBatchSize,
		dimensions: config.embeddingDimensions,
	};
}

export function memoryNodeEmbeddingText(node: {
	title: string;
	content: string;
	summary?: string | null;
	keywords?: unknown;
}): string {
	const keywords = Array.isArray(node.keywords)
		? node.keywords.filter((item): item is string => typeof item === 'string').join(', ')
		: '';
	return clipEmbeddingText([
		node.title,
		node.summary ? clipEmbeddingText(node.summary, MEMORY_EMBEDDING_SUMMARY_CHAR_LIMIT) : null,
		keywords ? `Keywords: ${keywords}` : null,
		clipEmbeddingText(node.content, MEMORY_EMBEDDING_CONTENT_CHAR_LIMIT),
	].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n\n'), MEMORY_EMBEDDING_TEXT_CHAR_LIMIT);
}

function clipEmbeddingText(value: string, max = MEMORY_EMBEDDING_TEXT_CHAR_LIMIT): string {
	const text = value.replace(/\s+/g, ' ').trim();
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export async function embedMemoryTexts(
	texts: string[],
	config = memoryEmbeddingConfig(),
	signal?: AbortSignal,
): Promise<number[][]> {
	signal?.throwIfAborted();
	if (!config) throw new Error('Memory embeddings are not configured.');
	if (texts.length === 0) return [];
	return reuseQueryEmbedding({ texts, config, ollamaGpu: process.env.OLLAMA_EMBED_NUM_GPU ?? null },
		signal ?? currentServerProviderHooks()?.signal, () => dispatchMemoryTexts(texts, config, signal));
}

async function dispatchMemoryTexts(texts: string[], config: MemoryEmbeddingConfig, signal?: AbortSignal): Promise<number[][]> {
	if (config.customUrl) return embedCustom(texts, config, signal);
	if (config.provider === 'local' || config.provider === 'local-hash') {
		return texts.map((text) => localHashEmbedding(text, config.dimensions));
	}
	if (config.provider === 'openai' || config.provider === 'openai-compatible' || config.provider === 'openrouter') {
		return embedOpenAiCompatible(texts, config, signal);
	}
	if (config.provider === 'ollama') {
		if (!getMtheriosAppConfig().localEmbeddingsEnabled) throw new Error('Local embeddings are off for this session.');
		return embedOllama(texts, config, signal);
	}
	throw new Error(`Unsupported memory embedding provider: ${config.provider}`);
}

export function localHashEmbedding(text: string, dimensions: number): number[] {
	const size = Math.max(1, Math.trunc(dimensions));
	const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	const features = [
		...tokens.map((token) => ({ value: token, weight: 1 })),
		...tokens.slice(1).map((token, index) => ({ value: `${tokens[index]} ${token}`, weight: 0.7 })),
	];
	const vector = new Float64Array(size);
	for (const feature of features) {
		const hash = createHash('sha256').update(feature.value).digest();
		const index = hash.readUInt32BE(0) % size;
		vector[index] += (hash[4] & 1 ? 1 : -1) * feature.weight;
	}
	let norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	if (!norm) {
		vector[0] = 1;
		norm = 1;
	}
	return Array.from(vector, (value) => value / norm);
}

export async function embedMemoryText(text: string, config = memoryEmbeddingConfig(), signal?: AbortSignal): Promise<number[]> {
	const [vector] = await embedMemoryTexts([text], config, signal);
	return vector;
}

export function validateMemoryEmbeddingVector(vector: number[], dimensions: number): number[] {
	if (!Array.isArray(vector) || vector.length !== dimensions) {
		throw new Error(`Memory embedding produced ${vector?.length ?? 0} dimensions, expected ${dimensions}.`);
	}
	const clean = vector.map((value) => Number(value));
	if (clean.some((value) => !Number.isFinite(value))) {
		throw new Error('Memory embedding vector contains non-numeric values.');
	}
	return clean;
}

async function embedCustom(texts: string[], config: MemoryEmbeddingConfig, signal?: AbortSignal): Promise<number[][]> {
	const data = await requestEmbedding(config.customUrl, { model: config.model, input: texts.length === 1 ? texts[0] : texts }, config, signal);
	return parseEmbeddingResponse(data, texts.length);
}

async function embedOpenAiCompatible(texts: string[], config: MemoryEmbeddingConfig, signal?: AbortSignal): Promise<number[][]> {
	const url = `${config.baseUrl.replace(/\/$/, '')}/embeddings`;
	const data = await requestEmbedding(url, { model: config.model, input: texts.length === 1 ? texts[0] : texts,
		...(config.requestDimensions === false ? {} : { dimensions: config.dimensions }) }, config, signal);
	return parseEmbeddingResponse(data, texts.length);
}

async function embedOllama(texts: string[], config: MemoryEmbeddingConfig, signal?: AbortSignal): Promise<number[][]> {
	const base = config.baseUrl.replace(/\/$/, '');
	const embedded = await requestEmbedding(`${base}/api/embed`, { model: config.model, input: texts.length === 1 ? texts[0] : texts,
		...(process.env.OLLAMA_EMBED_NUM_GPU ? { options: { num_gpu: Number(process.env.OLLAMA_EMBED_NUM_GPU) } } : {}) }, config, signal, true);
	if (embedded) return parseEmbeddingResponse(embedded, texts.length);

	if (texts.length > 1) {
		const vectors: number[][] = [];
		for (const text of texts) vectors.push((await embedOllama([text], config, signal))[0]);
		return vectors;
	}

	return parseEmbeddingResponse(await requestEmbedding(`${base}/api/embeddings`, { model: config.model, prompt: texts[0] }, config, signal), 1);
}

/** Query embeddings share the active run's durable reservation; background indexing has no run scope. */
async function requestEmbedding(url: string, body: Record<string, unknown>, config: MemoryEmbeddingConfig, inputSignal?: AbortSignal, allowHttpFallback = false): Promise<unknown> {
	const hooks = currentServerProviderHooks();
	const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(inputSignal ? [inputSignal] : []), ...(hooks?.signal ? [hooks.signal] : [])]);
	const serializedBody = JSON.stringify(body), startedAt = Date.now();
	const complete = hooks ? await hooks.beforeRequest({
		profile: { providerType: 'openai-compatible', apiKey: config.apiKey, baseUrl: config.baseUrl,
			customModels: [], fetchedModels: [], reasoningModels: [], hiddenModels: [], favoriteModels: [] },
		model: config.model, system: 'Evidence retrieval query embedding.', prompt: typeof body.input === 'string' ? body.input : typeof body.prompt === 'string' ? body.prompt : '', signal, maxRetries: 0,
	}, { body, serializedBody, inputTokens: countTokens(serializedBody), reservedOutputTokens: 0, contextWindowTokens: 32_000 }) : undefined;
	signal.throwIfAborted();
	const response = await fetch(url, { method: 'POST', headers: config.provider === 'ollama' && !config.customUrl ? { 'Content-Type': 'application/json' } : headers(config), body: serializedBody, signal });
	if (!response.ok && allowHttpFallback) return null;
	const data = await parseJsonResponse(response, 'Memory embedding');
	signal.throwIfAborted();
	const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
	const usage = normalizeServerProviderUsage(record, false);
	if (usage.totalTokens == null && typeof record.prompt_eval_count === 'number' && record.prompt_eval_count >= 0) {
		usage.requestTokens = record.prompt_eval_count; usage.inputTokens = record.prompt_eval_count; usage.responseTokens = 0; usage.totalTokens = record.prompt_eval_count;
	}
	await complete?.({ text: 'Query embedded.', model: config.model, endpoint: url, durationMs: Date.now() - startedAt,
		promptChars: serializedBody.length, responseChars: 0, finishReason: 'stop', usage });
	return data;
}

function headers(config: MemoryEmbeddingConfig): Record<string, string> {
	const result: Record<string, string> = { 'Content-Type': 'application/json' };
	if (config.apiKey) result.Authorization = `Bearer ${config.apiKey}`;
	return result;
}

async function parseJsonResponse(response: Response, label: string): Promise<unknown> {
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${label} failed (${response.status}): ${text.slice(0, 500)}`);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${label} returned non-JSON: ${text.slice(0, 500)}`);
	}
}

function parseEmbeddingResponse(data: unknown, expectedCount: number): number[][] {
	const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
	let vectors: unknown = null;
	if (Array.isArray(record.data)) vectors = record.data.map((row) => (row as { embedding?: unknown }).embedding);
	else if (Array.isArray(record.embeddings)) vectors = record.embeddings;
	else if (Array.isArray(record.embedding)) vectors = [record.embedding];

	if (!Array.isArray(vectors) || vectors.some((vector) => !Array.isArray(vector))) {
		throw new Error('Embedding response did not include vector data.');
	}
	if (vectors.length !== expectedCount) {
		throw new Error(`Embedding response returned ${vectors.length} vectors for ${expectedCount} inputs.`);
	}
	return vectors.map((vector) => (vector as unknown[]).map((value) => Number(value)));
}
