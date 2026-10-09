import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { askJevArgsSchema, hasAnsweredResearch } from './agentRuns';

it('keeps the planner-facing askJev limits aligned with validation', () => {
	const native = z.toJSONSchema(askJevArgsSchema) as unknown as { properties: {
		question: { maxLength: number }; options: { items: { properties: { description: { maxLength: number } } } } } };
	expect(native.properties.question.maxLength).toBe(300);
	expect(native.properties.options.items.properties.description.maxLength).toBe(200);
	const valid = { actorId: 'npc_1', question: 'Q'.repeat(300), options: [
		{ id: 'agree', description: 'A'.repeat(200) }, { id: 'decline', description: 'Decline politely.' } ] };
	expect(askJevArgsSchema.safeParse(valid).success).toBe(true);
	expect(askJevArgsSchema.safeParse({ ...valid, question: 'Q'.repeat(301) }).success).toBe(false);
	expect(askJevArgsSchema.safeParse({ ...valid, options: [{ ...valid.options[0], description: 'A'.repeat(201) }, valid.options[1]] }).success).toBe(false);
});

describe('GM Research handoff', () => {
	it('skips a second recall pass only for a source-linked answer', () => {
		const result = { tool: 'research', result: { status: 'answered', statements: [{
			statement: 'The harbor levy was agreed yesterday.', sourceId: 'entry_3', revision: '7',
		}] } };
		expect(hasAnsweredResearch([result])).toBe(true);
		expect(hasAnsweredResearch([{ ...result, result: { status: 'unavailable', statements: [] } }])).toBe(false);
		expect(hasAnsweredResearch([{ ...result, result: { status: 'insufficient_evidence', statements: [] } }])).toBe(false);
		expect(hasAnsweredResearch([{ ...result, result: { status: 'answered', statements: [] } }])).toBe(false);
		expect(hasAnsweredResearch([{ ...result, result: { status: 'answered', statements: [{ statement: 'Unsupported.' }] } }])).toBe(false);
	});
	it('does not repeat successful GM recall during turn commitment', () => {
		expect(hasAnsweredResearch([{ tool: 'recall', result: { entries: [{ id: 'entry_3', text: 'The levy changed.' }] } }])).toBe(true);
		expect(hasAnsweredResearch([{ tool: 'recall', result: { status: 'unavailable' } }])).toBe(false);
		expect(hasAnsweredResearch([{ tool: 'recall', command: 'campaign.entriesAround', result: { entries: [] } }])).toBe(false);
		expect(hasAnsweredResearch([{ tool: 'recall', command: 'campaign.page.read', result: { relativePath: 'raw/turns/1.md', content: '', missing: true } }])).toBe(false);
		expect(hasAnsweredResearch([{ tool: 'recall', command: 'campaign.entriesAround', result: { excerpt: '{"entries":[{"id":"entry_3"' } }])).toBe(false);
		expect(hasAnsweredResearch([{ tool: 'recall', command: 'world.actor.brief', result: { sourceIds: ['mara'], data: { actor: { id: 'mara', name: 'Mara' } }, unresolved: ['No relevant memory.'] } }])).toBe(false);
		expect(hasAnsweredResearch([{ tool: 'recall', command: 'world.search', result: { results: [{ recordId: 'port', name: 'Port' }] } }])).toBe(false);
		expect(hasAnsweredResearch([{ tool: 'recall', command: 'world.record.get', result: { record: { id: 'port', name: 'Port' } } }])).toBe(true);
	});
	it('requires fresh research after an accepted player answer or roll', () => {
		const recall = { tool: 'recall', command: 'campaign.entriesAround', result: { entries: [{ id: 'entry_3', text: 'The levy changed.' }] } };
		expect(hasAnsweredResearch([recall, { tool: 'askUserQuestion', result: { optionId: 'later' } }])).toBe(false);
		expect(hasAnsweredResearch([recall, { tool: 'askPlayerToRoll', result: { total: 7 } }, recall])).toBe(true);
	});
});
