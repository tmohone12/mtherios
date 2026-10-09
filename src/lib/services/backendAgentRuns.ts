import { z } from 'zod';
import { turnRequestSchema, turnResponseSchema, type TurnRequest, type TurnResponse } from '$lib/contracts/memory';
import { postEngineCommand } from './backendMemory';
import type { Character, StoryEntry } from '$lib/types';

const interaction = z.object({
  id: z.string(), kind: z.enum(['question', 'roll']), prompt: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
  options_meta: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(['pending', 'answered', 'cancelled', 'expired']),
  response: z.unknown().nullable(), revision: z.number().int(),
});
const roll = z.object({
  diceExpression: z.string(), total: z.number(),
  groups: z.array(z.object({ notation: z.string(), label: z.string().nullable(), rolls: z.array(z.number()), kept: z.array(z.boolean()), subtotal: z.number() })),
  reason: z.string().optional(),
  skillName: z.string().nullable().optional(),
  targetCharacterId: z.string().nullable().optional(),
  targetCharacterName: z.string().nullable().optional(),
  portraitUrl: z.string().regex(/^\/api\/assets\/[A-Za-z0-9_-]+\?projectId=/).nullable().optional(),
}).passthrough();
const imageJob = z.object({ call_id: z.string(), tool: z.enum(['generateImage', 'generateFileImage']), job_id: z.string().nullable(), job_status: z.string().nullable(), job_error: z.string().nullable(), image_result: z.object({ assetId: z.string().optional(), applied: z.boolean().optional(), url: z.string().optional(), reason: z.string().optional() }).passthrough().nullable(), image_usage: z.record(z.string(), z.unknown()).nullable() });
const researchResult = z.object({ mode: z.literal('local_extract'), question: z.string(), status: z.enum(['answered', 'insufficient_evidence', 'unavailable']),
  statements: z.array(z.object({ kind: z.enum(['entry', 'event', 'world', 'content']), sourceId: z.string(), revision: z.string(), statement: z.string() })),
  sourceUnavailable: z.boolean(),
});
const researchTool = z.object({ call_id: z.string(), result: researchResult });
const run = z.object({
  id: z.string(), gameId: z.string(), clientTurnId: z.string(),
  status: z.enum(['running', 'awaiting_input', 'committing', 'completed', 'failed', 'cancelled']),
  error: z.string().nullable(), result: z.object({ turn: turnResponseSchema.optional() }).passthrough().nullable(),
  interactions: z.array(interaction),
  rolls: z.array(z.object({ call_id: z.string(), result: roll })),
  images: z.array(imageJob).default([]),
  research: z.array(researchTool).default([]),
});
export type BackendAgentRun = z.infer<typeof run>;
export type BackendAgentInteraction = z.infer<typeof interaction>;
export type BackendDiceRoll = z.infer<typeof roll>;
export type BackendImageJob = z.infer<typeof imageJob>;
export type BackendResearchTool = z.infer<typeof researchTool>;
export const readBackendDiceRoll = (value: unknown): BackendDiceRoll | null => roll.safeParse(value).data ?? null;
export function visibleRollPortrait(characters: readonly Character[], characterId: string | null | undefined): string | null {
  const character = characters.find(item => item.id === characterId);
  if (!character || !['public', 'player_known'].includes(String(character.metadata?.canonicalVisibility ?? ''))) return null;
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(character.portrait ?? '') ? character.portrait : null;
}
const history = z.object({
  interactions: z.array(z.object({ client_turn_id: z.string(), kind: z.enum(['question', 'roll']), prompt: z.string(), options: z.array(z.object({ id: z.string(), label: z.string() })), response: z.unknown() })),
  rolls: z.array(z.object({ client_turn_id: z.string(), result: roll })),
  images: z.array(imageJob.extend({ client_turn_id: z.string() })).default([]),
  research: z.array(researchTool.extend({ client_turn_id: z.string() })).default([]),
});
export type BackendAgentHistory = z.infer<typeof history>;

export function narrationTurnId(entry: StoryEntry | undefined): string {
	if (!entry || entry.type !== 'narration') return '';
	const metadata = entry.metadata as Record<string, unknown> | null;
	return typeof metadata?.clientTurnId === 'string' && metadata.clientTurnId.trim()
		? metadata.clientTurnId.trim() : entry.id.startsWith('narration_') ? entry.id.slice('narration_'.length) : '';
}

export function agentHistoryNarrationEntries(entries: readonly StoryEntry[]): Map<string, string> {
	const result = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== 'narration') continue;
		const turnId = narrationTurnId(entry);
		if (turnId) result.set(turnId, entry.id);
	}
	return result;
}

export async function getBackendAgentHistory(storyId: string, clientTurnIds: string[]): Promise<BackendAgentHistory> {
	const result: BackendAgentHistory = { interactions: [], rolls: [], images: [], research: [] };
	for (let offset = 0; offset < clientTurnIds.length; offset += 400) {
		const pages = [];
		for (let start = offset; start < Math.min(offset + 400, clientTurnIds.length); start += 100) {
			pages.push(postEngineCommand(storyId, 'agent.run.history', { clientTurnIds: clientTurnIds.slice(start, start + 100) }));
		}
		for (const page of await Promise.all(pages)) {
			const parsed = history.parse(page);
			result.interactions.push(...parsed.interactions);
			result.rolls.push(...parsed.rolls);
			result.images.push(...parsed.images);
			result.research.push(...parsed.research);
		}
	}
	return result;
}

export async function requestBackendSceneImage(input: { projectId: string; gameId: string; clientTurnId: string; callId: string }) {
	return z.object({ status: z.literal('complete'), jobId: z.string(), styleRevision: z.number(), imageResult: imageResult })
		.parse(await postEngineCommand(input.gameId, 'image.scene.request', input));
}

const imageResult = z.object({ assetId: z.string().optional(), applied: z.boolean().optional(), url: z.string().optional(), reason: z.string().optional() }).passthrough();
const portraitJobStatus = z.object({ jobId: z.string(), status: z.string(), error: z.string().nullable(), imageResult: imageResult.nullable() });
export type BackendPortraitJobStatus = z.infer<typeof portraitJobStatus>;

export async function requestBackendPortraitImage(input: { projectId: string; gameId: string; characterId: string; callId: string }) {
	return z.object({ status: z.literal('complete'), jobId: z.string(), expectedEntityVersion: z.number(), styleRevision: z.number(), imageResult })
		.parse(await postEngineCommand(input.gameId, 'image.portrait.request', input));
}

export async function readBackendPortraitImageStatus(input: { projectId: string; gameId: string; characterId: string }): Promise<BackendPortraitJobStatus | null> {
	const value = await postEngineCommand(input.gameId, 'image.portrait.status', input);
	return value === null ? null : portraitJobStatus.parse(value);
}

export async function startBackendAgentRun(turn: TurnRequest): Promise<BackendAgentRun> {
  const parsed = turnRequestSchema.parse(turn);
  return run.parse(await postEngineCommand(parsed.storyId, 'agent.run.start', { turn: parsed }, parsed.clientTurnId));
}

export async function currentBackendAgentRun(storyId: string): Promise<BackendAgentRun | null> {
  const value = await postEngineCommand(storyId, 'agent.run.current', {});
  return value === null ? null : run.parse(value);
}

export async function getBackendAgentRun(storyId: string, runId: string): Promise<BackendAgentRun> {
  return run.parse(await postEngineCommand(storyId, 'agent.run.status', { runId }));
}

export async function respondBackendAgentRun(storyId: string, runId: string, interactionId: string, expectedRevision: number, response: { optionId?: string; text?: string; roll?: true }): Promise<BackendAgentRun> {
  return run.parse(await postEngineCommand(storyId, 'agent.run.respond', { runId, interactionId, expectedRevision, response }));
}

export function completedBackendAgentTurn(runSnapshot: BackendAgentRun): TurnResponse | null {
  return runSnapshot.status === 'completed' ? runSnapshot.result?.turn ?? null : null;
}
