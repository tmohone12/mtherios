import { describe, it, expect } from 'vitest';
import { stripThinkTags } from '../generate';

describe('stripThinkTags', () => {
	it('drops a complete <think> block from the start of content', () => {
		const out = stripThinkTags('<think>plan: do X</think>{"a":1}');
		expect(out).toBe('{"a":1}');
	});

	it('drops a partial / unterminated <think> block', () => {
		const out = stripThinkTags('<think>plan: do X');
		expect(out).toBe('');
	});

	it('passes content without think tags through unchanged', () => {
		expect(stripThinkTags('{"a":1}')).toBe('{"a":1}');
		expect(stripThinkTags('  hello  ')).toBe('hello');
	});

	it('handles mixed prose around the think block', () => {
		const out = stripThinkTags('Prelude <think>cot</think> {"ok":true}');
		expect(out).toBe('Prelude  {"ok":true}');
	});
});
