import { z } from 'zod';

export const SCENE_CHECKPOINT_ENTRY_LIMIT = 600;
export const sceneCheckpointNoteSchema = z.object({
	sourceEntryId: z.string().min(1),
	position: z.number().int().nonnegative(),
	kind: z.enum(['statement', 'commitment', 'question', 'last_beat']),
	text: z.string().min(1).max(420),
}).strict();

const sceneCheckpointParticipantSchema = z.object({
	entityId: z.string().min(1),
	roles: z.array(z.enum(['actor', 'target'])).min(1).max(2),
	sourceEventIds: z.array(z.string().min(1)).min(1).max(8),
}).strict();

const sceneCheckpointBeatSchema = z.object({
	sourceEventId: z.string().min(1),
	sourceEntryIds: z.array(z.string().min(1)).min(1).max(8),
	type: z.string().min(1).max(80),
	title: z.string().min(1).max(220),
}).strict();

const sceneCheckpointActionSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(['thread', 'agreement']),
	summary: z.string().min(1).max(360),
	sourceEntryIds: z.array(z.string().min(1)).max(32),
	sourceEventIds: z.array(z.string().min(1)).max(32),
}).strict();

const sceneCheckpointCommitmentSchema = z.object({
	agreementId: z.string().min(1),
	status: z.enum(['active', 'contested']),
	parties: z.array(z.string().min(1)).max(12),
	sourceEntryIds: z.array(z.string().min(1)).max(32),
	sourceEventIds: z.array(z.string().min(1)).max(32),
}).strict();

/** Deterministic, bounded pointers into canonical rows; never a second obligation ledger. */
export const sceneCheckpointProjectionSchema = z.object({
	compilerVersion: z.literal('scene-projection-v1'),
	participants: z.array(sceneCheckpointParticipantSchema).max(32),
	completedBeats: z.array(sceneCheckpointBeatSchema).max(24),
	unresolvedActions: z.array(sceneCheckpointActionSchema).max(24),
	commitments: z.array(sceneCheckpointCommitmentSchema).max(16),
	factIds: z.array(z.string().min(1)).max(32),
	beliefIds: z.array(z.string().min(1)).max(32),
}).strict();

export type SceneCheckpointProjection = z.infer<typeof sceneCheckpointProjectionSchema>;

/** Rebuildable excerpts, never authoritative canon or a replacement for the transcript. */
export const sceneCheckpointSchema = z.object({
	version: z.literal(1),
	id: z.string().min(1),
	storyId: z.string().min(1),
	locationId: z.string().nullable(),
	scene: z.string().max(200),
	branchId: z.string().nullable(),
	pov: z.literal('primary'),
	sourceStart: z.number().int().nonnegative(),
	sourceEnd: z.number().int().nonnegative(),
	sourceEntryIds: z.array(z.string().min(1)).min(1).max(SCENE_CHECKPOINT_ENTRY_LIMIT),
	sourceHash: z.string().regex(/^[a-f0-9]{32}$/),
	notes: z.array(sceneCheckpointNoteSchema).max(128),
	projection: sceneCheckpointProjectionSchema.optional(),
	createdAt: z.string(),
}).strict().refine(value => value.sourceStart <= value.sourceEnd
	&& new Set(value.sourceEntryIds).size === value.sourceEntryIds.length
	&& value.notes.every(note => value.sourceEntryIds.includes(note.sourceEntryId)
		&& note.position >= value.sourceStart && note.position <= value.sourceEnd), 'Invalid source coverage');

export type SceneCheckpoint = z.infer<typeof sceneCheckpointSchema>;
export type SceneCheckpointNote = z.infer<typeof sceneCheckpointNoteSchema>;

export const sceneCheckpointSelectionSchema = z.object({
	id: z.string(), scene: z.string(),
	sourceStart: z.number().int(), sourceEnd: z.number().int(), sourceCount: z.number().int(),
	notes: z.array(sceneCheckpointNoteSchema.extend({ id: z.string() })),
	projection: sceneCheckpointProjectionSchema.optional(),
});
export type SceneCheckpointSelection = z.infer<typeof sceneCheckpointSelectionSchema>;
