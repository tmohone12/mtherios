/**
 * Live model lists from provider APIs, shared by the settings UI and the server. Browser
 * requests to Anthropic go through /api/anthropic (the Vite dev proxy or the production
 * route) unless a custom base URL is set, because api.anthropic.com rejects cross-origin
 * browser requests; the server calls the API directly.
 */
export const ANTHROPIC_PROXY_URL = '/api/anthropic';
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
/** Pages of the Anthropic model list to follow; each page holds up to 1000 models. */
const MAX_MODEL_PAGES = 10;

/** Auth headers: setup tokens (sk-ant-oat-*) use a Bearer token with the OAuth beta; API keys use x-api-key. */
export function anthropicHeaders(apiKey: string): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'anthropic-version': '2023-06-01',
	};
	if (apiKey.startsWith('sk-ant-oat-')) {
		headers['Authorization'] = `Bearer ${apiKey}`;
		headers['anthropic-beta'] = 'oauth-2025-04-20';
	} else if (apiKey) {
		headers['x-api-key'] = apiKey;
	}
	return headers;
}

async function failure(res: Response): Promise<Error> {
	const body = await res.text().catch(() => '');
	return new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 150)}` : ''}`);
}

/**
 * Model IDs available to this key from GET /v1/models, newest first as the API returns them.
 * The endpoint pages its results (20 by default), so this asks for full pages and follows
 * `has_more` / `last_id` until the list ends.
 */
export async function fetchAnthropicModels(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
	const root = (baseUrl || ANTHROPIC_PROXY_URL).replace(/\/+$/, '');
	const ids: string[] = [];
	let afterId: string | null = null;
	for (let page = 0; page < MAX_MODEL_PAGES; page++) {
		const query = new URLSearchParams({ limit: '1000' });
		if (afterId) query.set('after_id', afterId);
		const res = await fetchImpl(`${root}/v1/models?${query}`, { headers: anthropicHeaders(apiKey) });
		if (!res.ok) throw await failure(res);
		const data = await res.json() as { data?: Array<{ id?: unknown }>; has_more?: boolean; last_id?: string | null };
		for (const model of Array.isArray(data.data) ? data.data : []) {
			if (typeof model?.id === 'string' && model.id) ids.push(model.id);
		}
		if (!data.has_more || !data.last_id || data.last_id === afterId) break;
		afterId = data.last_id;
	}
	return Array.from(new Set(ids));
}

/**
 * Fetch the live model list from an OpenAI-compatible /models endpoint.
 * Returns deduplicated, sorted model IDs. Handles the standard
 * { data: [{ id }] } shape plus a couple of common variants.
 */
export async function fetchOpenAICompatibleModels(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
	const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, { headers });
	if (!res.ok) throw await failure(res);
	const data = await res.json();
	const list: unknown[] = Array.isArray(data?.data)
		? data.data
		: Array.isArray(data?.models)
			? data.models
			: Array.isArray(data)
				? data
				: [];
	const ids = list
		.map((m) => (typeof m === 'string' ? m : (m as { id?: unknown; name?: unknown })?.id ?? (m as { name?: unknown })?.name))
		.filter((id): id is string => typeof id === 'string' && id.length > 0);
	return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}
