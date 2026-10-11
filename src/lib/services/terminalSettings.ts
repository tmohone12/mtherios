import { SERVICE_DEFINITIONS, settings } from '$lib/stores/settings.svelte';
import { PROVIDERS } from '$lib/services/ai/sdk/providers/config';
import type { APIProfile, ProviderType, ReasoningEffort } from '$lib/types';
import { llmServiceSettingSchema } from '$lib/contracts/engine';
import type { EngineCommandResponse, LlmServiceSettingPatch } from '$lib/contracts/engine';

const DEFAULT_KEY_REFS: Partial<Record<ProviderType, string>> = {
	openrouter: 'env:OPENROUTER_API_KEY',
	nanogpt: 'env:NANOGPT_API_KEY',
	chutes: 'env:CHUTES_API_KEY',
	openai: 'env:OPENAI_API_KEY',
	anthropic: 'env:ANTHROPIC_API_KEY',
	'google-ai-studio': 'env:GEMINI_API_KEY',
	google: 'env:GOOGLE_GENERATIVE_AI_API_KEY',
	xai: 'env:XAI_API_KEY',
	groq: 'env:GROQ_API_KEY',
	'z-ai': 'env:Z_AI_API_KEY',
	zhipu: 'env:ZHIPU_API_KEY',
	deepseek: 'env:DEEPSEEK_API_KEY',
	mistral: 'env:MISTRAL_API_KEY',
	kimi: 'env:KIMI_API_KEY',
	'anthropic-proxy': 'env:BRIDGE_TOKEN',
};

function serviceDefaultKey(serviceId: string): 'narrative' | 'classification' {
	return serviceId === 'classifier' || serviceId === 'characterUpdate' || serviceId === 'worldSimulation' || serviceId === 'smallBrain' || serviceId === 'activeRecall' || serviceId === 'actorDecision' || serviceId === 'continuityReview'
		? 'classification'
		: 'narrative';
}

export function defaultTerminalApiKeyRef(providerType: ProviderType): string {
	const provider = PROVIDERS[providerType];
	if (provider && !provider.requiresApiKey) return '';
	return DEFAULT_KEY_REFS[providerType] ?? `env:${String(providerType).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

export function terminalApiKeyRefForProfile(profile: APIProfile | null): string | null {
	if (!profile) return null;
	const explicit = profile.terminalApiKeyRef?.trim();
	if (explicit) return explicit;
	const fallback = defaultTerminalApiKeyRef(profile.providerType as ProviderType);
	return fallback || null;
}

type TerminalSecretRef = { ref: string; value: string };

export async function patchTerminalLlmSettings(payload: LlmServiceSettingPatch[], secrets: TerminalSecretRef[] = []): Promise<void> {
	if (payload.length === 0) return;
	const response = await fetch('/api/engine/command', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			storyId: '__app__',
			command: 'settings.llm.save',
			args: { settings: payload, secrets },
		}),
	});
	const body = await response.json().catch(() => ({})) as Partial<EngineCommandResponse> & { error?: string };
	if (!response.ok) {
		throw new Error(body.error ?? `Terminal LLM settings failed: HTTP ${response.status}`);
	}
	if (body.status !== 'succeeded') {
		throw new Error(body.error ?? 'Terminal LLM settings failed');
	}
}

/** A task without its own saved model or profile inherits its role on the server. */
export function browserServiceIsExplicit(serviceId: string): boolean {
	const raw = settings.serviceConfigs[serviceId];
	return serviceId === 'narrative' || Boolean(raw?.model || raw?.profileId);
}

function terminalSettingForService(serviceId: string): LlmServiceSettingPatch | null {
	const config = settings.getServiceConfig(serviceId);
	const profile = settings.getServiceProfile(serviceId) ?? settings.activeProfile;
	if (!profile) return null;

	const providerType = profile.providerType as ProviderType;
	const provider = PROVIDERS[providerType];
	if (!provider) return null;
	const serviceDefaults = provider.services?.[serviceDefaultKey(serviceId)] ?? provider.services?.narrative;
	const model = config.model || serviceDefaults?.model || provider.fallbackModels[0] || null;
	// Never send a resolved inherited model as though the user chose it for this task.
	const connection = browserServiceIsExplicit(serviceId) ? {
		providerType,
		baseUrl: profile.baseUrl ?? provider.baseUrl ?? null,
		model,
		apiKeyRef: terminalApiKeyRefForProfile(profile),
	} : {};

	return {
		serviceId,
		...connection,
		temperature: config.temperature,
		maxTokens: config.maxTokens,
		enabled: config.enabled,
		systemPromptOverride: config.systemPromptOverride?.trim() || null,
		metadata: {
			source: 'frontend_settings',
			profileId: profile.id,
			profileName: profile.name,
			profileProviderType: profile.providerType,
			browserProfileHasLocalKey: Boolean(profile.apiKey),
			...(serviceId === 'dialogue' ? { dialogueMode: config.dialogueMode === 'important' ? 'important' : 'all' } : {}),
			...(serviceId === 'batchAuthoring' && config.batchMaxCostUsd != null && config.batchInputUsdPerMillion != null && config.batchOutputUsdPerMillion != null
				? { batchBudget: { maxCostUsd: config.batchMaxCostUsd, inputUsdPerMillion: config.batchInputUsdPerMillion,
					outputUsdPerMillion: config.batchOutputUsdPerMillion } } : {}),
			syncedAt: new Date().toISOString(),
		},
	};
}

function terminalSecretForService(serviceId: string): TerminalSecretRef | null {
	const profile = settings.getServiceProfile(serviceId) ?? settings.activeProfile;
	const ref = terminalApiKeyRefForProfile(profile);
	const value = profile?.apiKey?.trim();
	if (!ref || !value) return null;
	return { ref, value };
}

function uniqueSecrets(items: Array<TerminalSecretRef | null>): TerminalSecretRef[] {
	const byRef = new Map<string, TerminalSecretRef>();
	for (const item of items) {
		if (item?.ref && item.value) byRef.set(item.ref, item);
	}
	return [...byRef.values()];
}

export async function syncTerminalLlmSettingsFromBrowser(serviceIds = Object.keys(SERVICE_DEFINITIONS), saveSecrets = false): Promise<void> {
	const activeIds = serviceIds.filter(serviceId => Object.hasOwn(SERVICE_DEFINITIONS, serviceId));
	const payload = activeIds
		.map(terminalSettingForService)
		.filter((item): item is LlmServiceSettingPatch => Boolean(item));
	const secrets = saveSecrets ? uniqueSecrets(activeIds.map(terminalSecretForService)) : [];
	await patchTerminalLlmSettings(payload, secrets);
}

/** Server settings are authoritative. Secret values are never fetched into the browser. */
export async function refreshTerminalLlmSettings(): Promise<void> {
	const response = await fetch('/api/engine/command', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ storyId: '__app__', command: 'settings.llm.list', args: {} }),
	});
	const body = await response.json();
	if (!response.ok || body.status !== 'succeeded') throw new Error(body.error || 'Could not load terminal settings.');
	const rows = llmServiceSettingSchema.array().parse(body.result?.settings);
	const profiles = new Map<string, APIProfile>();
	for (const row of rows) {
		if (!PROVIDERS[row.providerType as ProviderType]) continue;
		const id = `terminal:${row.providerType}:${row.baseUrl ?? ''}:${row.apiKeyRef ?? ''}`;
		const previous = settings.profiles.find(profile => profile.id === id);
		profiles.set(id, { ...previous, id, name: `Server ${PROVIDERS[row.providerType as ProviderType].name ?? row.providerType}`, providerType: row.providerType as ProviderType,
			apiKey: '', terminalApiKeyRef: row.apiKeyRef, baseUrl: row.baseUrl ?? undefined,
			customModels: previous?.customModels ?? [], fetchedModels: previous?.fetchedModels ?? [], reasoningModels: previous?.reasoningModels ?? [], hiddenModels: previous?.hiddenModels ?? [], favoriteModels: previous?.favoriteModels ?? [], createdAt: previous?.createdAt ?? Date.now() });
		const batchBudget = row.serviceId === 'batchAuthoring' && row.metadata?.batchBudget && typeof row.metadata.batchBudget === 'object'
			? row.metadata.batchBudget as Record<string, unknown> : null;
		// Inherited rows stay inherited in the browser; only explicit task overrides become browser overrides.
		const inherited = row.metadata?.inherited === true && row.serviceId !== 'narrative';
		settings.serviceConfigs[row.serviceId] = { model: inherited ? '' : row.model ?? '', effectiveModel: row.model ?? '', inherited,
			temperature: row.temperature, maxTokens: row.maxTokens, enabled: row.enabled, systemPromptOverride: row.systemPromptOverride ?? '', profileId: inherited ? '' : id,
			...(row.serviceId === 'dialogue' ? { dialogueMode: row.metadata?.dialogueMode === 'important' ? 'important' as const : 'all' as const } : {}),
			...(batchBudget ? { batchMaxCostUsd: typeof batchBudget.maxCostUsd === 'number' ? batchBudget.maxCostUsd : null,
				batchInputUsdPerMillion: typeof batchBudget.inputUsdPerMillion === 'number' ? batchBudget.inputUsdPerMillion : null,
				batchOutputUsdPerMillion: typeof batchBudget.outputUsdPerMillion === 'number' ? batchBudget.outputUsdPerMillion : null } : {}) };
		if (row.serviceId === 'narrative') {
			settings.activeProfileId = id;
			Object.assign(settings.narrativeSettings, { model: row.model ?? '', temperature: row.temperature, maxTokens: row.maxTokens, reasoningEffort: (row.reasoningEffort ?? 'off') as ReasoningEffort });
			settings.contextBudget = row.contextBudget ?? 0;
		}
	}
	settings.profiles = [...profiles.values(), ...settings.profiles.filter(profile => !profile.id.startsWith('terminal:'))];
}
