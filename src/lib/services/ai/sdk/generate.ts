/**
 * AI Generation — Mtherios
 * 
 * Lightweight wrapper around fetch for streaming narrative generation.
 * Uses the active provider profile from settings.
 */

import { getSetting } from '$lib/services/database';
import { PROVIDERS } from './providers/config';
import type { APIProfile, ProviderType } from '$lib/types';

export interface GenerateOptions {
	system: string;
	prompt: string;
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
}

export interface StreamChunk {
	content: string;
	reasoning?: string;
	done: boolean;
}

async function getActiveProfile(): Promise<{ profile: APIProfile; baseUrl: string }> {
	const profilesJson = await getSetting('apiProfiles');
	const activeProfileId = await getSetting('activeProfileId');
	
	if (!profilesJson) throw new Error('No API profiles configured. Please set up a provider in Settings.');
	
	const profiles: APIProfile[] = JSON.parse(profilesJson);
	const profile = activeProfileId 
		? profiles.find(p => p.id === activeProfileId) ?? profiles[0]
		: profiles[0];
	
	if (!profile) throw new Error('No API profile found.');
	
	const providerConfig = PROVIDERS[profile.providerType as ProviderType];
	const baseUrl = profile.baseUrl || providerConfig?.baseUrl || 'https://api.openai.com/v1';
	
	return { profile, baseUrl };
}

/**
 * Get the active model for narrative generation.
 */
export async function getActiveModel(): Promise<string> {
	const modelOverride = await getSetting('narrativeModel');
	if (modelOverride) return modelOverride;
	
	const { profile } = await getActiveProfile();
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
	const { profile, baseUrl } = await getActiveProfile();
	const model = await getActiveModel();
	
	const body: Record<string, any> = {
		model,
		messages: [
			{ role: 'system', content: options.system },
			{ role: 'user', content: options.prompt },
		],
		stream: true,
		temperature: options.temperature ?? 1.0,
		max_tokens: options.maxTokens ?? 4096,
	};

	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${profile.apiKey}`,
		},
		body: JSON.stringify(body),
		signal: options.signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => 'Unknown error');
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
				if (!trimmed.startsWith('data: ')) continue;

				try {
					const data = JSON.parse(trimmed.slice(6));
					const delta = data.choices?.[0]?.delta;
					if (delta?.content) {
						yield { content: delta.content, done: false };
					}
					if (delta?.reasoning) {
						yield { content: '', reasoning: delta.reasoning, done: false };
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
}

/**
 * Generate a complete (non-streaming) response.
 */
export async function generateNarrative(options: GenerateOptions): Promise<string> {
	const { profile, baseUrl } = await getActiveProfile();
	const model = await getActiveModel();

	const body: Record<string, any> = {
		model,
		messages: [
			{ role: 'system', content: options.system },
			{ role: 'user', content: options.prompt },
		],
		temperature: options.temperature ?? 1.0,
		max_tokens: options.maxTokens ?? 4096,
	};

	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${profile.apiKey}`,
		},
		body: JSON.stringify(body),
		signal: options.signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => 'Unknown error');
		throw new Error(`AI request failed (${response.status}): ${errorText}`);
	}

	const data = await response.json();
	return data.choices?.[0]?.message?.content ?? '';
}
