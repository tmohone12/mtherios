import { createHash } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { modelProfiles, modelRoles, modelTaskOverrides } from '$lib/server/db/schema';
import {
	MODEL_ROLES,
	activeModelTasks,
	isRolePrimaryTask,
	modelProfileSchema,
	modelRoleIds,
	modelRoleSettingSchema,
	modelSettingsSaveSchema,
	modelTaskDefinition,
	modelTaskOverrideSchema,
	type ModelGenerationParameters,
	type ModelProfile,
	type ModelRoleId,
	type ModelRoleSetting,
	type ModelSettingsSave,
	type ModelTaskDefinition,
	type ModelTaskOverride,
	type ModelTaskProvenance,
} from '$lib/contracts/modelTasks';
import { llmServiceSettingSchema, type LlmServiceSetting, type LlmServiceSettingPatch } from '$lib/contracts/engine';
import type { TurnRequest } from '$lib/contracts/memory';
import { supportsDecisionModel } from '$lib/contracts/decisionModels';
import { PROVIDERS } from '$lib/services/ai/sdk/providers/config';
import type { ProviderType } from '$lib/types';
import { environmentServiceSetting, resolveApiKeyRef, saveLocalApiKeyRefs } from './llmEnvironment';

/**
 * One owner for model configuration. Resolution is read-only: it never inserts,
 * enables or rewrites a setting. A task uses its explicit override, else its role's
 * profile, else (core roles only) the environment default. Decisions, Authoring and
 * Image never inherit another role.
 */

type ProviderProfile = NonNullable<TurnRequest['providerProfile']>;
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ModelSettingsSnapshot {
	profiles: Map<string, ModelProfile>;
	roles: Map<ModelRoleId, ModelRoleSetting>;
	overrides: Map<string, ModelTaskOverride>;
	revision: string;
}

export interface ResolvedTaskGeneration {
	model?: string;
	temperature?: number;
	maxTokens?: number;
	reasoningEffort?: string | null;
}

export interface ResolvedModelTask {
	task: ModelTaskDefinition;
	/** Effective settings in the legacy per-service shape, for existing consumers. Null without a profile. */
	setting: LlmServiceSetting | null;
	/** Null when disabled or not configured. */
	profile: ProviderProfile | null;
	generation: ResolvedTaskGeneration;
	systemPromptOverride: string | null;
	/** Task-level operational settings (dialogue mode, batch budget, agent budget). */
	metadata: Record<string, unknown>;
	/** Explicitly configured fallbacks, in order; never another role implicitly. */
	fallbacks: Array<{ profileId: string; profile: ProviderProfile; generation: ResolvedTaskGeneration }>;
	provenance: ModelTaskProvenance;
	missingReason: string | null;
}

const MODEL_SETTINGS_LOCK = 'model-settings';

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function settingsRevision(input: { profiles: ModelProfile[]; roles: ModelRoleSetting[]; overrides: ModelTaskOverride[] }): string {
	const parts = [
		...input.profiles.map(row => `p:${row.id}:${row.revision}`),
		...input.roles.map(row => `r:${row.role}:${row.revision}:${row.profileId ?? ''}`),
		...input.overrides.map(row => `t:${row.taskId}:${row.revision}`),
	].sort();
	return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export async function loadModelSettings(db: Pick<Db, 'select'> = getDb()): Promise<ModelSettingsSnapshot> {
	const [profileRows, roleRows, overrideRows] = await Promise.all([
		db.select().from(modelProfiles),
		db.select().from(modelRoles),
		db.select().from(modelTaskOverrides),
	]);
	const profiles = profileRows.map(row => modelProfileSchema.parse(row));
	const roles = roleRows.filter(row => (modelRoleIds as readonly string[]).includes(row.role)).map(row => modelRoleSettingSchema.parse(row));
	const overrides = overrideRows.map(row => modelTaskOverrideSchema.parse(row));
	return {
		profiles: new Map(profiles.map(row => [row.id, row])),
		roles: new Map(roles.map(row => [row.role, row])),
		overrides: new Map(overrides.map(row => [row.taskId, row])),
		revision: settingsRevision({ profiles, roles, overrides }),
	};
}

function environmentProfile(role: ModelRoleId): ModelProfile | null {
	const definition = MODEL_ROLES[role];
	if (definition.requiresExplicitProfile) return null;
	const setting = environmentServiceSetting(definition.primaryTaskId);
	if (!setting?.model) return null;
	return modelProfileSchema.parse({
		id: `environment:${role}`,
		name: `${definition.label} (environment)`,
		providerType: setting.providerType,
		baseUrl: setting.baseUrl,
		apiKeyRef: setting.apiKeyRef,
		model: setting.model,
		contextWindowTokens: setting.contextWindowTokens ?? null,
		generation: {
			temperature: setting.temperature, maxTokens: setting.maxTokens, topP: setting.topP,
			frequencyPenalty: setting.frequencyPenalty, presencePenalty: setting.presencePenalty, reasoningEffort: setting.reasoningEffort,
		},
		metadata: { source: 'environment' },
	});
}

function mergeParameters(...layers: Array<ModelGenerationParameters | Record<string, unknown> | undefined>): ModelGenerationParameters {
	const merged: Record<string, unknown> = {};
	for (const layer of layers) {
		for (const [key, value] of Object.entries(layer ?? {})) {
			// A present key, including null, is an explicit choice for that layer.
			if (value !== undefined) merged[key] = value;
		}
	}
	return merged as ModelGenerationParameters;
}

function providerProfile(profile: ModelProfile, taskId: string, apiKey: string): ProviderProfile {
	return {
		id: profile.id.startsWith('environment:') ? `server-${taskId}` : profile.id,
		name: profile.name,
		providerType: profile.providerType as ProviderType,
		baseUrl: profile.baseUrl ?? undefined,
		apiKey,
		contextWindowTokens: profile.contextWindowTokens ?? undefined,
		customModels: [profile.model],
		fetchedModels: [],
		reasoningModels: [],
		hiddenModels: [],
		favoriteModels: [],
	};
}

function generationFor(profile: ModelProfile, parameters: ModelGenerationParameters): ResolvedTaskGeneration {
	return {
		model: profile.model,
		temperature: parameters.temperature ?? undefined,
		maxTokens: parameters.maxTokens ?? undefined,
		reasoningEffort: parameters.reasoningEffort ?? null,
	};
}

/** Why a profile cannot run a task, or null when it can. */
export function profileUnavailableReason(profile: ModelProfile, task: ModelTaskDefinition): string | null {
	const provider = PROVIDERS[profile.providerType as ProviderType];
	if (!provider) return `Model configuration needed: profile "${profile.name}" uses unsupported provider "${profile.providerType}".`;
	const role = MODEL_ROLES[task.role];
	// Inheriting an arbitrary text model must never imply Decisions compatibility.
	if (role.capability === 'decisions' && !supportsDecisionModel(profile.providerType, profile.model)) {
		return `Model configuration needed: ${role.label} needs a supported decision model; "${profile.model}" on ${profile.providerType} is not one.`;
	}
	if (provider.requiresApiKey && !resolveApiKeyRef(profile.apiKeyRef).trim()) {
		return `Model configuration needed: profile "${profile.name}" needs an API key. Set its key reference to an environment variable or local config key; raw keys are not stored in PostgreSQL.`;
	}
	return null;
}

function selectedProfile(task: ModelTaskDefinition, snapshot: ModelSettingsSnapshot): { profile: ModelProfile | null; source: ModelTaskProvenance['source']; reason: string | null } {
	const override = snapshot.overrides.get(task.id);
	if (override?.profileId) {
		const profile = snapshot.profiles.get(override.profileId);
		return profile ? { profile, source: 'task_override', reason: null }
			: { profile: null, source: 'none', reason: `Model configuration needed: ${task.label} overrides a profile that no longer exists.` };
	}
	const role = snapshot.roles.get(task.role);
	if (role?.profileId) {
		const profile = snapshot.profiles.get(role.profileId);
		if (profile) return { profile, source: 'role', reason: null };
		return { profile: null, source: 'none', reason: `Model configuration needed: ${MODEL_ROLES[task.role].label} references a profile that no longer exists.` };
	}
	const fromEnvironment = environmentProfile(task.role);
	if (fromEnvironment) return { profile: fromEnvironment, source: 'environment', reason: null };
	return { profile: null, source: 'none', reason: `Model configuration needed: ${MODEL_ROLES[task.role].label} has no model profile. Choose one in Settings → Models.` };
}

function legacySetting(task: ModelTaskDefinition, profile: ModelProfile, parameters: ModelGenerationParameters, enabled: boolean,
	override: ModelTaskOverride | undefined, provenance: ModelTaskProvenance): LlmServiceSetting {
	return llmServiceSettingSchema.parse({
		serviceId: task.id,
		providerType: profile.providerType,
		baseUrl: profile.baseUrl,
		model: profile.model,
		temperature: parameters.temperature ?? 1,
		maxTokens: parameters.maxTokens ?? 4096,
		topP: parameters.topP ?? null,
		frequencyPenalty: parameters.frequencyPenalty ?? null,
		presencePenalty: parameters.presencePenalty ?? null,
		reasoningEffort: parameters.reasoningEffort ?? null,
		contextBudget: parameters.contextBudget ?? null,
		contextWindowTokens: profile.contextWindowTokens ?? null,
		enabled,
		systemPromptOverride: override?.systemPromptOverride ?? null,
		apiKeyRef: profile.apiKeyRef,
		metadata: { ...(override?.metadata ?? {}), inherited: provenance.source !== 'task_override', provenance },
		updatedAt: override?.updatedAt ?? profile.updatedAt,
	});
}

/** Read-only resolution of one task against a settings snapshot. */
export function resolveModelTaskFromSnapshot(taskId: string, snapshot: ModelSettingsSnapshot): ResolvedModelTask {
	const task = modelTaskDefinition(taskId);
	if (!task) throw new Error(`Unknown model task "${taskId}".`);
	const override = snapshot.overrides.get(task.id);
	const enabled = task.status === 'active' && (override?.enabled ?? task.defaultEnabled);
	const selection = selectedProfile(task, snapshot);
	const profile = selection.profile;
	const parameters = profile ? mergeParameters(profile.generation, task.parameterDefaults, override?.parameters) : {};
	const unavailable = task.status === 'retired' ? `${task.label} is retired.`
		: selection.reason ?? (profile ? profileUnavailableReason(profile, task) : null);
	const fallbackIds = override?.fallbackProfileIds.length ? override.fallbackProfileIds : snapshot.roles.get(task.role)?.fallbackProfileIds ?? [];
	const status: ModelTaskProvenance['status'] = task.status === 'retired' ? 'retired' : !enabled ? 'disabled' : unavailable ? 'needs_configuration' : 'ready';
	const provenance: ModelTaskProvenance = {
		taskId: task.id,
		role: task.role,
		source: profile ? selection.source : 'none',
		profileId: profile && selection.source !== 'environment' ? profile.id : null,
		profileRevision: profile && selection.source !== 'environment' ? profile.revision : null,
		providerType: profile?.providerType ?? null,
		model: profile?.model ?? null,
		enabled,
		enabledSource: override?.enabled === null || override?.enabled === undefined ? 'task_default' : 'task_override',
		overriddenParameters: Object.keys(override?.parameters ?? {}).sort(),
		fallbackProfileIds: fallbackIds,
		limits: {
			maxTokens: parameters.maxTokens ?? null,
			contextWindowTokens: profile?.contextWindowTokens ?? null,
			maxRequests: override?.budget.maxRequests ?? task.budget.maxRequests,
		},
		settingsRevision: snapshot.revision,
		status,
		reason: status === 'disabled' ? `${task.label} is disabled.` : status === 'ready' ? null : unavailable,
	};
	const setting = profile ? legacySetting(task, profile, parameters, enabled, override, provenance) : null;
	const ready = status === 'ready' && profile;
	const fallbacks = ready ? fallbackIds.flatMap(profileId => {
		const fallback = snapshot.profiles.get(profileId);
		if (!fallback || profileUnavailableReason(fallback, task)) return [];
		const fallbackParameters = mergeParameters(fallback.generation, task.parameterDefaults, override?.parameters);
		return [{ profileId, profile: providerProfile(fallback, task.id, resolveApiKeyRef(fallback.apiKeyRef)), generation: generationFor(fallback, fallbackParameters) }];
	}) : [];
	return {
		task,
		setting,
		profile: ready ? providerProfile(profile, task.id, resolveApiKeyRef(profile.apiKeyRef)) : null,
		generation: ready ? generationFor(profile, parameters) : {},
		systemPromptOverride: override?.systemPromptOverride ?? null,
		metadata: { ...(override?.metadata ?? {}) },
		fallbacks,
		provenance,
		missingReason: provenance.reason,
	};
}

export async function resolveModelTask(taskId: string, snapshot?: ModelSettingsSnapshot): Promise<ResolvedModelTask> {
	return resolveModelTaskFromSnapshot(taskId, snapshot ?? await loadModelSettings());
}

/** Every active task's effective configuration, for settings views and receipts. */
export async function describeModelSettings(snapshot?: ModelSettingsSnapshot) {
	const current = snapshot ?? await loadModelSettings();
	return {
		revision: current.revision,
		profiles: [...current.profiles.values()].map(profile => ({ ...profile, apiKeyConfigured: Boolean(resolveApiKeyRef(profile.apiKeyRef).trim()) })),
		roles: modelRoleIds.map(role => ({ ...MODEL_ROLES[role], setting: current.roles.get(role) ?? null })),
		tasks: activeModelTasks().map(task => {
			const resolved = resolveModelTaskFromSnapshot(task.id, current);
			return { definition: task, override: current.overrides.get(task.id) ?? null, provenance: resolved.provenance };
		}),
	};
}

/** Effective image task settings in the row shape image callers check (read-only). */
export async function imageTaskSetting(db: Pick<Db, 'select'> = getDb()) {
	const setting = resolveModelTaskFromSnapshot('imageGeneration', await loadModelSettings(db)).setting;
	return setting ? { provider_type: setting.providerType, model: setting.model, api_key_ref: setting.apiKeyRef, enabled: setting.enabled } : undefined;
}

// ── Writes ──

function revisionConflict(): Error {
	return Object.assign(new Error('Model settings changed since they were loaded. Reload and apply the change again.'), { retryable: false });
}

function validateSave(input: ModelSettingsSave, profiles: Map<string, ModelProfile>): void {
	for (const role of input.roles) {
		for (const id of [role.profileId, ...role.fallbackProfileIds]) if (id && !profiles.has(id)) throw new Error(`Unknown profile "${id}" for ${MODEL_ROLES[role.role].label}.`);
		const profile = role.profileId ? profiles.get(role.profileId) : null;
		if (profile && MODEL_ROLES[role.role].capability === 'decisions' && !supportsDecisionModel(profile.providerType, profile.model)) {
			throw new Error(`Decisions needs a supported decision model; "${profile.model}" on ${profile.providerType} is not one.`);
		}
	}
	for (const task of input.tasks) {
		const definition = modelTaskDefinition(task.taskId);
		if (!definition) throw new Error(`Unknown model task "${task.taskId}".`);
		for (const id of [task.profileId, ...task.fallbackProfileIds]) if (id && !profiles.has(id)) throw new Error(`Unknown profile "${id}" for ${definition.label}.`);
		const profile = task.profileId ? profiles.get(task.profileId) : null;
		if (profile && MODEL_ROLES[definition.role].capability === 'decisions' && !supportsDecisionModel(profile.providerType, profile.model)) {
			throw new Error(`Decisions needs a supported decision model; "${profile.model}" on ${profile.providerType} is not one.`);
		}
	}
	for (const id of input.clearTaskIds) if (!modelTaskDefinition(id)) throw new Error(`Unknown model task "${id}".`);
}

function overrideIsEmpty(task: Omit<ModelTaskOverride, 'revision' | 'updatedAt'>): boolean {
	return !task.profileId && task.enabled === null && Object.keys(task.parameters).length === 0 && !task.systemPromptOverride
		&& task.fallbackProfileIds.length === 0 && Object.keys(task.budget).length === 0 && Object.keys(task.metadata).length === 0;
}

async function writeModelSettings(tx: Tx, input: ModelSettingsSave): Promise<void> {
	const now = new Date().toISOString();
	for (const profile of input.profiles) {
		const values = { ...profile, capabilities: profile.capabilities as Record<string, unknown>, generation: profile.generation as Record<string, unknown>, updatedAt: now };
		await tx.insert(modelProfiles).values(values).onConflictDoUpdate({
			target: modelProfiles.id,
			set: { ...values, revision: sql`${modelProfiles.revision} + 1` },
		});
	}
	for (const role of input.roles) {
		await tx.insert(modelRoles).values({ ...role, updatedAt: now }).onConflictDoUpdate({
			target: modelRoles.role,
			set: { profileId: role.profileId, fallbackProfileIds: role.fallbackProfileIds, metadata: role.metadata, updatedAt: now, revision: sql`${modelRoles.revision} + 1` },
		});
	}
	for (const task of input.tasks) {
		if (overrideIsEmpty(task)) {
			await tx.delete(modelTaskOverrides).where(eq(modelTaskOverrides.taskId, task.taskId));
			continue;
		}
		const values = { ...task, parameters: task.parameters as Record<string, unknown>, budget: task.budget as Record<string, unknown>, updatedAt: now };
		await tx.insert(modelTaskOverrides).values(values).onConflictDoUpdate({
			target: modelTaskOverrides.taskId,
			set: { ...values, revision: sql`${modelTaskOverrides.revision} + 1` },
		});
	}
	if (input.clearTaskIds.length) await tx.delete(modelTaskOverrides).where(inArray(modelTaskOverrides.taskId, input.clearTaskIds));
	if (input.deleteProfileIds.length) {
		const [roles, overrides] = await Promise.all([
			tx.select({ role: modelRoles.role, profileId: modelRoles.profileId, fallbacks: modelRoles.fallbackProfileIds }).from(modelRoles),
			tx.select({ taskId: modelTaskOverrides.taskId, profileId: modelTaskOverrides.profileId, fallbacks: modelTaskOverrides.fallbackProfileIds }).from(modelTaskOverrides),
		]);
		for (const id of input.deleteProfileIds) {
			const users = [...roles.filter(row => row.profileId === id || row.fallbacks.includes(id)).map(row => MODEL_ROLES[row.role as ModelRoleId]?.label ?? row.role),
				...overrides.filter(row => row.profileId === id || row.fallbacks.includes(id)).map(row => modelTaskDefinition(row.taskId)?.label ?? row.taskId)];
			if (users.length) throw new Error(`Profile "${id}" is still used by ${users.join(', ')}. Choose another profile for them first.`);
		}
		await tx.delete(modelProfiles).where(inArray(modelProfiles.id, input.deleteProfileIds));
	}
}

/** Revision-checked save of profiles, role assignments and task overrides in one transaction. */
export async function saveModelSettings(raw: unknown) {
	const input = modelSettingsSaveSchema.parse(raw);
	saveLocalApiKeyRefs(input.secrets);
	await getDb().transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${MODEL_SETTINGS_LOCK}, 0))`);
		const current = await loadModelSettings(tx);
		if (input.expectedRevision && input.expectedRevision !== current.revision) throw revisionConflict();
		const profiles = new Map(current.profiles);
		for (const profile of input.profiles) profiles.set(profile.id, modelProfileSchema.parse(profile));
		for (const id of input.deleteProfileIds) profiles.delete(id);
		validateSave(input, profiles);
		await writeModelSettings(tx, input);
	});
	return describeModelSettings();
}

// ── Compatibility with the per-service settings commands ──

function connectionKey(value: { providerType: string; baseUrl: string | null; apiKeyRef: string | null; model: string; contextWindowTokens: number | null }): string {
	return JSON.stringify([value.providerType, value.baseUrl ?? '', value.apiKeyRef ?? '', value.model, value.contextWindowTokens ?? null]);
}

function profileIdForConnection(key: string): string {
	return `profile_${createHash('md5').update(key).digest('hex').slice(0, 16)}`;
}

const GENERATION_KEYS = ['temperature', 'maxTokens', 'topP', 'frequencyPenalty', 'presencePenalty', 'reasoningEffort', 'contextBudget'] as const;

/**
 * Map a legacy per-service patch onto profiles and overrides. Values equal to what the task
 * inherits are stored as inheritance, never as an explicit copy; `metadata.inherit: true`
 * clears a task override completely.
 */
export function planLegacyServicePatches(patches: LlmServiceSettingPatch[], snapshot: ModelSettingsSnapshot): ModelSettingsSave {
	const save: ModelSettingsSave = { profiles: [], deleteProfileIds: [], roles: [], tasks: [], clearTaskIds: [], secrets: [] };
	const profiles = new Map(snapshot.profiles);
	const roles = new Map(snapshot.roles);
	const overrides = new Map(snapshot.overrides);
	const upsertProfile = (profile: ModelProfile) => {
		profiles.set(profile.id, profile);
		save.profiles = [...save.profiles.filter(row => row.id !== profile.id), profile];
	};
	for (const patch of patches) {
		const task = modelTaskDefinition(patch.serviceId);
		if (!task || task.status !== 'active') throw new Error(`Unknown or retired model task "${patch.serviceId}".`);
		const metadata = asRecord(patch.metadata);
		if (metadata.inherit === true) {
			overrides.delete(task.id);
			save.clearTaskIds.push(task.id);
			save.tasks = save.tasks.filter(row => row.taskId !== task.id);
			continue;
		}
		const view: ModelSettingsSnapshot = { profiles, roles, overrides, revision: snapshot.revision };
		const current = resolveModelTaskFromSnapshot(task.id, view);
		const effective = current.setting;
		const existing = overrides.get(task.id);
		const roleSetting = roles.get(task.role);
		const roleProfile = roleSetting?.profileId ? profiles.get(roleSetting.profileId) ?? null : null;
		const connectionPatched = ['providerType', 'baseUrl', 'apiKeyRef', 'model', 'contextWindowTokens'].some(key => (patch as Record<string, unknown>)[key] !== undefined);
		let taskProfileId = existing?.profileId ?? null;
		if (connectionPatched) {
			const providerType = patch.providerType ?? effective?.providerType;
			const model = patch.model ?? effective?.model;
			if (!providerType || !model) throw new Error(`${task.label} needs a provider and model.`);
			const providerChanged = Boolean(patch.providerType && patch.providerType !== effective?.providerType);
			const connection = {
				providerType,
				baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : providerChanged ? (PROVIDERS[providerType as ProviderType]?.baseUrl || null) : effective?.baseUrl ?? null,
				apiKeyRef: patch.apiKeyRef !== undefined ? patch.apiKeyRef : providerChanged ? null : effective?.apiKeyRef ?? null,
				model,
				contextWindowTokens: patch.contextWindowTokens !== undefined ? patch.contextWindowTokens ?? null : providerChanged ? null : effective?.contextWindowTokens ?? null,
			};
			if (roleProfile && connectionKey(roleProfile) === connectionKey(connection)) {
				taskProfileId = null;
			} else {
				// Never edit a profile in place from a per-task patch: roles may share it.
				// Select (or create) the profile for this connection and sampling defaults.
				const generation = Object.fromEntries(GENERATION_KEYS.filter(name => name !== 'contextBudget').map(name =>
					[name, roleProfile?.generation[name] ?? (effective as Record<string, unknown> | null)?.[name] ?? undefined]));
				const identity = JSON.stringify([connectionKey(connection), generation.topP ?? null, generation.frequencyPenalty ?? null, generation.presencePenalty ?? null, generation.reasoningEffort ?? null]);
				const reuse = [...profiles.values()].find(profile => JSON.stringify([connectionKey(profile), profile.generation.topP ?? null, profile.generation.frequencyPenalty ?? null,
					profile.generation.presencePenalty ?? null, profile.generation.reasoningEffort ?? null]) === identity);
				const profile = reuse ?? modelProfileSchema.parse({ id: profileIdForConnection(identity), name: `${connection.model} · ${connection.providerType}`, ...connection,
					generation, metadata: { source: 'legacy_service_patch', firstTaskId: task.id } });
				if (!reuse) upsertProfile(profile);
				if (isRolePrimaryTask(task.id)) {
					const role = modelRoleSettingSchema.parse({ ...(roleSetting ?? { role: task.role }), profileId: profile.id });
					roles.set(task.role, role);
					save.roles = [...save.roles.filter(row => row.role !== task.role), role];
					taskProfileId = null;
				} else {
					taskProfileId = profile.id;
				}
			}
		}
		const baseProfile = taskProfileId ? profiles.get(taskProfileId) ?? null : (roles.get(task.role)?.profileId ? profiles.get(roles.get(task.role)!.profileId!) ?? null : null);
		const inherited = mergeParameters(baseProfile?.generation, task.parameterDefaults);
		const parameters: Record<string, unknown> = { ...(existing?.parameters ?? {}) };
		for (const name of GENERATION_KEYS) {
			const value = (patch as Record<string, unknown>)[name];
			if (value === undefined) continue;
			if (value === (inherited as Record<string, unknown>)[name] || (value === null && (inherited as Record<string, unknown>)[name] === undefined)) delete parameters[name];
			else parameters[name] = value;
		}
		const enabled = patch.enabled === undefined ? existing?.enabled ?? null : patch.enabled === task.defaultEnabled ? null : patch.enabled;
		const taskMetadata: Record<string, unknown> = { ...(existing?.metadata ?? {}) };
		for (const name of ['dialogueMode', 'batchBudget', 'agentBudget', 'decisionMode'] as const) if (metadata[name] !== undefined) taskMetadata[name] = metadata[name];
		const next = modelTaskOverrideSchema.parse({
			...(existing ?? { taskId: task.id }),
			profileId: taskProfileId,
			enabled,
			parameters,
			systemPromptOverride: patch.systemPromptOverride !== undefined ? (patch.systemPromptOverride?.trim() || null) : existing?.systemPromptOverride ?? null,
			metadata: taskMetadata,
		});
		const { revision: _revision, updatedAt: _updatedAt, ...row } = next;
		overrides.set(task.id, next);
		save.tasks = [...save.tasks.filter(item => item.taskId !== task.id), row];
		save.clearTaskIds = save.clearTaskIds.filter(id => id !== task.id);
	}
	return save;
}

export async function saveLegacyServicePatches(patches: LlmServiceSettingPatch[], secrets: Array<{ ref: string; value: string }> = []) {
	saveLocalApiKeyRefs(secrets);
	await getDb().transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${MODEL_SETTINGS_LOCK}, 0))`);
		const snapshot = await loadModelSettings(tx);
		const plan = planLegacyServicePatches(patches, snapshot);
		const profiles = new Map(snapshot.profiles);
		for (const profile of plan.profiles) profiles.set(profile.id, modelProfileSchema.parse(profile));
		validateSave(plan, profiles);
		await writeModelSettings(tx, plan);
	});
	return listEffectiveServiceSettings();
}

/** Effective per-task settings in the legacy row shape. Inherited values are marked, not persisted. */
export async function listEffectiveServiceSettings(snapshot?: ModelSettingsSnapshot): Promise<LlmServiceSetting[]> {
	const current = snapshot ?? await loadModelSettings();
	return activeModelTasks().flatMap(task => {
		const setting = resolveModelTaskFromSnapshot(task.id, current).setting;
		return setting ? [setting] : [];
	});
}

export { saveLocalApiKeyRefs };
