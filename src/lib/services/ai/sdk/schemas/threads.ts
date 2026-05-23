import { z } from 'zod';

export const storyThreadSchema = z.object({
	id: z.string(),
	storyId: z.string(),
	description: z.string(),
	status: z.enum(['open', 'imminent', 'stalled', 'closed', 'abandoned']),
	significance: z.enum(['minor', 'moderate', 'major', 'critical']),
	sourceArcId: z.string().nullable(),
	sourceChapterId: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
	closedAt: z.number().nullable(),
	closureReason: z.string().nullable(),
	relatedFactionIds: z.array(z.string()),
	relatedCharacterNames: z.array(z.string()),
});

export const threadUpdateSchema = z.object({
	threadId: z.string().nullable().describe('Existing thread ID to update, or null to create a new thread'),
	description: z.string().describe('Thread description. For existing threads, repeat or refine the current description'),
	status: z.enum(['open', 'imminent', 'stalled', 'closed', 'abandoned']),
	significance: z.enum(['minor', 'moderate', 'major', 'critical']),
	reason: z.string().describe('Why the status changed or why this thread matters now'),
});

export type StoryThread = z.infer<typeof storyThreadSchema>;
export type ThreadUpdate = z.infer<typeof threadUpdateSchema>;
