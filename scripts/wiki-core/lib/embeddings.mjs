export function embeddingConfig(overrides = {}) {
	return {
		provider: overrides.provider ?? process.env.WIKI_EMBED_PROVIDER ?? 'ollama',
		model: overrides.model ?? process.env.WIKI_EMBED_MODEL ?? process.env.EMBED_MODEL ?? 'nomic-embed-text',
		ollamaUrl: overrides.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
		openAiBaseUrl: overrides.openAiBaseUrl ?? process.env.WIKI_EMBED_BASE_URL ?? process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:1234/v1',
		openAiApiKey: overrides.openAiApiKey ?? process.env.WIKI_EMBED_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
		customUrl: overrides.customUrl ?? process.env.WIKI_EMBED_URL ?? '',
		batchSize: Number(overrides.batchSize ?? process.env.WIKI_EMBED_BATCH ?? 8),
	};
}

export async function embedText(text, config = embeddingConfig()) {
	const vectors = await embedMany([text], config);
	return vectors[0];
}

export async function embedMany(texts, config = embeddingConfig()) {
	if (texts.length === 0) return [];
	if (config.customUrl) return embedCustom(texts, config);
	if (config.provider === 'openai' || config.provider === 'openai-compatible') return embedOpenAi(texts, config);
	return embedOllama(texts, config);
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
		body: JSON.stringify({ model: config.model, input: texts.length === 1 ? texts[0] : texts }),
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
