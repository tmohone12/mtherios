import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { gmToolDefinitions } from '$lib/server/engine/agentRuns';
import { anthropicInputSchema } from './provider';

describe('Anthropic tool input schemas', () => {
	it('gives every GM tool an object schema with no top-level union', () => {
		for (const tool of Object.values(gmToolDefinitions)) {
			const schema = anthropicInputSchema(tool.parameters);
			expect(schema.type, tool.name).toBe('object');
			for (const keyword of ['anyOf', 'oneOf', 'allOf']) expect(schema, `${tool.name} ${keyword}`).not.toHaveProperty(keyword);
		}
	});

	it('merges argument forms, requiring only what every form requires and naming the forms', () => {
		const args = z.union([
			z.object({ command: z.enum(['campaign.status', 'world.scene.check']), args: z.record(z.string(), z.unknown()).default({}) }).strict(),
			z.object({ kind: z.literal('source'), sourceRef: z.string(), command: z.string().optional() }).strict(),
		]);
		const schema = anthropicInputSchema(z.toJSONSchema(args, { io: 'input' }) as Record<string, unknown>);
		expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
		expect(Object.keys(schema.properties as object)).toEqual(['command', 'args', 'kind', 'sourceRef']);
		// Required in only one form each, so required in neither.
		expect(schema).not.toHaveProperty('required');
		// Two different command shapes are both allowed.
		expect((schema.properties as Record<string, { anyOf?: unknown[] }>).command.anyOf).toHaveLength(2);
		expect(schema.description).toBe('Use exactly one argument form: {command, args?} or {kind: "source", sourceRef, command?}.');
	});

	it('leaves a plain object schema unchanged', () => {
		const schema = { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] };
		expect(anthropicInputSchema(schema)).toBe(schema);
	});
});
