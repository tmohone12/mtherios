/**
 * Model context window lookup.
 *
 * Extracted from the deleted ContextAssembler so the story store and
 * ContextWindow UI can size conversation history without depending on
 * the legacy 5-tier assembler.
 */

const DEFAULT_MODEL_CONTEXT = 128000;

export type ModelContextWindowSource = 'explicit-override' | 'model-window-registry-or-default';

export interface ModelContextWindowInfo {
	tokens: number;
	source: ModelContextWindowSource;
}

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	// OpenAI
	'gpt-4o': 128000,
	'gpt-4o-mini': 128000,
	'gpt-4-turbo': 128000,
	'gpt-4': 8192,
	'gpt-3.5-turbo': 16385,
	'o1': 200000,
	'o1-mini': 128000,
	// Anthropic
	'claude-opus-4-5-20251101': 200000,
	'claude-sonnet-4-5-20250929': 200000,
	'claude-haiku-4-5-20251001': 200000,
	'claude-opus-4-1-20250805': 200000,
	'claude-sonnet-4-20250514': 200000,
	'claude-opus-4-20250514': 200000,
	// Google
	'gemini-3-pro-preview': 1048576,
	'gemini-3-flash-preview': 1048576,
	'gemini-2.5-pro': 1048576,
	'gemini-2.5-flash': 1048576,
	'gemini-2.5-flash-lite': 1048576,
	// DeepSeek
	'deepseek-chat': 64000,
	'deepseek-reasoner': 64000,
	// xAI
	'grok-3': 131072,
	'grok-3-fast': 131072,
	'grok-2': 131072,
	// Groq
	'llama-3.3-70b-versatile': 128000,
	'mixtral-8x7b-32768': 32768,
	// Mistral
	'mistral-large-latest': 128000,
	'mistral-small-latest': 128000,
	// OpenRouter common
	'z-ai/glm-5': 128000,
	'x-ai/grok-4.1-fast': 131072,
	'google/gemini-3-flash-preview': 1048576,
	'deepseek/deepseek-v3.2': 64000,
	'stepfun/step-3.5-flash:free': 128000,
	// NanoGPT common
	'zai-org/glm-5:thinking': 128000,
	'stepfun-ai/step-3.5-flash:thinking': 128000,
	'openai/gpt-oss-120b': 128000,
	// Kimi (Moonshot)
	'kimi-for-coding': 262144,
	'kimi-latest': 131072,
	'kimi-k2-0905-preview': 131072,
	'kimi-k2-0711-preview': 131072,
	'moonshot-v1-128k': 131072,
	'moonshot-v1-32k': 32768,
	'moonshot-v1-8k': 8192,
};

export function getModelContextWindowInfo(model: string, explicitOverride?: number | null): ModelContextWindowInfo {
	if (Number.isFinite(explicitOverride) && Number(explicitOverride) > 0) {
		return { tokens: Math.trunc(Number(explicitOverride)), source: 'explicit-override' };
	}
	if (MODEL_CONTEXT_WINDOWS[model]) return { tokens: MODEL_CONTEXT_WINDOWS[model], source: 'model-window-registry-or-default' };

	for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (model.startsWith(key)) return { tokens: value, source: 'model-window-registry-or-default' };
	}

	if (model.includes('gemini')) return { tokens: 1048576, source: 'model-window-registry-or-default' };
	if (model.includes('claude')) return { tokens: 200000, source: 'model-window-registry-or-default' };
	if (model.includes('gpt-4o')) return { tokens: 128000, source: 'model-window-registry-or-default' };
	if (model.includes('grok')) return { tokens: 131072, source: 'model-window-registry-or-default' };
	if (model.includes('kimi-for-coding')) return { tokens: 262144, source: 'model-window-registry-or-default' };
	if (model.includes('kimi') || model.includes('moonshot')) return { tokens: 131072, source: 'model-window-registry-or-default' };

	return { tokens: DEFAULT_MODEL_CONTEXT, source: 'model-window-registry-or-default' };
}

export function getModelContextWindow(model: string, explicitOverride?: number | null): number {
	return getModelContextWindowInfo(model, explicitOverride).tokens;
}
