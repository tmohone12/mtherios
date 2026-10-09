import { resolveRuntimeOptions } from '../../runtime-config.mjs';

import os from 'node:os';
import path from 'node:path';
import { withQdrantCollectionLock } from './collection-lock.mjs';

export { withQdrantCollectionLock } from './collection-lock.mjs';

export function qdrantConfig(overrides = {}) {
	const runtime = resolveRuntimeOptions();
	return {
		url: overrides.url ?? runtime.qdrantUrl,
		collection: overrides.collection ?? runtime.qdrantCollection,
		lockDir: overrides.lockDir ?? process.env.MYTHENGINE_QDRANT_LOCK_DIR ?? process.env.MTHERIOS_QDRANT_LOCK_DIR ?? path.join(os.tmpdir(), 'mythengine-qdrant-sync-locks'),
		lockTimeoutMs: overrides.lockTimeoutMs ?? 5 * 60_000,
		lockStaleMs: overrides.lockStaleMs ?? 30 * 60_000,
		lockPollMs: overrides.lockPollMs ?? 100,
	};
}

async function ensureCollectionUnlocked(vectorSize, config) {
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
				`Choose another QDRANT_COLLECTION or rebuild both wiki and canonical indexes together.`,
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

export async function ensureCollection(vectorSize, config = qdrantConfig()) {
	return withQdrantCollectionLock(config, () => ensureCollectionUnlocked(vectorSize, config));
}

async function syncWikiPointsUnlocked(points, config, batchSize) {
	await upsertPoints(points, config, batchSize);

	const currentIds = new Set(points.map((point) => point.id));
	const obsoleteIds = (await listWikiPoints(config))
		.filter((point) => !currentIds.has(point.id))
		.map((point) => point.id);

	for (let i = 0; i < obsoleteIds.length; i += batchSize) {
		await requestQdrant(`/collections/${encodeURIComponent(config.collection)}/points/delete?wait=true`, {
			method: 'POST',
			body: { points: obsoleteIds.slice(i, i + batchSize) },
			config,
		});
	}

	return { upserted: points.length, removed: obsoleteIds.length };
}

export async function syncWikiPoints(points, config = qdrantConfig(), batchSize = 64) {
	return withQdrantCollectionLock(config, () => syncWikiPointsUnlocked(points, config, batchSize));
}

async function syncWikiIndexUnlocked(vectorSize, points, config, batchSize) {
	await ensureCollectionUnlocked(vectorSize, config);
	return syncWikiPointsUnlocked(points, config, batchSize);
}

export async function syncWikiIndex(vectorSize, points, config = qdrantConfig(), batchSize = 64) {
	return withQdrantCollectionLock(config, () => syncWikiIndexUnlocked(vectorSize, points, config, batchSize));
}

export async function prepareAndSyncWikiIndex(prepare, config = qdrantConfig(), batchSize = 64) {
	return withQdrantCollectionLock(config, async () => {
		const prepared = await prepare();
		if (!prepared.vectorSize) return syncWikiPointsUnlocked(prepared.points ?? [], config, batchSize);
		return syncWikiIndexUnlocked(prepared.vectorSize, prepared.points ?? [], config, batchSize);
	});
}

async function listWikiPoints(config) {
	const points = [];
	let offset;

	do {
		const body = {
			limit: 256,
			with_payload: true,
			with_vector: false,
			filter: wikiPointFilter(),
		};
		if (offset != null) body.offset = offset;

		const data = await requestQdrant(`/collections/${encodeURIComponent(config.collection)}/points/scroll`, {
			method: 'POST',
			body,
			allow404: true,
			config,
		});
		if (!data) break;

		for (const point of data.result?.points ?? []) {
			if (point?.id != null && point.payload?.kind !== 'canonical_record') points.push(point);
		}
		offset = data.result?.next_page_offset;
	} while (offset != null);

	return points;
}

function wikiPointFilter() {
	return {
		must_not: [{ key: 'kind', match: { value: 'canonical_record' } }],
	};
}

export async function searchPoints(vector, config = qdrantConfig(), { limit = 8, scoreThreshold = null, layer = null } = {}) {
	const body = {
		vector,
		limit,
		with_payload: true,
		with_vector: false,
		filter: wikiPointFilter(),
	};
	if (scoreThreshold != null) body.score_threshold = scoreThreshold;
	if (layer) body.filter = { ...wikiPointFilter(), must: [{ key: 'layer', match: { value: layer } }] };

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
