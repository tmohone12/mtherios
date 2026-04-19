/**
 * Model context window lookup.
 *
 * Extracted from the deleted ContextAssembler so the story store and
 * ContextWindow UI can size conversation history without depending on
 * the legacy 5-tier assembler.
 */

const DEFAULT_MODEL_CONTEXT = 128000;

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
};

export function getModelContextWindow(model: string): number {
	if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];

	for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (model.startsWith(key)) return value;
	}

	if (model.includes('gemini')) return 1048576;
	if (model.includes('claude')) return 200000;
	if (model.includes('gpt-4o')) return 128000;
	if (model.includes('grok')) return 131072;

	return DEFAULT_MODEL_CONTEXT;
}
