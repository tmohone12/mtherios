import { z } from 'zod';

// ── Plot Injection (from original WorldSim) ──

export const plotInjectionSchema = z.object({
	prose: z.string(),
	urgency: z.enum(['simmer', 'emerging', 'immediate']),
	involvedCharacters: z.array(z.string()),
	involvedLocations: z.array(z.string()),
	narratorDirective: z.string(),
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
		'none',
	]),
	target: z.string().nullable().describe('Targeted faction, location, or character — null if internal/none'),
	motivation: z.string().describe('1 sentence: WHY'),
	consequences: z.array(z.string()).describe('1-3 observable consequences'),
	urgency: z.enum(['background', 'simmering', 'emerging', 'critical']),
	affectedRegions: z.array(z.string()),
});

// ── Rumor ──

export const rumorSchema = z.object({
	content: z.string().describe('The rumor as NPCs would tell it — may be distorted'),
	truthfulness: z.number().min(0).max(1),
	originRegion: z.string(),
	spreadRadius: z.enum(['local', 'regional', 'continental']),
	sourceType: z.enum(['raven', 'traveler', 'spy', 'public_decree', 'whisper']),
	relatedFaction: z.string().nullable(),
	staleAfterChapters: z.number(),
});

// ── Unified World Simulation Result ──
// Single output from the merged WorldSim + FactionSim service.

export const worldSimulationResultSchema = z.object({
	// Original WorldSim outputs
	plotInjection: plotInjectionSchema.nullable().default(null),
	worldNarrative: z.string().default(''),

	// Faction outputs (empty arrays when no factions exist)
	factionActions: z.array(factionActionSchema).default([]),
	rumors: z.array(rumorSchema).default([]),
	worldTension: z.number().min(0).max(10).default(0),
	plotSeeds: z.array(z.string()).default([]),
});

export type PlotInjection = z.infer<typeof plotInjectionSchema>;
export type FactionAction = z.infer<typeof factionActionSchema>;
export type Rumor = z.infer<typeof rumorSchema>;
export type WorldSimulationResult = z.infer<typeof worldSimulationResultSchema>;
