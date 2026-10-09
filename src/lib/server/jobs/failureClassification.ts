export type BackendJobFailureCause =
	| 'provider_account'
	| 'provider_output'
	| 'provider_unavailable'
	| 'capacity'
	| 'stale_source'
	| 'validation'
	| 'unknown';

export interface BackendJobFailureClass {
	storyId: string | null;
	projectId?: string;
	type: string;
	cause: BackendJobFailureCause;
	count: number;
	sourceVersions: number[];
	latestUpdatedAt: string;
	lastError: string | null;
	retryable: boolean;
}

export function classifyBackendJobFailure(lastError: string | null): { cause: BackendJobFailureCause; retryable: boolean } {
	const error = (lastError ?? '').toLowerCase();
	if (/(?:insufficient balance|payment required|\b402\b|billing|quota)/i.test(error)) return { cause: 'provider_account', retryable: false };
	if (/(?:invalid|empty|malformed|unrecognized key|expected .*received).*(?:output|response|schema|json|state)|(?:output|response|schema|json|state).*(?:invalid|empty|malformed)/i.test(error)) return { cause: 'provider_output', retryable: false };
	if (/(?:context window|context allowance|token limit|output limit|capacity|too many tokens)/i.test(error)) return { cause: 'capacity', retryable: false };
	if (/(?:stale|outdated|source .*changed|dependency .*changed|superseded)/i.test(error)) return { cause: 'stale_source', retryable: true };
	if (/(?:validation|invalid input|zod|refine|parse error)/i.test(error)) return { cause: 'validation', retryable: false };
	if (/(?:fetch failed|econnrefused|enotfound|timeout|timed out|abort|unavailable|network)/i.test(error)) return { cause: 'provider_unavailable', retryable: true };
	return { cause: 'unknown', retryable: false };
}

export function manualRetryBlockCause(cause: BackendJobFailureCause): boolean {
	return cause === 'provider_account' || cause === 'provider_output' || cause === 'capacity' || cause === 'validation';
}
