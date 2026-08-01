import { resolveServiceGeneration, requireResolvedServiceProfile } from '$lib/server/engine/llmSettings';
import { z } from 'zod';
import { recordApiCallLog } from '$lib/server/engine/apiCallLogs';
import {
	generateServerTextWithMetrics,
	parseJsonFromGeneratedText,
	ServerGenerationError,
	type ServerGenerationResult,
} from '$lib/server/turn/provider';
import {
	buildStrategicWorldBrainSystemPrompt,
	buildStrategicWorldBrainUserPrompt,
	type StrategicWorldBrainInput,
} from '$lib/services/ai/context/strategicWorldBrainInput';
import { hasStrategicPlotContent, strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
import { finalizeStrategicWorldFrame } from '$lib/services/ai/generation/strategicWorldFrame';
import type { StrategicWorldFrame } from '$lib/types';

const { $schema: _schema, ...strategicWorldJsonSchema } = z.toJSONSchema(strategicWorldFrameSchema) as Record<string, unknown>;
const strategicWorldResponseSchema = {
	name: 'mtherios_strategic_world_frame',
	strict: false,
	schema: strategicWorldJsonSchema,
};

async function logCall(
	input: StrategicWorldBrainInput,
	profile: Parameters<typeof generateServerTextWithMetrics>[0]['profile'],
	result: ServerGenerationResult | ServerGenerationError['result'],
	status: 'success' | 'error',
	error?: unknown,
	phase = 'generation',
): Promise<void> {
	const usage = result.usage;
	await recordApiCallLog({
		storyId: input.story.id,
		serviceId: 'strategicWorldBrain',
		operation: 'plotBrain.plan',
		providerType: profile.providerType,
		providerName: profile.name ?? null,
		profileId: profile.id ?? null,
		model: result.model,
		endpoint: result.endpoint,
		status,
		durationMs: result.durationMs,
		requestTokens: usage?.requestTokens ?? null,
		responseTokens: usage?.responseTokens ?? null,
		totalTokens: usage?.totalTokens ?? null,
		promptChars: result.promptChars,
		responseChars: result.responseChars ?? null,
		error: error instanceof Error ? error.message : error ? String(error) : null,
		metadata: { trigger: input.trigger, phase },
	});
}

export async function planStrategicWorldFrameWithTerminal(input: StrategicWorldBrainInput): Promise<StrategicWorldFrame> {
	const resolved = await resolveServiceGeneration('strategicWorldBrain');
	const profile = requireResolvedServiceProfile('strategicWorldBrain', resolved);
	const promptInput = {
		...input,
		contextBudget: input.contextBudget ?? resolved.setting?.contextBudget ?? undefined,
	};
	let generated: ServerGenerationResult;
	try {
		generated = await generateServerTextWithMetrics({
			profile,
			model: resolved.generation.model,
			temperature: resolved.generation.temperature ?? 0.45,
			maxTokens: resolved.generation.maxTokens ?? 9000,
			reasoningEffort: 'off',
			timeoutMs: 240_000,
			system: `${resolved.systemPromptOverride?.trim() || buildStrategicWorldBrainSystemPrompt()}\n\nRespond ONLY with valid JSON matching this JSON Schema. No markdown, code fences, or explanation.\n\n${JSON.stringify(strategicWorldJsonSchema)}`,
			prompt: buildStrategicWorldBrainUserPrompt(promptInput),
			responseFormat: 'json_object',
			responseSchema: strategicWorldResponseSchema,
		});
	} catch (error) {
		if (error instanceof ServerGenerationError) await logCall(input, profile, error.result, 'error', error);
		throw error;
	}

	try {
		const parsed = strategicWorldFrameSchema.parse(parseJsonFromGeneratedText(generated.text));
		if (generated.finishReason === 'length' || !hasStrategicPlotContent(parsed)) {
			throw new Error('Strategic planner returned an incomplete frame without usable plot content.');
		}
		const frame = finalizeStrategicWorldFrame(promptInput, parsed as unknown as StrategicWorldFrame);
		await logCall(input, profile, generated, 'success');
		return frame;
	} catch (error) {
		await logCall(input, profile, generated, 'error', error, 'parse');
		throw error;
	}
}
