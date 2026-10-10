import { recordApiCallLog } from './apiCallLogs';
import type { ServerGenerationAttempt, ServerGenerationError, ServerGenerationOptions, ServerGenerationResult } from '$lib/server/turn/provider';

type GenerationReceipt = ServerGenerationResult | ServerGenerationError['result'];
export interface GenerationLogOptions {
	storyId?: string | null;
	serviceId: string;
	operation: string;
	profile: ServerGenerationOptions['profile'];
	result: GenerationReceipt;
	status: 'success' | 'error';
	error?: unknown;
	metadata?: Record<string, unknown>;
}

/** Adapt a transport callback receipt without inventing response text or usage. */
export function generationAttemptResult(attempt: ServerGenerationAttempt): ServerGenerationError['result'] {
	return { model: attempt.model, endpoint: attempt.endpoint, durationMs: attempt.durationMs, promptChars: attempt.promptChars,
		responseChars: attempt.responseChars ?? undefined, finishReason: attempt.finishReason, usage: attempt.usage,
		statusCode: attempt.statusCode ?? undefined, retryCount: attempt.attempt, attempts: [attempt] };
}

/** Keep source usage for diagnostics while making the no-dispatch relationship explicit. */
export function reuseGenerationResult(result: ServerGenerationResult, source: { operation: string; runId?: string }): ServerGenerationResult {
	return { ...result, accounting: { kind: 'reuse', sourceOperation: source.operation,
		...(source.runId ? { sourceRunId: source.runId } : {}), attemptIds: result.attempts?.map(attempt => attempt.attemptId) ?? [] } };
}

/** One row per dispatched provider attempt; outcome/reuse never creates a second charge. */
export async function recordGenerationApiCalls(options: GenerationLogOptions): Promise<void> {
	if (options.result.accounting?.kind === 'reuse') return;
	const receipts = options.result.attempts ?? [options.result];
	for (const [index, result] of receipts.entries()) {
		const attempt = 'attemptId' in result ? result : null;
		const usage = result.usage;
		const last = index === receipts.length - 1;
		const status = attempt?.status === 'error' || (last && options.status === 'error') ? 'error' : 'success';
		const error = attempt?.error ?? (last && options.error != null ? options.error instanceof Error ? options.error.message : String(options.error) : null);
		const saved = await recordApiCallLog({
			storyId: options.storyId ?? null, serviceId: options.serviceId, operation: options.operation,
			providerType: options.profile.providerType, providerName: options.profile.name ?? null, profileId: options.profile.id ?? null,
			model: result.model, endpoint: result.endpoint, status, error, durationMs: result.durationMs,
			requestTokens: usage?.requestTokens ?? null, responseTokens: usage?.responseTokens ?? null, totalTokens: usage?.totalTokens ?? null,
			promptChars: result.promptChars, responseChars: result.responseChars ?? null,
			metadata: {
				...options.metadata,
				attemptId: attempt?.attemptId ?? null, providerRequestId: attempt?.providerRequestId ?? null,
				requestHash: attempt?.requestHash ?? null, attempt: attempt?.attempt ?? null, startedAt: attempt?.startedAt ?? null,
				statusCode: attempt?.statusCode ?? ('statusCode' in result ? result.statusCode : null) ?? null,
				providerCallCount: attempt ? 1 : null, usageAvailable: Boolean(usage && Object.values(usage).some(value => value != null)),
				inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
				cachedInputTokens: usage?.cachedInputTokens ?? null, cacheWriteTokens: usage?.cacheWriteTokens ?? null,
				reasoningTokens: usage?.reasoningTokens ?? null, finishReason: result.finishReason ?? null,
				providerCostUsd: usage?.providerCostUsd ?? null, estimatedCostUsd: usage?.estimatedCostUsd ?? null,
				costSource: usage?.providerCostUsd == null ? 'unavailable' : 'provider_reported',
			},
		}, attempt ? { id: attempt.attemptId } : undefined);
		if (saved === null) throw new Error('Provider accounting receipt could not be saved; no provider retry was requested.');
	}
}
