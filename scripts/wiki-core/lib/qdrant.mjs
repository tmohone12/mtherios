export function qdrantConfig(overrides = {}) {
	return {
		url: overrides.url ?? process.env.QDRANT_URL ?? 'http://127.0.0.1:6333',
		collection: overrides.collection ?? process.env.QDRANT_COLLECTION ?? process.env.COLLECTION ?? 'mtherios_wiki',
	};
}

export async function ensureCollection(vectorSize, config = qdrantConfig(), { recreate = false } = {}) {
	if (recreate) {
		await requestQdrant(`/collections/${encodeURIComponent(config.collection)}`, {
			method: 'DELETE',
			allow404: true,
			config,
		});
	}

	const current = await requestQdrant(`/collections/${encodeURIComponent(config.collection)}`, {
		method: 'GET',
		allow404: true,
		config,
	});

	if (current?.result) {
		const existingSize = current.result.config?.params?.vectors?.size;
		if (existingSize && existingSize !== vectorSize) {
			throw new Error(
				`Qdrant collection "${config.collection}" has vector size ${existingSize}, but embeddings produced ${vectorSize}. ` +
				`Use --recreate or choose another QDRANT_COLLECTION.`,
			);
		}
		return;
	}

	await requestQdrant(`/collections/${encodeURIComponent(config.collection)}`, {
		method: 'PUT',
		body: {
			vectors: {
				size: vectorSize,
				distance: 'Cosine',
			},
		},
		config,
	});
}

export async function upsertPoints(points, config = qdrantConfig(), batchSize = 64) {
	for (let i = 0; i < points.length; i += batchSize) {
		const batch = points.slice(i, i + batchSize);
		await requestQdrant(`/collections/${encodeURIComponent(config.collection)}/points?wait=true`, {
			method: 'PUT',
			body: { points: batch },
			config,
		});
	}
}

export async function searchPoints(vector, config = qdrantConfig(), { limit = 8, scoreThreshold = null } = {}) {
	const body = {
		vector,
		limit,
		with_payload: true,
		with_vector: false,
	};
	if (scoreThreshold != null) body.score_threshold = scoreThreshold;

	const data = await requestQdrant(`/collections/${encodeURIComponent(config.collection)}/points/search`, {
		method: 'POST',
		body,
		config,
	});
	return data.result ?? [];
}

async function requestQdrant(path, { method = 'GET', body = null, allow404 = false, config = qdrantConfig() } = {}) {
	const url = `${config.url.replace(/\/$/, '')}${path}`;
	const response = await fetch(url, {
		method,
		headers: body ? { 'Content-Type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});

	const text = await response.text();
	if (response.status === 404 && allow404) return null;
	if (!response.ok) {
		throw new Error(`Qdrant ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
	}
	return text ? JSON.parse(text) : null;
}
