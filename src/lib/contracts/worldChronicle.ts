import { z } from 'zod';

/**
 * World Chronicle: off-screen happenings generated when in-world time passes. A generated
 * happening is a draft (`proposed` story event) until the author accepts it; low-stakes
 * happenings are accepted automatically. See server/jobs/worldChronicle.ts.
 */
export const WORLD_CHRONICLE_SOURCE_TYPE = 'world_chronicle';
export const WORLD_HAPPENING_EVENT_TYPE = 'world_happening';

export const worldChronicleSpanSchema = z.enum(['day', 'week', 'season']);
export const worldChronicleEventfulnessSchema = z.enum(['quiet', 'normal', 'turbulent']);
export const worldChronicleCreativitySchema = z.enum(['grounded', 'balanced', 'wild']);
export type WorldChronicleSpan = z.infer<typeof worldChronicleSpanSchema>;
export type WorldChronicleEventfulness = z.infer<typeof worldChronicleEventfulnessSchema>;
export type WorldChronicleCreativity = z.infer<typeof worldChronicleCreativitySchema>;

/** Days of in-world time each span advances the World Clock by. */
export const WORLD_CHRONICLE_SPAN_DAYS: Readonly<Record<WorldChronicleSpan, number>> = Object.freeze({ day: 1, week: 7, season: 90 });

export const worldHappeningKindSchema = z.enum(['political', 'military', 'economic', 'natural', 'social', 'religious', 'supernatural', 'personal']);
export const worldHappeningStakesSchema = z.enum(['low', 'medium', 'high']);
/** How far news of a happening travels; mapped to story-event visibility when persisted. */
export const worldHappeningReachSchema = z.enum(['public', 'regional', 'secret']);
export const worldHappeningSeedTypeSchema = z.enum(['thread', 'faction_goal', 'forecast', 'event', 'new']);
export type WorldHappeningKind = z.infer<typeof worldHappeningKindSchema>;
export type WorldHappeningStakes = z.infer<typeof worldHappeningStakesSchema>;

export const worldChronicleJobPayloadSchema = z.object({
	span: worldChronicleSpanSchema,
	eventfulness: worldChronicleEventfulnessSchema.default('normal'),
	creativity: worldChronicleCreativitySchema.default('balanced'),
	requestedAt: z.string().optional(),
	source: z.string().default('manual'),
});
export type WorldChronicleJobPayload = z.infer<typeof worldChronicleJobPayloadSchema>;

/** The dials the drawer remembers (`story.metadata.worldChronicle`). */
export const worldChronicleSettingsSchema = z.object({
	eventfulness: worldChronicleEventfulnessSchema.default('normal'),
	creativity: worldChronicleCreativitySchema.default('balanced'),
});
export type WorldChronicleSettings = z.infer<typeof worldChronicleSettingsSchema>;

export function readWorldChronicleSettings(metadata: unknown): WorldChronicleSettings {
	const raw = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>).worldChronicle : null;
	const parsed = worldChronicleSettingsSchema.safeParse(raw && typeof raw === 'object' ? raw : {});
	return parsed.success ? parsed.data : { eventfulness: 'normal', creativity: 'balanced' };
}

export const worldChronicleReviewActionSchema = z.enum(['accept', 'dismiss', 'edit']);
export type WorldChronicleReviewAction = z.infer<typeof worldChronicleReviewActionSchema>;

/** One chronicle event as `world.chronicle.list` returns it. */
export const worldChronicleEventSchema = z.object({
	id: z.string(),
	status: z.string(),
	type: z.string(),
	title: z.string(),
	body: z.string(),
	visibility: z.string(),
	worldTime: z.string().nullable(),
	createdAt: z.string(),
	metadata: z.record(z.string(), z.unknown()),
});
export type WorldChronicleEvent = z.infer<typeof worldChronicleEventSchema>;

export const worldChronicleListResultSchema = z.object({
	events: z.array(worldChronicleEventSchema),
	settings: worldChronicleSettingsSchema,
	currentWorldTime: z.string().nullable().default(null),
});
export type WorldChronicleListResult = z.infer<typeof worldChronicleListResultSchema>;
