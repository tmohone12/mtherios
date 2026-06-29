import { PROVIDERS } from '$lib/services/ai/sdk/providers/config';
import type { TurnRequest } from '$lib/contracts/memory';
import type { ProviderType } from '$lib/types';
import { getModelContextWindow } from '$lib/services/ai/context/modelWindows';
import {
	getGoogleAgentPlatformBaseUrl,
	getGoogleAgentPlatformHeaders,
} from '$lib/server/ai/googleAgentPlatform';
import { toWellFormedText } from './wellFormedText';

type ProviderProfile = NonNullable<TurnRequest['providerProfile']>;

export type PromptCacheRetention = 'in_memory' | 'in-memory' | '24h';

export interface PromptCacheOptions {
	key: string;
	retention?: PromptCacheRetention;
}

export interface ResponseSchemaOptions {
	name: string;
	schema: Record<string, unknown>;
	strict?: boolean;
}

export interface ServerGenerationOptions {
	profile: ProviderProfile;
	model?: string;
	temperature?: number;
	maxTokens?: number;
	timeoutMs?: number;
	maxRetries?: number;
	system: string;
	systemDynamic?: string;
	messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
	prompt: string;
	responseFormat?: 'json_object';
	responseSchema?: ResponseSchemaOptions;
	cache?: PromptCacheOptions;
	onTextDelta?: (chunk: string) => void | Promise<void>;
}

export interface ServerGenerationUsage {
	requestTokens: number | null;
	responseTokens: number | null;
	totalTokens: number | null;
	inputTokens: number | null;
	cachedInputTokens: number | null;
	cacheWriteTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	estimatedCostUsd: number | null;
}

export interface ServerGenerationResult {
	text: string;
	model: string;
	endpoint: string;
	finishReason?: string | null;
	durationMs: number;
	timeToFirstTokenMs?: number | null;
	retryCount?: number;
	promptChars: number;
	responseChars: number;
	usage: ServerGenerationUsage;
}

export class ServerGenerationError extends Error {
	result: Omit<ServerGenerationResult, 'text' | 'responseChars' | 'usage'> & {
		responseChars?: number;
		usage?: ServerGenerationUsage;
		statusCode?: number;
		retryCount?: number;
	};

	constructor(
		message: string,
		result: Omit<ServerGenerationResult, 'text' | 'responseChars' | 'usage'> & {
			responseChars?: number;
			usage?: ServerGenerationUsage;
			statusCode?: number;
			retryCount?: number;
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
const DEFAULT_SERVER_GENERATION_RETRIES = 1;

export interface ProviderRuntimeCapabilities {
	cacheMode: 'openai_implicit' | 'anthropic_breakpoint' | 'gemini_explicit' | 'openrouter' | 'none';
	structuredOutputs: boolean;
	nativeTokenCounting: boolean;
	maxContextTokens: number;
}

export function getProviderCapabilities(profile: ProviderProfile, model?: string): ProviderRuntimeCapabilities {
	const providerType = profile.providerType as ProviderType;
	const provider = PROVIDERS[providerType];
	const isAnthropic = isAnthropicProvider(profile);
	const cacheMode: ProviderRuntimeCapabilities['cacheMode'] = isAnthropic
		? 'anthropic_breakpoint'
		: providerType === 'openai'
			? 'openai_implicit'
			: providerType === 'openrouter'
				? 'openrouter'
				: providerType === 'google' || providerType === 'google-ai-studio' || providerType === 'google-vertex' || providerType === 'google-agent-platform'
					? 'gemini_explicit'
					: 'none';
	return {
		cacheMode,
		structuredOutputs: !isAnthropic && Boolean(provider?.capabilities.structuredOutput),
		nativeTokenCounting: ['openai', 'openrouter', 'anthropic', 'anthropic-proxy', 'google', 'google-ai-studio', 'google-vertex', 'google-agent-platform', 'z-ai'].includes(providerType),
		maxContextTokens: getModelContextWindow(fallbackModelFor(profile, model)),
	};
}

function isGoogleAgentPlatformProvider(profile: ProviderProfile): boolean {
	return profile.providerType === 'google-agent-platform';
}

function supportsOpenRouterStyleCaching(profile: ProviderProfile): boolean {
	return getProviderCapabilities(profile).cacheMode === 'openrouter';
}

function supportsOpenAiPromptCacheFields(profile: ProviderProfile): boolean {
	return getProviderCapabilities(profile).cacheMode === 'openai_implicit';
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

function normalizePromptCacheRetention(retention: PromptCacheRetention): 'in-memory' | '24h' {
	return retention === '24h' ? '24h' : 'in-memory';
}

function buildOpenAiPromptCacheFields(profile: ProviderProfile, cache: PromptCacheOptions | undefined): Record<string, string> {
	if (!cache?.key || !supportsOpenAiPromptCacheFields(profile)) return {};
	return {
		prompt_cache_key: cache.key,
		...(cache.retention ? { prompt_cache_retention: normalizePromptCacheRetention(cache.retention) } : {}),
	};
}

function buildOpenAiResponseFormat(options: ServerGenerationOptions): Record<string, unknown> {
	if (options.responseSchema) {
		if (!getProviderCapabilities(options.profile, options.model).structuredOutputs) {
			return { response_format: { type: 'json_object' } };
		}
		return {
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: options.responseSchema.name,
					strict: options.responseSchema.strict ?? true,
					schema: options.responseSchema.schema,
				},
			},
		};
	}
	return options.responseFormat === 'json_object'
		? { response_format: { type: 'json_object' } }
		: {};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstNumber(...values: unknown[]): number | null {
	for (const value of values) {
		const parsed = optionalNumber(value);
		if (parsed != null) return parsed;
	}
	return null;
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function usageFromResponse(data: unknown, useAnthropic: boolean): ServerGenerationUsage {
	const record = asRecord(data);
	const usage = asRecord(record.usage);
	const promptDetails = asRecord(usage.prompt_tokens_details);
	const inputDetails = asRecord(usage.input_tokens_details);
	const completionDetails = asRecord(usage.completion_tokens_details);
	const outputDetails = asRecord(usage.output_tokens_details);
	const inputTokens = useAnthropic
		? optionalNumber(usage.input_tokens)
		: firstNumber(usage.prompt_tokens, usage.input_tokens);
	const outputTokens = useAnthropic
		? optionalNumber(usage.output_tokens)
		: firstNumber(usage.completion_tokens, usage.output_tokens);
	const cachedInputTokens = useAnthropic
		? optionalNumber(usage.cache_read_input_tokens)
		: firstNumber(promptDetails.cached_tokens, inputDetails.cached_tokens);
	const cacheWriteTokens = firstNumber(
		usage.cache_creation_input_tokens,
		usage.cache_write_input_tokens,
		inputDetails.cache_creation_tokens,
		inputDetails.cache_write_tokens,
	);
	const reasoningTokens = firstNumber(
		completionDetails.reasoning_tokens,
		outputDetails.reasoning_tokens,
		usage.reasoning_tokens,
	);
	const totalTokens = optionalNumber(usage.total_tokens)
		?? (inputTokens != null && outputTokens != null
			? inputTokens + outputTokens
			: null
		);
	return {
		requestTokens: inputTokens,
		responseTokens: outputTokens,
		totalTokens,
		inputTokens,
		cachedInputTokens,
		cacheWriteTokens,
		outputTokens,
		reasoningTokens,
		estimatedCostUsd: null,
	};
}

function finishReasonFromResponse(data: unknown, useAnthropic: boolean): string | null {
	const record = asRecord(data);
	if (useAnthropic) return optionalString(record.stop_reason);
	const choices = Array.isArray(record.choices) ? record.choices : [];
	const firstChoice = asRecord(choices[0]);
	return optionalString(firstChoice.finish_reason);
}

function emptyUsage(): ServerGenerationUsage {
	return {
		requestTokens: null,
		responseTokens: null,
		totalTokens: null,
		inputTokens: null,
		cachedInputTokens: null,
		cacheWriteTokens: null,
		outputTokens: null,
		reasoningTokens: null,
		estimatedCostUsd: null,
	};
}

async function readStreamingText(
	response: Response,
	useAnthropic: boolean,
	onTextDelta: (chunk: string) => void | Promise<void>,
	startTime: number,
): Promise<{ text: string; usage: ServerGenerationUsage; finishReason: string | null; timeToFirstTokenMs: number | null }> {
	if (!response.body) throw new Error('Provider streaming response had no body.');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	let usage = emptyUsage();
	let finishReason: string | null = null;
	let timeToFirstTokenMs: number | null = null;

	const consumeData = async (dataText: string) => {
		if (!dataText || dataText === '[DONE]') return;
		let data: unknown;
		try {
			data = JSON.parse(dataText);
		} catch {
			return;
		}
		const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
		let chunk = '';
		if (useAnthropic) {
			const delta = record.delta && typeof record.delta === 'object' ? record.delta as Record<string, unknown> : {};
			if (typeof delta.text === 'string') chunk = delta.text;
			finishReason = optionalString(delta.stop_reason) ?? optionalString(record.stop_reason) ?? finishReason;
			if (record.type === 'message_delta') {
				usage = usageFromResponse(record, true);
			}
		} else {
			const choices = Array.isArray(record.choices) ? record.choices : [];
			const firstChoice = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : {};
			const delta = firstChoice.delta && typeof firstChoice.delta === 'object' ? firstChoice.delta as Record<string, unknown> : {};
			if (typeof delta.content === 'string') chunk = delta.content;
			finishReason = optionalString(firstChoice.finish_reason) ?? finishReason;
			if (record.usage) usage = usageFromResponse(record, false);
		}
		if (chunk) {
			timeToFirstTokenMs ??= Math.max(0, Date.now() - startTime);
			text += chunk;
			await onTextDelta(chunk);
		}
	};

	const consumeEvent = async (eventText: string) => {
		const dataLines = eventText
			.split(/\r?\n/)
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trimStart());
		for (const dataLine of dataLines) {
			await consumeData(dataLine);
		}
	};

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let boundaryMatch = /\r?\n\r?\n/.exec(buffer);
		while (boundaryMatch) {
			const boundary = boundaryMatch.index;
			const eventText = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + boundaryMatch[0].length);
			await consumeEvent(eventText);
			boundaryMatch = /\r?\n\r?\n/.exec(buffer);
		}
	}
	buffer += decoder.decode();
	if (buffer.trim()) await consumeEvent(buffer);
	return { text, usage, finishReason, timeToFirstTokenMs };
}

function generationTimeoutMs(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SERVER_GENERATION_TIMEOUT_MS;
	return Math.max(1, Math.trunc(value));
}

function generationRetryLimit(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SERVER_GENERATION_RETRIES;
	return Math.max(0, Math.min(3, Math.trunc(value)));
}

function isTransientStatus(status: number | undefined): boolean {
	return status === 408 || status === 409 || status === 425 || status === 429 || (typeof status === 'number' && status >= 500);
}

function isTimeoutError(error: unknown): boolean {
	if (error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError') return true;
	return error instanceof Error && /timed out/i.test(error.message);
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
	const maxRetries = generationRetryLimit(options.maxRetries);

	const endpoint = useAnthropic
		? `${baseUrl || 'https://api.anthropic.com'}/v1/messages`
		: `${baseUrl}/chat/completions`;
	const inputChars = promptChars(options);
	const shouldStream = Boolean(options.onTextDelta) && options.responseFormat !== 'json_object' && !options.responseSchema;

	const body = useAnthropic
		? {
			model,
			max_tokens: maxTokens,
			temperature,
			...(shouldStream ? { stream: true } : {}),
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
			...buildOpenAiPromptCacheFields(options.profile, options.cache),
			...(shouldStream ? { stream: true, stream_options: { include_usage: true } } : {}),
			...buildOpenAiResponseFormat(options),
		};

	const headers = useAnthropic
		? anthropicHeaders(options.profile)
		: useGoogleAgentPlatform
			? { 'Content-Type': 'application/json', ...await getGoogleAgentPlatformHeaders() }
			: openAiHeaders(options.profile);
	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
		const abort = makeGenerationAbortSignal(timeoutMs);
		try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: abort.signal,
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			const error = new ServerGenerationError(`Server LLM request failed (${response.status}): ${text || response.statusText}`, {
				model,
				endpoint,
				durationMs: Date.now() - startTime,
				promptChars: inputChars,
				statusCode: response.status,
				retryCount: attempt,
			});
			if (attempt < maxRetries && isTransientStatus(response.status)) {
				lastError = error;
				continue;
			}
			throw error;
		}

		const streamed = shouldStream && options.onTextDelta
			? await readStreamingText(response, useAnthropic, options.onTextDelta, startTime)
			: null;
		const data = streamed ? null : await response.json();
		const text = streamed
			? streamed.text.trim()
			: useAnthropic
				? (data.content ?? []).map((block: { text?: string }) => block.text ?? '').join('').trim()
				: String(data.choices?.[0]?.message?.content ?? '').trim();
		return {
			text,
			model,
			endpoint,
			finishReason: streamed ? streamed.finishReason : finishReasonFromResponse(data, useAnthropic),
			durationMs: Date.now() - startTime,
			timeToFirstTokenMs: streamed?.timeToFirstTokenMs ?? null,
			retryCount: attempt,
			promptChars: inputChars,
			responseChars: text.length,
			usage: streamed ? streamed.usage : usageFromResponse(data, useAnthropic),
		};
	} catch (error) {
		if (error instanceof ServerGenerationError) throw error;
		const wrapped = new ServerGenerationError(generationErrorMessage(error, timeoutMs), {
			model,
			endpoint,
			durationMs: Date.now() - startTime,
			promptChars: inputChars,
			retryCount: attempt,
		});
		if (attempt < maxRetries && !isTimeoutError(error)) {
			lastError = wrapped;
			continue;
		}
		throw wrapped;
	} finally {
		abort.cleanup();
	}
	}
	if (lastError instanceof ServerGenerationError) throw lastError;
	throw new ServerGenerationError('Server LLM request failed without a provider response.', {
		model,
		endpoint,
		durationMs: Date.now() - startTime,
		promptChars: inputChars,
		retryCount: maxRetries,
	});
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
