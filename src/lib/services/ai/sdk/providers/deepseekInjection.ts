/**
 * DeepSeek request detection for the browser's structured-output calls.
 */
import type { APIProfile } from '$lib/types';

/**
 * True when the resolved request will hit a DeepSeek model — either via the
 * native DeepSeek API or routed through OpenRouter / a compatible aggregator.
 */
export function isDeepSeekProvider(profile: APIProfile, model: string | undefined): boolean {
	if (profile.providerType === 'deepseek') return true;
	if (model && /deepseek/i.test(model)) return true;
	return false;
}

/**
 * True when the resolved model is deepseek-reasoner (R1) or an alias.
 *
 * deepseek-reasoner supports OpenAI-style function calling in thinking mode
 * (https://api-docs.deepseek.com/guides/thinking_mode), so forced-tool calls
 * send it real tools instead of the JSON-output fallback used for deepseek-chat.
 *
 * Detection covers:
 * - `deepseek-reasoner` (native DeepSeek API)
 * - `deepseek/deepseek-r1*`, `deepseek-r1*` (OpenRouter / NanoGPT routes)
 * - any model whose name contains `reasoner` alongside `deepseek`
 */
export function isDeepSeekReasoner(profile: APIProfile, model: string | undefined): boolean {
	if (!isDeepSeekProvider(profile, model)) return false;
	if (!model) return false;
	const m = model.toLowerCase();
	if (m.includes('reasoner')) return true;
	// Match `r1` only as a token boundary — avoids false hits on `r10`, etc.
	if (/(^|[^a-z0-9])r1([^a-z0-9]|$)/.test(m)) return true;
	return false;
}
