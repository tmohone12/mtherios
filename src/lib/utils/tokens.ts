import { encode } from 'gpt-tokenizer';

// Cache the tokenizer — it's expensive to initialize
let _cachedEncode: typeof encode | null = null;

function getEncoder() {
	if (!_cachedEncode) _cachedEncode = encode;
	return _cachedEncode;
}

/** Accurate token count using tiktoken-compatible tokenizer */
export function countTokens(text: string): number {
	if (!text) return 0;
	try {
		return getEncoder()(text).length;
	} catch {
		// Fallback if tokenizer fails
		return Math.ceil(text.length / 4);
	}
}

/** Truncate text to fit within a token budget */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
	if (!text) return '';
	const tokens = getEncoder()(text);
	if (tokens.length <= maxTokens) return text;
	// Binary search for the right character position
	// (encoding substrings is expensive, so we estimate)
	let lo = 0, hi = text.length;
	while (lo < hi) {
		const mid = Math.floor((lo + hi + 1) / 2);
		const sub = text.slice(0, mid);
		if (getEncoder()(sub).length <= maxTokens) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return text.slice(0, lo) + '...';
}
