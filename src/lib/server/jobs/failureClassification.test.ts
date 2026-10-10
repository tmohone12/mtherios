import { describe, expect, it } from 'vitest';
import { classifyBackendJobFailure } from './failureClassification';

describe('background failure recovery decisions', () => {
	it.each([
		'Summary response did not contain a complete JSON object (finish_reason: length).',
		'Accounts response did not contain a complete JSON object (finish_reason: stop).',
		'Incomplete summary: accounts must cover every source exactly once in chronological order.',
	])('recognizes exhausted summary output: %s', message => {
		expect(classifyBackendJobFailure(message)).toEqual({ cause: 'provider_output', retryable: false });
	});
	it.each(['Server LLM request failed (502): Bad gateway', 'Server LLM request failed (504): Gateway timeout', 'Rate limit exceeded', 'read ECONNRESET'])('allows transient recovery: %s', message => {
		expect(classifyBackendJobFailure(message)).toEqual({ cause: 'provider_unavailable', retryable: true });
	});
	it('keeps account exhaustion and unknown failures stopped', () => {
		expect(classifyBackendJobFailure('429 insufficient quota; billing limit reached')).toEqual({ cause: 'provider_account', retryable: false });
		expect(classifyBackendJobFailure('Unexpected compiler failure')).toEqual({ cause: 'unknown', retryable: false });
	});
	it('distinguishes a temporary rate quota from exhausted account credit', () => {
		expect(classifyBackendJobFailure('Server LLM request failed (429): rate quota exceeded; retry later')).toEqual({ cause: 'provider_unavailable', retryable: true });
		expect(classifyBackendJobFailure('Server LLM request failed (429): insufficient_quota')).toEqual({ cause: 'provider_account', retryable: false });
		expect(classifyBackendJobFailure('Monthly quota exhausted')).toEqual({ cause: 'provider_account', retryable: false });
	});
});
