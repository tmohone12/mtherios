import { PROVIDERS } from '$lib/services/ai/sdk/providers/config';
import type { TurnRequest } from '$lib/contracts/memory';
import type { ProviderType } from '$lib/types';
import {
	getGoogleAgentPlatformBaseUrl,
	getGoogleAgentPlatformHeaders,
} from '$lib/server/ai/googleAgentPlatform';
import { toWellFormedText } from './wellFormedText';

type ProviderProfile = NonNullable<TurnRequest['providerProfile']>;

export interface ServerGenerationOptions {
	profile: ProviderProfile;
	model?: string;
	temperature?: number;
	maxTokens?: number;
	timeoutMs?: number;
	system: string;
	systemDynamic?: string;
	messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
	prompt: string;
	responseFormat?: 'json_object';
}

export interface ServerGenerationUsage {
	requestTokens: number | null;
	responseTokens: number | null;
	totalTokens: number | null;
}

export interface ServerGenerationResult {
	text: string;
	model: string;
	endpoint: string;
	durationMs: number;
	promptChars: number;
	responseChars: number;
	usage: ServerGenerationUsage;
}

export class ServerGenerationError extends Error {
	result: Omit<ServerGenerationResult, 'text' | 'responseChars' | 'usage'> & {
		responseChars?: number;
		usage?: ServerGenerationUsage;
		statusCode?: number;
	};

	constructor(
		message: string,
		result: Omit<ServerGenerationResult, 'text' | 'responseChars' | 'usage'> & {
			responseChars?: number;
			usage?: ServerGenerationUsage;
			statusCode?: number;
		},
	) {
		super(message);
		this.name = 'ServerGenerationError';
		this.result = result;
	}
}

function isAnthropicProvider(profile: ProviderProfile): boolean {
	return profile.providerType === 'anthropic' || profile.providerType === 'anthropic-proxy';
}

const DEFAULT_SERVER_GENERATION_TIMEOUT_MS = 120_000;

function isGoogleAgentPlatformProvider(profile: ProviderProfile): boolean {
	return profile.providerType === 'google-agent-platform';
}

function supportsOpenRouterStyleCaching(profile: ProviderProfile): boolean {
	return profile.providerType === 'openrouter';
}

function requiresApiKey(profile: ProviderProfile): boolean {
	const provider = PROVIDERS[profile.providerType as ProviderType];
	return provider?.requiresApiKey ?? true;
}

function baseUrlFor(profile: ProviderProfile): string {
	const provider = PROVIDERS[profile.providerType as ProviderType];
	return profile.baseUrl || provider?.baseUrl || 'https://api.openai.com/v1';
}

function fallbackModelFor(profile: ProviderProfile, override?: string): string {
	if (override) return override;
	const provider = PROVIDERS[profile.providerType as ProviderType];
	return provider?.services?.narrative?.model ?? provider?.fallbackModels?.[0] ?? 'gpt-4o-mini';
}

function anthropicHeaders(profile: ProviderProfile): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'anthropic-version': '2023-06-01',
	};
	if (profile.apiKey.startsWith('sk-ant-oat-')) {
		headers.Authorization = `Bearer ${profile.apiKey}`;
		headers['anthropic-beta'] = 'oauth-2025-04-01';
	} else {
		headers['x-api-key'] = profile.apiKey;
	}
	return headers;
}

function openAiHeaders(profile: ProviderProfile): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
	return headers;
}

function promptChars(options: ServerGenerationOptions): number {
	return options.system.length
		+ (options.systemDynamic?.length ?? 0)
		+ options.prompt.length
		+ (options.messages ?? []).reduce((total, message) => total + message.content.length, 0);
}

function combinedSystem(system: string, systemDynamic?: string): string {
	return systemDynamic ? `${system}\n\n${systemDynamic}` : system;
}

function wellFormedMessages(messages: Array<{ role: 'user' | 'assistant'; content: string }>): Array<{ role: 'user' | 'assistant'; content: string }> {
	return messages.map((message) => ({
		...message,
		content: toWellFormedText(message.content),
	}));
}

function buildAnthropicSystem(system: string, systemDynamic?: string): string | Array<Record<string, unknown>> {
	if (systemDynamic && systemDynamic.length > 0 && system.length > 0) {
		return [
			{ type: 'text', text: system, cache_control: { type: 'ephemeral' } },
			{ type: 'text', text: systemDynamic },
		];
	}
	return combinedSystem(system, systemDynamic);
}

function buildOpenAiSystemMessage(profile: ProviderProfile, system: string, systemDynamic?: string): { role: 'system'; content: unknown } {
	if (systemDynamic && systemDynamic.length > 0 && system.length > 0 && supportsOpenRouterStyleCaching(profile)) {
		return {
			role: 'system',
			content: [
				{ type: 'text', text: system, cache_control: { type: 'ephemeral' } },
				{ type: 'text', text: systemDynamic },
			],
		};
	}
	return { role: 'system', content: combinedSystem(system, systemDynamic) };
}

function usageFromResponse(data: unknown, useAnthropic: boolean): ServerGenerationUsage {
	const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
	const usage = record.usage && typeof record.usage === 'object' ? record.usage as Record<string, unknown> : {};
	const requestTokens = useAnthropic ? usage.input_tokens : usage.prompt_tokens;
	const responseTokens = useAnthropic ? usage.output_tokens : usage.completion_tokens;
	const totalTokens = typeof usage.total_tokens === 'number'
		? usage.total_tokens
		: typeof requestTokens === 'number' && typeof responseTokens === 'number'
			? requestTokens + responseTokens
			: null;
	return {
		requestTokens: typeof requestTokens === 'number' ? requestTokens : null,
		responseTokens: typeof responseTokens === 'number' ? responseTokens : null,
		totalTokens: typeof totalTokens === 'number' ? totalTokens : null,
	};
}

function generationTimeoutMs(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SERVER_GENERATION_TIMEOUT_MS;
	return Math.max(1, Math.trunc(value));
}

function makeGenerationAbortSignal(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(new Error(`Server LLM request timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	return {
		signal: controller.signal,
		cleanup: () => clearTimeout(timer),
	};
}

function generationErrorMessage(error: unknown, timeoutMs: number): string {
	if (error instanceof Error && error.message) return error.message;
	if (error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError') {
		return `Server LLM request timed out after ${timeoutMs}ms`;
	}
	return String(error);
}

export async function generateServerTextWithMetrics(options: ServerGenerationOptions): Promise<ServerGenerationResult> {
	if (requiresApiKey(options.profile) && !options.profile.apiKey?.trim()) {
		throw new Error('Server turn generation requires an API profile with an API key.');
	}

	const startTime = Date.now();
	const model = fallbackModelFor(options.profile, options.model);
	const temperature = options.temperature ?? 1;
	const maxTokens = options.maxTokens ?? 4096;
	const useAnthropic = isAnthropicProvider(options.profile);
	const useGoogleAgentPlatform = isGoogleAgentPlatformProvider(options.profile);
	const baseUrl = useGoogleAgentPlatform
		? await getGoogleAgentPlatformBaseUrl()
		: baseUrlFor(options.profile);
	const messages = wellFormedMessages(options.messages ?? []);
	const system = toWellFormedText(options.system);
	const systemDynamic = options.systemDynamic == null ? undefined : toWellFormedText(options.systemDynamic);
	const prompt = toWellFormedText(options.prompt);
	const timeoutMs = generationTimeoutMs(options.timeoutMs);

	const endpoint = useAnthropic
		? `${baseUrl || 'https://api.anthropic.com'}/v1/messages`
		: `${baseUrl}/chat/completions`;
	const inputChars = promptChars(options);

	const body = useAnthropic
		? {
			model,
			max_tokens: maxTokens,
			temperature,
			system: buildAnthropicSystem(system, systemDynamic),
			messages: [
				...messages,
				{ role: 'user', content: prompt },
			],
		}
		: {
			model,
			temperature,
			max_tokens: maxTokens,
			messages: [
				buildOpenAiSystemMessage(options.profile, system, systemDynamic),
				...messages,
				{ role: 'user', content: prompt },
			],
			...(options.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
		};

	const abort = makeGenerationAbortSignal(timeoutMs);
	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: useAnthropic
				? anthropicHeaders(options.profile)
				: useGoogleAgentPlatform
					? { 'Content-Type': 'application/json', ...await getGoogleAgentPlatformHeaders() }
					: openAiHeaders(options.profile),
			body: JSON.stringify(body),
			signal: abort.signal,
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new ServerGenerationError(`Server LLM request failed (${response.status}): ${text || response.statusText}`, {
				model,
				endpoint,
				durationMs: Date.now() - startTime,
				promptChars: inputChars,
				statusCode: response.status,
			});
		}

		const data = await response.json();
		const text = useAnthropic
			? (data.content ?? []).map((block: { text?: string }) => block.text ?? '').join('').trim()
			: String(data.choices?.[0]?.message?.content ?? '').trim();
		return {
			text,
			model,
			endpoint,
			durationMs: Date.now() - startTime,
			promptChars: inputChars,
			responseChars: text.length,
			usage: usageFromResponse(data, useAnthropic),
		};
	} catch (error) {
		if (error instanceof ServerGenerationError) throw error;
		throw new ServerGenerationError(generationErrorMessage(error, timeoutMs), {
			model,
			endpoint,
			durationMs: Date.now() - startTime,
			promptChars: inputChars,
		});
	} finally {
		abort.cleanup();
	}
}

export async function generateServerText(options: ServerGenerationOptions): Promise<string> {
	return (await generateServerTextWithMetrics(options)).text;
}

export function parseJsonFromGeneratedText(raw: string): unknown {
	const text = raw
		.replace(/<think>[\s\S]*?<\/think>/gi, '')
		.replace(/<think>[\s\S]*$/i, '')
		.trim();
	if (!text) return null;
	const tryParse = (value: string): unknown => {
		try {
			return JSON.parse(value);
		} catch {
			return undefined;
		}
	};
	const direct = tryParse(text);
	if (direct !== undefined) return direct;
	const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
	if (fence) {
		const parsed = tryParse(fence[1].trim());
		if (parsed !== undefined) return parsed;
	}
	const start = text.indexOf('{');
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (inString) {
			if (char === '\\') escape = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === '{') depth++;
		else if (char === '}') {
			depth--;
			if (depth === 0) {
				const parsed = tryParse(text.slice(start, i + 1));
				if (parsed !== undefined) return parsed;
				break;
			}
		}
	}
	return null;
}
