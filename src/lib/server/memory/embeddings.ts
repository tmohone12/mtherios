import { getServerMemoryConfig } from '$lib/server/env';

export interface MemoryEmbeddingConfig {
	provider: string;
	model: string;
	baseUrl: string;
	apiKey: string;
	customUrl: string;
	batchSize: number;
	dimensions: number;
}

export function memoryEmbeddingConfig(): MemoryEmbeddingConfig | null {
	const config = getServerMemoryConfig();
	if (!config.embeddingProvider || !config.embeddingModel) return null;
	const provider = config.embeddingProvider;
	const baseUrl = config.embeddingBaseUrl
		?? (provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234/v1');
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
	return [
		node.title,
		node.summary,
		keywords ? `Keywords: ${keywords}` : null,
		node.content,
	].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n\n');
}

export async function embedMemoryTexts(
	texts: string[],
	config = memoryEmbeddingConfig(),
): Promise<number[][]> {
	if (!config) throw new Error('Memory embeddings are not configured.');
	if (texts.length === 0) return [];
	if (config.customUrl) return embedCustom(texts, config);
	if (config.provider === 'openai' || config.provider === 'openai-compatible') {
		return embedOpenAiCompatible(texts, config);
	}
	if (config.provider === 'ollama') return embedOllama(texts, config);
	throw new Error(`Unsupported memory embedding provider: ${config.provider}`);
}

export async function embedMemoryText(text: string, config = memoryEmbeddingConfig()): Promise<number[]> {
	const [vector] = await embedMemoryTexts([text], config);
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

async function embedCustom(texts: string[], config: MemoryEmbeddingConfig): Promise<number[][]> {
	const response = await fetch(config.customUrl, {
		method: 'POST',
		headers: headers(config),
		body: JSON.stringify({ model: config.model, input: texts.length === 1 ? texts[0] : texts }),
	});
	return parseEmbeddingResponse(await parseJsonResponse(response, 'custom memory embedding'), texts.length);
}

async function embedOpenAiCompatible(texts: string[], config: MemoryEmbeddingConfig): Promise<number[][]> {
	const url = `${config.baseUrl.replace(/\/$/, '')}/embeddings`;
	const response = await fetch(url, {
		method: 'POST',
		headers: headers(config),
		body: JSON.stringify({ model: config.model, input: texts.length === 1 ? texts[0] : texts }),
	});
	return parseEmbeddingResponse(await parseJsonResponse(response, 'OpenAI-compatible memory embedding'), texts.length);
}

async function embedOllama(texts: string[], config: MemoryEmbeddingConfig): Promise<number[][]> {
	const base = config.baseUrl.replace(/\/$/, '');
	const embedResponse = await fetch(`${base}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: config.model, input: texts.length === 1 ? texts[0] : texts }),
	});

	if (embedResponse.ok) {
		return parseEmbeddingResponse(await embedResponse.json(), texts.length);
	}

	if (texts.length > 1) {
		const vectors: number[][] = [];
		for (const text of texts) vectors.push((await embedOllama([text], config))[0]);
		return vectors;
	}

	const legacyResponse = await fetch(`${base}/api/embeddings`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: config.model, prompt: texts[0] }),
	});
	return parseEmbeddingResponse(await parseJsonResponse(legacyResponse, 'Ollama memory embedding'), 1);
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
