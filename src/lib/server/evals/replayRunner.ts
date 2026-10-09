export interface ReplayScenario {
	id: string;
	storyFixture: string;
	playerAction: string;
	mustIncludeFactIds: string[];
	mustNotRevealFactIds: string[];
	mustNotIncludeFactIds?: string[];
	expectedStatePatch?: unknown;
	maxCostUsd?: number;
}

export interface ReplayResult {
	includedFactIds?: string[];
	revealedFactIds?: string[];
	statePatch?: unknown;
	estimatedCostUsd?: number | null;
	cachedInputTokens?: number | null;
	timeToFirstTokenMs?: number | null;
	totalLatencyMs?: number | null;
}

export interface ReplayModelConfig {
	provider: 'openai' | 'openrouter';
	baseUrl: string;
	model: string;
	apiKey: string;
}

export function parseReplaySpendCap(value: unknown, modelRequested: boolean): number | null {
	if (value === undefined || value === null || value === '') {
		if (modelRequested) throw new Error('Opt-in model replay requires --max-cost-usd as an explicit positive spend cap');
		return null;
	}
	const cap = typeof value === 'number' ? value : Number(String(value));
	if (!Number.isFinite(cap) || cap <= 0) throw new Error('--max-cost-usd must be a positive finite number');
	if (!modelRequested) throw new Error('--max-cost-usd requires --model');
	return cap;
}

export function replayModelConfig(model: string | undefined, provider: string | undefined, apiKey: string | undefined): ReplayModelConfig | null {
	if (!model) {
		if (provider) throw new Error('--provider requires --model');
		return null;
	}
	if (!model.trim()) throw new Error('--model must not be empty');
	if (provider && provider !== 'openai' && provider !== 'openrouter') throw new Error('Replay model provider must be openai or openrouter');
	if (!apiKey?.trim()) throw new Error('Opt-in model replay requires REPLAY_MODEL_API_KEY; saved credentials are never used');
	return { provider: provider === 'openrouter' ? 'openrouter' : 'openai', baseUrl: provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1', model: model.trim(), apiKey };
}

export async function forwardReplayModelRequest(config: ReplayModelConfig, url: string, init: RequestInit | undefined, send: typeof fetch): Promise<{ response: Response; costUsd: number | null }> {
	if (url !== `${config.baseUrl}/chat/completions`) throw new Error('Replay blocked an unexpected model endpoint');
	const body = JSON.parse(String(init?.body ?? '{}'));
	if (body.model !== config.model || (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 4096))) throw new Error('Replay blocked an unexpected model or unbounded output request');
	if (new Headers(init?.headers).get('authorization') !== `Bearer ${config.apiKey}`) throw new Error('Replay model request must use its explicit API key');
	const response = await send(url, { ...init, body: JSON.stringify({ ...body, max_tokens: body.max_tokens ?? 4096 }) });
	const data = await response.clone().json().catch(() => null);
	const cost = asRecord(asRecord(data).usage).cost;
	return { response, costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null };
}

export interface ReplayFinding {
	passed: boolean;
	label: string;
	detail: string;
}

export interface ReplayScore {
	scenarioId: string;
	passed: boolean;
	findings: ReplayFinding[];
	metrics: {
		estimatedCostUsd: number | null;
		cachedInputTokens: number | null;
		timeToFirstTokenMs: number | null;
		totalLatencyMs: number | null;
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown, key: string, source: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${source}: ${key} must contain non-empty fact IDs`);
	return [...new Set(value.map((item: string) => item.trim()))];
}

function requiredString(record: Record<string, unknown>, key: string, source: string): string {
	const value = record[key];
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${source}: missing ${key}`);
	return value;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

export function parseReplayScenarioJsonl(text: string, source = 'scenario.jsonl'): ReplayScenario[] {
	return text.split(/\r?\n/).flatMap((line, index) => {
		const trimmed = line.trim();
		if (!trimmed) return [];
		const lineSource = `${source}:${index + 1}`;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			throw new Error(`${lineSource}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
		}
		const record = asRecord(parsed);
		const maxCostUsd = record.maxCostUsd;
		if (maxCostUsd !== undefined && (typeof maxCostUsd !== 'number' || !Number.isFinite(maxCostUsd) || maxCostUsd < 0)) throw new Error(`${lineSource}: invalid maxCostUsd`);
		return [{
			id: requiredString(record, 'id', lineSource),
			storyFixture: requiredString(record, 'storyFixture', lineSource),
			playerAction: requiredString(record, 'playerAction', lineSource),
			mustIncludeFactIds: stringArray(record.mustIncludeFactIds, 'mustIncludeFactIds', lineSource),
			mustNotRevealFactIds: stringArray(record.mustNotRevealFactIds, 'mustNotRevealFactIds', lineSource),
			...(record.mustNotIncludeFactIds !== undefined ? { mustNotIncludeFactIds: stringArray(record.mustNotIncludeFactIds, 'mustNotIncludeFactIds', lineSource) } : {}),
			expectedStatePatch: record.expectedStatePatch,
			maxCostUsd: typeof maxCostUsd === 'number' && Number.isFinite(maxCostUsd) ? maxCostUsd : undefined,
		}];
	});
}

export function scoreReplayResult(scenario: ReplayScenario, result: ReplayResult): ReplayScore {
	const included = new Set(result.includedFactIds ?? []);
	const revealed = new Set(result.revealedFactIds ?? []);
	const findings: ReplayFinding[] = [];

	for (const factId of scenario.mustIncludeFactIds) {
		const passed = included.has(factId);
		findings.push({ passed, label: `include fact ${factId}`, detail: passed ? 'found' : 'missing' });
	}

	for (const factId of scenario.mustNotRevealFactIds) {
		const passed = !revealed.has(factId);
		findings.push({ passed, label: `do not reveal fact ${factId}`, detail: passed ? 'hidden' : 'revealed' });
	}

	if (scenario.expectedStatePatch !== undefined) {
		// Compare observations from persisted state, not the canned provider patch.
		const passed = stableJson(result.statePatch) === stableJson(scenario.expectedStatePatch);
		findings.push({ passed, label: 'expected state patch', detail: passed ? 'matched' : 'different' });
	}

	if (scenario.maxCostUsd != null) {
		const cost = result.estimatedCostUsd;
		const passed = typeof cost === 'number' && cost <= scenario.maxCostUsd;
		findings.push({ passed, label: typeof cost === 'number' ? 'max cost' : 'max cost (unavailable)', detail: `${cost ?? 'unknown'}/${scenario.maxCostUsd}` });
	}
	for (const factId of scenario.mustNotIncludeFactIds ?? []) {
		const passed = !included.has(factId);
		findings.push({ passed, label: `exclude prompt fact ${factId}`, detail: passed ? 'excluded' : 'included' });
	}

	return {
		scenarioId: scenario.id,
		passed: findings.every((finding) => finding.passed),
		findings,
		metrics: {
			estimatedCostUsd: result.estimatedCostUsd ?? null,
			cachedInputTokens: result.cachedInputTokens ?? null,
			timeToFirstTokenMs: result.timeToFirstTokenMs ?? null,
			totalLatencyMs: result.totalLatencyMs ?? null,
		},
	};
}
