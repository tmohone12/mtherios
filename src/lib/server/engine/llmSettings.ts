import {
	llmServiceSettingSchema,
	type LlmServiceSetting,
	type LlmServiceSettingPatch,
} from '$lib/contracts/engine';
import type { TurnRequest } from '$lib/contracts/memory';
import type { ModelTaskProvenance } from '$lib/contracts/modelTasks';
import { listEffectiveServiceSettings, resolveModelTask, saveLegacyServicePatches, type ResolvedTaskGeneration } from './modelSettings';

/**
 * Compatibility facade for per-service callers. Configuration lives in model profiles,
 * roles and task overrides (modelSettings.ts); the legacy llm_service_settings table is
 * retained only as a rollback source and is no longer read or written.
 */

export { resolveApiKeyRef, saveLocalApiKeyRefs, serviceDefaultKey } from './llmEnvironment';

type ProviderProfile = NonNullable<TurnRequest['providerProfile']>;

export class TerminalLlmNotConfiguredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TerminalLlmNotConfiguredError';
	}
}

export function mergeLlmServiceSettingPatch(
	base: LlmServiceSetting,
	patch: LlmServiceSettingPatch,
): LlmServiceSetting {
	const next: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) next[key] = value;
	}
	return llmServiceSettingSchema.parse(next);
}

export async function listLlmServiceSettings(): Promise<LlmServiceSetting[]> {
	return listEffectiveServiceSettings();
}

export async function upsertLlmServiceSettings(settings: LlmServiceSettingPatch[]) {
	return saveLegacyServicePatches(settings);
}

/**
 * Read-only resolution of a task (service) ID. The second argument is accepted for
 * source compatibility; resolution never creates or enables a setting.
 */
export async function resolveServiceGeneration(serviceId: string, _createIfMissing = true): Promise<{
	setting: LlmServiceSetting | null;
	profile: ProviderProfile | null;
	generation: ResolvedTaskGeneration;
	systemPromptOverride: string | null;
	missingReason: string | null;
	provenance?: ModelTaskProvenance;
	fallbacks?: Awaited<ReturnType<typeof resolveModelTask>>['fallbacks'];
}> {
	const resolved = await resolveModelTask(serviceId);
	return {
		setting: resolved.setting,
		profile: resolved.profile,
		generation: resolved.generation,
		systemPromptOverride: resolved.systemPromptOverride,
		missingReason: resolved.missingReason,
		provenance: resolved.provenance,
		fallbacks: resolved.fallbacks,
	};
}

export function requireResolvedServiceProfile(
	serviceId: string,
	resolved: Awaited<ReturnType<typeof resolveServiceGeneration>>,
): ProviderProfile {
	if (resolved.profile) return resolved.profile;
	throw new TerminalLlmNotConfiguredError(
		resolved.missingReason ?? `Terminal LLM service "${serviceId}" is not configured.`,
	);
}
