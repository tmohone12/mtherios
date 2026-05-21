import { desc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { storyEntries, syncOps } from '$lib/server/db/schema';
import { turnRequestSchema, type TurnResponse } from '$lib/contracts/memory';
import { bumpStoryVersion, getSyncChanges } from '$lib/server/memory/canonical';
import { retrieveMemoryPacket } from '$lib/server/memory/retrieval';
import { worldStateUpdateSchema } from '$lib/services/ai/tools/schemas';
import { loadTurnContext } from './context';
import { buildServerTurnPrompt, buildStateExtractionPrompt } from './promptPacket';
import { generateServerText, parseJsonFromGeneratedText } from './provider';
import { applyValidatedTurnUpdate, parseTurnUpdate } from './patchValidator';

function nowIso(): string {
	return new Date().toISOString();
}

async function nextEntryPosition(storyId: string): Promise<number> {
	const db = getDb();
	const [last] = await db
		.select({ position: storyEntries.position })
		.from(storyEntries)
		.where(eq(storyEntries.storyId, storyId))
		.orderBy(desc(storyEntries.position))
		.limit(1);
	return (last?.position ?? -1) + 1;
}

async function existingTurn(storyId: string, clientTurnId: string): Promise<TurnResponse | null> {
	const db = getDb();
	const playerEntryId = `entry_${clientTurnId}`;
	const assistantEntryId = `narration_${clientTurnId}`;
	const rows = await db
		.select()
		.from(storyEntries)
		.where(eq(storyEntries.storyId, storyId))
		.limit(200);
	const player = rows.find((entry) => entry.id === playerEntryId);
	const assistant = rows.find((entry) => entry.id === assistantEntryId);
	if (!player && !assistant) return null;
	const serverVersion = Math.max(player?.serverVersion ?? 0, assistant?.serverVersion ?? 0);
	return {
		narration: assistant?.content ?? '',
		entries: [player, assistant].filter(Boolean) as Array<Record<string, unknown>>,
		playerEntryId: player?.id ?? null,
		assistantEntryId: assistant?.id ?? null,
		statePatchIds: [],
		eventIds: [],
		retrievedMemoryIds: [],
		memoryNodeIds: [],
		serverVersion,
		syncChanges: await getSyncChanges(storyId, 0),
		warnings: ['Turn was already processed; returning existing backend entries.'],
	};
}

export async function processServerTurn(input: unknown): Promise<TurnResponse> {
	const request = turnRequestSchema.parse(input);
	const existing = await existingTurn(request.storyId, request.clientTurnId);
	if (existing) return existing;

	const db = getDb();
	const createdAt = nowIso();
	const playerEntryId = `entry_${request.clientTurnId}`;
	const assistantEntryId = `narration_${request.clientTurnId}`;
	const position = await nextEntryPosition(request.storyId);
	const turnVersion = await bumpStoryVersion(request.storyId);

	await db.insert(syncOps).values({
		id: `turn_${request.clientTurnId}`,
		storyId: request.storyId,
		type: 'turn_command',
		payload: { playerText: request.playerText, clientContext: request.clientContext ?? null },
		clientVersion: request.localVersion,
		status: 'applied',
		createdAt,
	}).onConflictDoNothing();

	await db.insert(storyEntries).values({
		id: playerEntryId,
		storyId: request.storyId,
		type: 'user_action',
		content: request.playerText,
		position,
		parentId: null,
		branchId: null,
		metadata: { clientTurnId: request.clientTurnId, source: 'server_turn' },
		serverVersion: turnVersion,
		createdAt,
		updatedAt: createdAt,
	}).onConflictDoNothing();

	const retrievalRequest = {
		storyId: request.storyId,
		query: request.playerText,
		sceneEntityIds: request.clientContext?.sceneEntityIds ?? [],
		presentNpcIds: request.clientContext?.presentNpcIds ?? [],
		locationId: request.clientContext?.locationId ?? null,
		threadIds: request.clientContext?.threadIds ?? [],
		currentFactionId: request.clientContext?.currentFactionId ?? null,
		tokenBudget: 1000,
	};
	const retrieved = await retrieveMemoryPacket(retrievalRequest);
	const ctx = await loadTurnContext(request.storyId, request.clientContext?.presentNpcIds ?? []);
	const prompt = buildServerTurnPrompt(ctx, retrieved, playerEntryId);

	let narration = '';
	const warnings: string[] = [];
	if (!request.providerProfile) {
		warnings.push('No provider profile was supplied; backend turn was persisted without generated narration.');
	} else {
		narration = await generateServerText({
			profile: request.providerProfile,
			model: request.generation?.model,
			temperature: request.generation?.temperature,
			maxTokens: request.generation?.maxTokens,
			system: prompt.system,
			messages: prompt.messages,
			prompt: `${prompt.prompt}\n\nPlayer action:\n${request.playerText}`,
		});
	}

	if (!narration.trim()) {
		narration = 'The backend recorded the turn, but no narration was generated. Check the server turn provider settings.';
		warnings.push('Empty backend narration.');
	}

	await db.insert(storyEntries).values({
		id: assistantEntryId,
		storyId: request.storyId,
		type: 'narration',
		content: narration,
		position: position + 1,
		parentId: playerEntryId,
		branchId: null,
		metadata: {
			clientTurnId: request.clientTurnId,
			source: 'server_turn',
			retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
		},
		serverVersion: turnVersion,
		createdAt,
		updatedAt: createdAt,
	}).onConflictDoNothing();

	let rawUpdate: unknown = { update: worldStateUpdateSchema.parse({}) };
	if (request.providerProfile) {
		try {
			const extraction = await generateServerText({
				profile: request.providerProfile,
				model: request.generation?.model,
				temperature: 0.2,
				maxTokens: Math.min(request.generation?.maxTokens ?? 4096, 4096),
				system: 'You extract canonical state changes for a text adventure. Return strict JSON only.',
				prompt: buildStateExtractionPrompt(request.playerText, narration),
				responseFormat: 'json_object',
			});
			rawUpdate = parseJsonFromGeneratedText(extraction);
		} catch (error) {
			warnings.push(`State extraction failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const parsedUpdate = parseTurnUpdate(rawUpdate);
	warnings.push(...parsedUpdate.warnings);
	const applied = await applyValidatedTurnUpdate({
		storyId: request.storyId,
		playerEntryId,
		assistantEntryId,
		narration,
		update: parsedUpdate.update,
		parseWarnings: parsedUpdate.warnings,
		retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
		serverVersion: turnVersion,
	});
	warnings.push(...applied.warnings);

	const entries = await db
		.select()
		.from(storyEntries)
		.where(eq(storyEntries.storyId, request.storyId))
		.orderBy(desc(storyEntries.position))
		.limit(2);
	const syncChanges = await getSyncChanges(request.storyId, request.localVersion);
	const maxVersion = syncChanges.reduce((max, change) => Math.max(max, change.version), turnVersion);

	return {
		narration,
		entries: entries.reverse(),
		playerEntryId,
		assistantEntryId,
		statePatchIds: applied.patchIds,
		eventIds: applied.eventIds,
		retrievedMemoryIds: retrieved.nodes.map((node) => node.id),
		memoryNodeIds: applied.memoryNodeIds,
		serverVersion: maxVersion,
		syncChanges,
		warnings,
	};
}
