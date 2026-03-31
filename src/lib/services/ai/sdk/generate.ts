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
	done: boolean;
}

/**
 * Detect if a key is an Anthropic OAuth setup-token (sk-ant-oat-*).
 */
function isOAuthToken(apiKey: string): boolean {
	return apiKey.startsWith('sk-ant-oat-');
}

/**
 * Check if a profile targets the Anthropic native API.
 */
function isAnthropicProvider(profile: APIProfile): boolean {
	return profile.providerType === 'anthropic';
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
 */
function toAnthropicBody(
	systemPrompt: string,
	messages: Array<{ role: string; content: string }>,
	model: string,
	temperature: number,
	maxTokens: number,
	stream: boolean,
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
		stream,
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
	const modelOverride = await getSetting('narrativeModel');
	if (modelOverride) return modelOverride;

	const { profile } = await getActiveProfile(profileId);
	const providerConfig = PROVIDERS[profile.providerType as ProviderType];
	
	// Use provider's narrative service default, or first fallback model
	return providerConfig?.services?.narrative?.model 
		?? providerConfig?.fallbackModels[0] 
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

	// Build request based on provider
	const endpoint = useAnthropic
		? `${baseUrl || '/api/anthropic'}/v1/messages`
		: `${baseUrl}/chat/completions`;
	const headers = useAnthropic ? buildAnthropicHeaders(profile) : buildAuthHeaders(profile);
	const body = useAnthropic
		? toAnthropicBody(options.system, messages, model, temperature, maxTokens, true)
		: { model, messages: [{ role: 'system', content: options.system }, ...messages.filter(m => m.role !== 'system').length ? messages : []], stream: true, temperature, max_tokens: maxTokens };

	// For OpenAI path, rebuild messages properly
	if (!useAnthropic) {
		const oaiMessages: Array<{ role: string; content: string }> = [
			{ role: 'system', content: options.system },
		];
		if (options.messages?.length) {
			for (const msg of options.messages) oaiMessages.push({ role: msg.role, content: msg.content });
		}
		oaiMessages.push({ role: 'user', content: options.prompt });
		Object.assign(body, { messages: oaiMessages, model, stream: true, temperature, max_tokens: maxTokens });
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
							// Anthropic stream: content_block_delta events
							if (data.type === 'content_block_delta' && data.delta?.text) {
								fullContent += data.delta.text;
								yield { content: data.delta.text, done: false };
							}
							if (data.type === 'message_stop') {
								// stream complete
							}
						} else {
							// OpenAI stream: choices[0].delta
							const delta = data.choices?.[0]?.delta;
							if (delta?.content) {
								fullContent += delta.content;
								yield { content: delta.content, done: false };
							}
							if (delta?.reasoning) {
								yield { content: '', reasoning: delta.reasoning, done: false };
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
		addLogEntry({
			id: uuid(),
			timestamp: Date.now(),
			service: (options as any)._service || 'narrative',
			model,
			system: options.system,
			prompt: options.prompt,
			conversationHistory: options.messages,
			response: fullContent,
			temperature,
			maxTokens,
			durationMs: Date.now() - startTime,
			error,
			tokenEstimate: Math.ceil((options.system.length + historyLength + options.prompt.length + fullContent.length) / 4),
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
