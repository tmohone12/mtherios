/**
 * DeepSeek roleplay injection.
 *
 * DeepSeek V3+/reasoner models will, by default, treat the contents of the
 * `<think>` block as analytical chain-of-thought. For interactive fiction the
 * preferred behaviour is in-character first-person inner monologue inside
 * `<think>`, which produces tighter, more immersive narration in the visible
 * output. The community-validated way to flip that mode is to append a short
 * Chinese instruction block to the *first* user message in the conversation;
 * the prompt then propagates through context history and shapes every
 * subsequent reasoning pass.
 *
 * Source: https://github.com/victorchen96/deepseek_v4_rolepaly_instruct
 */
import type { APIProfile } from '$lib/types';

/**
 * Role-immersion injection — character first-person inner monologue inside
 * the `<think>` block. Use for narrator/storyteller calls.
 */
export const DEEPSEEK_ROLEPLAY_INJECTION =
	'【角色沉浸要求】在你的思考过程（<think>标签内）中，请遵守以下规则：' +
	'1. 请以角色第一人称进行内心独白，用括号包裹内心活动，例如"（心想：……）"或"(内心OS：……)" ' +
	'2. 用第一人称描写角色的内心感受，例如"我心想""我觉得""我暗自"等 ' +
	'3. 思考内容应沉浸在角色中，通过内心独白分析剧情和规划回复';

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
 * deepseek-reasoner does NOT reliably honor OpenAI-style function calling: the
 * official reasoning_model docs list "Function Calling" as unsupported, and in
 * practice the model returns prose without tool_calls when forced via
 * `tool_choice`. Callers that need structured output should detect this and
 * switch to JSON output mode (`response_format: { type: 'json_object' }`),
 * which the reasoner does support.
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

/**
 * Append the role-immersion block to the first user-role message in the
 * sequence. If no user message exists yet, the bare `prompt` is treated as
 * the first user message and returned with the block appended.
 *
 * Returns a new `{ messages, prompt }` pair; never mutates inputs.
 */
export function injectDeepSeekRoleplay<M extends { role: string; content: string }>(
	messages: M[],
	prompt: string,
): { messages: M[]; prompt: string } {
	const idx = messages.findIndex((m) => m.role === 'user');
	if (idx === -1) {
		return { messages, prompt: `${prompt}\n\n${DEEPSEEK_ROLEPLAY_INJECTION}` };
	}
	const next = messages.slice();
	const first = next[idx];
	next[idx] = { ...first, content: `${first.content}\n\n${DEEPSEEK_ROLEPLAY_INJECTION}` };
	return { messages: next, prompt };
}
