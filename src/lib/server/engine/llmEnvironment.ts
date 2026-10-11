import fs from 'node:fs';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { resolveRuntimeOptions } from '../../../../scripts/runtime-config.mjs';
import { llmServiceSettingSchema, type LlmServiceSetting } from '$lib/contracts/engine';
import { PROVIDERS, type ProviderServices } from '$lib/services/ai/sdk/providers/config';
import type { ProviderType } from '$lib/types';

/** Local config file, environment and provider defaults. Never reads or writes PostgreSQL. */

function configPath(): string {
	return resolveRuntimeOptions([], { env }).configPath;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readConfig(): Record<string, unknown> {
	try {
		const raw = fs.readFileSync(configPath(), 'utf8');
		return asRecord(JSON.parse(raw));
	} catch {
		// Missing or malformed local config should not make settings unreadable.
	}
	return {};
}

function readConfigApiKey(ref: string): string {
	const parsed = readConfig();
	const maps = [
		parsed.llmApiKeys,
		parsed.apiKeys,
		parsed.secrets,
	].map(asRecord).filter((item) => Object.keys(item).length > 0);
	for (const map of maps) {
		const value = map[ref];
		if (typeof value === 'string') return value;
	}
	return '';
}

function cleanApiKeyRef(ref: string): string {
	return ref.trim().startsWith('env:') ? ref.trim().slice(4) : ref.trim();
}

export function saveLocalApiKeyRefs(secrets: Array<{ ref: string; value: string }>): void {
	const valid = secrets
		.map((secret) => ({
			ref: cleanApiKeyRef(secret.ref),
			value: secret.value.trim(),
		}))
		.filter((secret) => secret.ref && secret.value);
	if (valid.length === 0) return;

	const target = configPath();
	const current = readConfig();
	const llmApiKeys = { ...asRecord(current.llmApiKeys) };
	for (const secret of valid) {
		llmApiKeys[secret.ref] = secret.value;
	}
	const next = {
		...current,
		llmApiKeys,
	};
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export function resolveApiKeyRef(apiKeyRef?: string | null): string {
	const ref = apiKeyRef?.trim();
	if (!ref) return '';
	const clean = cleanApiKeyRef(ref);
	return env[clean] || process.env[clean] || readConfigApiKey(clean);
}

function envFirst(...keys: string[]): string | null {
	for (const key of keys) {
		const value = env[key]?.trim() || process.env[key]?.trim();
		if (value) return value;
	}
	return null;
}

function serviceEnvPrefix(serviceId: string): string {
	return serviceId.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function configString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

function configNumber(...values: unknown[]): number | null {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		if (typeof value === 'string' && value.trim()) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return null;
}

export function providerTypeOrNull(value: string | null | undefined): ProviderType | null {
	const key = value?.trim() as ProviderType | undefined;
	return key && PROVIDERS[key] ? key : null;
}

const KEY_REF_CANDIDATES: Array<{ providerType: ProviderType; refs: string[] }> = [
	{ providerType: 'openrouter', refs: ['OPENROUTER_API_KEY'] },
	{ providerType: 'nanogpt', refs: ['NANOGPT_API_KEY', 'NANO_GPT_API_KEY'] },
	{ providerType: 'chutes', refs: ['CHUTES_API_KEY'] },
	{ providerType: 'openai', refs: ['OPENAI_API_KEY'] },
	{ providerType: 'anthropic', refs: ['ANTHROPIC_API_KEY'] },
	{ providerType: 'google-ai-studio', refs: ['GOOGLE_AI_STUDIO_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
	{ providerType: 'xai', refs: ['XAI_API_KEY'] },
	{ providerType: 'groq', refs: ['GROQ_API_KEY'] },
	{ providerType: 'zhipu', refs: ['ZHIPU_API_KEY', 'ZAI_API_KEY'] },
	{ providerType: 'deepseek', refs: ['DEEPSEEK_API_KEY'] },
	{ providerType: 'mistral', refs: ['MISTRAL_API_KEY'] },
	{ providerType: 'kimi', refs: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'] },
	{ providerType: 'anthropic-proxy', refs: ['ANTHROPIC_PROXY_API_KEY', 'BRIDGE_TOKEN'] },
];

function inferProviderFromEnvKey(): { providerType: ProviderType; apiKeyRef: string } | null {
	for (const candidate of KEY_REF_CANDIDATES) {
		for (const ref of candidate.refs) {
			if (envFirst(ref)) return { providerType: candidate.providerType, apiKeyRef: `env:${ref}` };
		}
	}
	return null;
}

export function defaultApiKeyRef(providerType: ProviderType, explicit?: string | null): string | null {
	if (explicit) return explicit;
	const candidate = KEY_REF_CANDIDATES.find((item) => item.providerType === providerType);
	const ref = candidate?.refs.find((key) => envFirst(key));
	return ref ? `env:${ref}` : null;
}

export function serviceDefaultKey(serviceId: string): keyof ProviderServices {
	if (serviceId === 'classifier' || serviceId === 'characterUpdate' || serviceId === 'worldSimulation' || serviceId === 'smallBrain' || serviceId === 'activeRecall' || serviceId === 'actorDecision' || serviceId === 'continuityReview') return 'classification';
	return 'narrative';
}

export function providerServiceDefaults(providerType: ProviderType, serviceId: string) {
	const provider = PROVIDERS[providerType];
	return provider.services?.[serviceDefaultKey(serviceId)] ?? provider.services?.narrative;
}

function fallbackTemperature(serviceId: string): number {
	return serviceId === 'classifier' || serviceId === 'characterUpdate' || serviceId === 'smallBrain' || serviceId === 'activeRecall' || serviceId === 'actorDecision' || serviceId === 'continuityReview' ? 0.2 : 1;
}

function serviceConfigFromFile(serviceId: string): {
	global: Record<string, unknown>;
	service: Record<string, unknown>;
} {
	const root = readConfig();
	const llm = asRecord(root.llm ?? root.llmSettings ?? root.llmServices);
	const services = asRecord(llm.services);
	return {
		global: llm,
		service: asRecord(services[serviceId] ?? llm[serviceId]),
	};
}

/** The connection configured for a service by the local config file or environment,
 * or null. Computed on every call and never persisted. */
export function environmentServiceSetting(serviceId: string): LlmServiceSetting | null {
	const prefix = serviceEnvPrefix(serviceId);
	const { global, service } = serviceConfigFromFile(serviceId);
	const inferred = inferProviderFromEnvKey();
	const providerType = providerTypeOrNull(configString(
		service.providerType,
		service.provider,
		envFirst(`MTHERIOS_${prefix}_LLM_PROVIDER`, `MTHERIOS_${prefix}_PROVIDER`),
		global.providerType,
		global.provider,
		envFirst('MTHERIOS_LLM_PROVIDER', 'MTHERIOS_PROVIDER'),
		inferred?.providerType,
	));
	if (!providerType) return null;

	const provider = PROVIDERS[providerType];
	const defaults = providerServiceDefaults(providerType, serviceId);
	const explicitApiKeyRef = configString(
		service.apiKeyRef,
		envFirst(`MTHERIOS_${prefix}_LLM_API_KEY_REF`, `MTHERIOS_${prefix}_API_KEY_REF`),
		global.apiKeyRef,
		envFirst('MTHERIOS_LLM_API_KEY_REF', 'MTHERIOS_API_KEY_REF'),
		inferred?.providerType === providerType ? inferred.apiKeyRef : null,
	);
	const model = configString(
		service.model,
		envFirst(`MTHERIOS_${prefix}_LLM_MODEL`, `MTHERIOS_${prefix}_MODEL`),
		global.model,
		envFirst('MTHERIOS_LLM_MODEL'),
		defaults?.model,
		provider.fallbackModels[0],
	);
	const temperature = configNumber(
		service.temperature,
		envFirst(`MTHERIOS_${prefix}_LLM_TEMPERATURE`, `MTHERIOS_${prefix}_TEMPERATURE`),
		global.temperature,
		envFirst('MTHERIOS_LLM_TEMPERATURE'),
		defaults?.temperature,
		fallbackTemperature(serviceId),
	);
	const maxTokens = configNumber(
		service.maxTokens,
		service.max_tokens,
		envFirst(`MTHERIOS_${prefix}_LLM_MAX_TOKENS`, `MTHERIOS_${prefix}_MAX_TOKENS`),
		global.maxTokens,
		global.max_tokens,
		envFirst('MTHERIOS_LLM_MAX_TOKENS'),
		defaults?.maxTokens,
		4096,
	);

	return llmServiceSettingSchema.parse({
		serviceId,
		providerType,
		baseUrl: configString(
			service.baseUrl,
			service.base_url,
			envFirst(`MTHERIOS_${prefix}_LLM_BASE_URL`, `MTHERIOS_${prefix}_BASE_URL`),
			global.baseUrl,
			global.base_url,
			envFirst('MTHERIOS_LLM_BASE_URL'),
			provider.baseUrl || null,
		),
		model,
		temperature: temperature ?? fallbackTemperature(serviceId),
		maxTokens: Math.trunc(maxTokens ?? 4096),
		topP: configNumber(service.topP, service.top_p, global.topP, global.top_p),
		frequencyPenalty: configNumber(service.frequencyPenalty, service.frequency_penalty, global.frequencyPenalty, global.frequency_penalty),
		presencePenalty: configNumber(service.presencePenalty, service.presence_penalty, global.presencePenalty, global.presence_penalty),
		reasoningEffort: configString(service.reasoningEffort, service.reasoning_effort, global.reasoningEffort, global.reasoning_effort, defaults?.reasoningEffort),
		contextBudget: configNumber(service.contextBudget, service.context_budget, global.contextBudget, global.context_budget),
		contextWindowTokens: configNumber(
			service.contextWindowTokens,
			service.context_window_tokens,
			envFirst(`MTHERIOS_${prefix}_LLM_CONTEXT_WINDOW`, `MTHERIOS_${prefix}_CONTEXT_WINDOW`),
			global.contextWindowTokens,
			global.context_window_tokens,
			envFirst('MTHERIOS_LLM_CONTEXT_WINDOW'),
		),
		enabled: service.enabled !== false,
		systemPromptOverride: configString(service.systemPromptOverride, service.system_prompt_override),
		apiKeyRef: defaultApiKeyRef(providerType, explicitApiKeyRef),
		metadata: {
			source: 'terminal_default',
			configPath: configPath(),
		},
	});
}
