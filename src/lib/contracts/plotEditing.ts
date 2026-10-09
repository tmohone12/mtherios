import { z } from 'zod';
import { AGREEMENT_STATUSES } from './agreements';
import { strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';

export const plotEditSchema = z.discriminatedUnion('target', [
	z.object({
		target: z.literal('commitment'), serverVersion: z.number().int().positive(),
		kind: z.enum(['agreement', 'scheme']), recordId: z.string().min(1), action: z.enum(['delete', 'restore']),
	}),
	z.object({
		target: z.literal('agreement'), serverVersion: z.number().int().positive(), recordId: z.string().min(1),
		terms: z.string().trim().min(1).max(8000),
		parties: z.array(z.string().trim().min(1).max(300)).min(1).max(40),
		category: z.enum(['treaty', 'pact', 'alliance', 'oath', 'debt', 'promise', 'marriage', 'bond', 'contract', 'vassalage', 'bargain-with-entity']),
		status: z.enum(AGREEMENT_STATUSES), secrecy: z.enum(['public', 'known', 'secret']),
		consequences: z.array(z.string().trim().min(1).max(2000)).max(40),
	}),
	z.object({
		target: z.literal('scheme'), serverVersion: z.number().int().positive(), recordId: z.string().min(1),
		goal: z.string().trim().min(1).max(8000), trigger: z.string().max(4000),
		status: z.enum(['incubating', 'active', 'climaxing', 'resolved', 'foiled', 'abandoned']),
		secrecy: z.enum(['secret', 'rumored', 'known']), pressure: z.number().min(0).max(100),
		currentStageIndex: z.number().int().nonnegative(),
		stages: z.array(z.object({
			index: z.number().int().nonnegative(), label: z.string().trim().min(1).max(500), hook: z.string().max(4000),
			condition: z.enum(['time', 'player-location', 'player-act', 'prerequisite']), conditionPayload: z.record(z.string(), z.unknown()),
			completed: z.boolean(), completedAt: z.number().nullable(),
		})).min(1).max(40),
	}),
	z.object({
		target: z.literal('thread'),
		serverVersion: z.number().int().positive(),
		threadId: z.string().min(1),
		description: z.string().trim().min(1).max(8000),
		status: z.enum(['open', 'imminent', 'stalled', 'closed', 'deleted']),
		significance: z.enum(['minor', 'moderate', 'major', 'critical']),
	}),
	z.object({
		target: z.enum(['applied', 'pending']),
		serverVersion: z.number().int().positive(),
		frameId: z.string().min(1),
		frame: strategicWorldFrameSchema,
	}),
]);

export type PlotEdit = z.infer<typeof plotEditSchema>;
export const PLAYER_THREAD_CLOSURE = '[player:';
export function isDeletedThread(reason: unknown): boolean {
	return typeof reason === 'string' && reason.startsWith('[player:deleted]');
}
