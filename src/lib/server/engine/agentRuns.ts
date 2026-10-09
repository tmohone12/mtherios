import { randomUUID } from 'node:crypto';
import { agentRunHash as hash } from './agentRunHash';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { turnRequestSchema } from '$lib/contracts/memory';
import { getAgentSettings } from './agentSettings';
import { availablePlannerTools, currentJevObservations, formatAgentObservations, formatNarratorObservations, isRetryablePlannerError, MAX_AGENT_TOOL_CALLS, sameAgentQuestion, selectPlannerToolCalls } from './agentRunPlanner';
import { assertAgentToolAllowed, type AgentAuthority } from './agentPolicy';
import { updateContentInTransaction } from './content';
import { MutationError } from './mutationSafety';
import { generateServerTextWithMetrics, ServerGenerationError, type NativeToolDefinition, type ServerGenerationOptions } from '$lib/server/turn/provider';
import { applyPromptContextBudget, boundedRecallArgs, GM_RECALL_COMMANDS, normalizeGmToolArgs, prepareServerTurnContext, processServerTurn } from '$lib/server/turn/orchestrator';
import { countTokens } from '$lib/utils/tokens';
import { executeEngineCommand } from './command';
import { actorBriefArgsSchema, getActorDecisionView } from './gmTools';
import { requireResolvedServiceProfile, resolveServiceGeneration } from './llmSettings';
import { recordApiCallLog } from './apiCallLogs';
import { boundedJevSourceIds, chooseJevOption, isJevModel } from '$lib/server/turn/jev';
import { runCompactResearch } from './research';
import { publicResearchReceipt } from './researchHistory';
import { nameRequestSchema, parseNameCandidates } from './generatedNames';
import { parseSystemDice, rollSystemDice } from './systemDice';
import { reserveExplicitImage } from './imageRequests';
import { completeDirectImageRequest } from './imageJobs';
import { readStoryImageCardHistory } from './storyImageCards';
import { getLocationMap, saveLocationMap } from './locationMaps';
import { locationMapBodySchema, locationMapSaveSchema } from '$lib/contracts/locationMap';
import type { AgentTool } from '$lib/contracts/agentTools';

type Row = Record<string, unknown>;
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : String(value ?? '');
async function generateAgentText(run: Row, operation: string, options: ServerGenerationOptions) {
  try {
    const result = await generateServerTextWithMetrics(options);
    await recordApiCallLog({ storyId: text(run.game_id), serviceId: 'classifier', operation,
      providerType: options.profile.providerType, providerName: options.profile.name ?? null, profileId: options.profile.id ?? null,
      model: result.model, endpoint: result.endpoint, durationMs: result.durationMs, status: 'success',
      requestTokens: result.usage.requestTokens, responseTokens: result.usage.responseTokens, totalTokens: result.usage.totalTokens,
      promptChars: result.promptChars, responseChars: result.responseChars,
      metadata: { clientTurnId: text(run.client_turn_id), runId: text(run.id), cachedInputTokens: result.usage.cachedInputTokens ?? null,
        providerCostUsd: result.usage.providerCostUsd ?? null, costSource: result.usage.providerCostUsd == null ? 'unavailable' : 'provider_reported' } });
    return result;
  } catch (error) {
    if (error instanceof ServerGenerationError) {
      const result = error.result;
      await recordApiCallLog({ storyId: text(run.game_id), serviceId: 'classifier', operation,
        providerType: options.profile.providerType, providerName: options.profile.name ?? null, profileId: options.profile.id ?? null,
        model: result.model, endpoint: result.endpoint, durationMs: result.durationMs, status: 'error', error: error.message,
        requestTokens: result.usage?.requestTokens ?? null, responseTokens: result.usage?.responseTokens ?? null,
        totalTokens: result.usage?.totalTokens ?? null, promptChars: result.promptChars, responseChars: result.responseChars ?? null,
        metadata: { clientTurnId: text(run.client_turn_id), runId: text(run.id), statusCode: result.statusCode ?? null,
          providerCostUsd: result.usage?.providerCostUsd ?? null } });
    }
    throw error;
  }
}
function jevActionContext(playerText: string, observations: readonly unknown[]) {
  const playerInteractions = observations.filter(row => ['askUserQuestion', 'askPlayerToRoll'].includes(text(object(row).tool)))
    .map(row => { const item = object(row); return { tool: item.tool, callId: item.callId, result: item.result }; });
  return { playerInteractions, actionHash: hash(playerInteractions.length ? { playerText, playerInteractions } : playerText) };
}
const runIdSchema = z.object({ runId: z.string().min(1).max(100), storyId: z.string().min(1).max(200) }).strict();
const startSchema = z.object({ turn: turnRequestSchema }).strict();
const responseSchema = runIdSchema.extend({ interactionId: z.string().min(1).max(100), expectedRevision: z.number().int().positive(), response: z.object({ optionId: z.string().min(1).max(100).optional(), text: z.string().trim().min(1).max(1000).optional(), roll: z.literal(true).optional() }).strict() }).strict();
const questionSchema = z.object({ prompt: z.string().trim().min(1).max(1000), options: z.array(z.object({ id: z.string().min(1).max(100), label: z.string().trim().min(1).max(200) }).strict()).min(1).max(8), allowCustom: z.boolean().default(false) }).strict();
export const askJevArgsSchema = z.object({ actorId: z.string().min(1).max(200), question: z.string().trim().min(3).max(300), purpose: z.enum(['immediate_response', 'other']).default('other'), options: z.array(z.object({ id: z.string().regex(/^[a-z0-9_:-]{1,80}$/).refine(id => id !== 'hold'), description: z.string().trim().min(3).max(200) }).strict()).min(2).max(5).refine(options => new Set(options.map(option => option.id)).size === options.length) }).strict();
const askJevParameters = z.toJSONSchema(askJevArgsSchema);
delete askJevParameters.$schema;
const readCommands = ['campaign.status', 'world.actor.brief', 'world.scene.check', 'plot.thread.board'] as const;
const toolSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('read'), callId: z.string().min(1).max(200), args: z.object({ command: z.enum(readCommands), args: z.record(z.string(), z.unknown()).default({}) }).strict() }).strict(),
  z.object({ tool: z.literal('list'), callId: z.string().min(1).max(200), args: z.object({ type: z.string().min(1).max(100).optional(), limit: z.number().int().min(1).max(20).default(10) }).strict() }).strict(),
  z.object({ tool: z.literal('research'), callId: z.string().min(1).max(200), args: z.object({ question: z.string().trim().min(3).max(500) }).strict() }).strict(),
  z.object({ tool: z.literal('recall'), callId: z.string().min(1).max(200), args: z.object({ command: z.enum(GM_RECALL_COMMANDS), args: z.record(z.string(), z.unknown()).default({}) }).strict() }).strict(),
  z.object({ tool: z.literal('search'), callId: z.string().min(1).max(200), args: z.object({ query: z.string().trim().min(1).max(300) }).strict() }).strict(),
  z.object({ tool: z.literal('askUserQuestion'), callId: z.string().min(1).max(200), args: questionSchema }).strict(),
  z.object({ tool: z.literal('gmRollDice'), callId: z.string().min(1).max(200), args: z.object({ reason: z.string().trim().min(1).max(500), diceExpression: z.string().trim().min(1).max(200), fileName: z.string().trim().min(1).max(200).optional() }).strict() }).strict(),
  z.object({ tool: z.literal('askJev'), callId: z.string().min(1).max(200), args: askJevArgsSchema }).strict(),
  z.object({ tool: z.literal('generateNames'), callId: z.string().min(1).max(200), args: nameRequestSchema }).strict(),
  z.object({ tool: z.literal('generateImage'), callId: z.string().min(1).max(200), args: z.object({ prompt: z.string().trim().min(1).max(1000) }).strict() }).strict(),
  z.object({ tool: z.literal('generateFileImage'), callId: z.string().min(1).max(200), args: z.object({ fileName: z.string().trim().min(1).max(200), prompt: z.string().trim().min(1).max(1000) }).strict() }).strict(),
  z.object({ tool: z.literal('askPlayerToRoll'), callId: z.string().min(1).max(200), args: z.object({ reason: z.string().trim().min(1).max(500), diceExpression: z.string().trim().min(1).max(200), skillName: z.string().trim().min(1).max(100).optional(), targetCharacterSlug: z.string().trim().min(1).max(100).optional() }).strict() }).strict(),
  z.object({ tool: z.literal('update'), callId: z.string().min(1).max(200), args: z.object({ id: z.string().min(1).max(200), expectedRevision: z.number().int().positive(), expectedTypeRevision: z.number().int().positive(), changes: z.record(z.string(), z.unknown()) }).strict() }).strict(),
  z.object({ tool: z.literal('map'), callId: z.string().min(1).max(200), args: z.object({ action: z.enum(['get', 'save']), locationId: z.string().min(1).max(200), expectedRevision: z.number().int().min(0).optional(), map: locationMapBodySchema.optional(), reason: z.string().trim().min(1).max(2000).optional() }).strict() }).strict(),
]);
type ToolCall = z.infer<typeof toolSchema>;
const implemented = ['read', 'list', 'search', 'research', 'recall', 'askUserQuestion', 'gmRollDice', 'askJev', 'askPlayerToRoll', 'generateNames', 'generateImage', 'generateFileImage', 'update', 'map'] as const satisfies readonly AgentTool[];
const definitions: Record<ToolCall['tool'], NativeToolDefinition> = {
  read: { name: 'read', description: 'Read current game state. Commands: campaign.status, world.actor.brief, world.scene.check, plot.thread.board. world.actor.brief requires args.actorId or args.name; use a known actor from context or search first.', parameters: { type: 'object', properties: { command: { type: 'string', enum: readCommands }, args: { type: 'object' } }, required: ['command'], additionalProperties: false } },
  list: { name: 'list', description: 'List bounded canonical world records in this game.', parameters: { type: 'object', properties: { type: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false } },
  research: { name: 'research', description: 'Locally research public game history and current records; returns short source-linked excerpts. No provider is called by this tool.', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false } },
  recall: { name: 'recall', description: 'Read bounded GM-only historical or lore evidence when the prepared context leaves a material gap. Search first, then read a specific result in a later round. These results are for GM reasoning and must not be narrated as player-known facts without scene evidence.', parameters: { type: 'object', properties: { command: { type: 'string', enum: GM_RECALL_COMMANDS }, args: { type: 'object' } }, required: ['command'], additionalProperties: false } },
  search: { name: 'search', description: 'Search canonical world records in this game.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  askUserQuestion: { name: 'askUserQuestion', description: 'Pause this turn for one player answer. Supply stable option IDs and labels.', parameters: { type: 'object', properties: { prompt: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false } }, allowCustom: { type: 'boolean' } }, required: ['prompt', 'options'], additionalProperties: false } },
  gmRollDice: { name: 'gmRollDice', description: 'Roll game-system dice on the server for a GM or NPC action. Optional fileName shows the public cover of one exact game file on the roll card. Returns raw faces, kept dice, group subtotals, and total; interpret success using the game rules.', parameters: { type: 'object', properties: { reason: { type: 'string' }, diceExpression: { type: 'string' }, fileName: { type: 'string' } }, required: ['reason', 'diceExpression'], additionalProperties: false } },
  askJev: { name: 'askJev', description: 'Ask the configured Decisions model about one known NPC using that NPC\'s isolated beliefs and witnessed evidence. Keep the question under 300 characters and each plausible action under 200 characters. Set purpose to immediate_response only when options describe the NPC\'s immediate response to this player action; the turn can reuse that choice. The server adds a hold option. Its answer is advisory, not a completed action or a source of new facts.', parameters: askJevParameters },
  generateNames: { name: 'generateNames', description: 'Generate bounded character, place, or organization name candidates using the campaign naming context. Candidates are suggestions only; this tool never creates canon.', parameters: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 12 }, intent: { type: 'string', enum: ['character', 'place', 'organization'] }, genre: { type: 'string', enum: ['fantasy', 'science_fiction', 'horror', 'noir'] }, style: { type: 'string', maxLength: 200 }, culturalBlends: { type: 'array', maxItems: 4, items: { type: 'string' } }, exclude: { type: 'array', maxItems: 20, items: { type: 'string' } } }, required: ['count', 'intent'], additionalProperties: false } },
  generateImage: { name: 'generateImage', description: 'Generate one image directly for this GM game only when the player explicitly requests it. Gather the scene and ALL present participants using context/read/recall first, then compose a visual prompt with their saved bio appearance, species, current form, actions, scale and setting. Include everyone present; exclude merely mentioned/offscreen people. Use appropriate creature anatomy and scene framing; do not say portrait or impose human bodies on dragons. Wait for the API result; report completion only when its receipt includes the image asset.', parameters: { type: 'object', properties: { prompt: { type: 'string', maxLength: 1000 } }, required: ['prompt'], additionalProperties: false } },
  generateFileImage: { name: 'generateFileImage', description: 'Generate a new cover directly for one exact game document when the player explicitly asks for it. Resolve and read the scoped file first. Base character images on saved bio appearance and current species/form; avoid the word portrait and human framing for creatures. Wait for the API result before reporting completion.', parameters: { type: 'object', properties: { fileName: { type: 'string' }, prompt: { type: 'string', maxLength: 1000 } }, required: ['fileName', 'prompt'], additionalProperties: false } },
  askPlayerToRoll: { name: 'askPlayerToRoll', description: 'Pause for a player-controlled server roll using the game rules. Supply a reason and a bounded dice expression.', parameters: { type: 'object', properties: { reason: { type: 'string' }, diceExpression: { type: 'string' }, skillName: { type: 'string' }, targetCharacterSlug: { type: 'string' } }, required: ['reason', 'diceExpression'], additionalProperties: false } },
  update: { name: 'update', description: 'Edit an existing game-owned custom content document only. Its ID and exact item/type revisions must come from that document, not a character, world record, campaign file, or story clock. Canonical world changes are handled by the turn update pipeline.', parameters: { type: 'object', properties: { id: { type: 'string' }, expectedRevision: { type: 'integer' }, expectedTypeRevision: { type: 'integer' }, changes: { type: 'object' } }, required: ['id', 'expectedRevision', 'expectedTypeRevision', 'changes'], additionalProperties: false } },
  map: { name: 'map', description: 'Read or save a location map in this game. Get returns the current map and revision. Save requires the full bounded map document and that exact expected revision. Drawing changes the map only; it never moves characters.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['get', 'save'] }, locationId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 }, map: z.toJSONSchema(locationMapBodySchema), reason: { type: 'string' } }, required: ['action', 'locationId'], additionalProperties: false } },
};

async function event(tx: Tx, runId: string, eventType: string, data: unknown) {
  await tx.execute(sql`insert into agent_run_events(run_id,event_type,data) values(${runId},${eventType},${JSON.stringify(data)}::jsonb)`);
}
export async function resolveGmRollFilePortrait(db: Db | Tx, projectId: string, gameId: string, fileName: string): Promise<string | null> {
  const name = fileName.trim().replaceAll('\\', '/').toLowerCase();
  if (!name || name.length > 200) return null;
  const matches = await db.execute(sql`select a.id as asset_id from content_items i
    join content_types t on t.id=i.type_id
    left join assets a on a.id=i.cover_asset_id and a.project_id=i.project_id and a.game_id=i.game_id and a.visibility='public'
    where i.project_id=${projectId} and i.game_id=${gameId} and i.deleted_at is null and i.visibility='public'
      and i.branch_id is null and i.pov_character is null
      and (lower(i.id)=${name} or lower(i.title)=${name} or lower(i.slug || '.' || t.extension)=${name}
        or lower(case when i.folder='' then i.slug || '.' || t.extension else i.folder || '/' || i.slug || '.' || t.extension end)=${name})
    order by i.id limit 2`);
  if (matches.length !== 1 || !matches[0].asset_id) return null;
  return `/api/assets/${encodeURIComponent(String(matches[0].asset_id))}?projectId=${encodeURIComponent(projectId)}&gameId=${encodeURIComponent(gameId)}`;
}
async function scopedRun(runId: string, storyId: string, lock = false, db: Db | Tx = getDb()): Promise<Row> {
  const [run] = await db.execute(sql`select * from agent_runs where id=${runId} and game_id=${storyId} ${lock ? sql`for update` : sql``}`);
  if (!run) throw new MutationError('SCOPE_DENIED', 'Agent run not found in this game.');
  return run as Row;
}
async function snapshot(runId: string, storyId: string) {
  const run = await scopedRun(runId, storyId);
  const interactions = await getDb().execute(sql`select id,kind,prompt,options,options_meta,status,response,revision,expires_at from agent_interactions where run_id=${runId} order by created_at,id`);
  const rolls = await getDb().execute(sql`select call_id,result from agent_tool_calls where run_id=${runId} and tool='gmRollDice' and status='completed' order by created_at,call_id`);
  const images = await getDb().execute(sql`select t.call_id,t.tool,t.result->>'jobId' as job_id,j.status as job_status,j.last_error as job_error,j.metadata->'imageResult' as image_result,a.usage as image_usage
    from agent_tool_calls t left join backend_jobs j on j.id=t.result->>'jobId' and j.project_id=${run.project_id} and j.story_id=${run.game_id}
      and j.payload->'origin'->>'runId'=t.run_id and j.payload->'origin'->>'callId'=t.call_id
    left join assets a on a.origin_job_id=j.id and a.project_id=${run.project_id}
    where t.run_id=${runId} and t.tool in ('generateImage','generateFileImage') and t.status='completed' order by t.created_at,t.call_id`);
  const researchRows = await getDb().execute(sql`select call_id,result from agent_tool_calls where run_id=${runId} and tool='research' and status='completed' order by created_at,call_id`);
  const research = [];
  for (const row of researchRows) {
    const result = await publicResearchReceipt(row.result, { projectId: String(run.project_id), gameId: storyId });
    if (result) research.push({ call_id: row.call_id, result });
  }
  return { id: run.id, role: run.role, projectId: run.project_id, gameId: run.game_id, clientTurnId: run.client_turn_id, status: run.status, revision: run.revision, expiresAt: run.expires_at, usage: run.usage, continuation: run.continuation, error: run.error, result: run.result, interactions, rolls, images, research };
}
async function expire(runId: string, storyId: string) {
  await getDb().transaction(async tx => {
    const run = await scopedRun(runId, storyId, true, tx);
    if (!['running', 'awaiting_input'].includes(text(run.status))) return;
    if (new Date(text(run.expires_at)).getTime() > Date.now()) return;
    await tx.execute(sql`update agent_runs set status='failed',error='Run expired before completion.',revision=revision+1,updated_at=now() where id=${runId}`);
    await tx.execute(sql`update agent_interactions set status='expired',revision=revision+1,updated_at=now() where run_id=${runId} and status='pending'`);
    await event(tx, runId, 'run.failed', { reason: 'expired' });
  });
}

export async function startAgentRun(input: unknown, storyId: string) {
  const { turn } = startSchema.parse(input);
  if (turn.storyId !== storyId || storyId === '__app__') throw new MutationError('SCOPE_DENIED', 'Run game scope does not match the gateway.');
  const [game] = await getDb().execute(sql`select id,shelf_id from stories where id=${storyId}`);
  if (!game) throw new MutationError('SCOPE_DENIED', 'Game not found.');
  const { providerProfile: _unusedProfile, ...safeTurn } = turn;
  const fingerprint = hash(safeTurn);
  const [existing] = await getDb().execute(sql`select id,request from agent_runs where game_id=${storyId} and client_turn_id=${turn.clientTurnId}`);
  if (existing) {
    if (hash(existing.request) !== fingerprint) throw new MutationError('REVISION_CONFLICT', 'This client turn ID was used with different input.');
    return snapshot(text(existing.id), storyId);
  }
  const runId = `run_${randomUUID()}`;
  try {
    await getDb().transaction(async tx => {
      const [pending] = await tx.execute(sql`select id from agent_runs where game_id=${storyId} and status in ('running','awaiting_input','committing') limit 1`);
      if (pending) throw new MutationError('REVISION_CONFLICT', 'Another agent run is pending in this game.');
      await tx.execute(sql`insert into agent_runs(id,project_id,game_id,client_turn_id,status,request,lease_until,expires_at) values(${runId},${game.shelf_id},${storyId},${turn.clientTurnId},'running',${JSON.stringify(safeTurn)}::jsonb,now()+interval '3 minutes',now()+interval '24 hours')`);
      await event(tx, runId, 'run.started', { clientTurnId: turn.clientTurnId });
    });
  } catch (error) {
    const [raced] = await getDb().execute(sql`select id,request from agent_runs where game_id=${storyId} and client_turn_id=${turn.clientTurnId}`);
    if (!raced || hash(raced.request) !== fingerprint) throw error;
    return snapshot(text(raced.id), storyId);
  }
  await advance(runId, storyId);
  return snapshot(runId, storyId);
}

export async function getAgentRun(input: unknown) {
  const { runId, storyId } = runIdSchema.parse(input);
  await expire(runId, storyId);
  const run = await scopedRun(runId, storyId);
  if (['running', 'committing'].includes(text(run.status)) && new Date(text(run.lease_until)).getTime() < Date.now()) {
    const [claimed] = await getDb().execute(sql`update agent_runs set lease_until=now()+interval '3 minutes',updated_at=now() where id=${runId} and game_id=${storyId} and status in ('running','committing') and lease_until < now() returning id`);
    if (claimed) await advance(runId, storyId);
  }
  return snapshot(runId, storyId);
}

export async function retryFailedAgentRun(input: unknown) {
  const { runId, storyId } = runIdSchema.parse(input);
  await getDb().transaction(async tx => {
    const run = await scopedRun(runId, storyId, true, tx);
    if (run.status !== 'failed' || !isRetryablePlannerError(text(run.error)) || run.result != null) {
      throw new MutationError('REVISION_CONFLICT', 'Only a failed pre-narration planner run can be retried.');
    }
    const [newerRun] = await tx.execute(sql`select id from agent_runs where game_id=${storyId} and created_at>${run.created_at} limit 1`);
    const [newerEntry] = await tx.execute(sql`select id from story_entries where story_id=${storyId} and created_at>${run.created_at} limit 1`);
    const [pending] = await tx.execute(sql`select id from agent_interactions where run_id=${runId} and status='pending' limit 1`);
    if (newerRun || newerEntry || pending) throw new MutationError('REVISION_CONFLICT', 'Game activity changed after this run failed; retry is no longer safe.');
    await tx.execute(sql`update agent_runs set status='running',error=null,pending_decision=null,lease_until=now()+interval '3 minutes',revision=revision+1,updated_at=now() where id=${runId}`);
    await event(tx, runId, 'run.retried', { reason: run.error });
  });
  await advance(runId, storyId);
  return snapshot(runId, storyId);
}

export async function getCurrentAgentRun(input: unknown) {
  const { storyId } = z.object({ storyId: z.string().min(1).max(200) }).strict().parse(input);
  const [run] = await getDb().execute(sql`select id from agent_runs where game_id=${storyId} and status in ('running','awaiting_input','committing','completed') and (status='completed' or expires_at>now()) order by case when status='completed' then 1 else 0 end, created_at desc limit 1`);
  return run ? getAgentRun({ runId: text(run.id), storyId }) : null;
}

export async function getAgentRunHistory(input: unknown) {
  const { storyId, clientTurnIds } = z.object({ storyId: z.string().min(1).max(200), clientTurnIds: z.array(z.string().min(1).max(200)).max(500) }).strict().parse(input);
  if (!clientTurnIds.length) return { interactions: [], rolls: [], images: [], research: [] };
  const ids = [...new Set(clientTurnIds)];
  const scope = sql`r.client_turn_id in (${sql.join(ids.map(id => sql`${id}`), sql`,`)})`;
  const interactions = await getDb().execute(sql`select r.client_turn_id,i.kind,i.prompt,i.options,i.response from agent_interactions i join agent_runs r on r.id=i.run_id where r.game_id=${storyId} and ${scope} and r.status='completed' and i.status='answered' order by r.created_at,i.created_at limit 1000`);
  const rolls = await getDb().execute(sql`select r.client_turn_id,t.result from agent_tool_calls t join agent_runs r on r.id=t.run_id where r.game_id=${storyId} and ${scope} and r.status='completed' and t.tool='gmRollDice' and t.status='completed' order by r.created_at,t.created_at limit 1000`);
  const images = await getDb().execute(sql`select r.client_turn_id,t.call_id,t.tool,t.result->>'jobId' as job_id,j.status as job_status,j.last_error as job_error,j.metadata->'imageResult' as image_result,a.usage as image_usage
    from agent_tool_calls t join agent_runs r on r.id=t.run_id
    left join backend_jobs j on j.id=t.result->>'jobId' and j.project_id=r.project_id and j.story_id=r.game_id
      and j.payload->'origin'->>'runId'=t.run_id and j.payload->'origin'->>'callId'=t.call_id
    left join assets a on a.origin_job_id=j.id and a.project_id=r.project_id
    where r.game_id=${storyId} and ${scope} and r.status='completed' and t.tool in ('generateImage','generateFileImage') and t.status='completed' order by r.created_at,t.created_at limit 1000`);
  const manualImages = await getDb().execute(sql`select j.payload->'browserOrigin'->>'clientTurnId' as client_turn_id,
    j.payload->'browserOrigin'->>'callId' as call_id,'generateImage' as tool,j.id as job_id,
    j.status as job_status,j.last_error as job_error,j.metadata->'imageResult' as image_result,a.usage as image_usage
    from backend_jobs j join stories s on s.id=j.story_id and s.shelf_id=j.project_id
      left join assets a on a.origin_job_id=j.id and a.project_id=j.project_id and a.game_id=j.story_id
    where j.story_id=${storyId} and j.type='generate_image' and j.payload->>'kind'='manual_scene'
      and j.payload->'browserOrigin'->>'clientTurnId' in (${sql.join(ids.map(id => sql`${id}`), sql`,`)})
    order by j.created_at,j.id limit 1000`);
  const researchRows = await getDb().execute(sql`select r.client_turn_id,r.project_id,t.call_id,t.result
    from agent_tool_calls t join agent_runs r on r.id=t.run_id
    where r.game_id=${storyId} and ${scope} and r.status='completed' and t.tool='research' and t.status='completed'
    order by r.created_at,t.created_at limit 1000`);
  const research = [];
  for (let start = 0; start < researchRows.length; start += 8) {
    const batch = await Promise.all(researchRows.slice(start, start + 8).map(async row => {
      const result = await publicResearchReceipt(row.result, { projectId: String(row.project_id), gameId: storyId });
      return result ? { client_turn_id: row.client_turn_id, call_id: row.call_id, result } : null;
    }));
    research.push(...batch.filter((row): row is NonNullable<typeof row> => row !== null));
  }
  const cards = await readStoryImageCardHistory(storyId, ids);
  const cardOrigins = new Set(cards.map(card => `${card.client_turn_id}\0${card.call_id}`));
  return { interactions, rolls, images: [...images, ...manualImages].filter(row => !cardOrigins.has(`${row.client_turn_id}\0${row.call_id}`)).concat(cards), research };
}

export async function respondAgentRun(input: unknown) {
  const request = responseSchema.parse(input);
  await expire(request.runId, request.storyId);
  const shouldAdvance = await getDb().transaction(async tx => {
    const run = await scopedRun(request.runId, request.storyId, true, tx);
    const [interaction] = await tx.execute(sql`select * from agent_interactions where id=${request.interactionId} and run_id=${request.runId} for update`);
    if (!interaction) throw new MutationError('SCOPE_DENIED', 'Interaction not found in this run.');
    if (interaction.status === 'answered') {
      if (interaction.kind === 'roll' && request.response.roll === true && !request.response.optionId && !request.response.text) return false;
      if (hash(interaction.response) === hash(request.response)) return false;
      throw new MutationError('REVISION_CONFLICT', 'This interaction has a different accepted answer.');
    }
    if (run.status !== 'awaiting_input' || interaction.status !== 'pending') throw new MutationError('REVISION_CONFLICT', 'This run is not awaiting this answer.');
    if (Number(interaction.revision) !== request.expectedRevision) throw new MutationError('REVISION_CONFLICT', 'Interaction revision changed. Reload it.');
    if (new Date(text(interaction.expires_at)).getTime() <= Date.now()) throw new MutationError('REVISION_CONFLICT', 'Interaction expired.');
    let accepted: unknown;
    let tool: 'askUserQuestion' | 'askPlayerToRoll';
    if (interaction.kind === 'roll') {
      if (request.response.roll !== true || request.response.optionId || request.response.text) throw new MutationError('INVALID_FIELD', 'Use the server roll action for this interaction.');
      const meta = object(interaction.options_meta);
      const diceExpression = z.string().min(1).max(200).parse(meta.diceExpression);
      accepted = { reason: interaction.prompt, skillName: meta.skillName ?? null, targetCharacterId: meta.targetCharacterId ?? null, targetCharacterName: meta.targetCharacterName ?? null, ...rollSystemDice(diceExpression) };
      tool = 'askPlayerToRoll';
    } else if (interaction.kind === 'question') {
      if (request.response.roll) throw new MutationError('INVALID_FIELD', 'Choose an answer for this question.');
      const options = interaction.options as Array<{ id: string }>;
      const allowCustom = Boolean(object(interaction.options_meta).allowCustom);
      if (Boolean(request.response.optionId) === Boolean(request.response.text)) throw new MutationError('INVALID_FIELD', 'Select one option or give one custom answer.');
      if (request.response.optionId && !options.some(option => option.id === request.response.optionId)) throw new MutationError('INVALID_FIELD', 'Unknown question option.');
      if (request.response.text && !allowCustom) throw new MutationError('INVALID_FIELD', 'This question requires an option.');
      accepted = request.response;
      tool = 'askUserQuestion';
    } else throw new MutationError('INVALID_FIELD', 'Unsupported interaction kind.');
    await tx.execute(sql`update agent_interactions set status='answered',response=${JSON.stringify(accepted)}::jsonb,answered_by='local-gateway',revision=revision+1,updated_at=now() where id=${request.interactionId}`);
    await tx.execute(sql`update agent_tool_calls set status='completed',result=${JSON.stringify(accepted)}::jsonb,updated_at=now() where run_id=${request.runId} and call_id=${interaction.call_id}`);
    const observations = [...(run.observations as unknown[]), { tool, callId: interaction.call_id, result: accepted }];
    await tx.execute(sql`update agent_runs set status='running',observations=${JSON.stringify(observations)}::jsonb,lease_until=now()+interval '3 minutes',revision=revision+1,updated_at=now() where id=${request.runId}`);
    await event(tx, request.runId, 'interaction.answered', { interactionId: request.interactionId, response: accepted });
    return true;
  });
  if (shouldAdvance) await advance(request.runId, request.storyId);
  return snapshot(request.runId, request.storyId);
}

export async function cancelAgentRun(input: unknown) {
  const { runId, storyId } = runIdSchema.parse(input);
  await getDb().transaction(async tx => {
    const run = await scopedRun(runId, storyId, true, tx);
    if (run.status === 'cancelled') return;
    if (!['running', 'awaiting_input'].includes(text(run.status))) throw new MutationError('REVISION_CONFLICT', 'This run can no longer be cancelled.');
    await tx.execute(sql`update agent_runs set status='cancelled',revision=revision+1,updated_at=now() where id=${runId}`);
    await tx.execute(sql`update agent_interactions set status='cancelled',revision=revision+1,updated_at=now() where run_id=${runId} and status='pending'`);
    await event(tx, runId, 'run.cancelled', {});
  });
  return snapshot(runId, storyId);
}

export async function listAgentRunEvents(input: unknown) {
  const request = runIdSchema.extend({ after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }).parse(input);
  await scopedRun(request.runId, request.storyId);
  return getDb().execute(sql`select seq,run_id,event_type,data,created_at from agent_run_events where run_id=${request.runId} and seq > ${request.after} order by seq limit ${request.limit}`);
}

async function planNext(run: Row): Promise<Decision> {
  const priorCalls = await getDb().execute(sql`select tool,call_id from agent_tool_calls where run_id=${run.id} order by created_at,call_id`);
  if (priorCalls.length >= MAX_AGENT_TOOL_CALLS) return recordDecision(run, { kind: 'final', text: 'Tool budget reached; continue the turn using validated observations.' });
  const turn = turnRequestSchema.parse(run.request);
  const prepared = await prepareServerTurnContext(turn, { inspection: true });
  const settings = await getAgentSettings({ projectId: run.project_id, gameId: run.game_id });
  const actorDecision = await resolveServiceGeneration('actorDecision');
  const jevAvailable = Boolean(actorDecision.profile && isJevModel(actorDecision.generation.model));
  const usedNames = (run.observations as Array<{ tool?: string }>).some(observation => observation.tool === 'generateNames');
  const usedImage = (run.observations as Array<{ tool?: string }>).some(observation => observation.tool === 'generateImage' || observation.tool === 'generateFileImage');
  const [ownedDocuments] = await getDb().execute(sql`select exists(select 1 from content_items where project_id=${run.project_id} and game_id=${run.game_id} and deleted_at is null and branch_id is null and pov_character is null) as available`);
  const rejectedUpdate = (run.observations as Array<{ tool?: string; result?: { status?: string } }>).some(observation => observation.tool === 'update' && observation.result?.status === 'invalid_target');
  const enabled = availablePlannerTools(implemented.filter(tool => {
    if (tool === 'update' && (!ownedDocuments?.available || rejectedUpdate)) return false;
    if (tool === 'askJev' && !jevAvailable) return false;
    if (tool === 'generateNames' && usedNames) return false;
    if ((tool === 'generateImage' || tool === 'generateFileImage') && usedImage) return false;
    try { assertAgentToolAllowed({ role: 'gm', projectId: text(run.project_id), gameId: text(run.game_id) }, tool, { projectId: text(run.project_id), gameId: text(run.game_id) }, settings.effective, implemented); return true; } catch { return false; }
  }), priorCalls.map(row => text(row.tool)));
  const observations = (run.observations as unknown[]).slice(-6);
  const observationsText = formatAgentObservations(currentJevObservations(observations).rows, 1_800);
  const contextFingerprint = hash({ prompt: prepared.prompt.prompt, messages: prepared.prompt.messages, systemDynamic: prepared.narrativeSystemDynamic, settings: settings.sources });
  await getDb().execute(sql`update agent_runs set context_fingerprint=${contextFingerprint},settings_fingerprint=${hash(settings.effective)},updated_at=now() where id=${run.id} and status='running'`);
  const instruction = `You are the GameMaster's bounded tool planner. The canonical game context follows as evidence. You may request multiple independent native tools in this round, within the remaining tool budget, or finish tool use. Tool results arrive in the next round; never make a call that depends on another call's unseen result. A player question, player roll, document or map change, or image request ends this round; wait for its result before planning more tools. Never narrate the turn here. Use only enabled tools: ${enabled.join(', ')}. Check consequential gaps in scene facts, history, actor knowledge, and rules; proactively use a bounded lookup when it can resolve a material uncertainty before narration. Stop looking once the evidence is sufficient. Research returns public, source-linked excerpts; recall can search GM-only history and lore, then read a specific hit. Keep recall results out of player and NPC knowledge until separately established. Let NPCs and the world make supported choices; do not ask the player to direct them. The update tool edits only existing game-owned custom documents whose item and type revisions were read from that document. Never use it for a character, canonical world record, campaign file, or story clock; canonical changes belong in the turn update pipeline. Ask a player question only when their choice is necessary. If the player explicitly leaves independent choices unresolved, ask each one separately before narration; ask only one question in this tool round. Give each independent choice its own descriptive option IDs; reuse those IDs if restating that choice. When a named NPC's consequential choice is uncertain, use askJev with that actor's ID and two to five concrete plausible actions. Set purpose to immediate_response when the options answer this player's immediate action, so the turn can reuse the result in narration and dialogue. A previous offer accepted by the player is settled evidence: include honoring the terms among plausible actions, not a repeat demand. Jev's actor-scoped answer is advice, not canon or a reason to override established behavior. Do not ask JEV for routine or already-settled reactions. For dice, use the game's actual rules and notation (such as 2d6+3, 4d6kh3, 2d20kl1, 6d6[Pool], or 4dF+2); never assume d20 or treat a sum as success without the rules. Use generateNames for a requested list of new names when enabled; candidates are not canon. ${usedNames ? 'Name candidates were already generated in this run. Use those exact candidates; do not request generateNames again.' : ''} Use image tools only when the player explicitly asks for an image, and report the returned image receipt accurately. ${usedImage ? 'An image was already requested in this run; do not request another image tool.' : ''} Never invent scope, roles, IDs, evidence, or a prior result. Previous validated observations: ${observationsText}. A player answer in these observations is accepted and cannot be retracted by you; do not ask the same choice again. Finish tool use when you have enough evidence for the turn.`;
  const prompt = prepared.narrativePrompt;
  const plannerService = await resolveServiceGeneration('classifier');
  const profile = requireResolvedServiceProfile('classifier', plannerService);
  const plannerInstruction = `${MAX_AGENT_TOOL_CALLS - priorCalls.length} tool calls remain. Avoid repeating completed lookups. For world.actor.brief supply args.actorId or args.name from known context. ${instruction}`;
  const plannerBudgeted = prepared.narrativeSystemDynamic ? applyPromptContextBudget(prepared.prompt.prompt,
    Math.min(5_000, countTokens(prepared.narrativeSystemDynamic)), undefined,
    prepared.prompt.contextRecords.filter(record => ['campaignState', 'locationLore', 'locationPlaces', 'entities', 'chapters', 'arcs', 'requiredPlayer', 'requiredScene', 'requiredActors', 'requiredBeliefs', 'contentPinned', 'contentPartial'].includes(record.kind)),
    prepared.prompt.contextRecords.filter(record => ['requiredPlayer', 'requiredScene', 'requiredActors', 'requiredBeliefs', 'contentPinned', 'contentPartial'].includes(record.kind))) : null;
  const plannerContext = plannerBudgeted?.value ?? '';
  const options = { profile, model: plannerService.generation.model ?? undefined, temperature: 0, reasoningEffort: 'off', maxTokens: 8192, timeoutMs: 120_000, maxRetries: 0, system: plannerInstruction, systemDynamic: plannerContext, messages: prepared.prompt.messages, prompt };
  const plannerSourceStatus = prepared.prompt.contextRecords.map(record => {
    const length = record.end - record.start;
    const retained = (plannerBudgeted?.mappings ?? []).reduce((sum, mapping) =>
      sum + Math.max(0, Math.min(record.end, mapping.sourceEnd) - Math.max(record.start, mapping.sourceStart)), 0);
    return { id: `${record.kind}:${record.id}`, status: retained >= length ? 'retained' : retained > 0 ? 'partial' : 'omitted' };
  });
  const sourceIdsWithStatus = (status: string) => [...new Set(plannerSourceStatus.filter(source => source.status === status).map(source => source.id))];
  const plannerReceipt = { tokens: { system: countTokens(plannerInstruction), context: countTokens(plannerContext),
    history: prepared.prompt.messages.reduce((sum, message) => sum + countTokens(message.content), 0), action: countTokens(prompt) },
    retainedSourceIds: sourceIdsWithStatus('retained'), partialSourceIds: sourceIdsWithStatus('partial'),
    omittedSourceIds: sourceIdsWithStatus('omitted'), historySourceIds: prepared.prompt.dialogueSourceIds,
    historyPartialSourceIds: prepared.prompt.dialoguePartialSourceIds ?? [], contextHash: hash(plannerContext) };
  let generated;
  const attempts: Awaited<ReturnType<typeof generateServerTextWithMetrics>>[] = [];
  try {
    generated = await generateAgentText(run, 'turn.gm_planner', { ...options, tools: enabled.map(tool => definitions[tool]), parallelToolCalls: true });
    attempts.push(generated);
  } catch (error) {
    if (!(error instanceof ServerGenerationError) || ![400, 404, 422].includes(error.result.statusCode ?? 0)) throw error;
    generated = await generateAgentText(run, 'turn.gm_planner.fallback', { ...options, responseFormat: 'json_object', system: `${instruction} Return exactly {"kind":"final","text":"done"} or {"kind":"tool","tool":"enabled name","callId":"stable ID","args":{...}} as one complete JSON object.` });
    attempts.push(generated);
  }
  if (!generated.toolCalls?.length && !generated.text.trim()) {
    generated = await generateAgentText(run, 'turn.gm_planner.retry', { ...options, responseFormat: 'json_object', system: `${instruction} Return one complete JSON decision now. If no further tool is essential, return {"kind":"final","text":"done"}.` });
    attempts.push(generated);
  }
  const invalidCall = generated.toolCalls?.map(item => toolSchema.safeParse({ tool: item.name, callId: item.id, args: item.arguments }))
    .find(result => !result.success);
  if (invalidCall && !invalidCall.success) {
    const errors = invalidCall.error.issues.slice(0, 4).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    generated = await generateAgentText(run, 'turn.gm_planner.invalid_tool_retry', { ...options,
      tools: enabled.map(tool => definitions[tool]), parallelToolCalls: true,
      system: `${plannerInstruction} Your previous tool call failed validation: ${errors}. Regenerate concise tool calls within the schema limits; do not drop required player choices.` });
    attempts.push(generated);
  }
  await getDb().transaction(async tx => {
    const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
    if (current.status !== 'running') return;
    const usage = [...(current.usage as unknown[]), ...attempts.map(attempt => ({ model: attempt.model, durationMs: attempt.durationMs, ...attempt.usage }))].slice(-8);
    await tx.execute(sql`update agent_runs set usage=${JSON.stringify(usage)}::jsonb,updated_at=now() where id=${run.id}`);
    for (const attempt of attempts) await event(tx, text(run.id), 'provider.completed', { model: attempt.model, finishReason: attempt.finishReason ?? null, toolCallCount: attempt.toolCalls?.length ?? 0, plannerReceipt });
  });
  if (generated.finishReason === 'length') throw new Error('GM tool planner reached its output limit before a complete decision.');
  if (!generated.toolCalls?.length && !generated.text.trim()) return recordDecision(run, { kind: 'final', text: 'Planner produced no decision after retry; continue using validated observations.' });
  if (generated.toolCalls?.length) {
    const calls = generated.toolCalls.map(item => {
      const parsed = toolSchema.safeParse({ tool: item.name, callId: item.id, args: item.arguments });
      if (!parsed.success) throw new Error('GM tool planner returned invalid tool arguments after retry.');
      return parsed.data;
    });
    const selected = selectPlannerToolCalls(calls, enabled, priorCalls.map(row => ({ tool: text(row.tool), callId: text(row.call_id) })));
    return recordDecision(run, selected.length ? { kind: 'tools', calls: selected } : { kind: 'final', text: 'Planner requested unavailable or exhausted tools; continue using validated observations.' });
  }
  const value = generated.text.trim();
  if (value.startsWith('{')) {
    const parsed = z.discriminatedUnion('kind', [z.object({ kind: z.literal('final'), text: z.string().max(1000).default('') }).strict(), z.object({ kind: z.literal('tool'), tool: z.string(), callId: z.string(), args: z.record(z.string(), z.unknown()) }).strict()]).parse(JSON.parse(value));
    if (parsed.kind === 'tool') {
      if (usedNames && parsed.tool === 'generateNames') return recordDecision(run, { kind: 'final', text: 'Name candidates ready.' });
      if (usedImage && ['generateImage', 'generateFileImage'].includes(parsed.tool)) return recordDecision(run, { kind: 'final', text: 'Image already requested.' });
      const call = toolSchema.parse(parsed);
      return recordDecision(run, enabled.includes(call.tool) ? { kind: 'tool', call } : { kind: 'final', text: 'Planner requested an unavailable tool; continue using validated observations.' });
    }
    return recordDecision(run, parsed);
  }
  return recordDecision(run, { kind: 'final', text: value.slice(0, 1000) });
}

type Decision = { kind: 'final'; text: string } | { kind: 'tool'; call: ToolCall } | { kind: 'tools'; calls: ToolCall[] };
const decisionSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('final'), text: z.string() }), z.object({ kind: z.literal('tool'), call: toolSchema }), z.object({ kind: z.literal('tools'), calls: z.array(toolSchema).min(1).max(MAX_AGENT_TOOL_CALLS) })]);
async function recordDecision(run: Row, decision: Decision): Promise<Decision> {
  await getDb().transaction(async tx => {
    const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
    if (current.status !== 'running') throw new MutationError('REVISION_CONFLICT', 'Run stopped before the provider decision was saved.');
    const continuation = [...(current.continuation as unknown[]), { kind: 'assistant', decision }].slice(-14);
    await tx.execute(sql`update agent_runs set pending_decision=${JSON.stringify(decision)}::jsonb,continuation=${JSON.stringify(continuation)}::jsonb,updated_at=now() where id=${run.id}`);
    await event(tx, text(run.id), 'provider.decision', { kind: decision.kind, callIds: decision.kind === 'tools' ? decision.calls.map(call => call.callId) : decision.kind === 'tool' ? [decision.call.callId] : [] });
  });
  return decision;
}

async function reserveCall(run: Row, call: ToolCall) {
  const argsHash = hash({ tool: call.tool, args: call.args });
  return getDb().transaction(async tx => {
    const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
    if (current.status !== 'running') throw new MutationError('REVISION_CONFLICT', 'Run stopped before the tool call.');
    const pending = current.pending_decision ? decisionSchema.parse(current.pending_decision) : null;
    const remainder = pending?.kind === 'tools' && pending.calls[0]?.callId === call.callId
      ? pending.calls.length > 1 ? { kind: 'tools' as const, calls: pending.calls.slice(1) } : null
      : pending?.kind === 'tool' && pending.call.callId === call.callId ? null : pending;
    const [existing] = await tx.execute(sql`select * from agent_tool_calls where run_id=${run.id} and call_id=${call.callId}`);
    if (existing) {
      if (existing.args_hash !== argsHash) throw new MutationError('REVISION_CONFLICT', 'Provider reused a call ID with different arguments.');
      await tx.execute(sql`update agent_runs set pending_decision=${remainder ? JSON.stringify(remainder) : null}::jsonb where id=${run.id}`);
      return existing as Row;
    }
    const [{ count }] = await tx.execute(sql`select count(*)::int as count from agent_tool_calls where run_id=${run.id}`);
    if (Number(count) >= MAX_AGENT_TOOL_CALLS) throw new Error('Tool call limit reached.');
    const [saved] = await tx.execute(sql`insert into agent_tool_calls(run_id,call_id,tool,args_hash,args,status) values(${run.id},${call.callId},${call.tool},${argsHash},${JSON.stringify(call.args)}::jsonb,'reserved') returning *`);
    await tx.execute(sql`update agent_runs set pending_decision=${remainder ? JSON.stringify(remainder) : null}::jsonb where id=${run.id}`);
    await event(tx, text(run.id), 'tool.reserved', { callId: call.callId, tool: call.tool });
    return saved as Row;
  });
}

async function executeCall(run: Row, call: ToolCall) {
  const authority: AgentAuthority = { role: 'gm', projectId: text(run.project_id), gameId: text(run.game_id) };
  const settings = await getAgentSettings({ projectId: run.project_id, gameId: run.game_id });
  assertAgentToolAllowed(authority, call.tool, { projectId: authority.projectId, gameId: authority.gameId, id: 'id' in call.args ? text(call.args.id) : undefined }, settings.effective, implemented);
  const ledger = await reserveCall(run, call);
  if (ledger.status === 'completed') {
    if (call.tool === 'askUserQuestion') await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      if (current.status !== 'running') return;
      await tx.execute(sql`update agent_runs set status='committing',lease_until=now()+interval '3 minutes',revision=revision+1,updated_at=now() where id=${run.id}`);
      await event(tx, text(run.id), 'interaction.reused', { callId: call.callId });
    });
    return;
  }
  if (call.tool === 'read' && call.args.command === 'world.actor.brief' && !actorBriefArgsSchema.safeParse(call.args.args).success) {
    await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      if (current.status === 'running') await completeCall(tx, current, call, { status: 'invalid_args', error: 'world.actor.brief requires args.actorId or args.name.' });
    });
    return;
  }
  if (call.tool === 'askUserQuestion') {
    const distinct = new Set(call.args.options.map(option => option.id));
    if (distinct.size !== call.args.options.length) throw new MutationError('INVALID_FIELD', 'Question option IDs must be distinct.');
    await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      if (current.status !== 'running') throw new MutationError('REVISION_CONFLICT', 'Run stopped before the question.');
      const [prior] = await tx.execute(sql`select id from agent_interactions where run_id=${run.id} and call_id=${call.callId}`);
      if (prior) return;
      const answered = await tx.execute(sql`select prompt,options,options_meta,response from agent_interactions where run_id=${run.id} and status='answered'`);
      const repeated = answered.find(item => sameAgentQuestion(call.args, { prompt: text(item.prompt), options: item.options as Array<{ id: string; label: string }>, allowCustom: Boolean(object(item.options_meta).allowCustom) }));
      if (repeated) {
        await completeCall(tx, current, call, { alreadyAnswered: repeated.response });
        await tx.execute(sql`update agent_runs set status='committing',lease_until=now()+interval '3 minutes',revision=revision+1,updated_at=now() where id=${run.id}`);
        await event(tx, text(run.id), 'interaction.reused', { callId: call.callId });
        return;
      }
      const interactionId = `interaction_${randomUUID()}`;
      await tx.execute(sql`insert into agent_interactions(id,run_id,call_id,kind,prompt,options,options_meta,status,expires_at) values(${interactionId},${run.id},${call.callId},'question',${call.args.prompt},${JSON.stringify(call.args.options)}::jsonb,${JSON.stringify({ allowCustom: call.args.allowCustom })}::jsonb,'pending',now()+interval '24 hours')`);
      await tx.execute(sql`update agent_runs set status='awaiting_input',lease_until=null,revision=revision+1,updated_at=now() where id=${run.id}`);
      await event(tx, text(run.id), 'interaction.pending', { interactionId, callId: call.callId, prompt: call.args.prompt, options: call.args.options, allowCustom: call.args.allowCustom });
    });
    return;
  }
  if (call.tool === 'askPlayerToRoll') {
    parseSystemDice(call.args.diceExpression);
    await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      if (current.status !== 'running') throw new MutationError('REVISION_CONFLICT', 'Run stopped before the roll request.');
      const [prior] = await tx.execute(sql`select id from agent_interactions where run_id=${run.id} and call_id=${call.callId}`);
      if (prior) return;
      const interactionId = `interaction_${randomUUID()}`;
      const slug = call.args.targetCharacterSlug ?? '';
      const normalized = slug.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const matches = normalized ? await tx.execute(sql`select distinct e.id,e.name from entities e left join entity_aliases a on a.story_id=e.story_id and a.entity_id=e.id where e.story_id=${run.game_id} and e.type='character' and e.visibility in ('public','player_known') and (e.id=${slug} or trim(regexp_replace(lower(e.name),'[^a-z0-9]+',' ','g'))=${normalized} or a.normalized_alias=${normalized}) order by e.id limit 2`) : [];
      const character = matches.length === 1 ? matches[0] : null;
      const meta = { diceExpression: call.args.diceExpression, skillName: call.args.skillName ?? null, targetCharacterSlug: slug || null, targetCharacterId: character?.id ?? null, targetCharacterName: character?.name ?? null };
      await tx.execute(sql`insert into agent_interactions(id,run_id,call_id,kind,prompt,options,options_meta,status,expires_at) values(${interactionId},${run.id},${call.callId},'roll',${call.args.reason},'[]'::jsonb,${JSON.stringify(meta)}::jsonb,'pending',now()+interval '24 hours')`);
      await tx.execute(sql`update agent_runs set status='awaiting_input',lease_until=null,revision=revision+1,updated_at=now() where id=${run.id}`);
      await event(tx, text(run.id), 'interaction.pending', { interactionId, callId: call.callId, kind: 'roll', reason: call.args.reason, ...meta });
    });
    return;
  }
  if (call.tool === 'askJev') {
    let result: Record<string, unknown>;
    const turn = turnRequestSchema.parse(run.request);
    const actionContext = jevActionContext(turn.playerText, run.observations as unknown[]);
    let attempt: Record<string, unknown> = { question: call.args.question, purpose: call.args.purpose,
      actorId: call.args.actorId, playerActionHash: actionContext.actionHash, advisory: true };
    try {
      if (object(ledger.result).networkAttempted === true) {
        attempt = object(ledger.result);
        result = { ...attempt, status: 'unavailable', reason: 'JEV request was interrupted; its result is unknown and will not be requested again.' };
      } else {
        const service = await resolveServiceGeneration('actorDecision');
        if (!service.profile || !isJevModel(service.generation.model)) {
          result = { ...attempt, status: 'unavailable', reason: 'JEV is not enabled for Actor Decisions.' };
        } else {
          const actorView = await getActorDecisionView(text(run.game_id), { actorId: call.args.actorId, eventLimit: 6 });
          if (actorView.unresolved.length) {
            result = { ...attempt, status: 'insufficient_evidence', reason: actorView.unresolved.join(' '), sourceIds: boundedJevSourceIds(actorView.sourceIds) };
          } else {
              const answered = actionContext.playerInteractions.length
                ? await getDb().execute(sql`select call_id,prompt,options from agent_interactions
                    where run_id=${run.id} and status='answered' order by created_at,id limit 8`) : [];
              const interactionEvidence = actionContext.playerInteractions.map(item => {
                const match = answered.find(row => row.call_id === item.callId);
                const selected = (Array.isArray(match?.options) ? match.options : [])
                  .find(option => object(option).id === object(item.result).optionId);
                return { ...item, prompt: match?.prompt ?? null, selectedLabel: object(selected).label ?? null };
              });
            const actorEvidence = object(actorView.data);
            const availableSourceIds = new Set(boundedJevSourceIds([call.args.actorId, ...actorView.sourceIds]));
            const memoryOptions = [
              ...((Array.isArray(actorEvidence.beliefs) ? actorEvidence.beliefs : []) as unknown[]).map(item => ({
                id: text(object(item).id), description: text(object(item).belief),
              })),
              ...((Array.isArray(actorEvidence.witnessedEvents) ? actorEvidence.witnessedEvents : []) as unknown[]).map(item => ({
                id: text(object(item).id), description: `${text(object(item).title)}: ${text(object(item).body)}`,
              })),
              ...((Array.isArray(actorEvidence.commitments) ? actorEvidence.commitments : []) as unknown[]).map(item => ({
                id: text(object(item).id), description: text(object(item).terms),
              })),
            ].filter(item => availableSourceIds.has(item.id) && item.description.trim()).slice(0, 5)
              .map(item => ({ ...item, description: item.description.slice(0, 220) }));
            attempt = { ...attempt, networkAttempted: true,
              evidenceHash: hash({ actorEvidence: actorView.data, sourceIds: actorView.sourceIds }),
              configuredModel: service.generation.model,
              sourceIds: boundedJevSourceIds([call.args.actorId, ...actorView.sourceIds]) };
            // ponytail: an interrupted request may lose advice; replaying it risks a second paid decision.
            const [claimed] = await getDb().execute(sql`update agent_tool_calls set result=${JSON.stringify(attempt)}::jsonb,updated_at=now()
              where run_id=${run.id} and call_id=${call.callId} and status='reserved' and result is null returning call_id`);
            if (!claimed) {
              result = { ...attempt, status: 'unavailable', reason: 'JEV request was already attempted; its result is unknown.' };
            } else {
              const decision = await chooseJevOption({ profile: service.profile, model: service.generation.model!,
                storyId: text(run.game_id), operation: 'agent.askJev', psychology: true,
                evidence: { question: call.args.question, playerAction: turn.playerText,
                  playerInteractions: interactionEvidence, actorEvidence: actorView.data },
                sourceIds: [call.args.actorId, ...actorView.sourceIds],
                options: [...call.args.options, { id: 'hold', description: 'Hold or defer because this actor lacks a supported reason to choose a proposed action now.' }],
                memoryOptions });
              result = decision ? { ...attempt, status: decision.optionId === 'hold' ? 'held' : 'proposed',
                decisionTaskVersion: 'immediate_response_v1', candidateOptions: call.args.options,
                optionId: decision.optionId,
                selectedDescription: call.args.options.find(option => option.id === decision.optionId)?.description ?? null,
                selectedMemoryId: decision.memoryId,
                selectedMemoryText: memoryOptions.find(option => option.id === decision.memoryId)?.description ?? null,
                confidence: decision.confidence, sourceIds: decision.sourceIds, model: decision.model,
				...(decision.psychology ? { psychology: decision.psychology } : {}),
                usage: decision.usage } : { ...attempt, status: 'insufficient_evidence' };
            }
          }
        }
      }
    } catch (error) {
      result = { ...attempt, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
    }
    await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      if (current.status !== 'running') return;
      const [savedCall] = await tx.execute(sql`select status from agent_tool_calls where run_id=${run.id} and call_id=${call.callId} for update`);
      if (savedCall?.status !== 'completed') await completeCall(tx, current, call, result);
    });
    return;
  }
  if (call.tool === 'gmRollDice') {
    await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      if (current.status !== 'running') throw new MutationError('REVISION_CONFLICT', 'Run stopped before the roll.');
      const [savedCall] = await tx.execute(sql`select status from agent_tool_calls where run_id=${run.id} and call_id=${call.callId} for update`);
      if (savedCall?.status === 'completed') return;
      const portraitUrl = call.args.fileName ? await resolveGmRollFilePortrait(tx, text(run.project_id), text(run.game_id), call.args.fileName) : null;
      const result = { reason: call.args.reason, fileName: call.args.fileName ?? null, portraitUrl, ...rollSystemDice(call.args.diceExpression) };
      await completeCall(tx, current, call, result);
    });
    return;
  }
  if ((call.tool === 'generateImage' || call.tool === 'generateFileImage') && (run.observations as Array<{ tool?: string }>).some(observation => observation.tool === 'generateImage' || observation.tool === 'generateFileImage'))
    throw new MutationError('TOOL_DENIED', 'An image was already requested in this GM run.');
  if (call.tool === 'generateNames') {
    let generated: Awaited<ReturnType<typeof generateServerTextWithMetrics>> | null = null;
    let result: { status: 'ok'; names: string[]; intent: string } | { status: 'unavailable'; reason: string };
    try {
      const prepared = await prepareServerTurnContext(turnRequestSchema.parse(run.request), { inspection: true });
      const namesService = await resolveServiceGeneration('classifier');
      generated = await generateAgentText(run, 'turn.generate_names', {
        profile: requireResolvedServiceProfile('classifier', namesService), model: namesService.generation.model ?? undefined,
        temperature: 0.75, maxTokens: 512 + call.args.count * 64, timeoutMs: 30_000, maxRetries: 0,
        system: 'Generate name candidates only. Follow the campaign naming instructions and requested style. Return exactly one JSON object with a names array of the requested length. Each name must be distinct, 2-80 characters, and absent from the exclusions. Do not create or claim canonical characters, places, or organizations.',
        systemDynamic: prepared.narrativeSystemDynamic.slice(0, 6_000),
        prompt: JSON.stringify({ request: call.args, campaignContext: prepared.narrativePrompt.slice(-5_000) }),
      });
      if (generated.finishReason === 'length') throw new Error('Name generation reached its output limit.');
      result = { status: 'ok', intent: call.args.intent, names: parseNameCandidates(generated.text, call.args.count, call.args.exclude) };
    } catch {
      result = { status: 'unavailable', reason: 'Name generation was unavailable or returned invalid candidates. No names were applied.' };
    }
    await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      if (current.status !== 'running') return;
      const [savedCall] = await tx.execute(sql`select status from agent_tool_calls where run_id=${run.id} and call_id=${call.callId} for update`);
      if (savedCall?.status === 'completed') return;
      if (generated) {
        const usage = [...(current.usage as unknown[]), { model: generated.model, durationMs: generated.durationMs, ...generated.usage }].slice(-8);
        await tx.execute(sql`update agent_runs set usage=${JSON.stringify(usage)}::jsonb,updated_at=now() where id=${run.id}`);
      }
      await completeCall(tx, current, call, result);
    });
    return;
  }
  if (call.tool === 'generateImage' || call.tool === 'generateFileImage') {
    const receipt = await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      if (current.status !== 'running') throw new MutationError('REVISION_CONFLICT', 'Run stopped before the image request.');
      const [savedCall] = await tx.execute(sql`select status from agent_tool_calls where run_id=${run.id} and call_id=${call.callId} for update`);
      if (savedCall?.status === 'completed') return;
      return reserveExplicitImage(tx, { role: 'gm', projectId: authority.projectId, gameId: authority.gameId,
        runId: text(run.id), callId: call.callId, prompt: call.args.prompt,
        ...(call.tool === 'generateFileImage' ? { fileName: call.args.fileName } : {}) });
    });
    if (!receipt) return;
    const result = await completeDirectImageRequest(receipt);
    await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      await completeCall(tx, current, call, result);
    });
    return;
  }
  if (call.tool === 'update') {
    await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      if (current.status !== 'running') throw new MutationError('REVISION_CONFLICT', 'Run stopped before the update.');
      const [savedCall] = await tx.execute(sql`select status from agent_tool_calls where run_id=${run.id} and call_id=${call.callId} for update`);
      if (savedCall?.status === 'completed') return;
      const [item] = await tx.execute(sql`select game_id,branch_id,pov_character from content_items where id=${call.args.id} and project_id=${run.project_id} and deleted_at is null`);
      if (!item || item.game_id !== run.game_id || item.branch_id || item.pov_character) {
        await completeCall(tx, current, call, { status: 'invalid_target', reason: 'This is not an unscoped game-owned custom document. Continue the turn without this tool; canonical world changes belong in the turn update pipeline.' });
        return;
      }
      const result = await updateContentInTransaction(tx, { ...call.args, projectId: run.project_id, gameId: run.game_id }, { role: 'gm', runId: run.id, callId: call.callId, initiatedBy: 'local-user' });
      await completeCall(tx, current, call, result);
    });
    return;
  }
  if (call.tool === 'map') {
    const result = call.args.action === 'get'
      ? await getLocationMap(text(run.game_id), { locationId: call.args.locationId })
      : await saveLocationMap(text(run.game_id), locationMapSaveSchema.parse({ locationId: call.args.locationId,
          expectedRevision: call.args.expectedRevision, map: call.args.map, reason: call.args.reason }), { kind: 'agent', runId: text(run.id), callId: call.callId });
    await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      if (current.status !== 'running') return;
      const [savedCall] = await tx.execute(sql`select status from agent_tool_calls where run_id=${run.id} and call_id=${call.callId} for update`);
      if (savedCall?.status !== 'completed') await completeCall(tx, current, call, result);
    });
    return;
  }
  if (call.tool === 'research') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      runCompactResearch({ storyId: text(run.game_id), projectId: text(run.project_id), question: call.args.question, runId: text(run.id), callId: call.callId }),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unavailable', question: call.args.question, reason: 'Local Research exceeded its 7-second budget.', statements: [], unresolved: [call.args.question], gaps: ['timeout'], mode: 'local_extract' }), 7_000); }),
    ]).catch(error => ({ status: 'unavailable', question: call.args.question, reason: error instanceof Error ? error.message : String(error), statements: [], unresolved: [call.args.question], gaps: ['local Research failed'], mode: 'local_extract' })).finally(() => clearTimeout(timer));
    await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      if (current.status !== 'running') return;
      const [savedCall] = await tx.execute(sql`select status from agent_tool_calls where run_id=${run.id} and call_id=${call.callId} for update`);
      if (savedCall?.status !== 'completed') await completeCall(tx, current, call, result);
    });
    return;
  }
  if (call.tool === 'recall') {
    let result: unknown;
    try {
      const args = boundedRecallArgs(call.args.command, call.args.args);
      const response = await executeEngineCommand({ storyId: text(run.game_id), command: call.args.command,
        args: normalizeGmToolArgs({ command: call.args.command, args }), clientCommandId: `${run.id}:${call.callId}` });
      result = response.status === 'succeeded' ? response.result : { status: 'unavailable', error: response.error ?? `${call.args.command} failed.` };
    } catch (error) {
      result = { status: 'unavailable', error: error instanceof Error ? error.message : String(error) };
    }
    await getDb().transaction(async tx => {
      const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
      if (current.status !== 'running') return;
      const [savedCall] = await tx.execute(sql`select status from agent_tool_calls where run_id=${run.id} and call_id=${call.callId} for update`);
      if (savedCall?.status !== 'completed') await completeCall(tx, current, call, result);
    });
    return;
  }
  const command = call.tool === 'read' ? call.args.command : call.tool === 'list' ? 'world.records' : 'world.search';
  const args = call.tool === 'read' ? call.args.args : call.tool === 'list' ? { ...(call.args.type ? { type: call.args.type } : {}), limit: call.args.limit } : { q: call.args.query, limit: 10, includeSemantic: false };
  const response = await executeEngineCommand({ storyId: text(run.game_id), command, args, clientCommandId: `${run.id}:${call.callId}` });
  const result = response.status === 'succeeded' ? response.result : { status: 'unavailable', error: response.error ?? `${command} failed.` };
  await getDb().transaction(async tx => {
    const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
    if (current.status !== 'running') return;
    const [savedCall] = await tx.execute(sql`select status from agent_tool_calls where run_id=${run.id} and call_id=${call.callId} for update`);
    if (savedCall?.status !== 'completed') await completeCall(tx, current, call, result);
  });
}

async function completeCall(tx: Tx, run: Row, call: ToolCall, result: unknown) {
  const serialized = JSON.stringify(result ?? null);
  const value = serialized.length <= 10_000 ? result ?? null : { excerpt: serialized.slice(0, 10_000) };
  const observations = [...(run.observations as unknown[]), { tool: call.tool, callId: call.callId,
    ...(call.tool === 'recall' ? { command: call.args.command } : {}), result: value }];
  await tx.execute(sql`update agent_tool_calls set status='completed',result=${JSON.stringify(value)}::jsonb,updated_at=now() where run_id=${run.id} and call_id=${call.callId}`);
  await tx.execute(sql`update agent_runs set observations=${JSON.stringify(observations)}::jsonb,revision=revision+1,updated_at=now() where id=${run.id}`);
  await event(tx, text(run.id), 'tool.completed', call.tool === 'recall'
    ? { callId: call.callId, tool: call.tool, status: object(value).status ?? 'completed' }
    : { callId: call.callId, tool: call.tool, result: value });
}

async function advance(runId: string, storyId: string) {
  try {
    for (let round = 0; round < MAX_AGENT_TOOL_CALLS + 2; round += 1) {
      const run = await scopedRun(runId, storyId);
      if (run.status === 'awaiting_input' || run.status === 'cancelled' || run.status === 'failed' || run.status === 'completed') return;
      if (run.status === 'committing') { await completeTurn(run); return; }
      const [reserved] = await getDb().execute(sql`select * from agent_tool_calls where run_id=${runId} and status='reserved' order by created_at,call_id limit 1`);
      if (reserved) {
        await executeCall(run, toolSchema.parse({ tool: reserved.tool, callId: reserved.call_id, args: reserved.args }));
        continue;
      }
      const decision = run.pending_decision ? decisionSchema.parse(run.pending_decision) : await planNext(run);
      const latest = await scopedRun(runId, storyId);
      if (latest.status !== 'running') return;
      if (decision.kind === 'tool') { await executeCall(latest, decision.call); continue; }
      if (decision.kind === 'tools') { await executeCall(latest, decision.calls[0]); continue; }
      await getDb().transaction(async tx => {
        const current = await scopedRun(runId, storyId, true, tx);
        if (current.status !== 'running') throw new MutationError('REVISION_CONFLICT', 'Run changed before completion.');
        await tx.execute(sql`update agent_runs set status='committing',pending_decision=null,result=${JSON.stringify({ plannerText: decision.text })}::jsonb,lease_until=now()+interval '3 minutes',revision=revision+1,updated_at=now() where id=${runId}`);
        await event(tx, runId, 'run.committing', {});
      });
      await completeTurn(await scopedRun(runId, storyId));
      return;
    }
    throw new Error('Agent tool-round limit reached.');
  } catch (error) {
    await getDb().transaction(async tx => {
      const run = await scopedRun(runId, storyId, true, tx);
      if (!['running', 'committing'].includes(text(run.status))) return;
      await tx.execute(sql`update agent_runs set status='failed',error=${error instanceof Error ? error.message : String(error)},revision=revision+1,updated_at=now() where id=${runId}`);
      await event(tx, runId, 'run.failed', { error: error instanceof Error ? error.message : String(error) });
    });
  }
}

export function hasAnsweredResearch(observations: readonly unknown[]): boolean {
  const lastPlayerInteraction = observations.findLastIndex(item =>
    ['askUserQuestion', 'askPlayerToRoll'].includes(String(object(item).tool ?? '')));
  return observations.slice(lastPlayerInteraction + 1).some(item => {
    const row = object(item), result = object(row.result);
    if (row.tool === 'recall') {
      if (!row.result || ['unavailable', 'insufficient_evidence', 'invalid', 'failed'].includes(String(result.status))
        || result.ok === false || result.missing === true || 'excerpt' in result
        || (Array.isArray(result.unresolved) && result.unresolved.length > 0)
        || ['world.search', 'wiki.search', 'wiki.pages'].includes(String(row.command))) return false;
      const sourceText = (value: unknown): boolean => {
        const evidence = object(value);
        return ['id', 'sourceId', 'path', 'relativePath', 'recordId'].some(key => typeof evidence[key] === 'string' && evidence[key].trim())
          && ['content', 'text', 'body', 'description', 'name'].some(key => typeof evidence[key] === 'string' && evidence[key].trim());
      };
      return sourceText(result) || sourceText(result.record) || sourceText(result.page)
        || ['entries', 'nodes', 'events', 'facts', 'pages'].some(key => Array.isArray(result[key]) && result[key].some(sourceText))
        || (Array.isArray(result.sourceIds) && result.sourceIds.some(id => typeof id === 'string' && id.trim())
          && sourceText(object(result.data).actor));
    }
    return row.tool === 'research' && result.status === 'answered'
      && Array.isArray(result.statements) && result.statements.some(statement => {
        const source = object(statement);
        return typeof source.sourceId === 'string' && source.sourceId.length > 0
          && typeof source.revision === 'string' && source.revision.length > 0
          && typeof source.statement === 'string' && source.statement.length > 0;
      });
  });
}

async function completeTurn(run: Row) {
  const current = currentJevObservations(run.observations as unknown[]);
  const observations = formatNarratorObservations(current.rows, 2_800);
  const actionHash = jevActionContext(turnRequestSchema.parse(run.request).playerText, run.observations as unknown[]).actionHash;
  const turn = await processServerTurn(run.request, {
    agentRunId: text(run.id), agentRunObservations: observations,
    agentJevDecisions: (current.rows as Array<{ tool?: string; result?: unknown }>).filter(item => item.tool === 'askJev').map(item => item.result),
    agentJevActionHash: actionHash,
    suppressAutomaticActorDecisions: current.playerIntervened,
    researchAlreadyPerformed: hasAnsweredResearch(run.observations as unknown[]),
    runGmTool: async call => {
      const response = await executeEngineCommand({ storyId: text(run.game_id), command: call.command, clientCommandId: `${run.id}:gm:${call.id}`, args: normalizeGmToolArgs(call) });
      if (response.status !== 'succeeded') throw new Error(response.error || `${call.command} failed.`);
      return response.result;
    },
  });
  await getDb().transaction(async tx => {
    const current = await scopedRun(text(run.id), text(run.game_id), true, tx);
    if (current.status === 'completed') return;
    if (current.status !== 'committing') throw new MutationError('REVISION_CONFLICT', 'Run changed while completing its turn.');
    await tx.execute(sql`update agent_runs set status='completed',result=${JSON.stringify({ turn })}::jsonb,lease_until=null,revision=revision+1,updated_at=now() where id=${run.id}`);
    await event(tx, text(run.id), 'run.completed', { clientTurnId: run.client_turn_id, serverVersion: turn.serverVersion });
  });
}
