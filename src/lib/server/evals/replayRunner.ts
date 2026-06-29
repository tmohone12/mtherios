export interface ReplayScenario {
	id: string;
	storyFixture: string;
	playerAction: string;
	mustIncludeFactIds: string[];
	mustNotRevealFactIds: string[];
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

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
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
		return [{
			id: requiredString(record, 'id', lineSource),
			storyFixture: requiredString(record, 'storyFixture', lineSource),
			playerAction: requiredString(record, 'playerAction', lineSource),
			mustIncludeFactIds: stringArray(record.mustIncludeFactIds),
			mustNotRevealFactIds: stringArray(record.mustNotRevealFactIds),
			expectedStatePatch: record.expectedStatePatch,
			maxCostUsd: typeof maxCostUsd === 'number' && Number.isFinite(maxCostUsd) ? maxCostUsd : undefined,
		}];
	});
}

export function scoreReplayResult(scenario: ReplayScenario, result: ReplayResult): ReplayScore {
	const included = new Set(result.includedFactIds ?? []);
	const revealed = new Set([...(result.revealedFactIds ?? []), ...(result.includedFactIds ?? [])]);
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
		const passed = stableJson(result.statePatch) === stableJson(scenario.expectedStatePatch);
		findings.push({ passed, label: 'expected state patch', detail: passed ? 'matched' : 'different' });
	}

	if (scenario.maxCostUsd != null) {
		const cost = result.estimatedCostUsd;
		const passed = typeof cost === 'number' && cost <= scenario.maxCostUsd;
		findings.push({ passed, label: 'max cost', detail: `${cost ?? 'unknown'}/${scenario.maxCostUsd}` });
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
