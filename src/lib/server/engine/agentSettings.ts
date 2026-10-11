import { enqueueBackendJob, retryBackendJob } from '$lib/server/jobs/outbox';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { agentSettingsDocumentSchema, agentSettingsReadSchema, agentSettingsSaveSchema, projectJobActionSchema, resolveAgentSettings, type AgentSettingsDocument } from '$lib/contracts/agentTools';
import { MutationError } from './mutationSafety';
import { readProjectImageStyle } from '$lib/contracts/imageStyle';
import { loadModelSettings, resolveModelTaskFromSnapshot } from './modelSettings';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function readAgentDocument(settings: unknown): AgentSettingsDocument {
	const stored = object(settings).agentTools;
	return stored === undefined ? { schemaVersion: 1, revision: 0, overrides: {} } : agentSettingsDocumentSchema.parse(stored);
}

async function readScope(db: Db | Tx, projectId: string, gameId?: string, lock = false) {
	const [project] = await db.execute(sql`select id, settings from shelves where id = ${projectId} ${lock ? sql`for update` : sql``}`);
	if (!project) throw new MutationError('SCOPE_DENIED', 'Project not found.');
	const [game] = gameId ? await db.execute(sql`select id, settings from stories where id = ${gameId} and shelf_id = ${projectId} ${lock ? sql`for update` : sql``}`) : [];
	if (gameId && !game) throw new MutationError('SCOPE_DENIED', 'The game does not belong to this project.');
	return { project, game, projectDocument: readAgentDocument(project.settings), gameDocument: game ? readAgentDocument(game.settings) : undefined };
}

export async function getAgentSettings(input: unknown) {
	const { projectId, gameId } = agentSettingsReadSchema.parse(input);
	const scope = await readScope(getDb(), projectId, gameId);
	const modelSettings = await loadModelSettings();
	const profiles = ['assistant', 'batchAuthoring', 'activeRecall', 'imageGeneration'].flatMap(taskId => {
		const { setting, provenance } = resolveModelTaskFromSnapshot(taskId, modelSettings);
		// An environment default for a disabled optional task is not a configured profile.
		return setting && (setting.enabled || provenance.source !== 'environment')
			? [{ service_id: taskId, provider_type: setting.providerType, model: setting.model, enabled: setting.enabled }] : [];
	});
	const resolved = resolveAgentSettings(scope.projectDocument, scope.gameDocument);
	if (resolved.sources.gmAdaptiveResearch === 'default' && profiles.some(profile => profile.service_id === 'activeRecall' && profile.enabled === true)) {
		resolved.effective.gmAdaptiveResearch = true;
		resolved.sources.gmAdaptiveResearch = 'legacy';
	}
	return { projectId, gameId: gameId ?? null, project: scope.projectDocument, game: scope.gameDocument ?? null, imageStyle: readProjectImageStyle(scope.project.settings), ...resolved, profiles, toolsAvailable: Boolean(gameId) };
}

export async function saveAgentSettings(input: unknown) {
	const request = agentSettingsSaveSchema.parse(input);
	if (request.gameId && Object.hasOwn(request.changes, 'automaticCovers')) throw new MutationError('INVALID_FIELD', 'Automatic covers are a project setting.');
	await getDb().transaction(async tx => {
		const scope = await readScope(tx, request.projectId, request.gameId, true);
		const current = request.gameId ? scope.gameDocument! : scope.projectDocument;
		if (request.expectedRevision !== current.revision) throw new MutationError('REVISION_CONFLICT', 'Tool settings changed. Reload before saving.', { expected: request.expectedRevision, actual: current.revision });
		const overrides = { ...current.overrides };
		for (const [key, value] of Object.entries(request.changes)) {
			const settingKey = key as keyof typeof overrides;
			if (value === null) delete overrides[settingKey]; else if (value !== undefined) overrides[settingKey] = value;
		}
		const next: AgentSettingsDocument = { schemaVersion: 1, revision: current.revision + 1, overrides };
		const table = request.gameId ? sql`stories` : sql`shelves`;
		const targetId = request.gameId ?? request.projectId;
		await tx.execute(sql`update ${table} set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('agentTools', ${JSON.stringify(next)}::jsonb), server_version = server_version + 1, updated_at = now() where id = ${targetId}`);
		await enqueueBackendJob({ projectId: request.projectId, type: 'validate_agent_settings', dedupeKey: `settings-${targetId}-${next.revision}`, payload: { targetId, revision: next.revision } }, tx);
	});
	return getAgentSettings({ projectId: request.projectId, ...(request.gameId ? { gameId: request.gameId } : {}) });
}

export async function validateProjectAgentSettings(projectId: string) {
	return getDb().transaction(async tx => {
		const scope = await readScope(tx, projectId, undefined, true);
		const games = await tx.execute(sql`select id, settings from stories where shelf_id = ${projectId}`);
		for (const game of games) readAgentDocument(game.settings);
		const result = { projectId, projectRevision: scope.projectDocument.revision, gamesChecked: games.length, validatedAt: new Date().toISOString() };
		await tx.execute(sql`update shelves set metadata = metadata || jsonb_build_object('agentSettingsValidation', ${JSON.stringify(result)}::jsonb) where id = ${projectId}`);
		return result;
	});
}

export async function runProjectAgentJob(input: unknown, retry = false) {
	const request = projectJobActionSchema.parse(input);
	const [job] = await getDb().execute(sql`select id from backend_jobs where id = ${request.jobId} and project_id = ${request.projectId} and story_id is null and type in ('validate_agent_settings', 'generate_image')`);
	if (!job) throw new MutationError('SCOPE_DENIED', 'Project job not found in this scope.');
	if (retry) {
		if (!request.expectedUpdatedAt) throw new MutationError('REVISION_REQUIRED', 'Supply the failed job timestamp before retrying.');
		return retryBackendJob({ storyId: null, projectId: request.projectId, jobId: request.jobId, expectedUpdatedAt: request.expectedUpdatedAt });
	}
	const { runBackendJobNow } = await import('$lib/server/jobs/processor');
	return runBackendJobNow(request.jobId);
}
