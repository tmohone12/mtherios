import { z } from 'zod';

// ── Plot Injection (from original WorldSim) ──

export const plotInjectionSchema = z.object({
	prose: z.string(),
	urgency: z.enum(['simmer', 'emerging', 'immediate']),
	involvedCharacters: z.array(z.string()),
	involvedLocations: z.array(z.string()),
	narratorDirective: z.string(),
});

// ── Relation Delta (per-action change to inter-faction standing) ──
// Transforms (clamp + truncate) instead of strict validation so a single
// over-eager delta doesn't tank the whole worldsim tick.

export const relationDeltaSchema = z.object({
	targetFaction: z.string().describe('Name of the faction whose relation with this acting faction shifts'),
	delta: z.number()
		.describe('±5 small slight, ±15 visible hostility, ±30 major break, ±50 full war or alliance')
		.transform((v) => Math.max(-50, Math.min(50, v))),
	reason: z.string()
		.describe('1 short clause: why this action shifted the relationship')
		.transform((s) => (s.length > 140 ? s.slice(0, 137) + '…' : s)),
});

// ── Faction Action ──

export const factionActionSchema = z.object({
	factionName: z.string(),
	action: z.string().describe('1-2 sentence description of what the faction did'),
	actionType: z.enum([
		'military',
		'diplomatic',
		'economic',
		'intelligence',
		'internal',
		'dynastic',
		'intrigue',
		'religious',
		'seasonal',
		'none',
	]).describe('Category of the move. dynastic = marriages, betrothals, legitimizations, succession claims, births/deaths that alter inheritance. intrigue = poisonings, assassinations, blackmail, secret alliances, treachery. religious = Faith Militant, burnings, excommunications, prophecy. seasonal = harvest seizures, winter prep, famine response. military = raids, sieges, mercenaries. diplomatic = guest right, oaths, tourneys. economic = trade embargoes, Iron Bank loans, resource seizures. intelligence = spies, informants, forged letters. internal = consolidation, mustering, training.'),
	target: z.string().nullable().describe('Targeted faction, location, or character — null if internal/none'),
	motivation: z.string().describe('1 sentence: WHY'),
	consequences: z.array(z.string()).describe('1-3 observable consequences'),
	urgency: z.enum(['background', 'simmering', 'emerging', 'critical']),
	affectedRegions: z.array(z.string()),
	relationDeltas: z.array(relationDeltaSchema)
		.optional()
		.default([])
		.transform((arr) => arr.slice(0, 4))
		.describe('Per-action shifts to inter-faction relations. Most actions emit zero. Silently capped at 4.'),
});

// ── Rumor ──

export const rumorSchema = z.object({
	content: z.string().describe('The rumor as NPCs would tell it — may be distorted'),
	truthfulness: z.number().min(0).max(1),
	originRegion: z.string(),
	spreadRadius: z.enum(['local', 'regional', 'continental']),
	sourceType: z.enum(['raven', 'traveler', 'spy', 'public_decree', 'whisper', 'septon', 'maester']),
	relatedFaction: z.string().nullable(),
	staleAfterChapters: z.number(),
});

// ── Plot Momentum (Next Beat) ──
// Matches the rich structured output shown in prompt11.txt world simulation result.

export const criticalPathItemSchema = z.object({
	type: z.enum([
		'political_overture',
		'social_slight',
		'action_small_scale',
		'twist_from_secret',
		'environmental_shift',
		'discovery',
		'negotiation',
		'confrontation',
		'none',
	]).describe('Taxonomy of this path'),
	description: z.string().describe('1-2 sentence description of the NPC action, environmental shift, quiet pressure, or withheld seed'),
	friction: z.boolean().optional().default(false).describe('True if this path introduces resistance, counter-demand, or refusal'),
	action: z.boolean().optional().default(false).describe('True if this path involves physical movement, escalation, arrival/departure, or sound'),
	twist_from_existing_secret: z.boolean().optional().default(false).describe('True if this path draws from a stewing secret; this normally means foreshadow, not reveal'),
	downgraded_to_friction: z.boolean().optional().default(false).describe('True if this path was originally a twist but was held back or softened into friction'),
});

export const criticalPathSchema = z.object({
	path_a: criticalPathItemSchema,
	path_b: criticalPathItemSchema,
	path_c: criticalPathItemSchema,
	path_d: criticalPathItemSchema,
});

export const nextTurnStrategySchema = z.object({
	recommended_path: z.enum(['path_a', 'path_b', 'path_c', 'path_d']),
	rationale: z.string().describe('One line on why this serves slow-burn pacing and the current story pressure.'),
});

export const revelationBudgetSchema = z.object({
	major_reveals_stewing: z.array(z.string()).describe('Major reveals currently building in the background'),
	notes: z.string().describe('Guidance on reveal pacing, what is held back, and what evidence/cost should accumulate first'),
});

export const factionAdvisoryEntrySchema = z.object({
	disposition: z.string(),
	likely_next_move: z.string(),
	notes: z.string(),
});

export const factionAdvisorySchema = z.record(z.string(), factionAdvisoryEntrySchema)
	.describe('Keyed by faction name or slug (e.g., house_belaerys, house_stark)');

export const threadAwarenessSchema = z.object({
	existing_threads: z.array(z.string()),
	imminent_threads: z.array(z.string()),
	branch_alignment: z.string().describe('How the chosen branch aligns with active threads'),
});

export const nextBeatSchema = z.object({
	critical_path: criticalPathSchema,
	next_turn_strategy: nextTurnStrategySchema,
	revelation_budget: revelationBudgetSchema,
	faction_advisory: factionAdvisorySchema,
	thread_awareness: threadAwarenessSchema,
});

export const plotMomentumSchema = z.object({
	next_beat: nextBeatSchema,
});

// ── Thread Update (for structured thread lifecycle) ──

export const threadUpdateSchema = z.object({
	threadId: z.string().nullable().describe('Existing thread ID to update, or null to create a new thread'),
	description: z.string().describe('Thread description. For existing threads, repeat or refine the current description'),
	status: z.enum(['open', 'imminent', 'stalled', 'closed', 'abandoned']),
	significance: z.enum(['minor', 'moderate', 'major', 'critical']),
	reason: z.string().describe('Why the status changed or why this thread matters now'),
});

// ── Unified World Simulation Result ──
// Single output from the merged WorldSim + FactionSim + PlotMomentum service.

export const worldSimulationResultSchema = z.object({
	// Original WorldSim outputs
	plotInjection: plotInjectionSchema.nullable().default(null),
	worldNarrative: z.string().default(''),

	// Faction outputs (empty arrays when no factions exist)
	factionActions: z.array(factionActionSchema).default([]),
	rumors: z.array(rumorSchema).default([]),
	worldTension: z.number().min(0).max(10).default(0),
	plotSeeds: z.array(z.string()).default([]),

	// Plot momentum (merged from PlotMomentumService)
	plotMomentum: plotMomentumSchema.nullable().default(null),

	// Thread lifecycle updates
	threadUpdates: z.array(threadUpdateSchema).default([]),
});

export type PlotInjection = z.infer<typeof plotInjectionSchema>;
export type RelationDelta = z.infer<typeof relationDeltaSchema>;
export type FactionAction = z.infer<typeof factionActionSchema>;
export type Rumor = z.infer<typeof rumorSchema>;
export type CriticalPathItem = z.infer<typeof criticalPathItemSchema>;
export type CriticalPath = z.infer<typeof criticalPathSchema>;
export type NextTurnStrategy = z.infer<typeof nextTurnStrategySchema>;
export type RevelationBudget = z.infer<typeof revelationBudgetSchema>;
export type FactionAdvisoryEntry = z.infer<typeof factionAdvisoryEntrySchema>;
export type FactionAdvisory = z.infer<typeof factionAdvisorySchema>;
export type ThreadAwareness = z.infer<typeof threadAwarenessSchema>;
export type NextBeat = z.infer<typeof nextBeatSchema>;
export type PlotMomentum = z.infer<typeof plotMomentumSchema>;
export type ThreadUpdate = z.infer<typeof threadUpdateSchema>;
export type WorldSimulationResult = z.infer<typeof worldSimulationResultSchema>;
