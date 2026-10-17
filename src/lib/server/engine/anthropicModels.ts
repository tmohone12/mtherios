import { z } from 'zod';
import type { LlmServiceSetting } from '$lib/contracts/engine';
import { ANTHROPIC_API_URL, fetchAnthropicModels } from '$lib/services/ai/sdk/modelLists';
import { resolveApiKeyRef } from './llmEnvironment';

export const savedAnthropicModelsArgsSchema = z.object({
	apiKeyRef: z.string().min(1),
	baseUrl: z.string().nullable().default(null),
});

/**
 * Model IDs for a saved Anthropic setting, fetched with its server-held key; the key never
 * reaches the browser. Only a key reference and base URL saved together on an Anthropic setting
 * are accepted, so a request cannot send another secret or reach another host.
 */
export async function listSavedAnthropicModels(
	input: unknown,
	settings: LlmServiceSetting[],
	fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
	const { apiKeyRef, baseUrl } = savedAnthropicModelsArgsSchema.parse(input);
	const saved = settings.find(row => row.providerType === 'anthropic' && row.apiKeyRef === apiKeyRef && (row.baseUrl ?? null) === baseUrl);
	if (!saved) throw new Error('No saved Anthropic setting uses this key reference and base URL.');
	const apiKey = resolveApiKeyRef(apiKeyRef);
	if (!apiKey) throw new Error(`The server has no value for the Anthropic key ${apiKeyRef}. Enter the key and save it first.`);
	return fetchAnthropicModels(saved.baseUrl || ANTHROPIC_API_URL, apiKey, fetchImpl);
}
