import { PROVIDERS } from '$lib/services/ai/sdk/providers/config';
import type { TurnRequest } from '$lib/contracts/memory';
import type { ProviderType } from '$lib/types';
import {
	getGoogleAgentPlatformBaseUrl,
	getGoogleAgentPlatformHeaders,
} from '$lib/server/ai/googleAgentPlatform';

type ProviderProfile = NonNullable<TurnRequest['providerProfile']>;

export interface ServerGenerationOptions {
	profile: ProviderProfile;
	model?: string;
	temperature?: number;
	maxTokens?: number;
	system: string;
	messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
	prompt: string;
	responseFormat?: 'json_object';
}

function isAnthropicProvider(profile: ProviderProfile): boolean {
	return profile.providerType === 'anthropic' || profile.providerType === 'anthropic-proxy';
}

function isGoogleAgentPlatformProvider(profile: ProviderProfile): boolean {
	return profile.providerType === 'google-agent-platform';
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

export async function generateServerText(options: ServerGenerationOptions): Promise<string> {
	if (requiresApiKey(options.profile) && !options.profile.apiKey?.trim()) {
		throw new Error('Server turn generation requires an API profile with an API key.');
	}

	const model = fallbackModelFor(options.profile, options.model);
	const temperature = options.temperature ?? 1;
	const maxTokens = options.maxTokens ?? 4096;
	const useAnthropic = isAnthropicProvider(options.profile);
	const useGoogleAgentPlatform = isGoogleAgentPlatformProvider(options.profile);
	const baseUrl = useGoogleAgentPlatform
		? await getGoogleAgentPlatformBaseUrl()
		: baseUrlFor(options.profile);
	const messages = options.messages ?? [];

	const endpoint = useAnthropic
		? `${baseUrl || 'https://api.anthropic.com'}/v1/messages`
		: `${baseUrl}/chat/completions`;

	const body = useAnthropic
		? {
			model,
			max_tokens: maxTokens,
			temperature,
			system: options.system,
			messages: [
				...messages,
				{ role: 'user', content: options.prompt },
			],
		}
		: {
			model,
			temperature,
			max_tokens: maxTokens,
			messages: [
				{ role: 'system', content: options.system },
				...messages,
				{ role: 'user', content: options.prompt },
			],
			...(options.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
		};

	const response = await fetch(endpoint, {
		method: 'POST',
		headers: useAnthropic
			? anthropicHeaders(options.profile)
			: useGoogleAgentPlatform
				? { 'Content-Type': 'application/json', ...await getGoogleAgentPlatformHeaders() }
				: openAiHeaders(options.profile),
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`Server LLM request failed (${response.status}): ${text || response.statusText}`);
	}

	const data = await response.json();
	if (useAnthropic) {
		return (data.content ?? []).map((block: { text?: string }) => block.text ?? '').join('').trim();
	}
	return String(data.choices?.[0]?.message?.content ?? '').trim();
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
