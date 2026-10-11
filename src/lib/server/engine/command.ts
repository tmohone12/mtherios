import {migrateGame} from './gameMigration';
import { getLocationMap, listLocationMapHistory, restoreLocationMap, saveLocationMap } from './locationMaps';
import { addFactionDetail, readFactionProfile, saveFactionMembers } from '$lib/server/factions/authoring';
import { contentCommand } from './content';
import { selectContentCover } from './imageAssets';
import { generateManualSceneImage } from './imageRequests';
import { generatePortraitImage, readPortraitImageStatus } from './portraitImages';
import { contentCoverSelectSchema } from '$lib/contracts/content';
import { projectImageStyleSaveSchema } from '$lib/contracts/imageStyle';
import { saveProjectImageStyle } from './imageStyle';
import { startAgentRun, submitAgentTurn, getAgentRun, getCurrentAgentRun, getAgentRunHistory, respondAgentRun, cancelAgentRun, retryFailedAgentRun } from './agentRuns';
import { answerAssistantQuestion, cancelAssistantConversationBatch, cancelAssistantRun, createAssistantConversation, listAssistantConversations, readAssistantConversation, reviewAssistantApproval, undoAssistantStoryApproval, resumeAssistantRun, sendAssistantMessage } from './assistantConversations';
import { sourceMountsCommand, readRunSourceFile } from './sourceFiles';
import { getAgentSettings, saveAgentSettings, runProjectAgentJob } from './agentSettings';
import { agentSettingsReadSchema, agentSettingsSaveSchema } from '$lib/contracts/agentTools';
import { MutationError } from './mutationSafety';
import { randomUUID } from 'node:crypto';
import { plotEditSchema } from '$lib/contracts/plotEditing';
import { removeCampaignFact } from './campaignFacts';
import { editPlotState, listPlotCommitments } from './plotEditing';
import { findChapterCharacterCandidates, getBackendJobStats } from '$lib/server/jobs/processor';
import { z } from 'zod';
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
	engineMemoryRecoveryArgsSchema,
	engineRebuildSummariesArgsSchema,
	engineRetryJobArgsSchema,
	engineOrchestratorRunArgsSchema,
	enginePlotBrainPlanArgsSchema,
	enginePlotBrainRetireArgsSchema,
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
	type EnginePlotBrainPlanArgs,
	type EnginePlotBrainRetireArgs,
	type LlmServiceSetting,
	type LlmServiceSettingPatch,
	type RecordPatchRequest,
	worldRecordsQuerySchema,
} from '$lib/contracts/engine';
import type { GmTimelineBrief } from '$lib/contracts/memory';
import { worldDatabaseImportRequestSchema, type WorldDatabaseImportRequest } from '$lib/contracts/worldDatabase';
import {
	compileWorldSeedToBundle,
	previewWorldSeedSource,
	seedImportRequestSchema,
	seedPreviewRequestSchema,
} from '$lib/contracts/worldSeed';
import { createShelfRequestSchema, updateShelfRequestSchema } from '$lib/contracts/shelves';
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
	storyDeleteRequestSchema,
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
	type TurnSubmissionResponse,
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
	deleteBackendShelf,
	restoreBackendStory,
	exportBackendStory,
	createBackendStory,
	createBackendShelf,
	getBackendShelf,
	getBootstrap,
	getStoryEntriesPage,
	importIndexedDbBundle,
	listContextCheckpoints,
	listBackendStories,
	listBackendShelves,
	revertToContextCheckpoint,
	updateBackendShelf,
	upsertBackendArcFromLocal,
	upsertBackendChapterFromLocal,
	upsertBackendEntityFromEntry,
	upsertBackendLivingMemoryFromLocal,
	upsertBackendSagaFromLocal,
} from '$lib/server/memory/canonical';
import { normalizeGmToolArgs, prepareServerTurn, prepareServerTurnPreview, type ProcessServerTurnOptions, type PreparedServerTurnSummary, type PreparedServerTurnPreview } from '$lib/server/turn/orchestrator';
import { publishEngineEvent } from './events';
import {
	advanceStoryTurn,
	loadGmTimelineBrief,
	scheduleTimelineEvent,
	type StoryEventRow,
} from '$lib/server/events/timeline';
import {
	runMemoryRetrieveCommand,
	listBackendJobsCommand,
	retryBackendJobCommand,
	recoverMemoryCoverageCommand,
	rebuildSummariesCommand,
	runDueBackendJobsCommand,
	runReindexStoryJobCommand,
	runPlotBrainPlanCommand,
	runPlotBrainRetireCommand,
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
import { describeModelSettings, saveModelSettings } from './modelSettings';
import { buildPromptPacketDebug, type PromptPacketDebugInput } from './promptDiagnostics';
import {
	getWorldRecord,
	getStoryEntriesAround,
	listWorldRecordTypes,
	listWorldRecords as listWorldRecordsFromStore,
	patchWorldRecord,
} from './worldRecords';
import { getLocationWorkspace, saveLocationWorkspace } from './locationRecords';
import {
	characterDraftCreateArgsSchema,
	characterSourceDraftArgsSchema,
	draftCharacterFromCandidateSources,
	draftCharacterCreateFromStoryContext,
	draftCharacterUpdateFromStoryContext,
	type CharacterDraftCreateArgs,
	type CharacterDraftUpdateArgs,
	type CharacterSourceDraftArgs,
} from './characterDrafts';
import { searchCanonicalWorld } from './canonicalSearch';
import {
	actorBriefArgsSchema,
	affinityReadArgsSchema,
	checkScene,
	getActorBrief,
	getRelationshipWeb,
	getThreadBoard,
	readAffinity,
	relationshipWebArgsSchema,
	sceneCheckArgsSchema,
	threadBoardArgsSchema,
	type ActorBriefArgs,
	type AffinityReadArgs,
	type RelationshipWebArgs,
	type SceneCheckArgs,
	type ThreadBoardArgs,
} from './gmTools';
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

const patchProposalReviewArgsSchema = z.object({
	proposalId: z.string().min(1),
	decision: z.enum(['approved', 'rejected']),
	reviewer: z.string().min(1).optional(),
	notes: z.string().max(2_000).nullable().optional(),
	expectedProposalVersion: z.number().int().nonnegative().optional(),
});

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
	getWorldRecord?: (storyId: string, type: string, recordId: string) => Promise<JsonRecord>;
	patchWorldRecord?: (storyId: string, type: string, recordId: string, request: RecordPatchRequest) => Promise<JsonRecord>;
	draftCharacterUpdate?: (storyId: string, args: CharacterDraftUpdateArgs) => Promise<JsonRecord>;
	draftCharacterCreate?: (storyId: string, args: CharacterDraftCreateArgs) => Promise<JsonRecord>;
	draftCharacterFromSources?: (storyId: string, args: CharacterSourceDraftArgs) => Promise<JsonRecord>;
	findCharacterCandidates?: (storyId: string, chapterLimit: number) => Promise<JsonRecord>;
	searchWorld?: (input: Parameters<typeof searchCanonicalWorld>[0]) => Promise<JsonRecord>;
	getActorBrief?: (storyId: string, args: ActorBriefArgs) => Promise<JsonRecord>;
	readAffinity?: (storyId: string, args: AffinityReadArgs) => Promise<JsonRecord>;
	checkScene?: (storyId: string, args: SceneCheckArgs) => Promise<JsonRecord>;
	getRelationshipWeb?: (storyId: string, args: RelationshipWebArgs) => Promise<JsonRecord>;
	getThreadBoard?: (storyId: string, args: ThreadBoardArgs) => Promise<JsonRecord>;
	listShelves?: () => Promise<JsonRecord[]>;
	getShelf?: (shelfId: string) => Promise<JsonRecord>;
	createShelf?: (input: unknown) => Promise<JsonRecord>;
	updateShelf?: (shelfId: string, input: unknown) => Promise<JsonRecord>;
	deleteShelf?: (shelfId: string) => Promise<JsonRecord>;
	listStories?: (options?: { shelfId?: string | null }) => Promise<JsonRecord[]>;
	createStory?: (input: unknown) => Promise<JsonRecord>;
	exportStory?: (storyId: string) => Promise<JsonRecord>;
	deleteStory?: (storyId: string, options: { mode: 'archive' | 'purge'; exportBeforeDelete: boolean }) => Promise<JsonRecord>;
	restoreStory?: (storyId: string) => Promise<JsonRecord>;
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
	submitTurn?: (input: unknown) => Promise<TurnSubmissionResponse>;
	agentTurnOptions?: ProcessServerTurnOptions;
	loadTimelineBrief?: (input: Parameters<typeof loadGmTimelineBrief>[0]) => Promise<GmTimelineBrief>;
	scheduleTimelineEvent?: (input: Parameters<typeof scheduleTimelineEvent>[0]) => Promise<StoryEventRow>;
	advanceStoryTurn?: typeof advanceStoryTurn;
	prepareTurn?: (input: unknown) => Promise<PreparedServerTurnSummary>;
	previewTurn?: (input: unknown) => Promise<PreparedServerTurnPreview>;
	retrieveMemory?: (input: Parameters<typeof runMemoryRetrieveCommand>[0]) => Promise<RetrievedMemoryPacket>;
	pullSyncChanges?: (input: Parameters<typeof runSyncPullCommand>[0]) => Promise<SyncPullCommandResult>;
	pushSyncOperations?: (input: Parameters<typeof runSyncPushCommand>[0]) => Promise<SyncPushCommandResult>;
	runReindexStoryJob?: (input: unknown) => Promise<JsonRecord>;
	listJobs?: (input: JobStatusCommandInput) => Promise<JsonRecord>;
	retryJob?: (input: JsonRecord) => Promise<JsonRecord>;
	recoverMemory?: (input: JsonRecord) => Promise<JsonRecord>;
	rebuildSummaries?: (input: JsonRecord) => Promise<JsonRecord>;
	runDueJobs?: (input: RunDueJobsCommandInput) => Promise<JsonRecord>;
	runRollupArcJob?: (input: RollupArcJobCommandInput) => Promise<JsonRecord>;
	runStoryVaultSyncJob?: (input: StoryVaultSyncJobCommandInput) => Promise<JsonRecord>;
	runWorldSimJob?: (input: WorldSimJobCommandInput) => Promise<JsonRecord>;
	runPlotBrainPlan?: (input: EnginePlotBrainPlanArgs & { storyId: string }) => Promise<JsonRecord>;
	runPlotBrainRetire?: (input: EnginePlotBrainRetireArgs & { storyId: string }) => Promise<JsonRecord>;
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

function stringField(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

async function resolveBackendStoryId(
	storyId: string,
	listStories: () => Promise<JsonRecord[]>,
): Promise<string> {
	const clean = storyId.trim();
	if (!clean || clean === '__app__') return clean;
	try {
		const rows = await listStories();
		const match = rows.find((row) => stringField(row.id) === clean || stringField(row.clientStoryId) === clean);
		return stringField(match?.id) || clean;
	} catch {
		return clean;
	}
}

function asRecordArray(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.map(asRecord).filter((record) => Object.keys(record).length > 0) : [];
}

function nonnegativeInteger(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function promptSectionTokenEstimate(section: JsonRecord): number {
	const tokenEstimate = nonnegativeInteger(section.tokenEstimate);
	if (tokenEstimate > 0) return tokenEstimate;
	return nonnegativeInteger(section.maxTokens);
}

function promptSectionIds(sections: JsonRecord[]): string[] {
	return sections
		.map((section) => section.id)
		.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}

export async function executeEngineCommand(
	request: EngineCommandRequest,
	handlers: EngineCommandHandlers = {},
): Promise<EngineCommandResponse> {
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
	const draftCharacterCreate = handlers.draftCharacterCreate ?? draftCharacterCreateFromStoryContext;
	const draftCharacterFromSources = handlers.draftCharacterFromSources ?? draftCharacterFromCandidateSources;
	const findCharacterCandidates = handlers.findCharacterCandidates ?? findChapterCharacterCandidates;
	const searchWorld = handlers.searchWorld ?? searchCanonicalWorld;
	const loadActorBrief = handlers.getActorBrief ?? getActorBrief;
	const loadAffinity = handlers.readAffinity ?? readAffinity;
	const loadSceneCheck = handlers.checkScene ?? checkScene;
	const loadRelationshipWeb = handlers.getRelationshipWeb ?? getRelationshipWeb;
	const loadThreadBoard = handlers.getThreadBoard ?? getThreadBoard;
	const listShelves = handlers.listShelves ?? listBackendShelves;
	const getShelf = handlers.getShelf ?? getBackendShelf;
	const createShelf = handlers.createShelf ?? createBackendShelf;
	const updateShelf = handlers.updateShelf ?? updateBackendShelf;
	const deleteShelf = handlers.deleteShelf ?? deleteBackendShelf;
	const listStories = handlers.listStories ?? listBackendStories;
	request = { ...request, storyId: await resolveBackendStoryId(request.storyId, listStories) };
	const base = responseBase(request);
	const createStory = handlers.createStory ?? createBackendStory;
	const exportStory = handlers.exportStory ?? exportBackendStory;
	const deleteStory = handlers.deleteStory ?? deleteBackendStory;
	const restoreStory = handlers.restoreStory ?? restoreBackendStory;
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
	const loadTimelineBrief = handlers.loadTimelineBrief ?? loadGmTimelineBrief;
	const scheduleTimeline = handlers.scheduleTimelineEvent ?? scheduleTimelineEvent;
	const advanceTimelineTurn = handlers.advanceStoryTurn ?? advanceStoryTurn;
	const prepareTurn = handlers.prepareTurn ?? prepareServerTurn;
	const previewTurn = handlers.previewTurn ?? prepareServerTurnPreview;
	const retrieveMemory = handlers.retrieveMemory ?? runMemoryRetrieveCommand;
	const pullSyncChanges = handlers.pullSyncChanges ?? runSyncPullCommand;
	const pushSyncOperations = handlers.pushSyncOperations ?? runSyncPushCommand;
	const runReindexStoryJob = handlers.runReindexStoryJob ?? runReindexStoryJobCommand;
	const listJobs = handlers.listJobs ?? listBackendJobsCommand;
	const retryJob = handlers.retryJob ?? retryBackendJobCommand;
	const recoverMemory = handlers.recoverMemory ?? recoverMemoryCoverageCommand;
	const rebuildSummaries = handlers.rebuildSummaries ?? rebuildSummariesCommand;
	const runDueJobs = handlers.runDueJobs ?? runDueBackendJobsCommand;
	const runRollupArcJob = handlers.runRollupArcJob ?? runRollupArcJobCommand;
	const runStoryVaultSyncJob = handlers.runStoryVaultSyncJob ?? runStoryVaultSyncJobCommand;
	const runWorldSimJob = handlers.runWorldSimJob ?? runWorldSimJobCommand;
	const runPlotBrainPlan = handlers.runPlotBrainPlan ?? runPlotBrainPlanCommand;
	const runPlotBrainRetire = handlers.runPlotBrainRetire ?? runPlotBrainRetireCommand;
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
	const submitTurn = handlers.submitTurn ?? ((input: unknown) => submitAgentTurn(input, {
		...handlers.agentTurnOptions,
		runGmTool: async (call) => {
			const response = await executeEngineCommand({
				storyId: request.storyId,
				command: call.command,
				clientCommandId: `${request.clientCommandId ?? base.commandId}:${call.id}`,
				args: normalizeGmToolArgs(call),
			}, handlers);
			if (response.status !== 'succeeded') {
				throw new Error(response.error || `${call.command} failed.`);
			}
			return response.result;
		},
		onGmActivity: (activity) => {
			handlers.agentTurnOptions?.onGmActivity?.(activity);
			publishEngineEvent({
				storyId: request.storyId,
				type: 'gm.activity',
				data: { ...activity },
			});
		},
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
			case 'assistant.conversation.list': case 'assistant.conversation.create': case 'assistant.conversation.read': case 'assistant.message.send': case 'assistant.question.answer': case 'assistant.restore.review': case 'assistant.approval.review': case 'assistant.storyEdit.undo': case 'assistant.run.cancel': case 'assistant.run.resume': case 'assistant.batch.cancel': {
				if (request.storyId !== (request.args.gameId ?? '__app__')) throw new MutationError('SCOPE_DENIED', 'Command scope does not match the Assistant conversation.');
				const result = request.command === 'assistant.conversation.list' ? await listAssistantConversations(request.args)
					: request.command === 'assistant.conversation.create' ? await createAssistantConversation(request.args)
					: request.command === 'assistant.conversation.read' ? await readAssistantConversation(request.args)
					: request.command === 'assistant.message.send' ? await sendAssistantMessage(request.args)
					: request.command === 'assistant.question.answer' ? await answerAssistantQuestion(request.args)
					: request.command === 'assistant.run.resume' ? await resumeAssistantRun(request.args)
					: request.command === 'assistant.storyEdit.undo' ? await undoAssistantStoryApproval(request.args)
					: request.command === 'assistant.restore.review' || request.command === 'assistant.approval.review' ? await reviewAssistantApproval(request.args)
					: request.command === 'assistant.batch.cancel' ? await cancelAssistantConversationBatch(request.args) : await cancelAssistantRun(request.args);
				const response = { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
				return response;
			}
			case 'source.mounts.list': case 'source.mounts.save': case 'source.mounts.remove': {
				if (request.storyId !== '__app__') throw new MutationError('SCOPE_DENIED', 'Source folders are managed in project settings.');
				const result = await sourceMountsCommand(request.command, request.args);
				return { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
			}
			case 'source.file.read': {
				if (request.storyId !== (request.args.gameId ?? '__app__')) throw new MutationError('SCOPE_DENIED', 'Source command does not match its run scope.');
				const result = await readRunSourceFile(request.args);
				return { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
			}
			case 'research.preview': {
				const { getDb } = await import('$lib/server/db/client');
				const { sql } = await import('drizzle-orm');
				const [story] = await getDb().execute(sql`select shelf_id from stories where id=${request.storyId}`);
				if (!story) throw new MutationError('SCOPE_DENIED', 'Game not found.');
				const researchSettings = await getAgentSettings({ projectId: String(story.shelf_id), gameId: request.storyId });
				const result = researchSettings.effective.gmResearch
					? await (await import('./research')).runCompactResearch({ storyId: request.storyId, projectId: String(story.shelf_id), question: String(request.args.question ?? ''), runId: 'preview', callId: base.commandId })
					: { status: 'disabled', statements: [], unresolved: [String(request.args.question ?? '')], searchedSourceIds: [], mode: 'local_extract' };
				const response = { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'agent.run.start': case 'agent.run.status': case 'agent.run.current': case 'agent.run.history': case 'agent.run.respond': case 'agent.run.cancel': case 'agent.run.retry': {
				const args = { ...request.args, storyId: request.storyId };
				const result = request.command === 'agent.run.start' ? await startAgentRun(request.args, request.storyId, handlers.agentTurnOptions)
					: request.command === 'agent.run.status' ? await getAgentRun(args)
					: request.command === 'agent.run.current' ? await getCurrentAgentRun(args)
					: request.command === 'agent.run.history' ? await getAgentRunHistory(args)
					: request.command === 'agent.run.respond' ? await respondAgentRun(args)
					: request.command === 'agent.run.retry' ? await retryFailedAgentRun(args) : await cancelAgentRun(args);
				const response = { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
				if (!['agent.run.current', 'agent.run.status', 'agent.run.history'].includes(request.command)) publishSucceededEvent(response);
				return response;
			}

      case 'content.games.previewMove': case 'content.games.move': {
        if(request.storyId!=='__app__'&&request.storyId!==request.args.gameId)throw new MutationError('SCOPE_DENIED','Command game scope does not match migration scope.');
        const result=await migrateGame(request.args,request.command==='content.games.previewMove');
        const response={...base,status:'succeeded',result,updatedAt:nowIso()} satisfies EngineCommandResponse;publishSucceededEvent(response);return response;
      }
      case 'content.canonicalTypes.read': case 'content.canonicalTypes.preview': case 'content.canonicalTypes.save': case 'content.canonicalTypes.history': case 'content.canonicalTypes.previewRestore': case 'content.canonicalTypes.restore':
      case 'content.folders.previewArchive': case 'content.folders.archive': case 'content.folders.previewRestore': case 'content.folders.restore': case 'content.folders.previewCopy': case 'content.folders.copy': case 'content.folders.list': case 'content.folders.create': case 'content.folders.previewMove': case 'content.folders.move':
      case 'content.history': case 'content.history.previewRestore': case 'content.history.restore':
      case 'content.types.list': case 'content.types.preview': case 'content.types.save':
      case 'content.list': case 'content.read': case 'content.write': case 'content.update': case 'content.organize': case 'content.canonical': case 'content.canonical.edit': case 'content.canonical.history': case 'content.canonical.previewRestore': case 'content.canonical.restore': case 'content.canonical.create': case 'content.canonical.copy': case 'content.export': case 'content.import.preview': case 'content.import': {
        const result = await contentCommand(request.command, request.args, request.storyId);
        const response = { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
        publishSucceededEvent(response);
        return response;
      }
			case 'content.cover.select': {
				const args = contentCoverSelectSchema.parse(request.args);
				if (request.storyId !== '__app__' && request.storyId !== args.gameId) throw new MutationError('SCOPE_DENIED', 'Command game scope does not match the content scope.');
				const result = await selectContentCover(args);
				const response = { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'image.scene.request': {
				const args = z.object({ projectId: z.string().min(1).max(200), gameId: z.string().min(1).max(200),
					clientTurnId: z.string().min(1).max(200), callId: z.string().min(1).max(200),
					prompt: z.string().trim().min(1).max(1000).optional() }).strict().parse(request.args);
				if (request.storyId !== args.gameId) throw new MutationError('SCOPE_DENIED', 'Command game scope does not match the image origin.');
				const result = await generateManualSceneImage(args);
				const response = { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'image.portrait.request': case 'image.portrait.status': {
				const scope = z.object({ projectId: z.string().min(1).max(200), gameId: z.string().min(1).max(200),
					characterId: z.string().min(1).max(200) });
				const args = (request.command === 'image.portrait.request' ? scope.extend({ callId: z.string().min(1).max(200) }) : scope)
					.strict().parse(request.args);
				if (request.storyId !== args.gameId) throw new MutationError('SCOPE_DENIED', 'Command game scope does not match the portrait target.');
				const result = request.command === 'image.portrait.request'
					? await generatePortraitImage(args as typeof args & { callId: string }) : await readPortraitImageStatus(args);
				const response = { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
				if (request.command === 'image.portrait.request') publishSucceededEvent(response);
				return response;
			}
			case 'project.jobs.run':
			case 'project.jobs.retry': {
				if (request.storyId !== '__app__') throw new MutationError('SCOPE_DENIED', 'Project jobs require an explicit project scope.');
				const result = await runProjectAgentJob(request.args, request.command === 'project.jobs.retry');
				return { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
			}
			case 'project.jobs.status': {
				const args = agentSettingsReadSchema.parse(request.args ?? {});
				if (request.storyId !== '__app__' || args.gameId) throw new MutationError('SCOPE_DENIED', 'Project jobs require an explicit project scope.');
				await getAgentSettings(args);
				const result = await getBackendJobStats(null, args.projectId);
				return { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
			}
			case 'settings.agent.get':
			case 'settings.agent.save': {
				const args = (request.command === 'settings.agent.save' ? agentSettingsSaveSchema : agentSettingsReadSchema).parse(request.args ?? {});
				if (request.storyId !== '__app__' && request.storyId !== args.gameId) throw new MutationError('SCOPE_DENIED', 'Command game scope does not match the settings target.');
				const result = request.command === 'settings.agent.save' ? await saveAgentSettings(args) : await getAgentSettings(args);
				const response = { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
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
			case 'prompts.presets.list':
			case 'prompts.presets.get':
			case 'prompts.presets.save':
			case 'prompts.presets.duplicate':
			case 'prompts.presets.select':
			case 'prompts.presets.setDefault':
			case 'prompts.presets.export':
			case 'prompts.presets.import':
			case 'prompts.presets.preview': {
				const args = (request.args ?? {}) as Record<string, unknown>;
				if (request.command === 'prompts.presets.select' && request.storyId !== args.storyId) {
					throw new MutationError('SCOPE_DENIED', 'Preset selection must target the command story.');
				}
				const presets = await import('./promptPresets');
				const result = request.command === 'prompts.presets.list' ? await presets.listPromptPresets(typeof args.storyId === 'string' ? args.storyId : null)
					: request.command === 'prompts.presets.get' ? await presets.getPromptPreset(String(args.presetId ?? ''), typeof args.revision === 'number' ? args.revision : undefined)
					: request.command === 'prompts.presets.save' ? await presets.savePromptPreset(args)
					: request.command === 'prompts.presets.duplicate' ? await presets.duplicatePromptPreset(args)
					: request.command === 'prompts.presets.select' ? await presets.selectStoryPromptPreset(args)
					: request.command === 'prompts.presets.setDefault' ? await presets.setDefaultPromptPreset(args)
					: request.command === 'prompts.presets.export' ? await presets.exportPromptPreset(args)
					: request.command === 'prompts.presets.import' ? await presets.importPromptPreset(args)
					: await presets.previewPromptPreset(args);
				const changed = ['prompts.presets.save', 'prompts.presets.duplicate', 'prompts.presets.select', 'prompts.presets.setDefault', 'prompts.presets.import'].includes(request.command);
				const response = {
					...base,
					status: 'succeeded',
					result: result as unknown as JsonRecord,
					projectionChanges: changed ? { promptPresets: { command: request.command } } : {},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				if (changed) publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'world.clock.status':
			case 'world.clock.configure': {
				const clock = await import('$lib/server/events/worldClock');
				const args = request.command === 'world.clock.configure' ? z.object({
					calendar: z.object({ hoursPerDay: z.number().int().min(1).max(100).optional(),
						months: z.array(z.object({ name: z.string().trim().min(1), days: z.number().int().min(1).max(1000) }).strict()).max(100).optional(),
						weekdays: z.array(z.string().trim().min(1)).max(50).optional(), era: z.string().trim().max(40).nullable().optional() }).strict().optional(),
					label: z.string().trim().min(1).max(240).nullable().optional(),
					reviewedBy: z.string().trim().min(1), reason: z.string().max(2000).optional(),
				}).strict().parse(request.args ?? {}) : null;
				const result = args
					? await clock.configureWorldClock({ storyId: request.storyId, ...args })
					: await clock.worldClockStatus(request.storyId);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { worldClock: args ? { configured: true } : { status: true } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				if (args) publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'chapters.windows.status':
			case 'chapters.windows.reconcile': {
				const [windows, { enqueueChapterSummaryJob }] = await Promise.all([import('$lib/server/jobs/chapterWindows'), import('$lib/server/jobs/outbox')]);
				const args = request.command === 'chapters.windows.reconcile' ? z.object({
					windowId: z.string().min(1), revision: z.number().int().positive(), decision: z.enum(['redispatch', 'invalidate']),
					reviewedBy: z.string().trim().min(1), note: z.string().max(2000).optional(),
				}).strict().parse(request.args ?? {}) : null;
				const result = args
					? await windows.reconcileChapterWindow({ storyId: request.storyId, ...args })
					: await windows.chapterWindowStatus(request.storyId);
				if (args) await enqueueChapterSummaryJob({ storyId: request.storyId, serverVersion: 0,
					dedupeKey: `${args.windowId}-r${args.revision}-reconciled-${Date.now()}` });
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { chapters: { windows: args ? { reconciled: { windowId: args.windowId, revision: args.revision, decision: args.decision } } : { status: true } } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				if (args) publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'settings.models.get':
			case 'settings.models.save': {
				const result = request.command === 'settings.models.save'
					? await saveModelSettings(request.args ?? {})
					: await describeModelSettings();
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { modelSettings: { revision: result.revision } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				if (request.command === 'settings.models.save') publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
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
					contextBudget: args.contextBudget,
					recentDialogueTokens: args.recentDialogueTokens,
					recentDialogueTurns: args.recentDialogueTurns,
				});
				const retrieved = asRecord(diagnostics.retrieved);
				const prompt = asRecord(diagnostics.prompt);
				const messages = Array.isArray(prompt.messages) ? prompt.messages : [];
				const compiledPrompt = asRecord(prompt.compiledPrompt);
				const stableSections = asRecordArray(compiledPrompt.stablePrefix);
				const dynamicSections = asRecordArray(compiledPrompt.dynamicTail);
				const promptSections = [...stableSections, ...dynamicSections];
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
							sectionCount: promptSections.length,
							stableSectionCount: stableSections.length,
							dynamicSectionCount: dynamicSections.length,
							sectionIds: promptSectionIds(promptSections),
							sectionTokenEstimate: promptSections.reduce((sum, section) => sum + promptSectionTokenEstimate(section), 0),
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
			case 'database.seed.preview': {
				const args = seedPreviewRequestSchema.parse(request.args ?? {});
				const result = previewWorldSeedSource(args);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						seedPreview: result.summary,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'database.seed.import': {
				const args = seedImportRequestSchema.parse(request.args ?? {});
				const preview = args.source ? previewWorldSeedSource(args.source) : null;
				const seed = args.seed ?? preview?.seedDraft;
				if (!seed) throw new Error('Seed import requires either a seed object or an import source.');
				const bundle = compileWorldSeedToBundle(seed);
				if (!bundle.worldDatabase.story) throw new Error('Seed import requires a first story. Add story.title to the seed.');
				const result = await importWorldDatabase({
					bundle: bundle as unknown as WorldDatabaseImportRequest['bundle'],
					options: args.options,
				});
				const imported = asRecord(result);
				const storyId = typeof imported.storyId === 'string' ? imported.storyId : request.storyId;
				const response = {
					...base,
					status: 'succeeded',
					result: { ...asRecord(result), bundle, preview },
					projectionChanges: {
						seedImport: {
							ok: imported.ok !== false,
							storyId,
							shelfId: typeof bundle.shelf.id === 'string' ? bundle.shelf.id : null,
							counts: asRecord(imported.counts),
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId, type: 'state.changed', data: response.projectionChanges });
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
				const args = withCommandStoryId(request.storyId, request.args ?? {});
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
				return response;
			}
			case 'settings.image.save': {
				if (request.storyId !== '__app__') throw new MutationError('SCOPE_DENIED', 'Project image style requires project scope.');
				const result = await saveProjectImageStyle(projectImageStyleSaveSchema.parse(request.args ?? {}));
				const response = { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'campaign.status': {
				const args = engineCampaignStatusArgsSchema.parse(request.args ?? {});
				const projection = await loadCampaignProjection(request.storyId, {
					entryLimit: args.entryLimit,
					entityLimit: args.entityLimit,
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
			case 'world.actor.brief': {
				const args = actorBriefArgsSchema.parse(request.args ?? {});
				const result = await loadActorBrief(request.storyId, args);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { gmTool: { command: request.command, target: args.actorId ?? args.name ?? null } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'world.affinity.read': {
				const args = affinityReadArgsSchema.parse(request.args ?? {});
				const result = await loadAffinity(request.storyId, args);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { gmTool: { command: request.command, target: args.actorIds[0] ?? args.actorNames[0] ?? null } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'world.scene.check': {
				const args = sceneCheckArgsSchema.parse(request.args ?? {});
				const result = await loadSceneCheck(request.storyId, args);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { gmTool: { command: request.command, target: args.locationId ?? args.locationName ?? null } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'world.relationship.web': {
				const args = relationshipWebArgsSchema.parse(request.args ?? {});
				const result = await loadRelationshipWeb(request.storyId, args);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { gmTool: { command: request.command, target: args.actorIds[0] ?? args.actorNames[0] ?? null } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'plot.thread.board': {
				const args = threadBoardArgsSchema.parse(request.args ?? {});
				const result = await loadThreadBoard(request.storyId, args);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { gmTool: { command: request.command, target: args.query ?? args.actorIds[0] ?? args.factionIds[0] ?? null } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'world.location.get':
			case 'world.location.save': {
				const result = request.command === 'world.location.get'
					? await getLocationWorkspace(request.storyId, request.args as Parameters<typeof getLocationWorkspace>[1])
					: await saveLocationWorkspace(request.storyId, request.args as Parameters<typeof saveLocationWorkspace>[1]);
				const response = { ...base, status: 'succeeded', result, projectionChanges: { location: { storyId: request.storyId, locationId: request.args?.locationId } }, updatedAt: nowIso() } satisfies EngineCommandResponse;
				if (request.command === 'world.location.save') publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'world.location.map.get':
			case 'world.location.map.history':
			case 'world.location.map.save':
			case 'world.location.map.restore': {
				const result = request.command === 'world.location.map.get'
					? await getLocationMap(request.storyId, request.args as Parameters<typeof getLocationMap>[1])
					: request.command === 'world.location.map.history'
						? await listLocationMapHistory(request.storyId, request.args as Parameters<typeof listLocationMapHistory>[1])
						: request.command === 'world.location.map.save'
							? await saveLocationMap(request.storyId, request.args as Parameters<typeof saveLocationMap>[1])
							: await restoreLocationMap(request.storyId, request.args as Parameters<typeof restoreLocationMap>[1]);
				const response = { ...base, status: 'succeeded', result, projectionChanges: { locationMap: { storyId: request.storyId, locationId: request.args?.locationId } }, updatedAt: nowIso() } satisfies EngineCommandResponse;
				if (request.command === 'world.location.map.save' || request.command === 'world.location.map.restore') publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'world.faction.profile.get':
			case 'world.faction.profile.add':
			case 'world.faction.profile.saveMembers': {
				const result = request.command === 'world.faction.profile.get'
					? await readFactionProfile(request.storyId, request.args)
					: request.command === 'world.faction.profile.add'
						? await addFactionDetail(request.storyId, request.args)
						: await saveFactionMembers(request.storyId, request.args);
				const response = { ...base, status: 'succeeded', result, projectionChanges: { worldRecord: { type: 'factions', recordId: result.factionId, storyId: request.storyId, serverVersion: result.version } }, updatedAt: nowIso() } satisfies EngineCommandResponse;
				if (request.command !== 'world.faction.profile.get') publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'world.record.get': {
				const args = engineWorldRecordDetailArgsSchema.parse(request.args ?? {});
				const detail = await readWorldRecord(request.storyId, args.type, args.recordId);
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
			case 'campaign.fact.remove': {
				const result = await removeCampaignFact(request.storyId, request.args);
				const response = { ...base, status: 'succeeded', result,
					projectionChanges: { campaignState: { removedKey: result.removed.key } }, updatedAt: nowIso() } satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'world.record.patch': {
				const args = engineWorldRecordPatchArgsSchema.parse(request.args ?? {});
				const result = await writeWorldRecord(request.storyId, args.type, args.recordId, {
					updates: args.updates,
					reason: args.reason,
					...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
					...(args.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: args.expectedUpdatedAt } : {}),
					...(args.jsonMode !== undefined ? { jsonMode: args.jsonMode } : {}),
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
			case 'world.character.draftCreate': {
				const args = characterDraftCreateArgsSchema.parse(request.args ?? {});
				const result = await draftCharacterCreate(request.storyId, args);
				const record = asRecord(result);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						characterDraftCreate: {
							name: args.name,
							recordId: typeof record.recordId === 'string' ? record.recordId : null,
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
			case 'world.character.findCandidates': {
				const args = z.object({ chapterLimit: z.number().int().min(1).max(12).default(8) }).parse(request.args ?? {});
				const result = await findCharacterCandidates(request.storyId, args.chapterLimit);
				const response = { ...base, status: 'succeeded', result, projectionChanges: { characterCandidates: result }, updatedAt: nowIso() } satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'world.character.draftFromSources': {
				const args = characterSourceDraftArgsSchema.parse(request.args ?? {});
				const result = await draftCharacterFromSources(request.storyId, args);
				const response = {
					...base, status: 'succeeded', result,
					projectionChanges: { characterDraftFromSources: { proposalId: args.proposalId, status: result.status } },
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
				const args = storyDeleteRequestSchema.parse(request.args ?? {});
				const result = await deleteStory(request.storyId, args);
				const resultRecord = asRecord(result);
				const deleted = resultRecord.ok !== false;
				const warnings = Array.isArray(resultRecord.warnings) ? resultRecord.warnings : [];
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						story: {
							storyId: request.storyId,
							deleted,
							mode: typeof resultRecord.mode === 'string' ? resultRecord.mode : args.mode,
							canonDeleted: resultRecord.canonDeleted === true,
							artifactCleanup: asRecord(resultRecord.artifactCleanup),
							warningCount: warnings.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'story.restore': {
				const result = await restoreStory(request.storyId);
				const restored = asRecord(result);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						story: {
							storyId: request.storyId,
							restored: restored.ok !== false,
							serverVersion: typeof restored.serverVersion === 'number' ? restored.serverVersion : null,
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
			case 'shelf.list': {
				const shelves = await listShelves();
				const response = {
					...base,
					status: 'succeeded',
					result: { shelves },
					projectionChanges: {
						shelfCatalog: { count: shelves.length },
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'shelf.get': {
				const args = asRecord(request.args ?? {});
				const shelfId = stringField(args.shelfId) || request.storyId;
				const shelf = await getShelf(shelfId);
				const response = {
					...base,
					status: 'succeeded',
					result: { shelf },
					projectionChanges: { shelf },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'shelf.create': {
				const args = createShelfRequestSchema.parse(request.args ?? {});
				const result = await createShelf(args);
				const created = asRecord(result);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						shelf: {
							shelfId: typeof created.shelfId === 'string' ? created.shelfId : null,
							created: true,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'shelf.update': {
				const rawArgs = asRecord(request.args ?? {});
				const shelfId = stringField(rawArgs.shelfId) || request.storyId;
				const args = updateShelfRequestSchema.parse(rawArgs);
				const shelf = await updateShelf(shelfId, args);
				const response = {
					...base,
					status: 'succeeded',
					result: { shelf },
					projectionChanges: { shelf },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'shelf.delete': {
				const args = asRecord(request.args ?? {});
				const shelfId = stringField(args.shelfId) || request.storyId;
				const result = await deleteShelf(shelfId);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { shelf: { shelfId, deleted: true } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'story.list': {
				const args = asRecord(request.args ?? {});
				const stories = await listStories({
					shelfId: typeof args.shelfId === 'string' ? args.shelfId : null,
					includeArchived: args.includeArchived === true,
				});
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
							...(args.startWorkflow ? { startWorkflow: args.startWorkflow } : {}),
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
					expectedVersion: typeof args.expectedVersion === 'number' ? args.expectedVersion : undefined,
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
				const args = patchProposalReviewArgsSchema.parse(request.args ?? {});
				const result = await reviewProposal({
					storyId: request.storyId,
					proposalId: args.proposalId,
					decision: args.decision,
					reviewer: args.reviewer ?? 'human',
					notes: args.notes ?? null,
					...(args.expectedProposalVersion !== undefined ? { expectedProposalVersion: args.expectedProposalVersion } : {}),
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
					...(args.delayWorldMinutes ? { delayWorldMinutes: args.delayWorldMinutes } : {}),
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
				const { currentTurn, serverVersion, promotedEvents } = await advanceTimelineTurn(request.storyId, args.delta, {
					expectedServerVersion: args.serverVersion,
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
					serverVersion,
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
						serverVersion,
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
			case 'turn.preview': {
				const args = asRecord(request.args);
				const turnInput = turnRequestSchema.parse({
					...args,
					storyId: request.storyId,
					clientTurnId: typeof args.clientTurnId === 'string' ? args.clientTurnId : request.clientCommandId ?? base.commandId,
				});
				const preview = await previewTurn(turnInput);
				const response = {
					...base,
					status: 'succeeded',
					result: preview,
					projectionChanges: {
						turnPreview: {
							clientTurnId: preview.clientTurnId,
							preparationMs: preview.preparationMs,
							sourceReferenceCount: preview.sourceReferences.length,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
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
							stepCount: orchestrator.steps.length,
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
				if ('status' in turn) {
					const response = { ...base, status: 'succeeded', result: turn, updatedAt: nowIso() } satisfies EngineCommandResponse;
					publishSucceededEvent(response);
					return response;
				}
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
					...(args.status ? { status: args.status } : {}),
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
			case 'jobs.retry': {
				const args = engineRetryJobArgsSchema.parse(request.args ?? {});
				const result = await retryJob({ storyId: request.storyId, ...args });
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { jobs: { retry: result } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'jobs.recoverMemory': {
				const args = engineMemoryRecoveryArgsSchema.parse(request.args ?? {});
				const result = await recoverMemory({ storyId: request.storyId, ...args });
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { jobs: { recoverMemory: result } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'jobs.rebuildSummaries': {
				const args = engineRebuildSummariesArgsSchema.parse(request.args ?? {});
				const result = await rebuildSummaries({ storyId: request.storyId, ...args });
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: { jobs: { rebuildSummaries: result } },
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
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
					scope: args.scope,
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
			case 'plotBrain.plan': {
				const args = enginePlotBrainPlanArgsSchema.parse(request.args ?? {});
				const result = await runPlotBrainPlan({
					...args,
					storyId: request.storyId,
				});
				const resultRecord = asRecord(result);
				const projection = {
					ok: resultRecord.ok !== false,
					storyId: typeof resultRecord.storyId === 'string' ? resultRecord.storyId : request.storyId,
					frameId: typeof resultRecord.frameId === 'string' ? resultRecord.frameId : null,
					plotCardCount: typeof resultRecord.plotCardCount === 'number' ? resultRecord.plotCardCount : null,
					threadCount: typeof resultRecord.threadCount === 'number' ? resultRecord.threadCount : null,
					eventCount: typeof resultRecord.eventCount === 'number' ? resultRecord.eventCount : null,
					proposalCount: typeof resultRecord.proposalCount === 'number' ? resultRecord.proposalCount : null,
					executed: resultRecord.executed === true,
				};
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						plotBrain: projection,
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'plot.edit': {
				const result = await editPlotState(request.storyId, plotEditSchema.parse(request.args));
				const response = { ...base, status: 'succeeded', result, projectionChanges: { plotBrain: result }, updatedAt: nowIso() } satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
				return response;
			}
			case 'plot.commitments': {
				const result = await listPlotCommitments(request.storyId);
				const response = { ...base, status: 'succeeded', result, updatedAt: nowIso() } satisfies EngineCommandResponse;
				publishSucceededEvent(response);
				return response;
			}
			case 'plotBrain.retire': {
				const args = enginePlotBrainRetireArgsSchema.parse(request.args ?? {});
				const result = await runPlotBrainRetire({ ...args, storyId: request.storyId });
				const resultRecord = asRecord(result);
				const response = {
					...base,
					status: 'succeeded',
					result,
					projectionChanges: {
						plotBrain: {
							active: false,
							quietUntilTurn: resultRecord.quietUntilTurn ?? null,
							retiredStoryThreads: resultRecord.retiredStoryThreads ?? 0,
							retiredStoryEvents: resultRecord.retiredStoryEvents ?? 0,
							serverVersion: resultRecord.serverVersion ?? null,
						},
					},
					updatedAt: nowIso(),
				} satisfies EngineCommandResponse;
				publishEngineEvent({ storyId: request.storyId, type: 'state.changed', data: response.projectionChanges });
				publishSucceededEvent(response);
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
			...(error instanceof MutationError ? { errorDetails: { code: error.code, details: error.details } } : {}),
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
