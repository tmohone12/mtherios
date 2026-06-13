import {
	engineCommandResponseSchema,
	llmServiceSettingSchema,
	type LlmServiceSetting,
} from '$lib/contracts/engine';

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(body: unknown, fallback: string): string {
	const record = asRecord(body);
	return typeof record.error === 'string' && record.error.trim()
		? record.error
		: fallback;
}

async function parseEngineResponse(response: Response, fallback: string): Promise<LlmServiceSetting[]> {
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(errorMessage(body, `${fallback}: HTTP ${response.status}`));
	}
	const directResult = asRecord(body);
	if (Array.isArray(directResult.settings)) {
		return directResult.settings.map((row) => llmServiceSettingSchema.parse(row));
	}
	const command = engineCommandResponseSchema.parse(body);
	if (command.status !== 'succeeded') {
		throw new Error(command.error ?? fallback);
	}
	const result = asRecord(command.result);
	const rows = Array.isArray(result.settings) ? result.settings : [];
	return rows.map((row) => llmServiceSettingSchema.parse(row));
}

export function normalizePromptOverride(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	return value.trim() ? value : null;
}

export function promptOverrideDrafts(rows: LlmServiceSetting[]): Record<string, string> {
	return Object.fromEntries(rows.map((row) => [row.serviceId, row.systemPromptOverride ?? '']));
}

export function buildPromptOverridePatch(
	rows: LlmServiceSetting[],
	drafts: Record<string, string>,
): LlmServiceSetting[] {
	const rowsByService = new Map(rows.map((row) => [row.serviceId, row]));
	const patch: LlmServiceSetting[] = [];
	for (const [serviceId, draft] of Object.entries(drafts)) {
		const row = rowsByService.get(serviceId);
		if (!row) continue;
		const nextPrompt = normalizePromptOverride(draft);
		if (nextPrompt === normalizePromptOverride(row.systemPromptOverride)) continue;
		patch.push({
			...row,
			systemPromptOverride: nextPrompt,
		});
	}
	return patch;
}

export async function loadTerminalPromptSettings(fetchImpl: typeof fetch = fetch): Promise<LlmServiceSetting[]> {
	const response = await fetchImpl('/api/settings/llm', { method: 'GET' });
	return parseEngineResponse(response, 'Failed to load terminal prompt settings');
}

export async function saveTerminalPromptOverrides(
	rows: LlmServiceSetting[],
	drafts: Record<string, string>,
	fetchImpl: typeof fetch = fetch,
): Promise<LlmServiceSetting[]> {
	const patch = buildPromptOverridePatch(rows, drafts);
	if (patch.length === 0) return rows;
	const response = await fetchImpl('/api/settings/llm', {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ settings: patch }),
	});
	return parseEngineResponse(response, 'Failed to save terminal prompt settings');
}
