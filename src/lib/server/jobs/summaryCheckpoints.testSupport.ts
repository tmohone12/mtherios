import type { SummaryCheckpointStore, SummaryCheckpointFailure } from './summaryCheckpoints';

/** Test fixture only; production coordination is exercised separately against PostgreSQL. */
export function memorySummaryCheckpointStore() {
	const rows = new Map<string, { owner: string; failureFingerprint: string; state: 'running' | 'complete' | 'failed'; value?: unknown; failure?: SummaryCheckpointFailure }>();
	const store: SummaryCheckpointStore = {
		async claim(input, owner) {
			const row = rows.get(input.fingerprint);
			if (row?.state === 'complete') return { state: 'complete', value: row.value };
			const failureFingerprint = input.failureFingerprint ?? input.fingerprint;
			const matching = [...rows.values()].filter(row => row.failureFingerprint === failureFingerprint);
			const failed = matching.find(row => row.state === 'failed' && !row.failure?.retryable);
			if (failed) return { state: 'failed', failure: failed.failure! };
			if (matching.some(row => row.state === 'running')) return { state: 'busy' };
			rows.set(input.fingerprint, { state: 'running', owner, failureFingerprint }); return { state: 'claimed' };
		},
		async complete(input, owner, value) {
			if (rows.get(input.fingerprint)?.owner !== owner) return false;
			rows.set(input.fingerprint, { state: 'complete', owner, failureFingerprint: input.failureFingerprint ?? input.fingerprint, value: structuredClone(value) }); return true;
		},
		async fail(input, owner, failure) {
			if (rows.get(input.fingerprint)?.owner !== owner) return false;
			rows.set(input.fingerprint, { state: 'failed', owner, failureFingerprint: input.failureFingerprint ?? input.fingerprint, failure }); return true;
		},
		async renew() {},
	};
	return { store, rows };
}
