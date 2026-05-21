/**
 * Scheme schemas — antagonist plot tracking + player-declared plans.
 *
 * The `manage_schemes` tool is the LLM-facing surface for the evaluator
 * pass. The model can:
 *   - create new schemes when player actions warrant antagonist response
 *   - escalate an existing scheme (advance stage, raise pressure)
 *   - mark schemes as foiled/resolved when player neutralizes them
 *
 * Stages, conditions, and pressures are all bounded — see Scheme types
 * for the canonical contract. Owner resolution (faction-or-character) is
 * by display name so the model doesn't need to track lorebook ids.
 */

import { z } from 'zod';

export const schemeStageSchema = z.object({
	label: z.string(),
	hook: z.string(),
	condition: z.enum(['time', 'player-location', 'player-act', 'prerequisite']).default('time'),
	condition_payload: z.record(z.string(), z.unknown()).optional().default({}),
});

export type SchemeStageInput = z.infer<typeof schemeStageSchema>;

export const schemeCreateSchema = z.object({
	owner_name: z.string(),
	owner_type: z.enum(['faction', 'character']),
	goal: z.string(),
	trigger: z.string(),
	stages: z.array(schemeStageSchema).min(2).max(6),
	secrecy: z.enum(['secret', 'rumored', 'known']).optional().default('secret'),
	initial_pressure: z.number().min(0).max(100).optional().default(20),
});

export const schemeEscalateSchema = z.object({
	id: z.string(),
	advance_stage: z.boolean().optional().default(false),
	pressure_delta: z.number().min(-100).max(100).optional().default(0),
	status: z.enum(['active', 'climaxing']).optional(),
});

export const schemeResolveSchema = z.object({
	id: z.string(),
	outcome: z.enum(['resolved', 'foiled', 'abandoned']),
	reason: z.string().optional(),
});

export const manageSchemesSchema = z.object({
	create: z.array(schemeCreateSchema).optional().default([]),
	escalate: z.array(schemeEscalateSchema).optional().default([]),
	resolve: z.array(schemeResolveSchema).optional().default([]),
});

export type ManageSchemesArgs = z.infer<typeof manageSchemesSchema>;

// ── OpenAI Function-Calling Format ──

export const SCHEME_TOOL = {
	type: 'function' as const,
	function: {
		name: 'manage_schemes',
		description:
			'Create, escalate, or resolve antagonist schemes based on the latest story beats. ' +
			'Call AT MOST ONCE per turn. Only create schemes when the player\'s action genuinely ' +
			'warrants antagonist response (a slight, a kill, a theft, exposure of a secret, a public defiance). ' +
			'Escalate existing schemes when their owner had screen time or the player did something ' +
			'tangential to their goal. Resolve schemes when the player neutralizes them ' +
			'(kills the schemer, exposes the plot, satisfies the demand).',
		parameters: {
			type: 'object',
			properties: {
				create: {
					type: 'array',
					description: 'New schemes birthed by this turn. Prefer 0-1 per turn. Each scheme MUST have at least 2 stages and at most 6 — concrete, escalating, with the final stage being the climax.',
					items: {
						type: 'object',
						properties: {
							owner_name: { type: 'string', description: 'Display name matching a faction or character lorebook entry' },
							owner_type: { type: 'string', enum: ['faction', 'character'] },
							goal: { type: 'string', description: 'What the antagonist wants (concrete, achievable, dramatic). "Kill the player at the wedding feast" not "be evil".' },
							trigger: { type: 'string', description: 'What player action birthed this scheme — one sentence' },
							stages: {
								type: 'array',
								minItems: 2,
								maxItems: 6,
								items: {
									type: 'object',
									properties: {
										label: { type: 'string', description: 'Short label, e.g. "gather allies", "forge the letter"' },
										hook: { type: 'string', description: 'Narrative beat to inject when this stage matures. Concrete and actionable for the narrator: "Lord Frey\'s sellsword arrives at the city gate asking after the player." Not vague mood.' },
										condition: { type: 'string', enum: ['time', 'player-location', 'player-act', 'prerequisite'], description: 'How this stage advances. "time" is default and safest.' },
										condition_payload: {
											type: 'object',
											description: 'Optional metadata: for time → {days_after_prev: number}; for player-location → {location_name: string}; for player-act → {act_pattern: string}',
										},
									},
									required: ['label', 'hook'],
								},
							},
							secrecy: { type: 'string', enum: ['secret', 'rumored', 'known'], description: 'Does the player know? Default secret. Use "rumored" when the player heard whispers; "known" when openly declared.' },
							initial_pressure: { type: 'number', minimum: 0, maximum: 100, description: '0..100. Default 20. Hot triggers (the player killed a faction leader\'s son) start at 50+.' },
						},
						required: ['owner_name', 'owner_type', 'goal', 'trigger', 'stages'],
					},
				},
				escalate: {
					type: 'array',
					description: 'Bump existing schemes — advance their stage, raise pressure, promote to climaxing.',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', description: 'Existing scheme id' },
							advance_stage: { type: 'boolean', description: 'Move to the next stage now (overrides time gate)' },
							pressure_delta: { type: 'number', minimum: -100, maximum: 100, description: 'Signed pressure change' },
							status: { type: 'string', enum: ['active', 'climaxing'], description: 'Promote to climaxing when the final stage is imminent' },
						},
						required: ['id'],
					},
				},
				resolve: {
					type: 'array',
					description: 'Close out schemes. Use when player neutralized them or they\'ve run their course.',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							outcome: { type: 'string', enum: ['resolved', 'foiled', 'abandoned'] },
							reason: { type: 'string' },
						},
						required: ['id', 'outcome'],
					},
				},
			},
		},
	},
};

// ── Player scheme declaration (separate tool, single-shot from /plan or modal) ──

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
