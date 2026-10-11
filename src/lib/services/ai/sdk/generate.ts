/**
 * AI Generation — Mtherios
 * 
 * Browser-side model calls for the remaining client assistants: player
 * suggestions, story setup assistance and player-plan structuring. Story turns,
 * extraction and summaries run on the server.
 * Uses the active provider profile from settings.
 */

import { getSetting } from '$lib/services/database';
import { uuid } from '$lib/utils/uuid';
import { PROVIDERS } from './providers/config';
import { isDeepSeekProvider, isDeepSeekReasoner } from './providers/deepseekInjection';
import type { APIProfile, ProviderType } from '$lib/types';

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
}

export interface GenerateOptions {
	system: string;
	prompt: string;
	/** Optional conversation history — inserted between system and final user prompt */
	messages?: ChatMessage[];
	model?: string;
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	/** Optional API profile ID — routes this request to a specific provider/key */
	profileId?: string;
	/**
	 * Optional dynamic suffix appended to the system prompt. When present and the
	 * provider is Anthropic, the request is sent as two text blocks with a
	 * cache_control breakpoint between them, so the (stable) `system` half is
	 * cached across turns. OpenAI-compatible providers don't support this and
	 * receive the two halves concatenated.
	 */
	systemDynamic?: string;
	/**
	 * If set to `'json_object'`, requests a strict-JSON response from
	 * OpenAI-compatible providers (sent as `response_format: { type: 'json_object' }`).
	 * Anthropic ignores this — it uses tools for structured output instead.
	 * Required by deepseek-reasoner to reliably emit JSON; recommended for any
	 * service whose response is parsed as JSON.
	 */
	responseFormat?: 'json_object';
}

// ── API Log ──
export interface APILogEntry {
	id: string;
	timestamp: number;
	service: string;
	model: string;
	system: string;
	prompt: string;
	/** Conversation history messages (if used) */
	conversationHistory?: ChatMessage[];
	response: string;
	temperature: number;
	maxTokens: number;
	durationMs: number;
	error?: string;
	tokenEstimate?: number;
}

// ── Always-on API log (clears on page reload) ──
const _apiLog: APILogEntry[] = [];
const _apiLogListeners: Array<() => void> = [];

export function getApiLog(): APILogEntry[] { return _apiLog; }
export function clearApiLog() { _apiLog.length = 0; _apiLogListeners.forEach(fn => fn()); }
export function onApiLogChange(fn: () => void) { _apiLogListeners.push(fn); return () => { const i = _apiLogListeners.indexOf(fn); if (i >= 0) _apiLogListeners.splice(i, 1); }; }

function addLogEntry(entry: APILogEntry) {
	_apiLog.push(entry);
	_apiLogListeners.forEach(fn => fn());
}

/**
 * Detect if a key is an Anthropic OAuth setup-token (sk-ant-oat-*).
 */
function isOAuthToken(apiKey: string): boolean {
	return apiKey.startsWith('sk-ant-oat-');
}

/**
 * Check if a profile targets the Anthropic Messages API shape (native or
 * the cc-bridge proxy). Both speak `/v1/messages` and accept `x-api-key`.
 */
function isAnthropicProvider(profile: APIProfile): boolean {
	return profile.providerType === 'anthropic' || profile.providerType === 'anthropic-proxy';
}

/**
 * OpenRouter accepts OpenAI-shaped multipart message content with
 * `cache_control: { type: 'ephemeral' }` markers. For Anthropic-routed
 * models the markers turn into prompt-cache breakpoints (up to 4); for
 * other backends (OpenAI, Gemini, DeepSeek via OpenRouter) the field is
 * ignored and caching happens automatically server-side.
 *
 * DeepSeek (called directly) caches automatically based on prefix
 * matching — no client-side markers needed.
 */
function supportsOpenRouterStyleCaching(profile: APIProfile): boolean {
	return profile.providerType === 'openrouter';
}

/**
 * Build a system message that's safe to send to an OpenAI-compatible
 * provider. When `systemDynamic` is present and the provider supports
 * cache_control on multipart content (OpenRouter), emit two text parts
 * with a cache breakpoint after the stable half. Otherwise fall back to
 * a single concatenated string.
 */
function buildOAISystemMessage(
	profile: APIProfile,
	systemStable: string,
	systemDynamic?: string,
): { role: 'system'; content: any } {
	if (systemDynamic && systemDynamic.length > 0 && systemStable.length > 0 && supportsOpenRouterStyleCaching(profile)) {
		return {
			role: 'system',
			content: [
				{ type: 'text', text: systemStable, cache_control: { type: 'ephemeral' } },
				{ type: 'text', text: systemDynamic },
			],
		};
	}
	const combined = systemDynamic ? `${systemStable}\n\n${systemDynamic}` : systemStable;
	return { role: 'system', content: combined };
}

/**
 * Strip `<think>...</think>` blocks (and stray opening tags) that some
 * OpenRouter / aggregator routes leak into `message.content` for reasoning
 * models. The native DeepSeek API keeps reasoning in `reasoning_content`
 * instead, so this is a no-op there. Safe to run on any provider's content.
 */
export function stripThinkTags(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/gi, '')
		.replace(/<think>[\s\S]*$/i, '')
		.trim();
}

/**
 * Best-effort JSON extractor for OpenAI-shaped responses where the model
 * returned a JSON payload as prose (code-fenced, surrounded by commentary,
 * or with leaked `<think>` blocks). Returns the parsed value or null.
 *
 * Handles, in order: raw JSON, code-fenced JSON, `<think>`-prefixed JSON,
 * and the first balanced `{...}` slice in the text.
 */
export function parseJsonFromText(raw: string): unknown {
	const stripped = stripThinkTags(raw).trim();
	if (!stripped) return null;

	const tryParse = (s: string): unknown => {
		try { return JSON.parse(s); } catch { return undefined; }
	};

	const direct = tryParse(stripped);
	if (direct !== undefined) return direct;

	const fence = stripped.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fence) {
		const fenced = tryParse(fence[1].trim());
		if (fenced !== undefined) return fenced;
	}

	// Walk to the first '{' or '[' and slice out a balanced run.
	const objStart = stripped.indexOf('{');
	const arrStart = stripped.indexOf('[');
	const candidates = [objStart, arrStart].filter(i => i >= 0).sort((a, b) => a - b);
	for (const start of candidates) {
		const open = stripped[start];
		const close = open === '{' ? '}' : ']';
		let depth = 0;
		let inString = false;
		let escape = false;
		for (let i = start; i < stripped.length; i++) {
			const c = stripped[i];
			if (escape) { escape = false; continue; }
			if (inString) {
				if (c === '\\') escape = true;
				else if (c === '"') inString = false;
				continue;
			}
			if (c === '"') { inString = true; continue; }
			if (c === open) depth++;
			else if (c === close) {
				depth--;
				if (depth === 0) {
					const slice = stripped.slice(start, i + 1);
					const parsed = tryParse(slice);
					if (parsed !== undefined) return parsed;
					break;
				}
			}
		}
	}

	return null;
}

/**
 * Build auth headers for OpenAI-compatible APIs.
 */
function buildAuthHeaders(profile: APIProfile): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (profile.apiKey) {
		headers['Authorization'] = `Bearer ${profile.apiKey}`;
	}
	return headers;
}

/**
 * Build auth headers for Anthropic Messages API.
 * OAuth tokens use Authorization: Bearer; API keys use x-api-key.
 */
function buildAnthropicHeaders(profile: APIProfile): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'anthropic-version': '2023-06-01',
	};
	if (isOAuthToken(profile.apiKey)) {
		headers['Authorization'] = `Bearer ${profile.apiKey}`;
		headers['anthropic-beta'] = 'oauth-2025-04-01';
	} else {
		headers['x-api-key'] = profile.apiKey;
	}
	return headers;
}

/**
 * Convert OpenAI-style messages to Anthropic Messages API format.
 * Extracts system prompt, ensures alternating user/assistant.
 */
function toAnthropicBody(
	systemPrompt: string,
	messages: Array<{ role: string; content: string }>,
	model: string,
	temperature: number,
	maxTokens: number,
): Record<string, any> {
	// Filter out system messages — Anthropic uses a separate system field
	const nonSystemMessages = messages.filter(m => m.role !== 'system');

	// Ensure first message is user (Anthropic requires it)
	if (nonSystemMessages.length > 0 && nonSystemMessages[0].role !== 'user') {
		nonSystemMessages.unshift({ role: 'user', content: '(continue)' });
	}

	// Merge consecutive same-role messages (Anthropic doesn't allow them)
	const merged: Array<{ role: string; content: string }> = [];
	for (const msg of nonSystemMessages) {
		const last = merged[merged.length - 1];
		if (last && last.role === msg.role) {
			last.content += '\n\n' + msg.content;
		} else {
			merged.push({ ...msg });
		}
	}

	return {
		model,
		system: systemPrompt,
		messages: merged,
		max_tokens: maxTokens,
		temperature,
		stream: false,
	};
}

async function getActiveProfile(overrideProfileId?: string): Promise<{ profile: APIProfile; baseUrl: string }> {
	const profilesJson = await getSetting('apiProfiles');
	const activeProfileId = await getSetting('activeProfileId');

	if (!profilesJson) throw new Error('No API profiles configured. Please set up a provider in Settings.');

	const profiles: APIProfile[] = JSON.parse(profilesJson);

	// If a specific profile is requested, use it; otherwise fall back to active profile
	let profile: APIProfile | undefined;
	if (overrideProfileId) {
		profile = profiles.find(p => p.id === overrideProfileId);
	}
	if (!profile) {
		profile = activeProfileId
			? profiles.find(p => p.id === activeProfileId) ?? profiles[0]
			: profiles[0];
	}

	if (!profile) throw new Error('No API profile found.');

	const providerConfig = PROVIDERS[profile.providerType as ProviderType];
	const baseUrl = profile.baseUrl || providerConfig?.baseUrl || 'https://api.openai.com/v1';

	return { profile, baseUrl };
}

/**
 * Get the active model for narrative generation.
 */
export async function getActiveModel(profileId?: string): Promise<string> {
	if (!profileId) {
		const modelOverride = await getSetting('narrativeModel');
		if (modelOverride) return modelOverride;
	}

	const { profile } = await getActiveProfile(profileId);
	const providerConfig = PROVIDERS[profile.providerType as ProviderType];
	
	// Use provider's narrative service default, or first fallback model
	return providerConfig?.services?.narrative?.model
		?? providerConfig?.fallbackModels?.[0]
		?? 'gpt-4o-mini';
}

/**
 * Generate a complete (non-streaming) response.
 * If options.model is set, uses that model. Otherwise falls back to getActiveModel().
 */
export async function generateNarrative(options: GenerateOptions): Promise<string> {
	const { profile, baseUrl } = await getActiveProfile(options.profileId);
	const model = options.model || await getActiveModel(options.profileId);
	const temperature = options.temperature ?? 1.0;
	const maxTokens = options.maxTokens ?? 4096;
	const startTime = Date.now();
	const useAnthropic = isAnthropicProvider(profile);

	// Build messages array
	const messages: Array<{ role: string; content: string }> = [];
	if (!useAnthropic) {
		messages.push({ role: 'system', content: options.system });
	}
	if (options.messages?.length) {
		for (const msg of options.messages) {
			messages.push({ role: msg.role, content: msg.content });
		}
	}
	messages.push({ role: 'user', content: options.prompt });

	const endpoint = useAnthropic
		? `${baseUrl || '/api/anthropic'}/v1/messages`
		: `${baseUrl}/chat/completions`;
	const headers = useAnthropic ? buildAnthropicHeaders(profile) : buildAuthHeaders(profile);
	let body: Record<string, any>;
	if (useAnthropic) {
		body = toAnthropicBody(options.system, messages, model, temperature, maxTokens);
	} else {
		body = { model, messages, temperature, max_tokens: maxTokens };
		// JSON output mode — required to get reliable JSON out of deepseek-reasoner
		// (which otherwise drifts into prose mid-thinking and emits empty content).
		// Per DeepSeek docs the prompt must also contain the word "json"; callers
		// using this flag (BaseAIService.generateStructured) already do.
		if (options.responseFormat === 'json_object') {
			body.response_format = { type: 'json_object' };
		}
	}

	let responseText = '';
	let error: string | undefined;

	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: options.signal,
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => 'Unknown error');
			error = `HTTP ${response.status}: ${errorText}`;
			throw new Error(`AI request failed (${response.status}): ${errorText}`);
		}

		const data = await response.json();
		if (useAnthropic) {
			// Anthropic: content is an array of blocks
			responseText = data.content?.map((b: any) => b.text ?? '').join('') ?? '';
		} else {
			responseText = data.choices?.[0]?.message?.content ?? '';
		}
		return responseText;
	} catch (err) {
		error = error || (err instanceof Error ? err.message : String(err));
		throw err;
	} finally {
		const historyLength = options.messages?.reduce((sum, m) => sum + m.content.length, 0) ?? 0;
		addLogEntry({
			id: uuid(),
			timestamp: Date.now(),
			service: (options as any)._service || 'narrative',
			model,
			system: options.system,
			prompt: options.prompt,
			conversationHistory: options.messages,
			response: responseText,
			temperature,
			maxTokens,
			durationMs: Date.now() - startTime,
			error,
			tokenEstimate: Math.ceil((options.system.length + historyLength + options.prompt.length + responseText.length) / 4),
		});
	}
}

// ── Tool call types ──

export interface ToolCall {
	name: string;
	arguments: Record<string, any>;
	/**
	 * Provider-issued tool call id. Required by the OpenAI/DeepSeek
	 * multi-round protocol when sending tool result messages back. Anthropic
	 * also emits ids on tool_use blocks. Empty when synthesized from inline
	 * fallback parsers.
	 */
	id?: string;
}

export interface GenerateWithToolsOptions extends GenerateOptions {
	tools: any[];
	/** Force a specific tool to be called */
	forceTool?: string;
}

export interface ToolCallResult {
	content: string;
	toolCalls: ToolCall[];
}

/**
 * Generate a response with tool call support (non-streaming).
 * Used for the orchestrator's world-state update call.
 */
export async function generateStructuredWithTools(options: GenerateWithToolsOptions): Promise<ToolCallResult> {
	const { profile, baseUrl } = await getActiveProfile(options.profileId);
	const model = options.model || await getActiveModel(options.profileId);
	const temperature = options.temperature ?? 0.2;
	const maxTokens = options.maxTokens ?? 4096;
	const startTime = Date.now();
	const useAnthropic = isAnthropicProvider(profile);
	// deepseek-chat/V3 routinely emits malformed or missing tool_calls when
	// `tool_choice` is forced against a complex schema like
	// `update_world_state`, so we still route it through JSON output mode.
	// deepseek-reasoner now supports OpenAI-style tool calling in thinking
	// mode (https://api-docs.deepseek.com/guides/thinking_mode) and is sent
	// real tools. This is single-shot — no `reasoning_content` round-trip
	// is needed because the caller doesn't re-prompt the assistant turn.
	const useJsonModeForDeepSeek = !useAnthropic
		&& isDeepSeekProvider(profile, model)
		&& !isDeepSeekReasoner(profile, model)
		&& !!options.forceTool;

	const endpoint = useAnthropic
		? `${baseUrl || '/api/anthropic'}/v1/messages`
		: `${baseUrl}/chat/completions`;
	const headers = useAnthropic ? buildAnthropicHeaders(profile) : buildAuthHeaders(profile);

	let body: Record<string, any>;
	let responseText = '';
	let error: string | undefined;
	const toolCalls: ToolCall[] = [];

	// Resolve the schema of the forced tool — used both to build the JSON-mode
	// prompt for DeepSeek and as fallback context.
	const forcedToolSchema = options.forceTool
		? options.tools.find((t: any) => (t.function?.name ?? t.name) === options.forceTool)
		: undefined;

	if (useAnthropic) {
		// Anthropic Messages API with tools
		const messages: Array<{ role: string; content: string }> = [];
		if (options.messages?.length) {
			for (const msg of options.messages) messages.push({ role: msg.role, content: msg.content });
		}
		messages.push({ role: 'user', content: options.prompt });

		// Convert tools to Anthropic format
		const anthropicTools = options.tools.map((t: any) => ({
			name: t.function?.name ?? t.name,
			description: t.function?.description ?? t.description,
			input_schema: t.function?.parameters ?? t.input_schema,
		}));

		body = {
			model,
			system: options.system,
			messages: messages.length > 0 && messages[0].role !== 'user'
				? [{ role: 'user', content: '(continue)' }, ...messages]
				: messages,
			max_tokens: maxTokens,
			temperature,
			tools: anthropicTools,
			tool_choice: options.forceTool
				? { type: 'tool', name: options.forceTool }
				: { type: 'any' },
		};
	} else if (useJsonModeForDeepSeek) {
		// JSON-output path for DeepSeek (chat + reasoner). The schema goes into
		// the system prompt so the model knows the shape; `response_format`
		// forces strict JSON emission. The word "json" is required to be in the
		// prompt per DeepSeek's JSON mode spec, which the augmented system
		// supplies.
		const schemaSpec = forcedToolSchema?.function?.parameters ?? forcedToolSchema?.input_schema;
		const augmentedSystem =
			`${options.system}\n\n` +
			`You MUST respond with a single valid JSON object matching the schema for ` +
			`the \`${options.forceTool}\` tool. Do not include any prose, code fences, ` +
			`or commentary — just the raw JSON object.\n\n` +
			(schemaSpec
				? `JSON schema:\n${JSON.stringify(schemaSpec, null, 2)}`
				: '');
		const oaiMessages: Array<{ role: string; content: any }> = [
			buildOAISystemMessage(profile, augmentedSystem, options.systemDynamic),
		];
		if (options.messages?.length) {
			for (const msg of options.messages) oaiMessages.push({ role: msg.role, content: msg.content });
		}
		oaiMessages.push({ role: 'user', content: options.prompt });

		body = {
			model,
			messages: oaiMessages,
			temperature,
			max_tokens: maxTokens,
			response_format: { type: 'json_object' },
		};
	} else {
		// OpenAI-compatible with tools: send a multipart system message with
		// cache_control on OpenRouter.
		const oaiMessages: Array<{ role: string; content: any }> = [
			buildOAISystemMessage(profile, options.system, options.systemDynamic),
		];
		if (options.messages?.length) {
			for (const msg of options.messages) oaiMessages.push({ role: msg.role, content: msg.content });
		}
		oaiMessages.push({ role: 'user', content: options.prompt });

		body = {
			model,
			messages: oaiMessages,
			temperature,
			max_tokens: maxTokens,
			tools: options.tools,
			tool_choice: options.forceTool
				? { type: 'function', function: { name: options.forceTool } }
				: 'auto',
		};
		if (profile.providerType === 'openrouter') {
			body.usage = { include: true };
		}
	}

	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: options.signal,
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => 'Unknown error');
			error = `HTTP ${response.status}: ${errorText}`;
			throw new Error(`AI request failed (${response.status}): ${errorText}`);
		}

		const data = await response.json();

		if (useAnthropic) {
			// Anthropic: content is an array of blocks (text and tool_use)
			for (const block of data.content ?? []) {
				if (block.type === 'text') {
					responseText += block.text ?? '';
				} else if (block.type === 'tool_use') {
					toolCalls.push({
						name: block.name,
						arguments: block.input ?? {},
						id: block.id,
					});
				}
			}
		} else {
			// OpenAI: message.content + message.tool_calls.
			// Coerce content to string — some OpenAI-compatible providers stuff
			// non-string payloads (objects, nulls) when tool_calls are present.
			const message = data.choices?.[0]?.message;
			responseText = typeof message?.content === 'string' ? message.content : '';
			if (Array.isArray(message?.tool_calls)) {
				for (const tc of message.tool_calls) {
					// Some providers (cc-bridge, certain OpenRouter routes) emit
					// `tool_calls` entries without a fully-formed `function` block.
					// Skip those rather than throw — the world update can still
					// recover via the JSON-from-prose fallback below.
					const name = tc?.function?.name;
					if (typeof name !== 'string' || !name) continue;
					const rawArgs = tc?.function?.arguments;
					let args: Record<string, any> = {};
					try {
						args = typeof rawArgs === 'string'
							? (rawArgs ? JSON.parse(rawArgs) : {})
							: (rawArgs ?? {});
					} catch {
						console.error('[generateStructuredWithTools] Failed to parse tool call args:', rawArgs);
					}
					toolCalls.push({ name, arguments: args, id: tc?.id });
				}
			}
		}

		// Fallback: if no tool calls found, parse JSON from response text. Handles
		// the deepseek-reasoner JSON-mode branch above plus any provider that
		// emits structured output as prose. Strips `<think>` blocks that some
		// proxies leak into content, then extracts the first balanced JSON object.
		if (toolCalls.length === 0 && responseText.trim()) {
			const parsed = parseJsonFromText(responseText);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				toolCalls.push({
					name: options.forceTool ?? 'update_world_state',
					arguments: parsed as Record<string, any>,
				});
			} else {
				console.warn('[generateStructuredWithTools] Could not parse JSON fallback from response text');
			}
		}

		// Canonicalize tool names when forceTool is set. Some providers (GLM 5.1
		// observed) emit truncated or malformed tool names like `update` instead
		// of `update_world_state`. Since we forced one specific tool, any call
		// returned IS that tool — rewrite the name so the executor's switch
		// matches and the arguments aren't dropped on the floor.
		if (options.forceTool) {
			const knownNames = new Set(options.tools.map((t: any) => t.function?.name ?? t.name));
			for (const tc of toolCalls) {
				if (!knownNames.has(tc.name)) {
					console.warn(`[generateStructuredWithTools] Renaming malformed tool call "${tc.name}" → "${options.forceTool}"`);
					tc.name = options.forceTool;
				}
			}
		}

		return { content: responseText, toolCalls };
	} catch (err) {
		error = error || (err instanceof Error ? err.message : String(err));
		throw err;
	} finally {
		const historyLength = options.messages?.reduce((sum, m) => sum + m.content.length, 0) ?? 0;
		addLogEntry({
			id: uuid(),
			timestamp: Date.now(),
			service: (options as any)._service || 'world-update',
			model,
			system: options.system,
			prompt: options.prompt,
			conversationHistory: options.messages,
			response: responseText + (toolCalls.length > 0 ? `\n[Tool calls: ${toolCalls.map(t => t.name).join(', ')}]` : ''),
			temperature,
			maxTokens,
			durationMs: Date.now() - startTime,
			error,
			tokenEstimate: Math.ceil((options.system.length + historyLength + options.prompt.length + responseText.length) / 4),
		});
	}
}
