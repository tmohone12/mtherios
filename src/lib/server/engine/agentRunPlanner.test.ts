import { describe, expect, it } from 'vitest';
import { availablePlannerTools, currentJevObservations, formatAgentObservations, formatNarratorObservations, isRetryablePlannerError, MAX_AGENT_TOOL_CALLS, sameAgentQuestion, selectPlannerToolCalls } from './agentRunPlanner';
import { actorBriefArgsSchema } from './gmTools';

describe('GM planner tool budget', () => {
	it('stops repeated lookups while preserving player interactions and the final turn', () => {
		const tools = ['read', 'list', 'search', 'research', 'askUserQuestion', 'askPlayerToRoll', 'gmRollDice'] as const;
		expect(availablePlannerTools(tools, ['search', 'read'])).toContain('research');
		expect(availablePlannerTools(tools, ['search', 'read', 'search'])).toEqual(['askUserQuestion', 'askPlayerToRoll', 'gmRollDice']);
		expect(availablePlannerTools(tools, Array(MAX_AGENT_TOOL_CALLS).fill('read'))).toEqual([]);
	});
	it('requires an actor before dispatching a world.actor.brief lookup', () => {
		expect(actorBriefArgsSchema.safeParse({}).success).toBe(false);
		expect(actorBriefArgsSchema.safeParse({ name: 'Mira' }).success).toBe(true);
	});
	it('retries only failures that occurred before narration', () => {
		expect(isRetryablePlannerError('GM tool planner returned no decision.')).toBe(true);
		expect(isRetryablePlannerError('The provider returned more than one tool call in one round.')).toBe(true);
		expect(isRetryablePlannerError('Server LLM request timed out after 45000ms')).toBe(true);
		expect(isRetryablePlannerError('actorId or name is required.')).toBe(true);
		expect(isRetryablePlannerError('GM tool planner returned invalid tool arguments after retry.')).toBe(true);
		expect(isRetryablePlannerError('GM tool planner reached its output limit before a complete decision.')).toBe(true);
		expect(isRetryablePlannerError(JSON.stringify([{ code: 'too_big', path: ['args', 'question'] },
			{ code: 'too_big', path: ['args', 'options', 2, 'description'] }]))).toBe(true);
		expect(isRetryablePlannerError(JSON.stringify([{ code: 'too_big', path: ['args', 'changes'] }]))).toBe(false);
		expect(isRetryablePlannerError('Narration provider timed out.')).toBe(false);
	});
	it('accepts independent native calls in provider order and applies budgets within the batch', () => {
		const calls = [
			{ tool: 'read', callId: 'scene', args: {} },
			{ tool: 'search', callId: 'lore', args: {} },
			{ tool: 'list', callId: 'actors', args: {} },
			{ tool: 'research', callId: 'history', args: {} },
		] as const;
		expect(selectPlannerToolCalls(calls, ['read', 'search', 'list', 'research'], [])
			.map(call => call.callId)).toEqual(['scene', 'lore', 'actors']);
		expect(selectPlannerToolCalls(calls, ['read', 'search', 'list', 'research'], [{ tool: 'read', callId: 'old' }, { tool: 'search', callId: 'older' }])
			.map(call => call.callId)).toEqual(['scene']);
	});
	it('stops a batch at a player interaction or state change and ignores repeated calls', () => {
		const tools = ['read', 'askUserQuestion', 'update', 'search', 'generateNames', 'generateImage'] as const;
		const calls = [
			{ tool: 'read', callId: 'prior', args: {} },
			{ tool: 'read', callId: 'scene', args: {} },
			{ tool: 'askUserQuestion', callId: 'choice', args: {} },
			{ tool: 'search', callId: 'stale-after-choice', args: {} },
		] as const;
		expect(selectPlannerToolCalls(calls, tools, [{ tool: 'read', callId: 'prior' }]).map(call => call.callId)).toEqual(['scene', 'choice']);
		expect(selectPlannerToolCalls([
			{ tool: 'update', callId: 'edit', args: {} }, { tool: 'search', callId: 'stale-after-edit', args: {} },
		], tools, []).map(call => call.callId)).toEqual(['edit']);
		expect(selectPlannerToolCalls([
			{ tool: 'generateNames', callId: 'names-1', args: {} }, { tool: 'generateNames', callId: 'names-2', args: {} },
			{ tool: 'generateImage', callId: 'image-1', args: {} }, { tool: 'generateImage', callId: 'image-2', args: {} },
		], tools, []).map(call => call.callId)).toEqual(['names-1', 'image-1']);
	});
	it('does not reuse an answer for a different question with the same option IDs', () => {
		const first = { prompt: 'Open the gate?', options: [{ id: 'yes', label: 'Open it' }, { id: 'no', label: 'Leave it shut' }], allowCustom: false };
		expect(sameAgentQuestion(first, { ...first, prompt: 'Cross the bridge?' })).toBe(false);
		expect(sameAgentQuestion(first, { ...first, options: [{ id: 'no', label: 'Leave it shut' }, { id: 'yes', label: 'Open it' }] })).toBe(true);
		expect(sameAgentQuestion(first, { ...first, options: [{ id: 'yes', label: 'Unlock it' }, { id: 'no', label: 'Leave it shut' }] })).toBe(false);
	});
	it('retains the later player answer after a large tool result', () => {
		const formatted = formatAgentObservations([
			{ tool: 'research', callId: 'history', result: { text: 'history '.repeat(3_000) } },
			{ tool: 'askUserQuestion', callId: 'gate', result: { optionId: 'yes' } },
		], 1_800);
		const lines = formatted.split('\n').map(line => JSON.parse(line));
		expect(lines[0].truncated).toBe(true);
		expect(lines[1]).toEqual({ tool: 'askUserQuestion', callId: 'gate', result: { optionId: 'yes' } });
		expect(formatted.length).toBeLessThan(3_600);
	});
	it('keeps raw GM state reads in the planner and out of narrator observations', () => {
		const rows = [
			{ tool: 'read', callId: 'board', result: { secretCard: 'Unselected invasion' } },
			{ tool: 'research', callId: 'source', result: { statement: 'The quay charges a fee.' } },
		];
		expect(formatAgentObservations(rows, 2_800)).toContain('Unselected invasion');
		expect(formatNarratorObservations(rows, 2_800)).toBe(JSON.stringify(rows[1]));
	});
	it('drops Jev advice made before the latest accepted player interaction', () => {
		const rows = [
			{ tool: 'askJev', result: { optionId: 'old_choice' } },
			{ tool: 'askUserQuestion', result: { optionId: 'decline' } },
			{ tool: 'askJev', result: { optionId: 'current_choice' } },
			{ tool: 'askPlayerToRoll', result: { total: 4 } },
			{ tool: 'research', result: { sourceId: 'source_1' } },
		];
		const current = currentJevObservations(rows);
		expect(current.playerIntervened).toBe(true);
		expect(current.rows).toEqual([rows[1], rows[3], rows[4]]);
		expect(formatNarratorObservations(current.rows, 2_800)).not.toContain('old_choice');
		expect(currentJevObservations(rows.slice(0, 3)).rows).toEqual([rows[1], rows[2]]);
		expect(currentJevObservations(rows.slice(0, 1))).toEqual({ rows: rows.slice(0, 1), playerIntervened: false });
	});
});
