/**
 * AI Generation — Mtherios
 * 
 * Lightweight wrapper around fetch for streaming narrative generation.
 * Uses the active provider profile from settings.
 */

import { getSetting } from '$lib/services/database';
import { uuid } from '$lib/utils/uuid';
import { PROVIDERS } from './providers/config';
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

	// Combined system prompt for OpenAI-compatible providers (no caching support)
	const combinedSystem = options.systemDynamic
		? `${options.system}\n\n${options.systemDynamic}`
		: options.system;

	// Build messages array
	const messages: Array<{ role: string; content: string }> = [];
	if (!useAnthropic) {
		messages.push({ role: 'system', content: combinedSystem });
	}
	if (options.messages?.length) {
		for (const msg of options.messages) {
			messages.push({ role: msg.role, content: msg.content });
		}
	}
	messages.push({ role: 'user', content: options.prompt });

	// Build request based on provider
	const endpoint = useAnthropic
		? `${baseUrl || '/api/anthropic'}/v1/messages`
		: `${baseUrl}/chat/completions`;
	const headers = useAnthropic ? buildAnthropicHeaders(profile) : buildAuthHeaders(profile);

	let body: Record<string, any>;
	if (useAnthropic) {
		body = toAnthropicBody(
			options.system, messages, model, temperature, maxTokens, useStream,
			options.systemDynamic, options.tools, options.forceTool,
		);
	} else {
		// OpenAI-compatible: system as a message role, then history, then user prompt
		const oaiMessages: Array<{ role: string; content: string }> = [
			{ role: 'system', content: combinedSystem },
		];
		if (options.messages?.length) {
			for (const msg of options.messages) oaiMessages.push({ role: msg.role, content: msg.content });
		}
		oaiMessages.push({ role: 'user', content: options.prompt });
		body = { model, messages: oaiMessages, stream: useStream, temperature, max_tokens: maxTokens };
		if (options.tools && options.tools.length > 0) {
			body.tools = options.tools;
			body.tool_choice = options.forceTool
				? { type: 'function', function: { name: options.forceTool } }
				: 'auto';
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
			const data = await response.json();
			if (useAnthropic) {
				for (const block of data.content ?? []) {
					if (block.type === 'text' && typeof block.text === 'string' && block.text) {
						fullContent += block.text;
						yield { content: block.text, done: false };
					} else if (block.type === 'tool_use') {
						yield {
							content: '',
							toolCall: { name: block.name, arguments: block.input ?? {} },
							done: false,
						};
					}
				}
			} else {
				const message = data.choices?.[0]?.message;
				const content = typeof message?.content === 'string' ? message.content : '';
				if (content) {
					fullContent += content;
					yield { content, done: false };
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
						yield { content: '', toolCall: { name: tc.function?.name ?? '', arguments: args }, done: false };
					}
				}
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
		type ToolBlock = { name: string; jsonBuffer: string };
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
									yield { content: '', toolCall: { name: block.name, arguments: args }, done: false };
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
							if (typeof delta?.reasoning === 'string' && delta.reasoning) {
								yield { content: '', reasoning: delta.reasoning, done: false };
							}
							if (Array.isArray(delta?.tool_calls)) {
								for (const tc of delta.tool_calls) {
									const idx = tc.index ?? 0;
									let block = oaiToolCalls.get(idx);
									if (!block) {
										block = { name: tc.function?.name ?? '', jsonBuffer: '' };
										oaiToolCalls.set(idx, block);
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
									yield { content: '', toolCall: { name: block.name, arguments: args }, done: false };
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
	const body = useAnthropic
		? toAnthropicBody(options.system, messages, model, temperature, maxTokens, false)
		: { model, messages, temperature, max_tokens: maxTokens };

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

	const endpoint = useAnthropic
		? `${baseUrl || '/api/anthropic'}/v1/messages`
		: `${baseUrl}/chat/completions`;
	const headers = useAnthropic ? buildAnthropicHeaders(profile) : buildAuthHeaders(profile);

	let body: Record<string, any>;
	let responseText = '';
	let error: string | undefined;
	const toolCalls: ToolCall[] = [];

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
	} else {
		// OpenAI-compatible with tools
		const oaiMessages: Array<{ role: string; content: string }> = [
			{ role: 'system', content: options.system },
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
					});
				}
			}
		} else {
			// OpenAI: message.content + message.tool_calls.
			// Coerce content to string — some OpenAI-compatible providers stuff
			// non-string payloads (objects, nulls) when tool_calls are present.
			const message = data.choices?.[0]?.message;
			responseText = typeof message?.content === 'string' ? message.content : '';
			if (message?.tool_calls) {
				for (const tc of message.tool_calls) {
					let args: Record<string, any> = {};
					try {
						args = typeof tc.function.arguments === 'string'
							? JSON.parse(tc.function.arguments)
							: tc.function.arguments;
					} catch {
						console.error('[generateStructuredWithTools] Failed to parse tool call args:', tc.function.arguments);
					}
					toolCalls.push({
						name: tc.function.name,
						arguments: args,
					});
				}
			}
		}

		// Fallback: if no tool calls found, try to parse JSON from response text
		if (toolCalls.length === 0 && responseText.trim()) {
			const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/) || responseText.match(/(\{[\s\S]*\})/);
			if (jsonMatch) {
				try {
					const parsed = JSON.parse(jsonMatch[1]);
					toolCalls.push({
						name: 'update_world_state',
						arguments: parsed,
					});
				} catch {
					console.warn('[generateStructuredWithTools] Could not parse JSON fallback from response text');
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
