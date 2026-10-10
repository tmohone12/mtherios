import { createHash } from 'node:crypto';

export function embeddingConfig(overrides = {}) {
	const provider = overrides.provider ?? process.env.WIKI_EMBED_PROVIDER ?? 'openrouter';
	return {
		provider,
		model: overrides.model ?? process.env.WIKI_EMBED_MODEL ?? process.env.EMBED_MODEL ?? (provider === 'openrouter' ? 'openai/text-embedding-3-small' : 'nomic-embed-text'),
		ollamaUrl: overrides.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
		openAiBaseUrl: overrides.openAiBaseUrl ?? process.env.WIKI_EMBED_BASE_URL ?? process.env.OPENAI_BASE_URL ?? (provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'http://127.0.0.1:1234/v1'),
		openAiApiKey: overrides.openAiApiKey ?? process.env.WIKI_EMBED_API_KEY ?? (provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : '') ?? process.env.OPENAI_API_KEY ?? '',
		customUrl: overrides.customUrl ?? process.env.WIKI_EMBED_URL ?? '',
		batchSize: Number(overrides.batchSize ?? process.env.WIKI_EMBED_BATCH ?? 8),
		dimensions: Math.max(1, Number(overrides.dimensions ?? process.env.WIKI_EMBED_DIMENSIONS ?? 768)),
	};
}

export async function embedText(text, config = embeddingConfig()) {
	const vectors = await embedMany([text], config);
	return vectors[0];
}

export async function embedMany(texts, config = embeddingConfig()) {
	if (texts.length === 0) return [];
	if (process.env.MYTHENGINE_WIKI_EMBED_MAX_REQUESTS === '0' && (config.customUrl || !['local', 'local-hash'].includes(config.provider))) throw new Error('Scoped wiki query has no external embedding request allowance.');
	if (config.customUrl) return embedCustom(texts, config);
	if (config.provider === 'local' || config.provider === 'local-hash') return texts.map((text) => localHashEmbedding(text, config.dimensions));
	if (config.provider === 'openai' || config.provider === 'openai-compatible' || config.provider === 'openrouter') return embedOpenAi(texts, config);
	if (config.provider === 'ollama') {
		if (process.env.MYTHENGINE_LOCAL_EMBEDDINGS !== 'true' && process.env.MTHERIOS_LOCAL_EMBEDDINGS !== 'true') throw new Error('Local embeddings are off for this session.');
		return embedOllama(texts, config);
	}
	throw new Error(config.provider === 'disabled' ? 'Local embeddings are off for this session; exact search remains available.' : `Unsupported embedding provider: ${config.provider}`);
}

export function localHashEmbedding(text, dimensions = 768) {
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

async function embedCustom(texts, config) {
	const response = await fetch(config.customUrl, {
		method: 'POST',
		headers: headers(config),
		body: JSON.stringify({ model: config.model, input: texts.length === 1 ? texts[0] : texts }),
	});
	const data = await parseJsonResponse(response, 'custom embedding');
	return parseEmbeddingResponse(data, texts.length);
}

async function embedOpenAi(texts, config) {
	const url = `${config.openAiBaseUrl.replace(/\/$/, '')}/embeddings`;
	const response = await fetch(url, {
		method: 'POST',
		headers: headers(config),
		body: JSON.stringify({ model: config.model, input: texts.length === 1 ? texts[0] : texts }),
	});
	const data = await parseJsonResponse(response, 'OpenAI-compatible embedding');
	return parseEmbeddingResponse(data, texts.length);
}

async function embedOllama(texts, config) {
	const base = config.ollamaUrl.replace(/\/$/, '');
	const embedResponse = await fetch(`${base}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: config.model, input: texts.length === 1 ? texts[0] : texts,
			...(process.env.OLLAMA_EMBED_NUM_GPU ? { options: { num_gpu: Number(process.env.OLLAMA_EMBED_NUM_GPU) } } : {}) }),
	});

	if (embedResponse.ok) {
		const data = await embedResponse.json();
		return parseEmbeddingResponse(data, texts.length);
	}

	if (texts.length > 1) {
		const vectors = [];
		for (const text of texts) vectors.push(await embedOllama([text], config).then((rows) => rows[0]));
		return vectors;
	}

	const legacyResponse = await fetch(`${base}/api/embeddings`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: config.model, prompt: texts[0] }),
	});
	const data = await parseJsonResponse(legacyResponse, 'Ollama embedding');
	return parseEmbeddingResponse(data, 1);
}

function headers(config) {
	const result = { 'Content-Type': 'application/json' };
	if (config.openAiApiKey) result.Authorization = `Bearer ${config.openAiApiKey}`;
	return result;
}

async function parseJsonResponse(response, label) {
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

function parseEmbeddingResponse(data, expectedCount) {
	let vectors = null;
	if (Array.isArray(data.data)) vectors = data.data.map((row) => row.embedding);
	else if (Array.isArray(data.embeddings)) vectors = data.embeddings;
	else if (Array.isArray(data.embedding)) vectors = [data.embedding];

	if (!Array.isArray(vectors) || vectors.some((vector) => !Array.isArray(vector))) {
		throw new Error(`Embedding response did not include vector data.`);
	}
	if (vectors.length !== expectedCount) {
		throw new Error(`Embedding response returned ${vectors.length} vectors for ${expectedCount} inputs.`);
	}
	return vectors;
}

export async function embedInBatches(texts, config = embeddingConfig(), onBatch = () => {}) {
	const vectors = [];
	const batchSize = Math.max(1, config.batchSize || 1);
	for (let i = 0; i < texts.length; i += batchSize) {
		const batch = texts.slice(i, i + batchSize);
		const embedded = await embedMany(batch, config);
		vectors.push(...embedded);
		onBatch({ done: vectors.length, total: texts.length });
	}
	return vectors;
}
