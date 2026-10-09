import type { AgentTool } from '$lib/contracts/agentTools';

export const MAX_AGENT_TOOL_CALLS = 6;
const MAX_LOOKUPS = 3;
const lookups = new Set<AgentTool>(['read', 'list', 'search', 'research', 'recall']);
const retryableErrors = new Set([
	'GM tool planner returned no decision.',
	'The provider returned more than one tool call in one round.',
	'Tool call limit reached.',
	'Agent tool-round limit reached.',
	'actorId or name is required.',
	'GM tool planner returned invalid tool arguments after retry.',
	'GM tool planner reached its output limit before a complete decision.',
]);

export function isRetryablePlannerError(error: string): boolean {
	if (retryableErrors.has(error) || error.startsWith('Server LLM request timed out after ')) return true;
	try {
		const issues = JSON.parse(error);
		return Array.isArray(issues) && issues.length > 0 && issues.every(issue => issue.code === 'too_big'
			&& issue.path?.[0] === 'args' && (issue.path[1] === 'question'
				|| (issue.path[1] === 'options' && issue.path[3] === 'description')));
	} catch { return false; }
}

export function availablePlannerTools<T extends AgentTool>(enabled: readonly T[], priorTools: readonly string[]): T[] {
	if (priorTools.length >= MAX_AGENT_TOOL_CALLS) return [];
	const lookupCount = priorTools.filter(tool => lookups.has(tool as AgentTool)).length;
	return lookupCount >= MAX_LOOKUPS ? enabled.filter(tool => !lookups.has(tool)) : [...enabled];
}

/** Keep a provider's independent calls in order, within the run's existing budgets. */
export function selectPlannerToolCalls<T extends { tool: AgentTool; callId: string; args: unknown }>(
	calls: readonly T[], enabled: readonly AgentTool[], prior: readonly { tool: string; callId: string }[],
): T[] {
	const selected: T[] = [];
	const ids = new Set(prior.map(call => call.callId));
	let lookupCount = prior.filter(call => lookups.has(call.tool as AgentTool)).length;
	let usedNames = prior.some(call => call.tool === 'generateNames');
	let usedImage = prior.some(call => call.tool === 'generateImage' || call.tool === 'generateFileImage');
	for (const call of calls) {
		if (selected.length + prior.length >= MAX_AGENT_TOOL_CALLS) break;
		if (!enabled.includes(call.tool) || ids.has(call.callId)) continue;
		if (lookups.has(call.tool) && lookupCount >= MAX_LOOKUPS) continue;
		if (call.tool === 'generateNames' && usedNames) continue;
		if ((call.tool === 'generateImage' || call.tool === 'generateFileImage') && usedImage) continue;
		selected.push(call);
		ids.add(call.callId);
		if (lookups.has(call.tool)) lookupCount += 1;
		if (call.tool === 'generateNames') usedNames = true;
		if (call.tool === 'generateImage' || call.tool === 'generateFileImage') usedImage = true;
		// The next decision must see this result before any more tools are chosen.
		if (call.tool === 'askUserQuestion' || call.tool === 'askPlayerToRoll' || call.tool === 'update'
			|| (call.tool === 'map' && (call.args as { action?: string }).action === 'save')
			|| call.tool === 'generateImage' || call.tool === 'generateFileImage') break;
	}
	return selected;
}

export function sameAgentQuestion(
	a: { prompt: string; options: Array<{ id: string; label: string }>; allowCustom: boolean },
	b: { prompt: string; options: Array<{ id: string; label: string }>; allowCustom: boolean },
): boolean {
	return a.prompt === b.prompt && a.allowCustom === b.allowCustom
		&& JSON.stringify(a.options.toSorted((left, right) => left.id.localeCompare(right.id)))
			=== JSON.stringify(b.options.toSorted((left, right) => left.id.localeCompare(right.id)));
}

export function formatAgentObservations(rows: readonly unknown[], maxPerRow: number): string {
	return rows.map(row => {
		const serialized = JSON.stringify(row);
		if (serialized.length <= maxPerRow) return serialized;
		const observation = row as { tool?: string; callId?: string; result?: unknown };
		let excerpt = JSON.stringify(observation.result ?? null).slice(0, maxPerRow);
		let compact = JSON.stringify({ tool: observation.tool, callId: observation.callId, truncated: true, excerpt });
		while (compact.length > maxPerRow) {
			excerpt = excerpt.slice(0, -(compact.length - maxPerRow));
			compact = JSON.stringify({ tool: observation.tool, callId: observation.callId, truncated: true, excerpt });
		}
		return compact;
	}).join('\n');
}

export function formatNarratorObservations(rows: readonly unknown[], maxPerRow: number): string {
	// Canonical scene and Director facts reach narration through its selected, budgeted packet.
	// Raw GM reads can contain unselected plot cards or actor-only evidence.
	return formatAgentObservations(rows.filter(row => (row as { tool?: string })?.tool !== 'read'), maxPerRow);
}

export function currentJevObservations(rows: readonly unknown[]): { rows: unknown[]; playerIntervened: boolean } {
	const lastPlayerInteraction = rows.findLastIndex(row =>
		['askUserQuestion', 'askPlayerToRoll'].includes((row as { tool?: string })?.tool ?? ''));
	return { playerIntervened: lastPlayerInteraction >= 0,
		rows: rows.filter((row, index) => index > lastPlayerInteraction || (row as { tool?: string })?.tool !== 'askJev') };
}
