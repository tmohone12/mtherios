/**
 * AI Generation — Mtherios
 * 
 * Lightweight wrapper around fetch for streaming narrative generation.
 * Uses the active provider profile from settings.
 */

import { getSetting } from '$lib/services/database';
import { uuid } from '$lib/utils/uuid';
import { PROVIDERS } from './providers/config';
import { isDeepSeekProvider, isDeepSeekReasoner, injectDeepSeekRoleplay } from './providers/deepseekInjection';
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
	 * Tools the model is allowed to call inline during generation. When present,
	 * `streamNarrative` will yield `StreamChunk`s with a `toolCall` field as
	 * each tool block completes, in addition to the usual text deltas.
	 */
	tools?: any[];
	/** If set, biases / forces the model to call this specific tool. */
	forceTool?: string;
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

export interface StreamChunk {
	content: string;
	reasoning?: string;
	/** Emitted when an inline tool call completes mid-stream. */
	toolCall?: ToolCall;
	done: boolean;
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
 * iOS Safari (incl. iPadOS) drops chunked-streamed fetch responses through
 * Cloudflare after a few seconds with a generic "Load failed". For the
 * cc-bridge proxy specifically we fall back to non-streaming on iOS.
 */
function isIOSSafari(): boolean {
	if (typeof navigator === 'undefined') return false;
	const ua = navigator.userAgent;
	if (/iPad|iPhone|iPod/.test(ua)) return true;
	// iPadOS 13+ reports as Mac; disambiguate via touch points.
	return ua.includes('Mac') && (navigator as any).maxTouchPoints > 1;
}

/**
 * Build auth headers for OpenAI-compatible APIs.
 */
function buildAuthHeaders(profile: APIProfile): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${profile.apiKey}`,
	};
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
 *
 * When `systemDynamic` is provided, the system prompt is sent as two
 * `{type:'text'}` blocks with a `cache_control: { type: 'ephemeral' }`
 * breakpoint between them. The stable half (the static narrator personality)
 * is cached across turns; the dynamic half (per-turn world state) is not.
 */
function toAnthropicBody(
	systemPrompt: string,
	messages: Array<{ role: string; content: string }>,
	model: string,
	temperature: number,
	maxTokens: number,
	stream: boolean,
	systemDynamic?: string,
	tools?: any[],
	forceTool?: string,
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

	// Two-block form is only useful when BOTH halves have content. Anthropic
	// rejects empty text blocks, and an empty stable block can't be cached
	// anyway. Fall back to the single-string form if either is empty.
	const useSplitSystem = !!(systemDynamic && systemDynamic.length > 0 && systemPrompt.length > 0);
	const system = useSplitSystem
		? [
			{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
			{ type: 'text', text: systemDynamic },
		]
		: (systemDynamic ? `${systemPrompt}\n\n${systemDynamic}` : systemPrompt);

	const body: Record<string, any> = {
		model,
		system,
		messages: merged,
		max_tokens: maxTokens,
		temperature,
		stream,
	};

	if (tools && tools.length > 0) {
		body.tools = tools.map((t: any) => ({
			name: t.function?.name ?? t.name,
			description: t.function?.description ?? t.description,
			input_schema: t.function?.parameters ?? t.input_schema,
		}));
		body.tool_choice = forceTool
			? { type: 'tool', name: forceTool }
			: { type: 'auto' };
	}

	return body;
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
	const modelOverride = await getSetting('narrativeModel');
	if (modelOverride) return modelOverride;

	const { profile } = await getActiveProfile(profileId);
	const providerConfig = PROVIDERS[profile.providerType as ProviderType];
	
	// Use provider's narrative service default, or first fallback model
	return providerConfig?.services?.narrative?.model
		?? providerConfig?.fallbackModels?.[0]
		?? 'gpt-4o-mini';
}

/**
 * Stream a narrative response from the active provider.
 * Returns an async generator of StreamChunks.
 */
export async function* streamNarrative(options: GenerateOptions): AsyncGenerator<StreamChunk> {
	const { profile, baseUrl } = await getActiveProfile(options.profileId);
	const model = options.model || await getActiveModel(options.profileId);
	const temperature = options.temperature ?? 1.0;
	const maxTokens = options.maxTokens ?? 4096;
	const startTime = Date.now();
	let fullContent = '';
	let error: string | undefined;
	const useAnthropic = isAnthropicProvider(profile);
	// iOS Safari + cc-bridge: chunked SSE through Cloudflare dies after a few
	// seconds with "Load failed". Send a non-streaming request and yield the
	// full text as a single chunk at the end.
	const useStream = !(isIOSSafari() && profile.providerType === 'anthropic-proxy');

	// Combined system prompt for OpenAI-compatible providers (used for the
	// Anthropic-bound message construction below and for log entries).
	const combinedSystem = options.systemDynamic
		? `${options.system}\n\n${options.systemDynamic}`
		: options.system;

	// DeepSeek roleplay injection — when targeting a DeepSeek model, the
	// first user message gets a Chinese instruction block that flips the
	// `<think>` content from analytical CoT into in-character inner monologue.
	const priorMessages = options.messages ?? [];
	const { messages: roleplayMessages, prompt: roleplayPrompt } = isDeepSeekProvider(profile, model)
		? injectDeepSeekRoleplay(priorMessages, options.prompt)
		: { messages: priorMessages, prompt: options.prompt };

	// deepseek-reasoner doesn't reliably honor OpenAI-style function calling.
	// Strip tools so the narrator emits prose only; the orchestrator will fall
	// through to the separate `executeWorldUpdate` call (which detects reasoner
	// and uses JSON output mode instead). Without this, the reasoner sometimes
	// returns an empty response while "thinking", killing the turn entirely.
	const skipToolsForReasoner = isDeepSeekReasoner(profile, model);
	const effectiveTools = skipToolsForReasoner ? undefined : options.tools;
	const effectiveForceTool = skipToolsForReasoner ? undefined : options.forceTool;

	// Build messages array (Anthropic body builder strips the system role)
	const messages: Array<{ role: string; content: string }> = [];
	if (!useAnthropic) {
		messages.push({ role: 'system', content: combinedSystem });
	}
	for (const msg of roleplayMessages) {
		messages.push({ role: msg.role, content: msg.content });
	}
	messages.push({ role: 'user', content: roleplayPrompt });

	// Build request based on provider
	const endpoint = useAnthropic
		? `${baseUrl || '/api/anthropic'}/v1/messages`
		: `${baseUrl}/chat/completions`;
	const headers = useAnthropic ? buildAnthropicHeaders(profile) : buildAuthHeaders(profile);

	let body: Record<string, any>;
	if (useAnthropic) {
		body = toAnthropicBody(
			options.system, messages, model, temperature, maxTokens, useStream,
			options.systemDynamic, effectiveTools, effectiveForceTool,
		);
	} else {
		// OpenAI-compatible. For OpenRouter we emit a multipart system message
		// with a cache_control breakpoint between the stable and dynamic halves
		// — this enables prompt caching on Anthropic-routed models and is
		// silently ignored by other backends (OpenAI/Gemini/DeepSeek caches
		// automatically). For everyone else we fall back to a single string.
		const oaiMessages: Array<{ role: string; content: any }> = [
			buildOAISystemMessage(profile, options.system, options.systemDynamic),
		];
		for (const msg of roleplayMessages) oaiMessages.push({ role: msg.role, content: msg.content });
		oaiMessages.push({ role: 'user', content: roleplayPrompt });
		body = { model, messages: oaiMessages, stream: useStream, temperature, max_tokens: maxTokens };
		if (effectiveTools && effectiveTools.length > 0) {
			body.tools = effectiveTools;
			body.tool_choice = effectiveForceTool
				? { type: 'function', function: { name: effectiveForceTool } }
				: 'auto';
		}
		if (options.responseFormat === 'json_object') {
			body.response_format = { type: 'json_object' };
		}
		// OpenRouter usage accounting — confirms cache hits in the response.
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

		// Non-streaming branch (iOS + cc-bridge). Parse the full JSON, yield
		// text + tool calls as discrete chunks, then signal done.
		if (!useStream) {
			const { extractInlineToolCalls } = await import('$lib/services/ai/tools/inline-extractor');
			const data = await response.json();
			let textOut = '';
			const collectedToolCalls: ToolCall[] = [];

			if (useAnthropic) {
				for (const block of data.content ?? []) {
					if (block.type === 'text' && typeof block.text === 'string') {
						textOut += block.text;
					} else if (block.type === 'tool_use') {
						collectedToolCalls.push({ name: block.name, arguments: block.input ?? {}, id: block.id });
					}
				}
			} else {
				const message = data.choices?.[0]?.message;
				textOut = typeof message?.content === 'string' ? message.content : '';
				// DeepSeek non-streaming: reasoning_content is on the message object.
				const reasoningOut = typeof message?.reasoning_content === 'string'
					? message.reasoning_content
					: (typeof message?.reasoning === 'string' ? message.reasoning : '');
				if (reasoningOut) {
					yield { content: '', reasoning: reasoningOut, done: false };
				}
				if (Array.isArray(message?.tool_calls)) {
					for (const tc of message.tool_calls) {
						let args: Record<string, any> = {};
						try {
							args = typeof tc.function?.arguments === 'string'
								? JSON.parse(tc.function.arguments)
								: (tc.function?.arguments ?? {});
						} catch {
							console.warn('[streamNarrative] Failed to parse tool args:', tc.function?.arguments);
						}
						collectedToolCalls.push({ name: tc.function?.name ?? '', arguments: args, id: tc.id });
					}
				}
			}

			// If the model only returned text (e.g. cc-bridge didn't forward
			// tool definitions), recover any tool calls embedded in the prose.
			if (collectedToolCalls.length === 0 && textOut) {
				const { cleaned, toolCalls } = extractInlineToolCalls(textOut);
				if (toolCalls.length > 0) {
					textOut = cleaned;
					collectedToolCalls.push(...toolCalls);
				}
			}

			if (textOut) {
				fullContent += textOut;
				yield { content: textOut, done: false };
			}
			for (const tc of collectedToolCalls) {
				yield { content: '', toolCall: tc, done: false };
			}
			yield { content: '', done: true };
			return;
		}

		const reader = response.body?.getReader();
		if (!reader) throw new Error('No response body');

		const decoder = new TextDecoder();
		let buffer = '';

		// Per-block state for tool-call accumulation across SSE events.
		// Anthropic: keyed by content_block index. OpenAI: keyed by tool_calls[i].index.
		type ToolBlock = { name: string; jsonBuffer: string; id?: string };
		const anthropicToolBlocks = new Map<number, ToolBlock>();
		const oaiToolCalls = new Map<number, ToolBlock>();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed === 'data: [DONE]') continue;
					if (trimmed === 'event: message_stop') continue;
					if (!trimmed.startsWith('data: ')) continue;

					try {
						const data = JSON.parse(trimmed.slice(6));

						if (useAnthropic) {
							// content_block_start — register a tool_use block.
							if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
								const idx = data.index ?? 0;
								anthropicToolBlocks.set(idx, {
									name: data.content_block.name ?? '',
									jsonBuffer: '',
									id: data.content_block.id,
								});
							}
							// content_block_delta — text_delta goes to prose, input_json_delta to tool buffer.
							else if (data.type === 'content_block_delta') {
								if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
									fullContent += data.delta.text;
									yield { content: data.delta.text, done: false };
								} else if (data.delta?.type === 'input_json_delta' && typeof data.delta.partial_json === 'string') {
									const idx = data.index ?? 0;
									const block = anthropicToolBlocks.get(idx);
									if (block) block.jsonBuffer += data.delta.partial_json;
								}
							}
							// content_block_stop — if this block was a tool, parse + yield.
							else if (data.type === 'content_block_stop') {
								const idx = data.index ?? 0;
								const block = anthropicToolBlocks.get(idx);
								if (block) {
									anthropicToolBlocks.delete(idx);
									let args: Record<string, any> = {};
									try {
										args = block.jsonBuffer ? JSON.parse(block.jsonBuffer) : {};
									} catch (e) {
										console.warn('[streamNarrative] Failed to parse tool args:', block.jsonBuffer, e);
									}
									yield { content: '', toolCall: { name: block.name, arguments: args, id: block.id }, done: false };
								}
							}
						} else {
							// OpenAI stream: choices[0].delta. Text into prose, tool_calls into tool buffers.
							const delta = data.choices?.[0]?.delta;
							const finishReason = data.choices?.[0]?.finish_reason;

							if (typeof delta?.content === 'string' && delta.content) {
								fullContent += delta.content;
								yield { content: delta.content, done: false };
							}
							// OpenRouter exposes reasoning as `delta.reasoning`; DeepSeek's
							// native API uses `delta.reasoning_content`. Capture both — the
							// latter is required for round-tripping into multi-round tool
							// calls (DeepSeek thinking-mode rejects requests that drop it).
							const reasoningDelta = (typeof delta?.reasoning_content === 'string' && delta.reasoning_content)
								? delta.reasoning_content
								: (typeof delta?.reasoning === 'string' && delta.reasoning ? delta.reasoning : '');
							if (reasoningDelta) {
								yield { content: '', reasoning: reasoningDelta, done: false };
							}
							if (Array.isArray(delta?.tool_calls)) {
								for (const tc of delta.tool_calls) {
									const idx = tc.index ?? 0;
									let block = oaiToolCalls.get(idx);
									if (!block) {
										block = { name: tc.function?.name ?? '', jsonBuffer: '', id: tc.id };
										oaiToolCalls.set(idx, block);
									}
									if (typeof tc.id === 'string' && tc.id) {
										block.id = tc.id;
									}
									if (typeof tc.function?.name === 'string' && tc.function.name) {
										block.name = tc.function.name;
									}
									if (typeof tc.function?.arguments === 'string') {
										block.jsonBuffer += tc.function.arguments;
									}
								}
							}

							// On finish, flush all accumulated tool calls.
							if (finishReason === 'tool_calls' || finishReason === 'stop') {
								for (const block of oaiToolCalls.values()) {
									if (!block.name) continue;
									let args: Record<string, any> = {};
									try {
										args = block.jsonBuffer ? JSON.parse(block.jsonBuffer) : {};
									} catch (e) {
										console.warn('[streamNarrative] Failed to parse tool args:', block.jsonBuffer, e);
									}
									yield { content: '', toolCall: { name: block.name, arguments: args, id: block.id }, done: false };
								}
								oaiToolCalls.clear();
							}
						}
					} catch {
						// Skip malformed JSON lines
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		// Flush any tool calls that weren't yielded because the provider didn't
		// emit a terminating event. OpenAI: stream truncated before
		// finish_reason. Anthropic: stream closed before content_block_stop on
		// a tool_use block. Without this, tool-only responses look like empty
		// responses to the caller.
		if (useAnthropic) {
			if (anthropicToolBlocks.size > 0) {
				for (const block of anthropicToolBlocks.values()) {
					if (!block.name) continue;
					let args: Record<string, any> = {};
					try {
						args = block.jsonBuffer ? JSON.parse(block.jsonBuffer) : {};
					} catch (e) {
						console.warn('[streamNarrative] Failed to parse tool args at stream end:', block.jsonBuffer, e);
					}
					yield { content: '', toolCall: { name: block.name, arguments: args, id: block.id }, done: false };
				}
				anthropicToolBlocks.clear();
			}
		} else if (oaiToolCalls.size > 0) {
			for (const block of oaiToolCalls.values()) {
				if (!block.name) continue;
				let args: Record<string, any> = {};
				try {
					args = block.jsonBuffer ? JSON.parse(block.jsonBuffer) : {};
				} catch (e) {
					console.warn('[streamNarrative] Failed to parse tool args at stream end:', block.jsonBuffer, e);
				}
				yield { content: '', toolCall: { name: block.name, arguments: args, id: block.id }, done: false };
			}
			oaiToolCalls.clear();
		}

		yield { content: '', done: true };
	} catch (err) {
		error = error || (err instanceof Error ? err.message : String(err));
		throw err;
	} finally {
		const historyLength = options.messages?.reduce((sum, m) => sum + m.content.length, 0) ?? 0;
		const fullSystem = options.systemDynamic
			? `${options.system}\n\n${options.systemDynamic}`
			: options.system;
		addLogEntry({
			id: uuid(),
			timestamp: Date.now(),
			service: (options as any)._service || 'narrative',
			model,
			system: fullSystem,
			prompt: options.prompt,
			conversationHistory: options.messages,
			response: fullContent,
			temperature,
			maxTokens,
			durationMs: Date.now() - startTime,
			error,
			tokenEstimate: Math.ceil((fullSystem.length + historyLength + options.prompt.length + fullContent.length) / 4),
		});
	}
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
		body = toAnthropicBody(options.system, messages, model, temperature, maxTokens, false);
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
		// OpenAI-compatible with tools. Mirror streamNarrative caching: send a
		// multipart system message with cache_control on OpenRouter.
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

// ── Multi-round tool continuation ──

export interface ToolRoundResult {
	toolCallId: string | undefined;
	toolName: string;
	content: string;
}

export interface ContinueAfterToolsOptions extends GenerateOptions {
	priorToolCalls: ToolCall[];
	toolResults: ToolRoundResult[];
	/**
	 * DeepSeek thinking-mode requirement: when an assistant turn contained
	 * tool_calls, every subsequent request must include the original
	 * `reasoning_content` on that assistant message. Stripping it produces a
	 * 400 "The reasoning_content in the thinking mode must be passed back".
	 * https://api-docs.deepseek.com/guides/thinking_mode
	 */
	priorReasoningContent?: string;
}

/**
 * Continue a conversation after the model emitted tool_calls, following the
 * DeepSeek / OpenAI multi-round protocol:
 *
 *   user → assistant{tool_calls} → tool{tool_call_id, content} → assistant{prose}
 *
 * Anthropic equivalent uses content blocks (`tool_use`/`tool_result`).
 *
 * Used when the narrator returned tool calls without prose. Re-invokes the
 * model with the proper multi-round context so it can produce the final
 * narration consistent with the world updates it just applied.
 */
export async function continueAfterTools(
	options: ContinueAfterToolsOptions,
	onChunk?: (delta: string, full: string) => void,
): Promise<string> {
	const { profile, baseUrl } = await getActiveProfile(options.profileId);
	const model = options.model || await getActiveModel(options.profileId);
	const temperature = options.temperature ?? 1.0;
	const maxTokens = options.maxTokens ?? 4096;
	const startTime = Date.now();
	const useAnthropic = isAnthropicProvider(profile);
	let fullContent = '';
	let error: string | undefined;

	const endpoint = useAnthropic
		? `${baseUrl || '/api/anthropic'}/v1/messages`
		: `${baseUrl}/chat/completions`;
	const headers = useAnthropic ? buildAnthropicHeaders(profile) : buildAuthHeaders(profile);

	let body: Record<string, any>;

	if (useAnthropic) {
		const priorMessages = options.messages ?? [];
		const messages: Array<{ role: string; content: any }> = [];
		for (const msg of priorMessages) messages.push({ role: msg.role, content: msg.content });
		messages.push({ role: 'user', content: options.prompt });
		messages.push({
			role: 'assistant',
			content: options.priorToolCalls.map(tc => ({
				type: 'tool_use',
				id: tc.id ?? `synth_${Math.random().toString(36).slice(2, 10)}`,
				name: tc.name,
				input: tc.arguments,
			})),
		});
		messages.push({
			role: 'user',
			content: options.toolResults.map(tr => ({
				type: 'tool_result',
				tool_use_id: tr.toolCallId ?? '',
				content: tr.content,
			})),
		});

		const useSplitSystem = !!(options.systemDynamic && options.systemDynamic.length > 0 && options.system.length > 0);
		const system = useSplitSystem
			? [
				{ type: 'text', text: options.system, cache_control: { type: 'ephemeral' } },
				{ type: 'text', text: options.systemDynamic },
			]
			: (options.systemDynamic ? `${options.system}\n\n${options.systemDynamic}` : options.system);

		body = {
			model,
			system,
			messages,
			max_tokens: maxTokens,
			temperature,
			stream: true,
		};
	} else {
		// OpenAI/DeepSeek: assistant message with tool_calls + one tool message
		// per call. DeepSeek requires `tool_call_id` to match the assistant id;
		// when the upstream stream didn't surface an id (synthesized from inline
		// parsers, cc-bridge, etc.) we fabricate stable ones.
		const fabricatedIds = new Map<ToolCall, string>();
		const idFor = (tc: ToolCall, i: number): string => {
			if (tc.id) return tc.id;
			let id = fabricatedIds.get(tc);
			if (!id) {
				id = `call_${i}_${Math.random().toString(36).slice(2, 10)}`;
				fabricatedIds.set(tc, id);
			}
			return id;
		};

		const oaiMessages: Array<{ role: string; content: any; tool_calls?: any[]; tool_call_id?: string; reasoning_content?: string }> = [
			buildOAISystemMessage(profile, options.system, options.systemDynamic),
		];
		const priorMessages = options.messages ?? [];
		for (const msg of priorMessages) oaiMessages.push({ role: msg.role, content: msg.content });
		oaiMessages.push({ role: 'user', content: options.prompt });
		// OpenAI/DeepSeek convention: when an assistant turn carries `tool_calls`,
		// `content` should be `null` (not `""`). Strict-validating gateways
		// (DeepSeek's thinking mode being one) reject empty-string content here.
		const assistantMsg: { role: string; content: any; tool_calls: any[]; reasoning_content?: string } = {
			role: 'assistant',
			content: null,
			tool_calls: options.priorToolCalls.map((tc, i) => ({
				id: idFor(tc, i),
				type: 'function',
				function: {
					name: tc.name,
					arguments: JSON.stringify(tc.arguments ?? {}),
				},
			})),
		};
		// DeepSeek thinking-mode round-trip: every assistant turn that carries
		// tool_calls MUST include a non-empty `reasoning_content` string, or the
		// API rejects the entire request with 400 "The reasoning_content in the
		// thinking mode must be passed back to the API". Detection covers
		// OpenRouter / aggregators that route to a deepseek-* model name too.
		// https://api-docs.deepseek.com/guides/thinking_mode
		if (isDeepSeekProvider(profile, model)) {
			const captured = options.priorReasoningContent?.trim();
			if (captured) {
				assistantMsg.reasoning_content = captured;
			} else {
				// Fallback: streaming parser didn't surface reasoning_content
				// (provider hiccup, non-thinking model, cc-bridge stripped it).
				// A non-empty placeholder is still accepted by DeepSeek and is
				// strictly better than the request 400-ing.
				console.warn(
					'[continueAfterTools] DeepSeek tool-call round-trip is missing captured reasoning_content; sending placeholder so the request does not 400.',
				);
				assistantMsg.reasoning_content =
					'(Reasoning trace was not captured upstream; tool calls were applied verbatim.)';
			}
		}
		oaiMessages.push(assistantMsg);
		for (let i = 0; i < options.priorToolCalls.length; i++) {
			const call = options.priorToolCalls[i];
			const result = options.toolResults.find(r =>
				(r.toolCallId && r.toolCallId === call.id) || r.toolName === call.name
			) ?? options.toolResults[i];
			oaiMessages.push({
				role: 'tool',
				tool_call_id: idFor(call, i),
				content: result?.content ?? JSON.stringify({ ok: true }),
			});
		}

		body = { model, messages: oaiMessages, stream: true, temperature, max_tokens: maxTokens };
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

		const reader = response.body?.getReader();
		if (!reader) throw new Error('No response body');

		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed === 'data: [DONE]') continue;
					if (trimmed === 'event: message_stop') continue;
					if (!trimmed.startsWith('data: ')) continue;
					try {
						const data = JSON.parse(trimmed.slice(6));
						if (useAnthropic) {
							if (data.type === 'content_block_delta'
								&& data.delta?.type === 'text_delta'
								&& typeof data.delta.text === 'string') {
								fullContent += data.delta.text;
								onChunk?.(data.delta.text, fullContent);
							}
						} else {
							const delta = data.choices?.[0]?.delta;
							if (typeof delta?.content === 'string' && delta.content) {
								fullContent += delta.content;
								onChunk?.(delta.content, fullContent);
							}
						}
					} catch {
						// skip malformed
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		return fullContent;
	} catch (err) {
		error = error || (err instanceof Error ? err.message : String(err));
		throw err;
	} finally {
		const historyLength = options.messages?.reduce((sum, m) => sum + m.content.length, 0) ?? 0;
		const fullSystem = options.systemDynamic
			? `${options.system}\n\n${options.systemDynamic}`
			: options.system;
		addLogEntry({
			id: uuid(),
			timestamp: Date.now(),
			service: (options as any)._service || 'narrative-continuation',
			model,
			system: fullSystem,
			prompt: `${options.prompt}\n[continuation after ${options.priorToolCalls.length} tool call(s)]`,
			conversationHistory: options.messages,
			response: fullContent,
			temperature,
			maxTokens,
			durationMs: Date.now() - startTime,
			error,
			tokenEstimate: Math.ceil((fullSystem.length + historyLength + options.prompt.length + fullContent.length) / 4),
		});
	}
}
