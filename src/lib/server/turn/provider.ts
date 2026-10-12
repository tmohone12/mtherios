import { createHash, randomUUID } from 'node:crypto';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { requestScope } from '$lib/server/requestScopes';
import { isJevModel } from './jev';
import { PROVIDERS } from '$lib/services/ai/sdk/providers/config';
import type { TurnRequest } from '$lib/contracts/memory';
import type { ProviderType } from '$lib/types';
import { getModelContextWindowInfo } from '$lib/services/ai/context/modelWindows';
import {
	getGoogleAgentPlatformBaseUrl,
	getGoogleAgentPlatformHeaders,
} from '$lib/server/ai/googleAgentPlatform';
import { toWellFormedText } from './wellFormedText';
import { countTokens } from '$lib/utils/tokens';

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

export interface NativeToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface NativeToolCall { id: string; name: string; arguments: Record<string, unknown> }

/** Ordered native history. Continuation fields are private provider protocol data. */
export type ServerGenerationMessage =
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string; toolCalls?: NativeToolCall[]; providerContinuation?: Record<string, unknown> }
	| { role: 'tool'; content: string; toolCallId: string; toolName?: string; isError?: boolean };

export interface ServerGenerationRequest {
	body: Record<string, unknown>;
	serializedBody: string;
	inputTokens: number;
	reservedOutputTokens: number;
	contextWindowTokens: number;
	/** Verified conservative price, when the transport can provide one (e.g. image catalog). */
	reservedCostUsd?: number;
}

export interface ServerProviderRequestHooks {
	signal?: AbortSignal;
	beforeRequest: (options: ServerGenerationOptions, request: ServerGenerationRequest) => Promise<(result: ServerGenerationResult) => Promise<void>>;
}
const providerRequestScope = requestScope<ServerProviderRequestHooks>();
/** Carries one run's durable budget through existing specialist/provider transports. */
export function withServerProviderHooks<T>(hooks: ServerProviderRequestHooks, work: () => Promise<T>): Promise<T> {
	return providerRequestScope.run(hooks, work);
}
export function currentServerProviderHooks(): ServerProviderRequestHooks | undefined { return providerRequestScope.getStore(); }

export interface ServerGenerationOptions {
	profile: ProviderProfile;
	/** Explicit bounded operations can pin one OpenRouter endpoint and prices. */
	nanoGptProvider?: { only: string[]; order: string[]; quantizations?: string[]; allow_fallbacks: false; require_parameters: true; max_price: { prompt: number; completion: number } };
	openRouterProvider?: { only: string[]; order: string[]; allow_fallbacks: false; require_parameters: true;
		max_price: { prompt: number; completion: number; request: number } };
	model?: string;
	temperature?: number;
	maxTokens?: number;
	/** Narration may use the provider's output allowance instead of an app cap. */
	providerOutputLimit?: boolean;
	reasoningEffort?: string | null;
	timeoutMs?: number;
	maxRetries?: number;
	system: string;
	systemDynamic?: string;
	/** Place changing turn context after dialogue on cache-ordered narration requests. */
	contextAfterDialogue?: boolean;
	/** Character offset where a second, shorter-lived system cache segment begins. */
	systemCacheBoundary?: number;
	messages?: ServerGenerationMessage[];
	prompt: string;
	/** Native agent history already includes the current user message. */
	appendPrompt?: boolean;
	responseFormat?: 'json_object';
	responseSchema?: ResponseSchemaOptions;
	tools?: NativeToolDefinition[];
	/** Allow independent native tool calls in one provider response. */
	parallelToolCalls?: boolean;
	cache?: PromptCacheOptions;
	onTextDelta?: (chunk: string) => void | Promise<void>;
	signal?: AbortSignal;
	/** Awaited before HTTP dispatch; durable runtimes reserve budgets here. No credentials. */
	onBeforeRequest?: (request: ServerGenerationRequest) => void | Promise<void>;
	/** Awaited before reading the response body; lets bounded callers retain billing correlation durably. */
	onResponseHeaders?: (headers: ServerGenerationResponseHeaders) => void | Promise<void>;
	/** One receipt for each actual HTTP dispatch, including failed attempts. Never contains credentials or request text. */
	onAttempt?: (attempt: ServerGenerationAttempt) => void | Promise<void>;
	/** The Pi bridge already reserves this request in its durable budget. */
	agentBudgetManaged?: boolean;
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
	providerCostUsd: number | null;
}

export interface ServerGenerationAttempt {
	attemptId: string;
	/** Header correlation when available, otherwise the legacy completion-ID fallback. */
	providerRequestId: string | null;
	/** Only the response X-Request-ID header is valid for NanoGPT Request Billing. */
	billingRequestId?: string | null;
	completionId?: string | null;
	requestHash: string;
	attempt: number;
	startedAt: string;
	model: string;
	endpoint: string;
	status: 'success' | 'error';
	statusCode: number | null;
	durationMs: number;
	promptChars: number;
	responseChars: number | null;
	finishReason: string | null;
	usage: ServerGenerationUsage;
	error: string | null;
}

export interface ServerGenerationResponseHeaders {
	attemptId: string;
	requestHash: string;
	billingRequestId: string | null;
	statusCode: number;
}

export interface ServerGenerationResult {
	text: string;
	message?: Extract<ServerGenerationMessage, { role: 'assistant' }>;
	toolCalls?: NativeToolCall[];
	model: string;
	endpoint: string;
	finishReason?: string | null;
	durationMs: number;
	timeToFirstTokenMs?: number | null;
	retryCount?: number;
	promptChars: number;
	responseChars: number;
	usage: ServerGenerationUsage;
	/** Provider usage is per attempt, never silently summed over retries. */
	attempts?: ServerGenerationAttempt[];
	/** This text was already accounted for by the named operation. */
	accounting?: { kind: 'reuse'; sourceOperation: string; sourceRunId?: string; attemptIds: string[] };
}

export class ServerGenerationError extends Error {
	result: Omit<ServerGenerationResult, 'text' | 'responseChars' | 'usage'> & {
		responseChars?: number;
		usage?: ServerGenerationUsage;
		statusCode?: number;
		retryCount?: number;
		retryAfterMs?: number;
	};

	constructor(
		message: string,
		result: Omit<ServerGenerationResult, 'text' | 'responseChars' | 'usage'> & {
			responseChars?: number;
			usage?: ServerGenerationUsage;
			statusCode?: number;
			retryCount?: number;
			retryAfterMs?: number;
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

function isDeepSeekRuntimeModel(providerType: ProviderType, model: string | undefined): boolean {
	if (providerType === 'deepseek') return true;
	return Boolean(model && /deepseek/i.test(model));
}

const DEFAULT_SERVER_GENERATION_TIMEOUT_MS = 120_000;
const DEFAULT_SERVER_GENERATION_RETRIES = 1;
const providerCooldowns = new Map<string, number>();

export function getProviderCooldownRemainingMs(): number {
	const now = Date.now();
	for (const [key, until] of providerCooldowns) if (until <= now) providerCooldowns.delete(key);
	return Math.max(0, ...[...providerCooldowns.values()].map(until => until - now));
}

function providerCooldownKey(profile: ProviderProfile, endpoint: string): string {
	return createHash('sha256').update(`${endpoint}\0${profile.apiKey ?? ''}`).digest('hex');
}

function retryAfterMs(header: string | null, status: number): number {
	const seconds = header && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header.trim()) * 1000 : NaN;
	const date = header && !Number.isFinite(seconds) ? Date.parse(header) - Date.now() : NaN;
	const requested = Number.isFinite(seconds) ? seconds : date;
	return Math.min(300_000, Math.max(1000, Number.isFinite(requested) ? requested : status === 429 ? 30_000 : 1000));
}

export interface ProviderRuntimeCapabilities {
	cacheMode: 'openai_implicit' | 'anthropic_breakpoint' | 'gemini_explicit' | 'openrouter' | 'none';
	structuredOutputs: boolean;
	nativeTokenCounting: boolean;
	maxContextTokens: number;
	contextWindowSource: 'explicit-override' | 'model-window-registry-or-default';
}

export function getProviderCapabilities(profile: ProviderProfile, model?: string): ProviderRuntimeCapabilities {
	const providerType = profile.providerType as ProviderType;
	const provider = PROVIDERS[providerType];
	const isAnthropic = isAnthropicProvider(profile);
	const isDeepSeekModel = isDeepSeekRuntimeModel(providerType, model);
	// Gemini accepts only a subset of JSON Schema: every strict state-patch schema sent to it
	// failed with "Request contains an invalid argument", while JSON mode succeeds.
	const isGeminiModel = /(?:^|\/)gemini-/i.test(fallbackModelFor(profile, model) ?? '');
	const cacheMode: ProviderRuntimeCapabilities['cacheMode'] = isAnthropic
		? 'anthropic_breakpoint'
		: providerType === 'openai'
			? 'openai_implicit'
			: providerType === 'openrouter'
				? 'openrouter'
				: providerType === 'google' || providerType === 'google-ai-studio' || providerType === 'google-vertex' || providerType === 'google-agent-platform'
					? 'gemini_explicit'
					: 'none';
	const contextWindow = getModelContextWindowInfo(fallbackModelFor(profile, model), profile.contextWindowTokens);
	return {
		cacheMode,
		structuredOutputs: !isAnthropic && !isDeepSeekModel && !isGeminiModel && Boolean(provider?.capabilities.structuredOutput),
		nativeTokenCounting: ['openai', 'openrouter', 'anthropic', 'anthropic-proxy', 'google', 'google-ai-studio', 'google-vertex', 'google-agent-platform', 'z-ai'].includes(providerType),
		maxContextTokens: contextWindow.tokens,
		contextWindowSource: contextWindow.source,
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
		+ (options.messages ?? []).reduce((total, message) => total + JSON.stringify(message).length, 0);
}

function combinedSystem(system: string, systemDynamic?: string): string {
	return systemDynamic ? `${system}\n\n${systemDynamic}` : system;
}

function wellFormedMessages(messages: ServerGenerationMessage[]): ServerGenerationMessage[] {
	return messages.map((message) => ({
		...message,
		content: toWellFormedText(message.content),
	}));
}

function openAiNativeMessages(messages: ServerGenerationMessage[]): Array<Record<string, unknown>> {
	return messages.map(message => {
		if (message.role === 'tool') {
			if (!message.toolCallId) throw new Error('Native tool result requires a tool call ID.');
			return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
		}
		if (message.role === 'user') return { role: message.role, content: message.content };
		const continuation = message.providerContinuation ?? {};
		return {
			role: 'assistant', content: message.content || null,
			...Object.fromEntries(['reasoning_content', 'reasoning', 'reasoning_details'].filter(key => continuation[key] != null).map(key => [key, continuation[key]])),
			...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
		};
	});
}

function anthropicNativeMessages(messages: ServerGenerationMessage[]): Array<Record<string, unknown>> {
	if (!messages.some(message => message.role === 'tool' || (message.role === 'assistant' && (message.toolCalls?.length || message.providerContinuation)))) {
		return messages.map(message => ({ role: message.role, content: message.content }));
	}
	const output: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];
	for (const message of messages) {
		const role = message.role === 'assistant' ? 'assistant' : 'user';
		const content: Array<Record<string, unknown>> = message.role === 'tool'
			? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content, ...(message.isError ? { is_error: true } : {}) }]
			: message.role === 'assistant' && Array.isArray(message.providerContinuation?.anthropicContent)
				? message.providerContinuation.anthropicContent as Array<Record<string, unknown>>
				: [
					...(message.content ? [{ type: 'text', text: message.content }] : []),
					...(message.role === 'assistant' ? (message.toolCalls ?? []).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })) : []),
				];
		if (message.role === 'tool' && !message.toolCallId) throw new Error('Native tool result requires a tool call ID.');
		const previous = output.at(-1);
		if (previous?.role === role) previous.content.push(...content);
		else output.push({ role, content });
	}
	return output;
}

function cachedSystemBlocks(system: string, systemDynamic: string, boundary?: number): Array<Record<string, unknown>> {
	const split = typeof boundary === 'number' && boundary > 0 && boundary < system.length;
	return [
		...(split ? [{ type: 'text', text: system.slice(0, boundary), cache_control: { type: 'ephemeral' } }] : []),
		{ type: 'text', text: split ? system.slice(boundary) : system, cache_control: { type: 'ephemeral' } },
		...(systemDynamic ? [{ type: 'text', text: systemDynamic }] : []),
	];
}

function buildAnthropicSystem(system: string, systemDynamic?: string, boundary?: number): string | Array<Record<string, unknown>> {
	if (systemDynamic && systemDynamic.length > 0 && system.length > 0) {
		return cachedSystemBlocks(system, systemDynamic, boundary);
	}
	return combinedSystem(system, systemDynamic);
}

function buildOpenAiSystemMessage(profile: ProviderProfile, system: string, systemDynamic?: string, boundary?: number, cacheStableSystem = false): { role: 'system'; content: unknown } {
	if (system.length > 0 && (systemDynamic || cacheStableSystem) && supportsOpenRouterStyleCaching(profile)) {
		return {
			role: 'system',
			content: cachedSystemBlocks(system, systemDynamic ?? '', boundary),
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

function firstNonNegativeNumber(...values: unknown[]): number | null {
	for (const value of values) {
		const parsed = optionalNumber(value);
		if (parsed != null && parsed >= 0) return parsed;
	}
	return null;
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function usageFromResponse(data: unknown, useAnthropic: boolean): ServerGenerationUsage {
	const record = asRecord(data);
	const usage = asRecord(record.usage);
	const nanoPricing = asRecord(record.x_nanogpt_pricing);
	const promptDetails = asRecord(usage.prompt_tokens_details);
	const inputDetails = asRecord(usage.input_tokens_details);
	const completionDetails = asRecord(usage.completion_tokens_details);
	const outputDetails = asRecord(usage.output_tokens_details);
	const uncachedInputTokens = useAnthropic
		? optionalNumber(usage.input_tokens)
		: firstNumber(usage.prompt_tokens, usage.input_tokens);
	const outputTokens = useAnthropic
		? optionalNumber(usage.output_tokens)
		: firstNumber(usage.completion_tokens, usage.output_tokens);
	const cachedInputTokens = useAnthropic
		? optionalNumber(usage.cache_read_input_tokens)
		: firstNumber(promptDetails.cached_tokens, inputDetails.cached_tokens, usage.prompt_cache_hit_tokens);
	const cacheWriteTokens = firstNumber(
		usage.cache_creation_input_tokens,
		usage.cache_write_input_tokens,
		promptDetails.cache_write_tokens,
		inputDetails.cache_creation_tokens,
		inputDetails.cache_write_tokens,
	);
	const inputTokens = useAnthropic && uncachedInputTokens != null
		? uncachedInputTokens + (cachedInputTokens ?? 0) + (cacheWriteTokens ?? 0)
		: uncachedInputTokens;
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
	const providerCostUsd = firstNonNegativeNumber(
		nanoPricing.currency === 'USD' ? nanoPricing.cost : null,
		usage.cost,
		usage.cost_usd,
		usage.total_cost,
		record.cost,
		record.cost_usd,
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
		providerCostUsd,
	};
}

function finishReasonFromResponse(data: unknown, useAnthropic: boolean): string | null {
	const record = asRecord(data);
	if (useAnthropic) return optionalString(record.stop_reason);
	const choices = Array.isArray(record.choices) ? record.choices : [];
	const firstChoice = asRecord(choices[0]);
	return optionalString(firstChoice.finish_reason);
}

export function emptyServerGenerationUsage(): ServerGenerationUsage {
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
		providerCostUsd: null,
	};
}

async function readStreamingText(
	response: Response,
	useAnthropic: boolean,
	onTextDelta: (chunk: string) => void | Promise<void>,
	startTime: number,
	onProgress?: (state: { text: string; usage: ServerGenerationUsage; finishReason: string | null; providerRequestId: string | null }) => void,
): Promise<{ text: string; usage: ServerGenerationUsage; finishReason: string | null; timeToFirstTokenMs: number | null; providerRequestId: string | null }> {
	if (!response.body) throw new Error('Provider streaming response had no body.');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	let usage = emptyServerGenerationUsage();
	let anthropicUsage: Record<string, unknown> = {};
	let finishReason: string | null = null;
	let timeToFirstTokenMs: number | null = null;
	let providerRequestId: string | null = null;

	const consumeData = async (dataText: string) => {
		if (!dataText || dataText === '[DONE]') return;
		let data: unknown;
		try {
			data = JSON.parse(dataText);
		} catch {
			return;
		}
		const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
		providerRequestId = optionalString(record.id) ?? optionalString(asRecord(record.message).id) ?? providerRequestId;
		let chunk = '';
		if (useAnthropic) {
			const delta = record.delta && typeof record.delta === 'object' ? record.delta as Record<string, unknown> : {};
			if (typeof delta.text === 'string') chunk = delta.text;
			finishReason = optionalString(delta.stop_reason) ?? optionalString(record.stop_reason) ?? finishReason;
			if (record.type === 'message_start' || record.type === 'message_delta') {
				const nextUsage = asRecord(record.type === 'message_start' ? asRecord(record.message).usage : record.usage);
				anthropicUsage = { ...anthropicUsage, ...Object.fromEntries(Object.entries(nextUsage).filter(([, value]) => value != null)) };
				usage = usageFromResponse({ usage: anthropicUsage }, true);
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
			onProgress?.({ text, usage, finishReason, providerRequestId });
			await onTextDelta(chunk);
		}
		onProgress?.({ text, usage, finishReason, providerRequestId });
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
	return { text, usage, finishReason, timeToFirstTokenMs, providerRequestId };
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

function makeGenerationAbortSignal(timeoutMs: number, externalSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const abortFromExternal = () => controller.abort(externalSignal?.reason);
	if (externalSignal?.aborted) abortFromExternal();
	else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
	const timer = setTimeout(() => {
		controller.abort(new Error(`Server LLM request timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			externalSignal?.removeEventListener('abort', abortFromExternal);
		},
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
	if (options.profile.providerType === 'ollama' && !getMtheriosAppConfig().localEmbeddingsEnabled) throw new Error('Ollama is off for this session. Enable Ollama/local embeddings at startup to use it.');
 if (process.env.MYTHENGINE_TEST_LOCAL_ONLY === 'true') {
  const url = new URL(options.profile.baseUrl || 'http://127.0.0.1:11434');
  if (!['ollama', 'openai-compatible'].includes(options.profile.providerType) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Isolated test copy permits local inference only.');
 }
	if (isJevModel(options.model)) throw new Error('Decision models use the Decisions API and are unavailable for text generation.');
	if (requiresApiKey(options.profile) && !options.profile.apiKey?.trim()) {
		throw new Error('Server turn generation requires an API profile with an API key.');
	}

	const startTime = Date.now();
	const model = fallbackModelFor(options.profile, options.model);
	const temperature = options.temperature ?? 1;
	const maxTokens = options.maxTokens ?? 4096;
	let requestedReasoningEffort = options.reasoningEffort?.trim().toLowerCase();
	// GLM-5.3 requires thinking. Older persisted "off" settings must remain usable.
	// https://docs.z.ai/guides/llm/glm-5.3 (migration guidance)
	const requiresGlmThinking = /(?:^|\/)glm-5\.3(?:$|[-:])/i.test(model);
	if (requiresGlmThinking && ['off', 'none', 'minimal'].includes(requestedReasoningEffort ?? '')) requestedReasoningEffort = 'low';
	const providerType = options.profile.providerType as ProviderType;
	const reasoningControl = requestedReasoningEffort && providerType === 'nanogpt'
		? { reasoning_effort: requestedReasoningEffort === 'off' ? 'none' : requestedReasoningEffort === 'max' ? 'xhigh' : requestedReasoningEffort }
		// OpenRouter translates its own reasoning object; native thinking flags can be ignored.
		: requestedReasoningEffort && providerType === 'openrouter'
			? { reasoning: { effort: requestedReasoningEffort === 'off' ? 'none' : requestedReasoningEffort } }
		: requiresGlmThinking && requestedReasoningEffort
			? { thinking: { type: 'enabled' }, reasoning_effort: ['max', 'xhigh'].includes(requestedReasoningEffort) ? 'max' : requestedReasoningEffort === 'low' ? 'low' : 'high' }
		: isDeepSeekRuntimeModel(providerType, model) && requestedReasoningEffort
			? requestedReasoningEffort === 'off'
				? { thinking: { type: 'disabled' } }
				: { thinking: { type: 'enabled' }, reasoning_effort: requestedReasoningEffort === 'max' ? 'max' : 'high' }
			: {};
	const useAnthropic = isAnthropicProvider(options.profile);
	const anthropicThinking = useAnthropic && requestedReasoningEffort && !['off', 'none'].includes(requestedReasoningEffort);
	const anthropicAdaptive = anthropicThinking && /claude-(?:opus|sonnet)-4[.-]6/i.test(model);
	if (anthropicThinking && !anthropicAdaptive && maxTokens <= 1024) throw new Error('Anthropic thinking requires an output allowance above 1024 tokens.');
	const useGoogleAgentPlatform = isGoogleAgentPlatformProvider(options.profile);
	const baseUrl = useGoogleAgentPlatform
		? await getGoogleAgentPlatformBaseUrl()
		: baseUrlFor(options.profile);
	const messages = wellFormedMessages(options.messages ?? []);
	const system = toWellFormedText(options.system);
	const contextAfterDialogue = options.contextAfterDialogue === true && ['nanogpt', 'openrouter'].includes(providerType);
	const turnContext = options.systemDynamic == null ? undefined : toWellFormedText(options.systemDynamic);
	const systemDynamic = contextAfterDialogue ? undefined : turnContext;
	const prompt = toWellFormedText(contextAfterDialogue && turnContext
		? `Current turn context (newer than the dialogue above; apply source priority when details conflict):\n${turnContext}\n\n${options.prompt}`
		: options.prompt);
	const timeoutMs = generationTimeoutMs(options.timeoutMs);
	const maxRetries = generationRetryLimit(options.maxRetries);
	const scopedHooks = options.agentBudgetManaged ? undefined : currentServerProviderHooks();
	const scopedSignal = currentServerProviderHooks()?.signal;
	const requestSignal = scopedSignal && options.signal ? AbortSignal.any([scopedSignal, options.signal]) : scopedSignal ?? options.signal;

	const endpoint = useAnthropic
		? `${baseUrl || 'https://api.anthropic.com'}/v1/messages`
		: `${baseUrl}/chat/completions`;
	const inputChars = promptChars({ ...options, systemDynamic, prompt });
	const shouldStream = Boolean(options.onTextDelta) && options.responseFormat !== 'json_object' && !options.responseSchema && !options.tools?.length;
	const dialogue = [...messages, ...(options.appendPrompt === false ? [] : [{ role: 'user' as const, content: prompt }])];

	const body = useAnthropic
		? {
			model,
			max_tokens: maxTokens,
			...(anthropicAdaptive ? {} : { temperature: anthropicThinking ? 1 : temperature }),
			...(anthropicAdaptive
				? { thinking: { type: 'adaptive' }, output_config: { effort: ['minimal', 'low'].includes(requestedReasoningEffort!) ? 'low' : requestedReasoningEffort === 'medium' ? 'medium' : requestedReasoningEffort === 'max' ? 'max' : 'high' } }
				: anthropicThinking ? { thinking: { type: 'enabled', budget_tokens: Math.min(maxTokens - 1, Math.max(1024, maxTokens - 1024), requestedReasoningEffort === 'low' || requestedReasoningEffort === 'minimal' ? 1024 : requestedReasoningEffort === 'medium' ? 2048 : 4096) } } : {}),
			...(shouldStream ? { stream: true } : {}),
			system: buildAnthropicSystem(system, systemDynamic, options.systemCacheBoundary),
			messages: anthropicNativeMessages(dialogue),
			...(options.tools?.length ? { tools: options.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
		}
		: {
			model,
			temperature,
			...(options.providerOutputLimit ? {} : { max_tokens: maxTokens }),
			messages: [
				buildOpenAiSystemMessage(options.profile, system, systemDynamic, options.systemCacheBoundary, contextAfterDialogue),
				...openAiNativeMessages(dialogue),
			],
			...buildOpenAiPromptCacheFields(options.profile, options.cache),
			...(options.profile.providerType === 'openrouter' && options.cache?.key
				? { session_id: options.cache.key.slice(0, 256) } : {}),
			...reasoningControl,
			...(options.profile.providerType === 'openrouter' && options.openRouterProvider ? { provider: options.openRouterProvider } : {}),
			...(options.profile.providerType === 'nanogpt' && options.nanoGptProvider ? { provider: options.nanoGptProvider } : {}),
			...(options.profile.providerType === 'nanogpt' && !shouldStream ? { include_usage: true } : {}),
			...(shouldStream ? { stream: true, stream_options: { include_usage: true } } : {}),
			...buildOpenAiResponseFormat(options),
			...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })), parallel_tool_calls: options.parallelToolCalls === true } : {}),
		};

	// Count the final serialized request, including schema, observations and framing.
	// Every generation passes here, including roll continuations and JSON repair.
	const serializedBody = JSON.stringify(body);
	const requestTokens = countTokens(serializedBody);
	const contextWindow = getProviderCapabilities(options.profile, model).maxContextTokens;
	// Anthropic requires max_tokens. Compatible APIs can choose their own output
	// allowance; an old saved maxTokens value must not cap or reject that request.
	const reservedOutput = options.providerOutputLimit && !useAnthropic ? 0 : maxTokens;
	if (requestTokens + reservedOutput + 512 > contextWindow) {
		throw new ServerGenerationError(`Request exceeds the model context allowance: approximately ${requestTokens} input tokens + ${reservedOutput} reserved output + 512 framing reserve > ${contextWindow}. Reduce Recent Dialogue or the scene and memory budget.`, {
			model, endpoint, durationMs: Date.now() - startTime, promptChars: inputChars, statusCode: 413, retryCount: 0, attempts: [],
		});
	}
	const headers = useAnthropic
		? anthropicHeaders(options.profile)
		: useGoogleAgentPlatform
			? { 'Content-Type': 'application/json', ...await getGoogleAgentPlatformHeaders() }
			: openAiHeaders(options.profile);
	const cooldownKey = providerCooldownKey(options.profile, endpoint);
	const attempts: ServerGenerationAttempt[] = [];
	for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
		const errorResult = () => ({ model, endpoint, durationMs: Date.now() - startTime, promptChars: inputChars, retryCount: attempt, attempts: [...attempts] });
		if (requestSignal?.aborted) throw new ServerGenerationError('Server LLM request cancelled.', errorResult());
		const coolingUntil = providerCooldowns.get(cooldownKey) ?? 0;
		if (coolingUntil > Date.now()) throw new ServerGenerationError('Provider cooling down after a rate limit; retry later.', {
			...errorResult(), statusCode: 429, retryAfterMs: coolingUntil - Date.now(),
		});
		const abort = makeGenerationAbortSignal(timeoutMs, requestSignal);
		let receipt: ServerGenerationAttempt | undefined;
		let responseReceived = false;
		let receiptCompleted = false;
		const finishAttempt = async (status: 'success' | 'error', error?: unknown) => {
			if (!receipt || receiptCompleted) return;
			receiptCompleted = true;
			receipt.status = status;
			receipt.error = error == null ? null : generationErrorMessage(error, timeoutMs);
			receipt.durationMs = Math.max(0, Date.now() - Date.parse(receipt.startedAt));
			attempts.push(structuredClone(receipt));
			try { await options.onAttempt?.(structuredClone(receipt)); } catch (error) {
				throw new ServerGenerationError(`Provider attempt receipt could not be persisted: ${generationErrorMessage(error, timeoutMs)}`, { ...errorResult(), usage: receipt.usage, responseChars: receipt.responseChars ?? undefined, finishReason: receipt.finishReason });
			}
		};
		try {
			const request = { body, serializedBody, inputTokens: requestTokens, reservedOutputTokens: reservedOutput, contextWindowTokens: contextWindow };
			const scopedComplete = scopedHooks ? await scopedHooks.beforeRequest(options, request) : undefined;
			if (options.onBeforeRequest) await options.onBeforeRequest(request);
			if (abort.signal.aborted) throw abort.signal.reason ?? new Error('Server LLM request cancelled.');
			receipt = { attemptId: `provider_attempt_${randomUUID()}`, providerRequestId: null, billingRequestId: null, completionId: null,
				requestHash: createHash('sha256').update(serializedBody).digest('hex'), attempt, startedAt: new Date().toISOString(),
				model, endpoint: (() => { const clean = new URL(endpoint); clean.username = ''; clean.password = ''; clean.search = ''; clean.hash = ''; return clean.toString(); })(), status: 'error', statusCode: null, durationMs: 0, promptChars: inputChars,
				responseChars: null, finishReason: null, usage: emptyServerGenerationUsage(), error: null };
			const response = await fetch(endpoint, { method: 'POST', headers, body: serializedBody, signal: abort.signal });
			responseReceived = true;
			receipt.statusCode = response.status;
			receipt.billingRequestId = response.headers.get('x-request-id');
			receipt.providerRequestId = receipt.billingRequestId ?? response.headers.get('request-id');
			try {
				await options.onResponseHeaders?.({attemptId:receipt.attemptId,requestHash:receipt.requestHash,billingRequestId:receipt.billingRequestId,statusCode:response.status});
			} catch (error) {
				throw new ServerGenerationError(`Provider response headers could not be persisted: ${generationErrorMessage(error, timeoutMs)}`, errorResult());
			}
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				try {
					const data = JSON.parse(text);
					receipt.usage = usageFromResponse(data, useAnthropic);
					receipt.completionId = optionalString(asRecord(data).id);
					receipt.providerRequestId = receipt.billingRequestId ?? receipt.completionId ?? receipt.providerRequestId;
				} catch { /* The provider may return plain text and no usage. */ }
				const retryDelay = (response.status === 429 || response.headers.has('Retry-After'))
					? retryAfterMs(response.headers.get('Retry-After'), response.status) : 0;
				if (retryDelay) providerCooldowns.set(cooldownKey, Date.now() + retryDelay);
				throw new ServerGenerationError(`Server LLM request failed (${response.status}): ${text || response.statusText}`, {
					...errorResult(), statusCode: response.status, ...(retryDelay ? { retryAfterMs: retryDelay } : {}),
				});
			}
			const streamed = shouldStream && options.onTextDelta
				? await readStreamingText(response, useAnthropic, options.onTextDelta, startTime, state => {
					receipt!.usage = state.usage; receipt!.finishReason = state.finishReason;
					receipt!.responseChars = state.text.length;
					receipt!.completionId = state.providerRequestId ?? receipt!.completionId;
					receipt!.providerRequestId = receipt!.billingRequestId ?? receipt!.completionId ?? receipt!.providerRequestId;
				}) : null;
			const data = streamed ? null : await response.json();
			// Preserve returned accounting before parsing/validating tool arguments.
			receipt.usage = streamed ? streamed.usage : usageFromResponse(data, useAnthropic);
			receipt.finishReason = streamed ? streamed.finishReason : finishReasonFromResponse(data, useAnthropic);
			receipt.completionId = (streamed ? streamed.providerRequestId : optionalString(asRecord(data).id)) ?? receipt.completionId;
			receipt.providerRequestId = receipt.billingRequestId ?? receipt.completionId ?? receipt.providerRequestId;
			const text = streamed ? streamed.text.trim() : useAnthropic
				? (data.content ?? []).map((block: { text?: string }) => block.text ?? '').join('').trim()
				: String(data.choices?.[0]?.message?.content ?? '').trim();
			receipt.responseChars = text.length;
			const toolCalls: NativeToolCall[] = streamed ? [] : useAnthropic
				? (data.content ?? []).filter((block: { type?: string }) => block.type === 'tool_use').map((block: { id: string; name: string; input: Record<string, unknown> }) => ({ id: block.id, name: block.name, arguments: block.input }))
				: (data.choices?.[0]?.message?.tool_calls ?? []).map((call: { id: string; function: { name: string; arguments: string } }) => ({ id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) }));
			if (toolCalls.some(call => !call.id || !call.name || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments))) throw new Error('Provider returned an invalid tool call.');
			const native = streamed || useAnthropic ? {} : asRecord(data.choices?.[0]?.message);
			const providerContinuation = useAnthropic && !streamed ? { anthropicContent: data.content ?? [] }
				: Object.fromEntries(['reasoning_content', 'reasoning', 'reasoning_details'].filter(key => native[key] != null).map(key => [key, native[key]]));
			await finishAttempt('success');
			const result: ServerGenerationResult = {
				text, message: { role: 'assistant', content: text, ...(toolCalls.length ? { toolCalls } : {}), ...(Object.keys(providerContinuation).length ? { providerContinuation } : {}) },
				...(toolCalls.length ? { toolCalls } : {}), ...errorResult(), finishReason: receipt.finishReason,
				timeToFirstTokenMs: streamed?.timeToFirstTokenMs ?? null, responseChars: text.length, usage: receipt.usage,
			};
			if (abort.signal.aborted) throw abort.signal.reason ?? new Error('Server LLM request cancelled.');
			await scopedComplete?.(result);
			return result;
		} catch (error) {
			await finishAttempt('error', error);
			const wrapped = new ServerGenerationError(generationErrorMessage(error, timeoutMs), {
				...(error instanceof ServerGenerationError ? error.result : {}), ...errorResult(),
				...(receipt ? { usage: receipt.usage, responseChars: receipt.responseChars ?? undefined, finishReason: receipt.finishReason } : {}),
			});
			// Retry known transient HTTP failures or a failed network dispatch. A malformed
			// completed response / validation or receipt failure must not buy another call.
			const transient = error instanceof ServerGenerationError
				? isTransientStatus(error.result.statusCode) && !error.result.retryAfterMs
				: false;
			const networkFailure = Boolean(receipt && !responseReceived && !isTimeoutError(error));
			if (attempt < maxRetries && !requestSignal?.aborted && !abort.signal.aborted && (transient || networkFailure)) continue;
			throw wrapped;
		} finally { abort.cleanup(); }
	}
	throw new ServerGenerationError('Server LLM request failed without a provider response.', {
		model, endpoint, durationMs: Date.now() - startTime, promptChars: inputChars, retryCount: maxRetries, attempts,
	});
}

export { usageFromResponse as normalizeServerProviderUsage };

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
