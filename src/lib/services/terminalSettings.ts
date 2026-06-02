import { SERVICE_DEFINITIONS, settings } from '$lib/stores/settings.svelte';
import { PROVIDERS } from '$lib/services/ai/sdk/providers/config';
import type { APIProfile, ProviderType } from '$lib/types';
import type { LlmServiceSetting } from '$lib/contracts/engine';

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
	zhipu: 'env:ZHIPU_API_KEY',
	deepseek: 'env:DEEPSEEK_API_KEY',
	mistral: 'env:MISTRAL_API_KEY',
	kimi: 'env:KIMI_API_KEY',
	'anthropic-proxy': 'env:BRIDGE_TOKEN',
};

function serviceDefaultKey(serviceId: string): 'narrative' | 'classification' {
	return serviceId === 'classifier' || serviceId === 'worldSimulation'
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

async function patchTerminalLlmSettings(payload: LlmServiceSetting[], secrets: TerminalSecretRef[] = []): Promise<void> {
	if (payload.length === 0) return;
	const response = await fetch('/api/settings/llm', {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ settings: payload, secrets }),
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({})) as { error?: string };
		throw new Error(body.error ?? `Terminal LLM settings failed: HTTP ${response.status}`);
	}
}

function terminalSettingForService(serviceId: string): LlmServiceSetting | null {
	const config = settings.getServiceConfig(serviceId);
	const profile = settings.getServiceProfile(serviceId) ?? settings.activeProfile;
	if (!profile) return null;

	const providerType = profile.providerType as ProviderType;
	const provider = PROVIDERS[providerType];
	if (!provider) return null;
	const serviceDefaults = provider.services?.[serviceDefaultKey(serviceId)] ?? provider.services?.narrative;
	const model = config.model || serviceDefaults?.model || provider.fallbackModels[0] || null;

	return {
		serviceId,
		providerType,
		baseUrl: profile.baseUrl ?? provider.baseUrl ?? null,
		model,
		temperature: config.temperature,
		maxTokens: config.maxTokens,
		topP: null,
		frequencyPenalty: null,
		presencePenalty: null,
		reasoningEffort: null,
		contextBudget: settings.contextBudget > 0 ? settings.contextBudget : null,
		enabled: config.enabled,
		systemPromptOverride: config.systemPromptOverride?.trim() || null,
		apiKeyRef: terminalApiKeyRefForProfile(profile),
		metadata: {
			source: 'frontend_settings',
			profileId: profile.id,
			profileName: profile.name,
			profileProviderType: profile.providerType,
			browserProfileHasLocalKey: Boolean(profile.apiKey),
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

export async function syncTerminalLlmSettingsFromBrowser(serviceIds = Object.keys(SERVICE_DEFINITIONS)): Promise<void> {
	const payload = serviceIds
		.map(terminalSettingForService)
		.filter((item): item is LlmServiceSetting => Boolean(item));
	const secrets = uniqueSecrets(serviceIds.map(terminalSecretForService));
	await patchTerminalLlmSettings(payload, secrets);
}
