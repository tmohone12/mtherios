export type BackendJobFailureCause =
	| 'provider_account'
	| 'provider_output'
	| 'provider_unavailable'
	| 'capacity'
	| 'stale_source'
	| 'validation'
	| 'configuration'
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

/** The persisted, classifiable failure text. Drizzle reports database errors as
 * "Failed query: <sql> params: <values>" with the server's reason only in `cause`;
 * keep that reason (deadlock, timeout, constraint) and drop bound parameter values. */
export function describeBackendJobError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	if (!error.message.startsWith('Failed query: ')) return error.message;
	const causes: string[] = [];
	for (let cause: unknown = error.cause, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
		const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
		if (message && !causes.includes(message)) causes.push(message);
	}
	const query = error.message.slice('Failed query: '.length).split('\nparams:')[0].replace(/\s+/g, ' ').trim();
	return `${causes.join('; ') || 'Database query failed'} (query: ${query.length > 160 ? `${query.slice(0, 160)}...` : query})`;
}

export function classifyBackendJobFailure(lastError: string | null): { cause: BackendJobFailureCause; retryable: boolean } {
	const error = (lastError ?? '').toLowerCase();
	// A missing or disabled model is fixed in settings; retrying before then cannot succeed.
	if (/model configuration needed/i.test(error)) return { cause: 'configuration', retryable: false };
	const accountExhausted = /(?:insufficient balance|payment required|\b402\b|billing|insufficient[_ ]quota)/i.test(error);
	const quotaWithoutThrottle = /quota/i.test(error) && !/(?:\b429\b|rate|per (?:minute|second)|retry[- ]after)/i.test(error);
	if (accountExhausted || quotaWithoutThrottle) return { cause: 'provider_account', retryable: false };
	if (/(?:finish_reason[\s:="']+length|(?:summary|accounts) response did not contain a complete json object|incomplete summary|accounts must cover every source)/i.test(error)) return { cause: 'provider_output', retryable: false };
	if (/(?:invalid|empty|malformed|unrecognized key|expected .*received).*(?:output|response|schema|json|state)|(?:output|response|schema|json|state).*(?:invalid|empty|malformed)/i.test(error)) return { cause: 'provider_output', retryable: false };
	if (/(?:context window|context allowance|token limit|output limit|capacity|too many tokens)/i.test(error)) return { cause: 'capacity', retryable: false };
	if (/(?:stale|outdated|source .*changed|dependency .*changed|superseded)/i.test(error)) return { cause: 'stale_source', retryable: true };
	if (/(?:validation|invalid input|zod|refine|parse error)/i.test(error)) return { cause: 'validation', retryable: false };
	if (/(?:fetch failed|econnrefused|econnreset|enotfound|etimedout|timeout|timed out|abort|unavailable|network|temporary provider outage|rate limit|too many requests|\b429\b|(?:http|status|request failed)[^\n]{0,30}\b50[0234]\b|deadlock detected|serialization failure|could not serialize access)/i.test(error)) return { cause: 'provider_unavailable', retryable: true };
	return { cause: 'unknown', retryable: false };
}

export function manualRetryBlockCause(cause: BackendJobFailureCause): boolean {
	return cause === 'provider_account' || cause === 'provider_output' || cause === 'capacity' || cause === 'validation';
}
