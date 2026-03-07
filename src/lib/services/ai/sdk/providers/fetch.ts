/**
 * Fetch Adapter — Mtherios
 * Pure browser fetch with timeout support. No Tauri dependencies.
 */

export function createTimeoutFetch(
	timeoutMs = 360000,
	_serviceId?: string,
	_debugId?: string,
) {
	const customFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

		// Chain external abort signal
		init?.signal?.addEventListener('abort', () => controller.abort());

		try {
			const response = await fetch(input, { ...init, signal: controller.signal });

			// For streaming responses, return directly
			if (!response.headers.get('content-type')?.includes('application/json')) {
				return response;
			}

			// For JSON responses, patch missing usage fields
			const text = await response.text();
			try {
				const json = JSON.parse(text);
				if (!json.usage) {
					json.usage = { input_tokens: 0, output_tokens: 0 };
				} else if (typeof json.usage === 'object') {
					json.usage.input_tokens ??= json.usage.prompt_tokens ?? 0;
					json.usage.output_tokens ??= json.usage.completion_tokens ?? 0;
				}
				return new Response(JSON.stringify(json), {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			} catch {
				return new Response(text, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			}
		} finally {
			clearTimeout(timeoutId);
		}
	};
	return customFetch as unknown as typeof globalThis.fetch;
}
