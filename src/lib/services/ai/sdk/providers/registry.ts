/**
 * Provider Registry — Mtherios
 * Creates Vercel AI SDK providers from APIProfile.
 * Slim version: only providers with installed SDK packages.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import type { APIProfile } from '$lib/types';
import { PROVIDERS, getBaseUrl } from './config';
import { createTimeoutFetch } from './fetch';

const DEFAULT_TIMEOUT_MS = 360000; // 6 minutes

export function createProviderFromProfile(profile: APIProfile, presetId: string, debugId?: string) {
	const fetch = createTimeoutFetch(DEFAULT_TIMEOUT_MS, presetId, debugId);
	const baseURL = profile.baseUrl || getBaseUrl(profile.providerType);

	switch (profile.providerType) {
		case 'openrouter':
			return createOpenRouter({
				apiKey: profile.apiKey,
				baseURL: baseURL ?? PROVIDERS.openrouter.baseUrl,
				headers: { 'HTTP-Referer': 'https://mtherios.app', 'X-Title': 'Mtherios' },
				fetch,
			});

		case 'openai':
			return createOpenAI({ apiKey: profile.apiKey, baseURL, fetch });

		case 'anthropic': {
			const isOAuth = profile.apiKey.startsWith('sk-ant-oat-');
			return createAnthropic({
				apiKey: profile.apiKey,
				baseURL,
				fetch,
				...(isOAuth ? { headers: { 'anthropic-beta': 'oauth-2025-04-01' } } : {}),
			});
		}

		case 'nanogpt':
			return createOpenAICompatible({
				name: 'nanogpt',
				apiKey: profile.apiKey,
				baseURL: baseURL ?? PROVIDERS.nanogpt.baseUrl,
				fetch,
			});

		case 'ollama':
			return createOpenAICompatible({
				name: 'ollama',
				apiKey: 'ollama',
				baseURL: baseURL ?? PROVIDERS.ollama.baseUrl,
				fetch,
			});

		case 'lmstudio':
			return createOpenAICompatible({
				name: 'lmstudio',
				apiKey: profile.apiKey || 'lm-studio',
				baseURL: baseURL ?? PROVIDERS.lmstudio.baseUrl,
				fetch,
			});

		case 'openai-compatible':
			if (!baseURL) throw new Error('OpenAI-compatible provider requires a custom base URL');
			return createOpenAICompatible({
				name: 'openai-compatible',
				apiKey: profile.apiKey ?? 'openai-compatible',
				baseURL,
				fetch,
			});

		case 'google-agent-platform':
			return createOpenAICompatible({
				name: 'google-agent-platform',
				apiKey: profile.apiKey || 'google-adc',
				baseURL: baseURL ?? PROVIDERS['google-agent-platform'].baseUrl,
				fetch,
			});

		case 'deepseek':
			return createOpenAICompatible({
				name: 'deepseek',
				apiKey: profile.apiKey,
				baseURL: baseURL ?? PROVIDERS.deepseek.baseUrl,
				fetch,
			});

		case 'groq':
			return createOpenAICompatible({
				name: 'groq',
				apiKey: profile.apiKey,
				baseURL: baseURL ?? PROVIDERS.groq.baseUrl,
				fetch,
			});

		case 'mistral':
			return createOpenAICompatible({
				name: 'mistral',
				apiKey: profile.apiKey,
				baseURL: baseURL ?? PROVIDERS.mistral.baseUrl,
				fetch,
			});

		case 'xai':
			return createOpenAICompatible({
				name: 'xai',
				apiKey: profile.apiKey,
				baseURL: baseURL ?? PROVIDERS.xai.baseUrl,
				fetch,
			});

		case 'anthropic-proxy': {
			const host = baseURL ?? PROVIDERS['anthropic-proxy'].baseUrl;
			return createAnthropic({
				apiKey: profile.apiKey || 'cc-bridge',
				baseURL: `${host}/v1`,
				fetch,
			});
		}

		default:
			// Fallback: treat any unknown provider as OpenAI-compatible
			return createOpenAICompatible({
				name: profile.providerType,
				apiKey: profile.apiKey ?? '',
				baseURL: baseURL ?? '',
				fetch,
			});
	}
}
