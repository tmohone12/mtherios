import { randomUUID } from 'node:crypto';
import {
	apiCallLogCreateSchema,
	apiCallLogListArgsSchema,
	engineCampaignBootstrapArgsSchema,
	engineCampaignPageReadArgsSchema,
	engineCampaignPageWriteArgsSchema,
	engineCampaignStatusArgsSchema,
	engineCharacterDraftUpdateArgsSchema,
	engineCacheStatusArgsSchema,
	engineEntriesAroundArgsSchema,
	engineEntityDeleteArgsSchema,
	engineJobStatusArgsSchema,
	engineOrchestratorRunArgsSchema,
	enginePromptPacketDebugArgsSchema,
	engineRollupArcJobArgsSchema,
	engineRunDueJobsArgsSchema,
	engineStoryVaultSyncJobArgsSchema,
	engineTranscriptPageArgsSchema,
	engineTimelineAdvanceArgsSchema,
	engineTimelineBriefArgsSchema,
	engineTimelineScheduleArgsSchema,
	engineWorldRecordDetailArgsSchema,
	engineWorldRecordPatchArgsSchema,
	llmSettingsPatchSchema,
	reindexStoryRequestSchema,
	searchQuerySchema,
	type CampaignProjection,
	type EngineCacheStatus,
	type EngineCacheStatusArgs,
	type EngineCommandRequest,
	type EngineCommandResponse,
	type LlmServiceSetting,
	type LlmServiceSettingPatch,
	type RecordPatchRequest,
	worldRecordsQuerySchema,
} from '$lib/contracts/engine';
import type { GmTimelineBrief } from '$lib/contracts/memory';
import { worldDatabaseImportRequestSchema, type WorldDatabaseImportRequest } from '$lib/contracts/worldDatabase';
import {
	arcDeleteRequestSchema,
	arcUpsertRequestSchema,
	type BootstrapResponse,
	chapterDeleteRequestSchema,
	chapterUpsertRequestSchema,
	type ArcCommandResponse,
	type ArcDeleteResponse,
	type ChapterCommandResponse,
	type ChapterDeleteResponse,
	contextCheckpointCreateRequestSchema,
	contextCheckpointRevertRequestSchema,
	type ContextCheckpointCommandResponse,
	type ContextCheckpointListResponse,
	type ContextCheckpointRevertResponse,
	type EntityCommandResponse,
	type EntityDeleteResponse,
	indexedDbImportRequestSchema,
	createStoryRequestSchema,
	entityUpsertRequestSchema,
	type LivingMemoryCommandResponse,
	type SagaCommandResponse,
	memoryRetrieveRequestSchema,
	livingMemoryUpsertRequestSchema,
	sagaUpsertRequestSchema,
	type StoryEntriesPageResponse,
	syncPullRequestSchema,
	syncPushRequestSchema,
	turnRequestSchema,
	type RetrievedMemoryPacket,
	type TurnResponse,
} from '$lib/contracts/memory';
import { getCampaignProjection } from './projections';
import { getEngineCacheStatus } from './cache';
import {
	readCampaignPage,
	writeCampaignPage,
	type CampaignPageReadResult,
	type CampaignVaultWriteResult,
} from './campaignVault';
import {
	createContextCheckpoint,
	deleteBackendArc,
	deleteBackendChapter,
	deleteBackendEntity,
	deleteBackendStory,
	exportBackendStory,
	createBackendStory,
	getBootstrap,
	getStoryEntriesPage,
	importIndexedDbBundle,
	listContextCheckpoints,
	listBackendStories,
	revertToContextCheckpoint,
	upsertBackendArcFromLocal,
	upsertBackendChapterFromLocal,
	upsertBackendEntityFromEntry,
	upsertBackendLivingMemoryFromLocal,
	upsertBackendSagaFromLocal,
} from '$lib/server/memory/canonical';
import { prepareServerTurn, processServerTurn, type PreparedServerTurnSummary } from '$lib/server/turn/orchestrator';
import { publishEngineEvent } from './events';
import {
	advanceStoryTurn,
	loadGmTimelineBrief,
	promoteDueTimelineEvents,
	scheduleTimelineEvent,
	type StoryEventRow,
} from '$lib/server/events/timeline';
import {
	runMemoryRetrieveCommand,
	listBackendJobsCommand,
	runDueBackendJobsCommand,
	runReindexStoryJobCommand,
	runRollupArcJobCommand,
	runStoryVaultSyncJobCommand,
	runSyncPullCommand,
	runSyncPushCommand,
	runWorldSimJobCommand,
	type JobStatusCommandInput,
	type RollupArcJobCommandInput,
	type RunDueJobsCommandInput,
	type StoryVaultSyncJobCommandInput,
	type SyncPullCommandResult,
	type SyncPushCommandResult,
	type WorldSimJobCommandInput,
} from './serviceCommands';
import {
	runEngineOrchestrator,
	type EngineOrchestratorRunInput,
	type EngineOrchestratorRunResult,
} from './orchestrator';
import { getAppStatus, type AppStatusInput } from './appStatus';
import { getDatabaseHealth } from './databaseHealth';
import { listApiCallLogs, recordApiCallLog } from './apiCallLogs';
import { listLlmServiceSettings, saveLocalApiKeyRefs, upsertLlmServiceSettings } from './llmSettings';
import { buildPromptPacketDebug, type PromptPacketDebugInput } from './promptDiagnostics';
import {
	getWorldRecord,
	getStoryEntriesAround,
	listWorldRecordTypes,
	listWorldRecords as listWorldRecordsFromStore,
	patchWorldRecord,
} from './worldRecords';
import { draftCharacterUpdateFromStoryContext, type CharacterDraftUpdateArgs } from './characterDrafts';
import { searchCanonicalWorld } from './canonicalSearch';
import { importWorldDatabaseBundle } from '$lib/server/db/worldDatabaseImport';
import { TERMINAL_WORLD_DATABASE_SCHEMA } from '$lib/server/db/worldDatabaseSchema';
import { listGoogleAgentModels } from './googleAgentProxy';
import {
	archiveWikiStoryVault,
	getWikiRuntimeStatus,
	getWikiStoryVaultStatus,
	materializeWikiStoryVault,
	runWikiAction,
	withCommandStoryId,
	type WikiCoreAction,
} from './wikiCommands';
import {
	addEntityAlias as addEntityAliasCommand,
	cleanupCanonDrift as cleanupCanonDriftCommand,
	continuityAudit as continuityAuditCommand,
	mergeEntities as mergeEntitiesCommand,
	previewEntityResolution as previewEntityResolutionCommand,
	reviewPatchProposal as reviewPatchProposalCommand,
} from './canonRepair';

type JsonRecord = Record<string, unknown>;
type LlmSettingsSaveInput = {
	settings: LlmServiceSettingPatch[];
	secrets: Array<{ ref: string; value: string }>;
};

export interface EngineCommandHandlers {
	loadAppStatus?: (input: AppStatusInput) => Promise<JsonRecord>;
	loadDatabaseHealth?: () => Promise<JsonRecord>;
	listApiCallLogs?: (input: Parameters<typeof listApiCallLogs>[0]) => Promise<JsonRecord[]>;
	recordApiCallLog?: (input: Parameters<typeof recordApiCallLog>[0]) => Promise<JsonRecord | null>;
	listLlmSettings?: () => Promise<LlmServiceSetting[]>;
	saveLlmSettings?: (input: LlmSettingsSaveInput) => Promise<LlmServiceSetting[]>;
	buildPromptPacketDebug?: (input: PromptPacketDebugInput) => Promise<JsonRecord>;
	getWorldDatabaseSchema?: () => Promise<JsonRecord> | JsonRecord;
	importWorldDatabaseBundle?: (input: WorldDatabaseImportRequest) => Promise<JsonRecord>;
	listGoogleAgentModels?: () => Promise<JsonRecord>;
	runWikiAction?: (action: WikiCoreAction, input: JsonRecord) => Promise<unknown>;
	getWikiStoryVaultStatus?: (storyId: string) => Promise<unknown>;
	materializeWikiStoryVault?: (input: JsonRecord) => Promise<unknown>;
	archiveWikiStoryVault?: (storyId: string) => Promise<unknown>;
	getWikiRuntimeStatus?: () => Promise<JsonRecord> | JsonRecord;
	loadBootstrap?: (storyId: string, options?: Parameters<typeof getBootstrap>[1]) => Promise<BootstrapResponse>;
	loadCampaignProjection?: (storyId: string, options?: Parameters<typeof getCampaignProjection>[1]) => Promise<CampaignProjection>;
	loadTranscriptPage?: (storyId: string, options?: Parameters<typeof getStoryEntriesPage>[1]) => Promise<StoryEntriesPageResponse>;
	loadEntriesAround?: (storyId: string, position: number, radius: number) => Promise<JsonRecord>;
	loadCacheStatus?: (storyId: string, options?: EngineCacheStatusArgs) => Promise<EngineCacheStatus>;
	readCampaignPage?: (input: Parameters<typeof readCampaignPage>[0]) => Promise<CampaignPageReadResult>;
	writeCampaignPage?: (input: Parameters<typeof writeCampaignPage>[0]) => Promise<CampaignVaultWriteResult>;
	listWorldRecords?: (storyId: string, options?: Parameters<typeof listWorldRecordsFromStore>[1]) => Promise<JsonRecord>;
	getWorldRecord?: (type: string, recordId: string) => Promise<JsonRecord>;
	patchWorldRecord?: (type: string, recordId: string, request: RecordPatchRequest) => Promise<JsonRecord>;
	draftCharacterUpdate?: (storyId: string, args: CharacterDraftUpdateArgs) => Promise<JsonRecord>;
	searchWorld?: (input: Parameters<typeof searchCanonicalWorld>[0]) => Promise<JsonRecord>;
	listStories?: () => Promise<JsonRecord[]>;
	createStory?: (input: unknown) => Promise<JsonRecord>;
	exportStory?: (storyId: string) => Promise<JsonRecord>;
	deleteStory?: (storyId: string) => Promise<JsonRecord>;
	importIndexedDbBundle?: (input: unknown) => Promise<JsonRecord>;
	upsertEntity?: (storyId: string, entry: JsonRecord) => Promise<EntityCommandResponse>;
	deleteEntity?: (storyId: string, entityId: string) => Promise<EntityDeleteResponse>;
	upsertChapter?: (storyId: string, chapter: JsonRecord) => Promise<ChapterCommandResponse>;
	upsertArc?: (storyId: string, arc: JsonRecord) => Promise<ArcCommandResponse>;
	deleteChapter?: (storyId: string, chapterId: string) => Promise<ChapterDeleteResponse>;
	deleteArc?: (storyId: string, arcId: string) => Promise<ArcDeleteResponse>;
	createContextCheckpoint?: (storyId: string, input: JsonRecord) => Promise<ContextCheckpointCommandResponse>;
	listContextCheckpoints?: (storyId: string, limit?: number) => Promise<ContextCheckpointListResponse>;
	revertToContextCheckpoint?: (storyId: string, input: JsonRecord) => Promise<ContextCheckpointRevertResponse>;
	upsertSaga?: (storyId: string, saga: JsonRecord) => Promise<SagaCommandResponse>;
	upsertLivingMemory?: (storyId: string, kind: Parameters<typeof upsertBackendLivingMemoryFromLocal>[1], records: JsonRecord[]) => Promise<LivingMemoryCommandResponse>;
	previewEntityResolution?: (input: Parameters<typeof previewEntityResolutionCommand>[0]) => Promise<JsonRecord>;
	addEntityAlias?: (input: Parameters<typeof addEntityAliasCommand>[0]) => Promise<JsonRecord>;
	mergeEntities?: (input: Parameters<typeof mergeEntitiesCommand>[0]) => Promise<JsonRecord>;
	reviewPatchProposal?: (input: Parameters<typeof reviewPatchProposalCommand>[0]) => Promise<JsonRecord>;
	continuityAudit?: (input: Parameters<typeof continuityAuditCommand>[0]) => Promise<JsonRecord>;
	cleanupCanonDrift?: (input: Parameters<typeof cleanupCanonDriftCommand>[0]) => Promise<JsonRecord>;
	submitTurn?: (input: unknown) => Promise<TurnResponse>;
	loadTimelineBrief?: (input: Parameters<typeof loadGmTimelineBrief>[0]) => Promise<GmTimelineBrief>;
	scheduleTimelineEvent?: (input: Parameters<typeof scheduleTimelineEvent>[0]) => Promise<StoryEventRow>;
	advanceStoryTurn?: (storyId: string, delta?: number) => Promise<number>;
	promoteDueTimelineEvents?: (
		storyId: string,
		currentTurn: number,
		options?: Parameters<typeof promoteDueTimelineEvents>[2],
	) => Promise<StoryEventRow[]>;
	prepareTurn?: (input: unknown) => Promise<PreparedServerTurnSummary>;
	retrieveMemory?: (input: Parameters<typeof runMemoryRetrieveCommand>[0]) => Promise<RetrievedMemoryPacket>;
	pullSyncChanges?: (input: Parameters<typeof runSyncPullCommand>[0]) => Promise<SyncPullCommandResult>;
	pushSyncOperations?: (input: Parameters<typeof runSyncPushCommand>[0]) => Promise<SyncPushCommandResult>;
	runReindexStoryJob?: (input: unknown) => Promise<JsonRecord>;
	listJobs?: (input: JobStatusCommandInput) => Promise<JsonRecord>;
	runDueJobs?: (input: RunDueJobsCommandInput) => Promise<JsonRecord>;
	runRollupArcJob?: (input: RollupArcJobCommandInput) => Promise<JsonRecord>;
	runStoryVaultSyncJob?: (input: StoryVaultSyncJobCommandInput) => Promise<JsonRecord>;
	runWorldSimJob?: (input: WorldSimJobCommandInput) => Promise<JsonRecord>;
	runOrchestrator?: (input: EngineOrchestratorRunInput) => Promise<EngineOrchestratorRunResult>;
}

function nowIso(): string {
	return new Date().toISOString();
}

function commandId(request: EngineCommandRequest): string {
	return request.clientCommandId ?? `engine_cmd_${randomUUID()}`;
}

function responseBase(request: EngineCommandRequest): Omit<EngineCommandResponse, 'status'> {
	const timestamp = nowIso();
	return {
		commandId: commandId(request),
		clientCommandId: request.clientCommandId ?? null,
		storyId: request.storyId,
		command: request.command,
		result: null,
		projectionChanges: {},
		error: null,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

export async function executeEngineCommand(
	request: EngineCommandRequest,
	handlers: EngineCommandHandlers = {},
): Promise<EngineCommandResponse> {
	const base = responseBase(request);
	const loadAppStatus = handlers.loadAppStatus ?? getAppStatus;
	const loadDatabaseHealth = handlers.loadDatabaseHealth ?? getDatabaseHealth;
	const listApiLogs = handlers.listApiCallLogs ?? listApiCallLogs;
	const recordApiLog = handlers.recordApiCallLog ?? recordApiCallLog;
	const listLlmSettings = handlers.listLlmSettings ?? listLlmServiceSettings;
	const saveLlmSettings = handlers.saveLlmSettings ?? (async (input: LlmSettingsSaveInput) => {
		saveLocalApiKeyRefs(input.secrets);
		return await upsertLlmServiceSettings(input.settings);
	});
	const loadPromptPacketDebug = handlers.buildPromptPacketDebug ?? buildPromptPacketDebug;
	const loadWorldDatabaseSchema = handlers.getWorldDatabaseSchema ?? (() => TERMINAL_WORLD_DATABASE_SCHEMA);
	const importWorldDatabase = handlers.importWorldDatabaseBundle ?? importWorldDatabaseBundle;
	const loadGoogleAgentModels = handlers.listGoogleAgentModels ?? listGoogleAgentModels;
	const runWiki = handlers.runWikiAction ?? runWikiAction;
	const loadWikiStoryVaultStatus = handlers.getWikiStoryVaultStatus ?? getWikiStoryVaultStatus;
	const materializeWikiVault = handlers.materializeWikiStoryVault ?? materializeWikiStoryVault;
	const archiveWikiVault = handlers.archiveWikiStoryVault ?? archiveWikiStoryVault;
	const loadWikiRuntimeStatus = handlers.getWikiRuntimeStatus ?? getWikiRuntimeStatus;
	const loadBootstrap = handlers.loadBootstrap ?? getBootstrap;
	const loadCampaignProjection = handlers.loadCampaignProjection ?? getCampaignProjection;
	const loadTranscriptPage = handlers.loadTranscriptPage ?? getStoryEntriesPage;
	const loadEntriesAround = handlers.loadEntriesAround ?? getStoryEntriesAround;
	const loadCacheStatus = handlers.loadCacheStatus ?? getEngineCacheStatus;
	const readVaultPage = handlers.readCampaignPage ?? readCampaignPage;
	const writeVaultPage = handlers.writeCampaignPage ?? writeCampaignPage;
	const listWorldRecords = handlers.listWorldRecords ?? (async (storyId: string, options?: Parameters<typeof listWorldRecordsFromStore>[1]) => ({
		types: listWorldRecordTypes(),
		...(await listWorldRecordsFromStore(storyId, options)),
	}));
	const readWorldRecord = handlers.getWorldRecord ?? getWorldRecord;
	const writeWorldRecord = handlers.patchWorldRecord ?? patchWorldRecord;
	const draftCharacterUpdate = handlers.draftCharacterUpdate ?? draftCharacterUpdateFromStoryContext;
	const searchWorld = handlers.searchWorld ?? searchCanonicalWorld;
	const listStories = handlers.listStories ?? listBackendStories;
	const createStory = handlers.createStory ?? createBackendStory;
	const exportStory = handlers.exportStory ?? exportBackendStory;
	const deleteStory = handlers.deleteStory ?? deleteBackendStory;
	const importIndexedDb = handlers.importIndexedDbBundle ?? importIndexedDbBundle;
	const upsertEntity = handlers.upsertEntity ?? upsertBackendEntityFromEntry;
	const deleteEntity = handlers.deleteEntity ?? deleteBackendEntity;
	const upsertChapter = handlers.upsertChapter ?? upsertBackendChapterFromLocal;
	const upsertArc = handlers.upsertArc ?? upsertBackendArcFromLocal;
	const removeChapter = handlers.deleteChapter ?? deleteBackendChapter;
	const removeArc = handlers.deleteArc ?? deleteBackendArc;
	const makeContextCheckpoint = handlers.createContextCheckpoint ?? createContextCheckpoint;
	const getContextCheckpoints = handlers.listContextCheckpoints ?? listContextCheckpoints;
	const restoreContextCheckpoint = handlers.revertToContextCheckpoint ?? revertToContextCheckpoint;
	const upsertSaga = handlers.upsertSaga ?? upsertBackendSagaFromLocal;
	const upsertLivingMemory = handlers.upsertLivingMemory ?? upsertBackendLivingMemoryFromLocal;
	const submitTurn = handlers.submitTurn ?? processServerTurn;
	const loadTimelineBrief = handlers.loadTimelineBrief ?? loadGmTimelineBrief;
	const scheduleTimeline = handlers.scheduleTimelineEvent ?? scheduleTimelineEvent;
	const advanceTimelineTurn = handlers.advanceStoryTurn ?? advanceStoryTurn;
	const promoteTimelineEvents = handlers.promoteDueTimelineEvents ?? promoteDueTimelineEvents;
	const prepareTurn = handlers.prepareTurn ?? prepareServerTurn;
	const retrieveMemory = handlers.retrieveMemory ?? runMemoryRetrieveCommand;
	const pullSyncChanges = handlers.pullSyncChanges ?? runSyncPullCommand;
	const pushSyncOperations = handlers.pushSyncOperations ?? runSyncPushCommand;
	const runReindexStoryJob = handlers.runReindexStoryJob ?? runReindexStoryJobCommand;
	const listJobs = handlers.listJobs ?? listBackendJobsCommand;
	const runDueJobs = handlers.runDueJobs ?? runDueBackendJobsCommand;
	const runRollupArcJob = handlers.runRollupArcJob ?? runRollupArcJobCommand;
	const runStoryVaultSyncJob = handlers.runStoryVaultSyncJob ?? runStoryVaultSyncJobCommand;
	const runWorldSimJob = handlers.runWorldSimJob ?? runWorldSimJobCommand;
	const previewResolution = handlers.previewEntityResolution ?? previewEntityResolutionCommand;
	const addAlias = handlers.addEntityAlias ?? addEntityAliasCommand;
	const mergeDuplicateEntities = handlers.mergeEntities ?? mergeEntitiesCommand;
	const reviewProposal = handlers.reviewPatchProposal ?? reviewPatchProposalCommand;
	const runContinuityAudit = handlers.continuityAudit ?? continuityAuditCommand;
	const runCanonDriftCleanup = handlers.cleanupCanonDrift ?? cleanupCanonDriftCommand;
	const runOrchestrator = handlers.runOrchestrator ?? ((input: EngineOrchestratorRunInput) => runEngineOrchestrator(input, {
		runTool: (call) => executeEngineCommand({
			storyId: input.storyId,
			command: call.command,
			clientCommandId: `${input.clientCommandId ?? base.commandId}:${call.id}`,
			args: call.args,
		}, handlers),
	}));
	const publishSucceededEvent = (response: EngineCommandResponse) => {
		publishEngineEvent({
			storyId: request.storyId,
			type: 'command.succeeded',
			data: {
				commandId: response.commandId,
				clientCommandId: response.clientCommandId,
				command: response.command,
				status: response.status,
				projectionChanges: response.projectionChanges,
			},
		});
	};

	publishEngineEvent({
		storyId: request.storyId,
		type: 'command.received',
		data: {
			commandId: base.commandId,
			clientCommandId: base.clientCommandId,
			command: request.command,
		},
		});
	try {
		publishEngineEvent({
			storyId: request.storyId,
			type: 'command.running',
			data: {
				commandId: base.commandId,
				clientCommandId: base.clientCommandId,
				command: request.command,
				status: 'running',
			},
		});
		switch (request.command) {
			case 'app.status': {
				const storyId = request.storyId === '__app__' ? null : request.storyId;
				const status = await loadAppStatus({ storyId });
				const services = asRecord(status.services);
				const qdrant = asRecord(services.qdrant);
				const ollama = asRecord(services.ollama);
				const response = {
					...base,
					status: 'succeeded',
					result: status,
					projectionChanges: {
						appStatus: {
							ok: status.ok !== false,
							mode: typeof status.mode === 'string' ? status.mode : 'terminal-process',
							storyId,
							qdrantOk: qdrant.ok === true,
							ollamaOk: ollama.ok === true,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'app.health': {
				const health = await loadDatabaseHealth();
				const tableCount = typeof health.table_count === 'number'
					? health.table_count
					: typeof health.tableCount === 'number' ? health.tableCount : null;
				const response = {
					...base,
					status: 'succeeded',
					result: health,
					projectionChanges: {
						appHealth: {
							ok: health.ok !== false,
							configured: health.configured === true,
							database: typeof health.database === 'string' ? health.database : null,
							tableCount,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'apiCallLogs.list': {
				const args = apiCallLogListArgsSchema.parse(request.args ?? {});
				const storyId = request.storyId === '__app__' ? args.storyId ?? null : request.storyId;
				const logs = await listApiLogs({
					storyId,
					status: args.status ?? null,
					serviceId: args.serviceId ?? null,
					limit: args.limit,
				});
				const response = {
					...base,
					status: 'succeeded',
					result: { logs },
					projectionChanges: {
						apiCallLogs: {
							storyId,
							logCount: logs.length,
							limit: args.limit,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'apiCallLogs.record': {
				const args = apiCallLogCreateSchema.parse(request.args ?? {});
				const log = await recordApiLog(args);
				const logRow = asRecord(log);
				const response = {
					...base,
					status: 'succeeded',
					result: { logged: Boolean(log), log },
					projectionChanges: {
						apiCallLogs: {
							logged: Boolean(log),
							logId: typeof logRow.id === 'string' ? logRow.id : null,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'settings.llm.list': {
				const settings = await listLlmSettings();
				const response = {
					...base,
					status: 'succeeded',
					result: { settings },
					projectionChanges: {
						llmSettings: {
							settingCount: settings.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'settings.llm.save': {
				const args = llmSettingsPatchSchema.parse(request.args ?? {});
				const settings = await saveLlmSettings(args);
				const response = {
					...base,
					status: 'succeeded',
					result: { settings },
					projectionChanges: {
						llmSettings: {
							settingCount: settings.length,
							secretRefCount: args.secrets.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'debug.promptPacket': {
				const args = enginePromptPacketDebugArgsSchema.parse(request.args ?? {});
				const diagnostics = await loadPromptPacketDebug({
					storyId: request.storyId,
					query: args.query,
					tokenBudget: args.tokenBudget,
				});
				const retrieved = asRecord(diagnostics.retrieved);
				const prompt = asRecord(diagnostics.prompt);
				const messages = Array.isArray(prompt.messages) ? prompt.messages : [];
				const tokenEstimate = typeof diagnostics.tokenEstimate === 'number'
					? diagnostics.tokenEstimate
					: typeof retrieved.tokenEstimate === 'number' ? retrieved.tokenEstimate : 0;
				const response = {
					...base,
					status: 'succeeded',
					result: diagnostics,
					projectionChanges: {
						promptPacket: {
							query: args.query,
							tokenEstimate,
							memoryNodeCount: Array.isArray(retrieved.nodes) ? retrieved.nodes.length : 0,
							systemChars: typeof prompt.system === 'string' ? prompt.system.length : 0,
							promptChars: typeof prompt.prompt === 'string' ? prompt.prompt.length : 0,
							messageCount: messages.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'database.schema.get': {
				const schema = await loadWorldDatabaseSchema();
				const schemaRecord = asRecord(schema);
				const response = {
					...base,
					status: 'succeeded',
					result: schema,
					projectionChanges: {
						database: {
							schemaVersion: typeof schemaRecord.schemaVersion === 'number' ? schemaRecord.schemaVersion : null,
							name: typeof schemaRecord.name === 'string' ? schemaRecord.name : null,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'database.importWorldBundle': {
				const args = worldDatabaseImportRequestSchema.parse(request.args ?? {});
				const result = await importWorldDatabase(args);
				const imported = asRecord(result);
				const storyId = typeof imported.storyId === 'string' ? imported.storyId : request.storyId;
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						databaseImport: {
							ok: imported.ok !== false,
							storyId,
							counts: asRecord(imported.counts),
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'googleAgent.models': {
				const result = await loadGoogleAgentModels();
				const models = Array.isArray(result.data) ? result.data : [];
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						googleAgentPlatform: {
							modelCount: models.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'wiki.brief':
			case 'wiki.context':
			case 'wiki.follow':
			case 'wiki.index':
			case 'wiki.ingest':
			case 'wiki.init':
			case 'wiki.lint':
			case 'wiki.page':
			case 'wiki.pages':
			case 'wiki.search':
			case 'wiki.write': {
				const action = request.command.slice('wiki.'.length) as WikiCoreAction;
				const args = withCommandStoryId(request.storyId, request.args ?? {});
				const result = await runWiki(action, args);
				const record = asRecord(result);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						wiki: {
							action,
							storyId: typeof args.storyId === 'string' ? args.storyId : request.storyId,
							ok: record.ok !== false,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				if (action === 'write' || action === 'ingest' || action === 'init' || action === 'index') {
					publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				}
				publishSucceededEvent(response);
				return response;
			}
			case 'wiki.status': {
				const result = await loadWikiRuntimeStatus();
				const record = asRecord(result);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						wiki: {
							action: 'status',
							storyId: null,
							ok: record.ok !== false,
							defaultVaultInitialized: record.defaultVaultInitialized === true,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'wiki.storyVault.status': {
				const args = asRecord(request.args);
				const storyId = typeof args.storyId === 'string' && args.storyId.trim() ? args.storyId.trim() : request.storyId;
				const result = await loadWikiStoryVaultStatus(storyId);
				const record = asRecord(result);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						wiki: {
							action: 'storyVault.status',
							storyId,
							ok: record.ok !== false,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'wiki.storyVault.materialize': {
				const args = withCommandStoryId(request.storyId, request.args ?? {});
				const result = await materializeWikiVault(args);
				const record = asRecord(result);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						wiki: {
							action: 'storyVault.materialize',
							storyId: typeof args.storyId === 'string' ? args.storyId : request.storyId,
							ok: record.ok !== false,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'wiki.storyVault.archive': {
				const args = asRecord(request.args);
				const storyId = typeof args.storyId === 'string' && args.storyId.trim() ? args.storyId.trim() : request.storyId;
				const result = await archiveWikiVault(storyId);
				const record = asRecord(result);
				const bytes = record.bytes instanceof Uint8Array ? record.bytes : null;
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						wiki: {
							action: 'storyVault.archive',
							storyId,
							ok: true,
							byteLength: bytes?.byteLength ?? null,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'campaign.bootstrap': {
				const args = engineCampaignBootstrapArgsSchema.parse(request.args ?? {});
				const bootstrap = await loadBootstrap(request.storyId, args);
				const projection = bootstrap.projection;
				const response = {
					...base,
					status: 'succeeded',
					result: bootstrap,
					projectionChanges: {
						mode: projection?.mode ?? 'control_surface',
						counts: projection?.counts ?? { entries: bootstrap.entryCount, entities: bootstrap.entities.length, events: bootstrap.recentEvents.length, memoryNodes: bootstrap.memoryNodes.length },
						vault: projection?.vault ?? null,
						cache: projection?.cache ?? null,
						entryLimit: args.entryLimit ?? 80,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'campaign.status', data: response.projectionChanges });
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			case 'campaign.status': {
				const args = engineCampaignStatusArgsSchema.parse(request.args ?? {});
				const projection = await loadCampaignProjection(request.storyId, {
					entryLimit: args.entryLimit,
					chapterLimit: args.chapterLimit,
					arcLimit: args.arcLimit,
					sagaLimit: args.sagaLimit,
				});
				const response = {
					...base,
					status: 'succeeded',
					result: projection,
					projectionChanges: {
						mode: projection.mode,
						counts: projection.counts,
						vault: projection.vault,
						cache: projection.cache,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'campaign.status', data: response.projectionChanges });
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			case 'campaign.transcriptPage': {
				const args = engineTranscriptPageArgsSchema.parse(request.args ?? {});
				const page = await loadTranscriptPage(request.storyId, {
					beforePosition: args.beforePosition ?? args.cursor ?? null,
					limit: args.limit,
					branchId: args.branchId ?? null,
				});
				const response = {
					...base,
					status: 'succeeded',
					result: page,
					projectionChanges: {
						transcript: {
							entryCount: page.entryCount,
							pageSize: page.entries.length,
							hasMore: page.hasMore,
							nextBeforePosition: page.nextBeforePosition,
							serverVersion: page.serverVersion,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			case 'campaign.entriesAround': {
				const args = engineEntriesAroundArgsSchema.parse(request.args ?? {});
				const page = await loadEntriesAround(request.storyId, args.position, args.radius);
				const entries = Array.isArray(page.entries) ? page.entries : [];
				const response = {
					...base,
					status: 'succeeded',
					result: page,
					projectionChanges: {
						entriesAround: {
							position: args.position,
							radius: args.radius,
							entryCount: entries.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'campaign.cacheStatus': {
				const args = engineCacheStatusArgsSchema.parse(request.args ?? {});
				const cache = await loadCacheStatus(request.storyId, args);
				const response = {
					...base,
					status: 'succeeded',
					result: cache,
					projectionChanges: { cache },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'cache.status', data: { cache } });
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			case 'campaign.page.read': {
				const args = engineCampaignPageReadArgsSchema.parse(request.args ?? {});
				const page = await readVaultPage({
					storyId: request.storyId,
					kind: args.kind,
					name: args.name ?? null,
					relativePath: args.path ?? null,
					missingOk: args.missingOk,
				});
				const response = {
					...base,
					status: 'succeeded',
					result: page,
					projectionChanges: {
						campaignPage: {
							kind: page.kind,
							relativePath: page.relativePath,
							contentHash: page.contentHash,
							byteLength: page.byteLength,
							missing: page.missing === true,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'campaign.page.write': {
				const args = engineCampaignPageWriteArgsSchema.parse(request.args ?? {});
				const result = await writeVaultPage({
					story: {
						id: request.storyId,
						title: request.storyId,
						serverVersion: args.serverVersion,
					},
					kind: args.kind,
					name: args.name,
					title: args.title,
					body: args.body,
					tags: args.tags,
					entityIds: args.entityIds,
					factionIds: args.factionIds,
					sourceEntryIds: args.sourceEntryIds,
					sourceEventIds: args.sourceEventIds,
					sourcePatchIds: args.sourcePatchIds,
					relativePath: args.path ?? null,
					metadata: args.metadata,
				});
				const firstFile = result.files[0] ?? null;
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						campaignPage: firstFile ? {
							kind: firstFile.kind,
							relativePath: firstFile.relativePath,
							contentHash: firstFile.contentHash,
							byteLength: firstFile.byteLength,
						} : null,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'world.records': {
				const args = worldRecordsQuerySchema.parse(request.args ?? {});
				const result = await listWorldRecords(request.storyId, args);
				const records = Array.isArray(result.records) ? result.records : [];
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						worldRecords: {
							type: String(result.type ?? args.type),
							recordCount: records.length,
							nextCursor: result.nextCursor ?? null,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'world.search': {
				const args = searchQuerySchema.parse(request.args ?? {});
				const result = await searchWorld({
					storyId: request.storyId,
					query: args.q,
					type: args.type,
					limit: args.limit,
					includeSemantic: args.includeSemantic,
				});
				const results = Array.isArray(result.results) ? result.results : [];
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						worldSearch: {
							query: String(result.query ?? args.q),
							resultCount: results.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'world.record.get': {
				const args = engineWorldRecordDetailArgsSchema.parse(request.args ?? {});
				const detail = await readWorldRecord(args.type, args.recordId);
				const record = asRecord(detail.record);
				const sourceEntries = Array.isArray(detail.sourceEntries) ? detail.sourceEntries : [];
				const sourceEvents = Array.isArray(detail.sourceEvents) ? detail.sourceEvents : [];
				const sourcePatches = Array.isArray(detail.sourcePatches) ? detail.sourcePatches : [];
				const response = {
					...base,
					status: 'succeeded',
					result: detail,
					projectionChanges: {
						worldRecord: {
							type: args.type,
							recordId: args.recordId,
							storyId: typeof record.story_id === 'string' ? record.story_id : typeof record.storyId === 'string' ? record.storyId : null,
							sourceEntryCount: sourceEntries.length,
							sourceEventCount: sourceEvents.length,
							sourcePatchCount: sourcePatches.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'world.record.patch': {
				const args = engineWorldRecordPatchArgsSchema.parse(request.args ?? {});
				const result = await writeWorldRecord(args.type, args.recordId, {
					updates: args.updates,
					reason: args.reason,
				});
				const patched = asRecord(result);
				const storyId = typeof patched.storyId === 'string' ? patched.storyId : null;
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						worldRecord: {
							type: args.type,
							recordId: args.recordId,
							storyId,
							patchId: typeof patched.patchId === 'string' ? patched.patchId : null,
							serverVersion: typeof patched.serverVersion === 'number' ? patched.serverVersion : null,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: storyId ?? request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'world.character.draftUpdate': {
				const args = engineCharacterDraftUpdateArgsSchema.parse(request.args ?? {});
				const result = await draftCharacterUpdate(request.storyId, args);
				const record = asRecord(result);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						characterDraftUpdate: {
							recordId: String(record.recordId ?? args.recordId),
							proposalId: typeof record.proposalId === 'string' ? record.proposalId : null,
							status: typeof record.status === 'string' ? record.status : null,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'story.export': {
				const result = await exportStory(request.storyId);
				const exported = asRecord(result);
				const storyEntries = Array.isArray(exported.storyEntries) ? exported.storyEntries : [];
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						storyExport: {
							storyId: request.storyId,
							entryCount: storyEntries.length,
							source: typeof exported.source === 'string' ? exported.source : null,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'story.delete': {
				const result = await deleteStory(request.storyId);
				const deleted = asRecord(result).ok !== false;
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						story: {
							storyId: request.storyId,
							deleted,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'story.importIndexedDb': {
				const args = indexedDbImportRequestSchema.parse(request.args ?? {});
				const result = await importIndexedDb(args);
				const imported = asRecord(result);
				const skipped = Array.isArray(imported.skipped) ? imported.skipped : [];
				const merged = Array.isArray(imported.merged) ? imported.merged : [];
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						storyImport: {
							storyId: typeof imported.storyId === 'string' ? imported.storyId : request.storyId,
							serverVersion: typeof imported.serverVersion === 'number' ? imported.serverVersion : null,
							counts: asRecord(imported.counts),
							skippedCount: skipped.length,
							mergedCount: merged.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'story.list': {
				const stories = await listStories();
				const response = {
					...base,
					status: 'succeeded',
					result: { stories },
					projectionChanges: {
						storyCatalog: {
							count: stories.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'story.create': {
				const args = createStoryRequestSchema.parse(request.args ?? {});
				const result = await createStory(args);
				const created = asRecord(result);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						story: {
							storyId: typeof created.storyId === 'string' ? created.storyId : null,
							serverVersion: typeof created.serverVersion === 'number' ? created.serverVersion : null,
							created: true,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'entity.create':
			case 'entity.upsert': {
				const args = entityUpsertRequestSchema.parse(request.args ?? {});
				const result = await upsertEntity(request.storyId, asRecord(args.entry));
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						entity: result.entity,
						serverVersion: result.serverVersion,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'entity.resolve': {
				const args = asRecord(request.args ?? {});
				const candidateRecord = asRecord(args.candidate);
				const candidate = {
					id: typeof candidateRecord.id === 'string' ? candidateRecord.id : candidateRecord.id == null ? null : String(candidateRecord.id),
					type: typeof candidateRecord.type === 'string' ? candidateRecord.type : '',
					name: typeof candidateRecord.name === 'string' ? candidateRecord.name : '',
					aliases: Array.isArray(candidateRecord.aliases)
						? candidateRecord.aliases.filter((value): value is string => typeof value === 'string')
						: undefined,
					description: typeof candidateRecord.description === 'string' ? candidateRecord.description : candidateRecord.description == null ? null : String(candidateRecord.description),
					sourceEntryIds: Array.isArray(candidateRecord.sourceEntryIds) ? candidateRecord.sourceEntryIds.filter((value): value is string => typeof value === 'string') : undefined,
					sourceEventIds: Array.isArray(candidateRecord.sourceEventIds) ? candidateRecord.sourceEventIds.filter((value): value is string => typeof value === 'string') : undefined,
					sourcePatchIds: Array.isArray(candidateRecord.sourcePatchIds) ? candidateRecord.sourcePatchIds.filter((value): value is string => typeof value === 'string') : undefined,
					relatedEntityIds: Array.isArray(candidateRecord.relatedEntityIds) ? candidateRecord.relatedEntityIds.filter((value): value is string => typeof value === 'string') : undefined,
				} satisfies Parameters<typeof previewResolution>[0]['candidate'];
				const result = await previewResolution({
					storyId: request.storyId,
					candidate,
					includeSemantic: args.includeSemantic !== false,
					maxCandidates: typeof args.maxCandidates === 'number' ? args.maxCandidates : undefined,
				});
				const summary = asRecord(result.resolution);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						entityResolution: {
							storyId: request.storyId,
							decision: typeof summary.decision === 'string' ? summary.decision : null,
							entityId: typeof summary.matchedEntityId === 'string' ? summary.matchedEntityId : null,
							confidence: typeof summary.confidence === 'number' ? summary.confidence : null,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'entity.alias.add': {
				const args = asRecord(request.args ?? {});
				const result = await addAlias({
					storyId: request.storyId,
					entityId: typeof args.entityId === 'string' ? args.entityId : '',
					alias: typeof args.alias === 'string' ? args.alias : '',
					sourceEntryIds: Array.isArray(args.sourceEntryIds) ? args.sourceEntryIds.filter((value): value is string => typeof value === 'string') : [],
					sourceEventIds: Array.isArray(args.sourceEventIds) ? args.sourceEventIds.filter((value): value is string => typeof value === 'string') : [],
					sourcePatchIds: Array.isArray(args.sourcePatchIds) ? args.sourcePatchIds.filter((value): value is string => typeof value === 'string') : [],
				});
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						entityAlias: {
							storyId: request.storyId,
							entityId: result.entityId,
							alias: result.alias,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'entity.merge': {
				const args = asRecord(request.args ?? {});
				const result = await mergeDuplicateEntities({
					storyId: request.storyId,
					keepEntityId: typeof args.keepEntityId === 'string' ? args.keepEntityId : '',
					mergeEntityId: typeof args.mergeEntityId === 'string' ? args.mergeEntityId : '',
					reason: typeof args.reason === 'string' ? args.reason : null,
				});
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						entityMerge: {
							storyId: request.storyId,
							keepEntityId: result.keepEntityId,
							mergeEntityId: result.mergeEntityId,
							mergedAliasCount: Array.isArray(result.mergedAliases) ? result.mergedAliases.length : 0,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'entity.delete': {
				const args = engineEntityDeleteArgsSchema.parse(request.args ?? {});
				const result = await deleteEntity(request.storyId, args.entityId);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						entityId: result.entityId,
						deleted: result.deleted,
						serverVersion: result.serverVersion,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'patchProposal.review': {
				const args = asRecord(request.args ?? {});
				const decision = args.decision === 'rejected' ? 'rejected' : 'approved';
				const result = await reviewProposal({
					storyId: request.storyId,
					proposalId: typeof args.proposalId === 'string' ? args.proposalId : '',
					decision,
					reviewer: typeof args.reviewer === 'string' ? args.reviewer : 'human',
					notes: typeof args.notes === 'string' ? args.notes : null,
				});
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						patchProposal: {
							storyId: request.storyId,
							proposalId: result.proposalId,
							status: result.status,
							decision: result.decision,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'continuity.audit': {
				const args = asRecord(request.args ?? {});
				const result = await runContinuityAudit({
					storyId: request.storyId,
					limit: typeof args.limit === 'number' ? args.limit : undefined,
				});
				const summary = asRecord(result.summary);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						continuityAudit: {
							storyId: request.storyId,
							openWarnings: typeof summary.openWarnings === 'number' ? summary.openWarnings : 0,
							pendingProposals: typeof summary.pendingProposals === 'number' ? summary.pendingProposals : 0,
							inactiveEntities: typeof summary.inactiveEntities === 'number' ? summary.inactiveEntities : 0,
							dueFactionProjects: typeof summary.dueFactionProjects === 'number' ? summary.dueFactionProjects : 0,
							factionProjectProposals: typeof summary.factionProjectProposals === 'number' ? summary.factionProjectProposals : 0,
							factionProjectWarnings: typeof summary.factionProjectWarnings === 'number' ? summary.factionProjectWarnings : 0,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'canon.cleanupDrift': {
				const args = asRecord(request.args ?? {});
				const result = await runCanonDriftCleanup({
					storyId: request.storyId,
					dryRun: args.dryRun === true,
				});
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						canonCleanup: {
							storyId: request.storyId,
							dryRun: result.dryRun === true,
							deleted: result.deleted === true,
							invalidSourceRefs: typeof result.invalidSourceRefs === 'number' ? result.invalidSourceRefs : 0,
							duplicateSourceRefs: typeof result.duplicateSourceRefs === 'number' ? result.duplicateSourceRefs : 0,
							unsafeMemoryNodes: typeof result.unsafeMemoryNodes === 'number' ? result.unsafeMemoryNodes : 0,
							deleteCount: typeof result.deleteCount === 'number' ? result.deleteCount : 0,
							serverVersion: typeof result.serverVersion === 'number' ? result.serverVersion : null,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'chapter.create':
			case 'chapter.upsert': {
				const args = chapterUpsertRequestSchema.parse(request.args ?? {});
				const result = await upsertChapter(request.storyId, asRecord(args.chapter));
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						chapter: result.chapter,
						serverVersion: result.serverVersion,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'chapter.delete': {
				const args = chapterDeleteRequestSchema.parse(request.args ?? {});
				const result = await removeChapter(request.storyId, args.chapterId);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						chapter: {
							id: result.chapterId,
							deleted: result.deleted,
						},
						unwrappedArcIds: result.unwrappedArcIds,
						unwrappedArcs: result.unwrappedArcs,
						serverVersion: result.serverVersion,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'arc.create':
			case 'arc.upsert': {
				const args = arcUpsertRequestSchema.parse(request.args ?? {});
				const result = await upsertArc(request.storyId, asRecord(args.arc));
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						arc: result.arc,
						serverVersion: result.serverVersion,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'arc.delete': {
				const args = arcDeleteRequestSchema.parse(request.args ?? {});
				const result = await removeArc(request.storyId, args.arcId);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						arc: {
							id: result.arcId,
							deleted: result.deleted,
						},
						serverVersion: result.serverVersion,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'context.checkpoint.create': {
				const args = contextCheckpointCreateRequestSchema.parse(request.args ?? {});
				const result = await makeContextCheckpoint(request.storyId, asRecord(args));
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						contextCheckpoint: result.checkpoint,
						serverVersion: result.serverVersion,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'context.checkpoint.list': {
				const args = asRecord(request.args ?? {});
				const result = await getContextCheckpoints(
					request.storyId,
					typeof args.limit === 'number' ? args.limit : undefined,
				);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						contextCheckpoints: result.checkpoints,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'context.checkpoint.revert': {
				const args = contextCheckpointRevertRequestSchema.parse(request.args ?? {});
				const result = await restoreContextCheckpoint(request.storyId, asRecord(args));
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						contextCheckpoint: result.checkpoint,
						restoredCounts: result.restoredCounts,
						serverVersion: result.serverVersion,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'saga.create':
			case 'saga.upsert': {
				const args = sagaUpsertRequestSchema.parse(request.args ?? {});
				const result = await upsertSaga(request.storyId, asRecord(args.saga));
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						saga: result.saga,
						serverVersion: result.serverVersion,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'livingMemory.upsert': {
				const args = livingMemoryUpsertRequestSchema.parse(request.args ?? {});
				const records = (args.record ? [args.record, ...args.records] : args.records).map(asRecord);
				if (records.length === 0) throw new Error('Missing living-memory record.');
				const result = await upsertLivingMemory(request.storyId, args.kind, records);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						livingMemory: {
							kind: result.kind,
							recordIds: result.recordIds,
							counts: result.counts,
						},
						serverVersion: result.serverVersion,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'timeline.brief': {
				const args = engineTimelineBriefArgsSchema.parse(request.args ?? {});
				const brief = await loadTimelineBrief({
					storyId: request.storyId,
					currentTurn: args.currentTurn,
					presentNpcIds: args.presentNpcIds,
					sceneEntityIds: args.sceneEntityIds,
					includeSecret: args.includeSecret,
					recentLimit: args.recentLimit,
					scheduledLimit: args.scheduledLimit,
					dueLimit: args.dueLimit,
					npcLimit: args.npcLimit,
					npcEventLimit: args.npcEventLimit,
				});
				const response = {
					...base,
					status: 'succeeded',
					result: brief,
					projectionChanges: { timeline: brief },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({
					storyId: request.storyId,
					type: 'timeline.brief',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						brief,
					},
				});
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			case 'timeline.schedule': {
				const args = engineTimelineScheduleArgsSchema.parse(request.args ?? {});
				let currentTurn = args.currentTurn;
				let currentWorldTime = args.currentWorldTime ?? null;
				if (currentTurn === undefined) {
					const clock = await loadTimelineBrief({
						storyId: request.storyId,
						dueLimit: 0,
						recentLimit: 0,
						scheduledLimit: 0,
						npcLimit: 0,
						npcEventLimit: 0,
					});
					currentTurn = clock.currentTurn;
					currentWorldTime = currentWorldTime ?? clock.currentWorldTime;
				}
				const event = await scheduleTimeline({
					storyId: request.storyId,
					type: args.type,
					title: args.title,
					body: args.body,
					currentTurn,
					delayTurns: args.delayTurns,
					now: nowIso(),
					actorEntityIds: args.actorEntityIds,
					targetEntityIds: args.targetEntityIds,
					actorNpcEntityIds: args.actorNpcEntityIds,
					targetNpcEntityIds: args.targetNpcEntityIds,
					locationId: args.locationId ?? null,
					locationIds: args.locationIds,
					factionIds: args.factionIds,
					threadIds: args.threadIds,
					visibility: args.visibility,
					worldTime: args.worldTime ?? null,
					currentWorldTime,
					memoryImpact: args.memoryImpact,
					sourceEntryIds: args.sourceEntryIds,
					sourcePatchIds: args.sourcePatchIds,
					metadata: args.metadata,
					serverVersion: args.serverVersion,
				});
				const response = {
					...base,
					status: 'succeeded',
					result: event,
					projectionChanges: { timeline: { scheduledEvent: event } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({
					storyId: request.storyId,
					type: 'timeline.eventScheduled',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						event,
					},
				});
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			case 'timeline.advance': {
				const args = engineTimelineAdvanceArgsSchema.parse(request.args ?? {});
				const currentTurn = await advanceTimelineTurn(request.storyId, args.delta);
				const promotedEvents = await promoteTimelineEvents(request.storyId, currentTurn, {
					serverVersion: args.serverVersion,
				});
				const brief = await loadTimelineBrief({
					storyId: request.storyId,
					currentTurn,
					presentNpcIds: args.presentNpcIds,
					sceneEntityIds: args.sceneEntityIds,
					includeSecret: args.includeSecret,
					recentLimit: args.recentLimit,
					scheduledLimit: args.scheduledLimit,
					dueLimit: args.dueLimit,
					npcLimit: args.npcLimit,
					npcEventLimit: args.npcEventLimit,
				});
				const result = {
					currentTurn,
					promotedEvents,
					brief,
				};
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { timeline: brief },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({
					storyId: request.storyId,
					type: 'timeline.eventsDue',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						currentTurn,
						promotedEventIds: promotedEvents.map((event) => event.id),
						dueEvents: brief.dueEvents,
					},
				});
				publishEngineEvent({
					storyId: request.storyId,
					type: 'timeline.brief',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						brief,
					},
				});
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			case 'turn.prepare': {
				const args = asRecord(request.args);
				const turnInput = turnRequestSchema.parse({
					...args,
					storyId: request.storyId,
					clientTurnId: typeof args.clientTurnId === 'string' ? args.clientTurnId : request.clientCommandId ?? base.commandId,
				});
				const prepared = await prepareTurn(turnInput);
				const response = {
					...base,
					status: 'succeeded',
					result: prepared,
					projectionChanges: {
						turnPreparation: {
							clientTurnId: prepared.clientTurnId,
							prompt: {
								tokenEstimate: prepared.prompt.tokenEstimate,
								totalChars: prepared.prompt.totalChars,
								messageCount: prepared.prompt.messageCount,
							},
							contextCounts: prepared.contextCounts,
							cache: prepared.cache ? {
								hitCount: prepared.cache.hitCount,
								missCount: prepared.cache.missCount,
								tokenEstimate: prepared.cache.tokenEstimate ?? 0,
							} : null,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			case 'orchestrator.run': {
				const args = engineOrchestratorRunArgsSchema.parse(request.args ?? {});
				const orchestrator = await runOrchestrator({
					...args,
					storyId: request.storyId,
					clientCommandId: request.clientCommandId ?? base.commandId,
				});
				const response = {
					...base,
					status: 'succeeded',
					result: orchestrator,
					projectionChanges: {
						orchestrator: {
							runId: orchestrator.runId,
							mode: orchestrator.mode,
							roleCount: orchestrator.roles.length,
							toolCallCount: orchestrator.toolCalls.length,
							toolResultCount: orchestrator.toolResults.length,
							executed: orchestrator.executed,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({
					storyId: request.storyId,
					type: 'orchestrator.completed',
					data: response.projectionChanges,
				});
				publishSucceededEvent(response);
				return response;
			}
			case 'turn.submit': {
				const args = asRecord(request.args);
				const turnInput = turnRequestSchema.parse({
					...args,
					storyId: request.storyId,
					clientTurnId: typeof args.clientTurnId === 'string' ? args.clientTurnId : request.clientCommandId ?? base.commandId,
				});
				const turn = await submitTurn(turnInput);
				const response = {
					...base,
					status: 'succeeded',
					result: turn,
					projectionChanges: {
						entries: turn.entries,
						serverVersion: turn.serverVersion,
						statePatchIds: turn.statePatchIds,
						eventIds: turn.eventIds,
						cache: turn.projection?.cache ?? null,
						projection: turn.projection ? {
							mode: turn.projection.mode,
							entryLimit: turn.projection.entryLimit,
							counts: turn.projection.counts,
						} : null,
						vault: turn.campaignVault ? {
							files: turn.campaignVault.files,
						} : null,
						performance: turn.performance ?? null,
						contextReceipt: turn.contextReceipt ?? null,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({
					storyId: request.storyId,
					type: 'narration.chunk',
					data: {
						commandId: response.commandId,
						clientTurnId: turnInput.clientTurnId,
						text: turn.narration,
						final: true,
					},
				});
				publishEngineEvent({
					storyId: request.storyId,
					type: 'state.changed',
					data: response.projectionChanges,
				});
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			case 'memory.retrieve': {
				const args = asRecord(request.args);
				const memory = await retrieveMemory(memoryRetrieveRequestSchema.parse({
					...args,
					storyId: request.storyId,
				}));
				const response = {
					...base,
					status: 'succeeded',
					result: memory,
					projectionChanges: {
						memory: {
							nodeCount: memory.nodes.length,
							tokenEstimate: memory.tokenEstimate,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			case 'sync.pull': {
				const args = asRecord(request.args);
				const sync = await pullSyncChanges(syncPullRequestSchema.parse({
					...args,
					storyId: request.storyId,
				}));
				const response = {
					...base,
					status: 'succeeded',
					result: sync,
					projectionChanges: {
						sync: {
							serverVersion: sync.serverVersion,
							changeCount: sync.changes.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			case 'sync.push': {
				const args = asRecord(request.args);
				const sync = await pushSyncOperations(syncPushRequestSchema.parse({
					...args,
					storyId: request.storyId,
				}));
				const response = {
					...base,
					status: 'succeeded',
					result: sync,
					projectionChanges: {
						sync: {
							serverVersion: sync.serverVersion,
							changeCount: sync.changes.length,
							appliedOpCount: sync.appliedOpIds.length,
							rejectedCount: sync.rejected.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			case 'jobs.reindexStory': {
				const args = reindexStoryRequestSchema.parse({
					...asRecord(request.args),
					storyId: request.storyId,
				});
				const job = await runReindexStoryJob(args);
				const jobRow = asRecord(job.job);
				const response = {
					...base,
					status: 'succeeded',
					result: job,
					projectionChanges: {
						jobs: {
							reindexStory: {
								ok: job.ok !== false,
								storyId: request.storyId,
								jobId: typeof job.jobId === 'string' ? job.jobId : null,
								completed: typeof jobRow.completed === 'boolean' ? jobRow.completed : job.ok !== false,
							},
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'jobs.status': {
				const args = engineJobStatusArgsSchema.parse(request.args ?? {});
				const storyId = args.allStories ? null : request.storyId;
				const jobStatus = await listJobs({
					storyId,
					limit: args.limit,
					allStories: args.allStories,
				});
				const jobs = Array.isArray(jobStatus.jobs) ? jobStatus.jobs : [];
				const stats = asRecord(jobStatus.stats);
				const response = {
					...base,
					status: 'succeeded',
					result: jobStatus,
					projectionChanges: {
						jobs: {
							status: {
								storyId,
								limit: args.limit,
								jobCount: jobs.length,
								total: typeof stats.total === 'number' ? stats.total : jobs.length,
							},
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'jobs.runDue': {
				const args = engineRunDueJobsArgsSchema.parse(request.args ?? {});
				const storyId = args.allStories ? null : request.storyId;
				const job = await runDueJobs({
					storyId,
					workerId: args.workerId,
					limit: args.limit,
					allStories: args.allStories,
				});
				const failed = Array.isArray(job.failed) ? job.failed : [];
				const response = {
					...base,
					status: 'succeeded',
					result: job,
					projectionChanges: {
						jobs: {
							runDue: {
								ok: job.ok !== false,
								storyId,
								workerId: typeof job.workerId === 'string' ? job.workerId : args.workerId ?? null,
								limit: typeof job.limit === 'number' ? job.limit : args.limit,
								claimed: typeof job.claimed === 'number' ? job.claimed : 0,
								completed: typeof job.completed === 'number' ? job.completed : 0,
								failedCount: failed.length,
							},
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'jobs.rollupArc': {
				const args = engineRollupArcJobArgsSchema.parse(request.args ?? {});
				const job = await runRollupArcJob({
					storyId: request.storyId,
					...args,
				});
				const jobRow = asRecord(job.job);
				const result = asRecord(jobRow.result);
				const response = {
					...base,
					status: 'succeeded',
					result: job,
					projectionChanges: {
						jobs: {
							rollupArc: {
								ok: job.ok !== false,
								storyId: request.storyId,
								workerId: typeof job.workerId === 'string' ? job.workerId : args.workerId ?? null,
								jobId: typeof job.jobId === 'string' ? job.jobId : null,
								runNow: typeof job.runNow === 'boolean' ? job.runNow : args.runNow !== false,
								completed: typeof jobRow.completed === 'boolean' ? jobRow.completed : job.ok !== false,
								arcCount: typeof result.arcCount === 'number' ? result.arcCount : null,
							},
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'jobs.storyVaultSync': {
				const args = engineStoryVaultSyncJobArgsSchema.parse(request.args ?? {});
				const storyId = args.allStories ? null : request.storyId;
				const job = await runStoryVaultSyncJob({
					storyId,
					...args,
				});
				const jobRow = asRecord(job.job);
				const mode = job.mode === 'bulk' || args.allStories ? 'bulk' : 'story';
				const response = {
					...base,
					status: 'succeeded',
					result: job,
					projectionChanges: {
						jobs: {
							storyVaultSync: {
								ok: job.ok !== false,
								mode,
								storyId,
								workerId: typeof job.workerId === 'string' ? job.workerId : args.workerId ?? null,
								jobId: typeof job.jobId === 'string' ? job.jobId : null,
								queued: typeof job.queued === 'number' ? job.queued : 1,
								selected: typeof job.selected === 'number' ? job.selected : 1,
								runNow: typeof job.runNow === 'boolean' ? job.runNow : args.runNow !== false,
								completed: typeof jobRow.completed === 'boolean' ? jobRow.completed : job.ok !== false,
							},
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'jobs.worldSim': {
				const args = asRecord(request.args);
				const job = await runWorldSimJob({
					...args,
					storyId: request.storyId,
				});
				const response = {
					...base,
					status: 'succeeded',
					result: job,
					projectionChanges: {
						jobs: { worldSim: job },
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({
					storyId: request.storyId,
					type: 'state.changed',
					data: response.projectionChanges,
				});
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.succeeded',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						projectionChanges: response.projectionChanges,
					},
				});
				return response;
			}
			default: {
				const response = {
					...base,
					status: 'failed',
					error: `Unknown engine command: ${request.command}`,
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({
					storyId: request.storyId,
					type: 'command.failed',
					data: {
						commandId: response.commandId,
						clientCommandId: response.clientCommandId,
						command: response.command,
						status: response.status,
						error: response.error,
					},
				});
				return response;
			}
		}
	} catch (error) {
		const response = {
			...base,
			status: 'failed',
			error: error instanceof Error ? error.message : String(error),
			updatedAt: nowIso(),
		} satisfies EngineCommandResponse;
		publishEngineEvent({
			storyId: request.storyId,
			type: 'command.failed',
			data: {
				commandId: response.commandId,
				clientCommandId: response.clientCommandId,
				command: response.command,
				status: response.status,
				error: response.error,
			},
		});
		return response;
	}
}
