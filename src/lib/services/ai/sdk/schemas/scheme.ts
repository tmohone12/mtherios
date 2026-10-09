/**
 * Schema and tool contract for explicit player-declared plans.
 */

import { z } from 'zod';

export const schemeStageSchema = z.object({
	label: z.string(),
	hook: z.string(),
	condition: z.enum(['time', 'player-location', 'player-act', 'prerequisite']).default('time'),
	condition_payload: z.record(z.string(), z.unknown()).optional().default({}),
});

export type SchemeStageInput = z.infer<typeof schemeStageSchema>;

export const playerSchemeDeclareSchema = z.object({
	goal: z.string(),
	stages: z.array(schemeStageSchema).min(2).max(6),
	initial_pressure: z.number().min(0).max(100).optional().default(30),
});

export type PlayerSchemeDeclareArgs = z.infer<typeof playerSchemeDeclareSchema>;

export const DECLARE_PLAYER_SCHEME_TOOL = {
	type: 'function' as const,
	function: {
		name: 'declare_player_scheme',
		description:
			'Structure a free-text player plan ("I want to poison Lord Frey at the wedding") into ' +
			'a multi-stage scheme. Stages should be obstacles/prerequisites the player will work through.',
		parameters: {
			type: 'object',
			properties: {
				goal: { type: 'string', description: 'The player\'s endgame — what they\'re trying to achieve' },
				stages: {
					type: 'array',
					minItems: 2,
					maxItems: 6,
					items: {
						type: 'object',
						properties: {
							label: { type: 'string', description: 'Short label e.g. "acquire poison"' },
							hook: { type: 'string', description: 'The opportunity/obstacle the narrator should surface when this stage is current. NOT inevitable — something the player must work toward.' },
							condition: { type: 'string', enum: ['player-act', 'player-location', 'prerequisite', 'time'] },
							condition_payload: { type: 'object' },
						},
						required: ['label', 'hook'],
					},
				},
				initial_pressure: { type: 'number', minimum: 0, maximum: 100 },
			},
			required: ['goal', 'stages'],
		},
	},
};
