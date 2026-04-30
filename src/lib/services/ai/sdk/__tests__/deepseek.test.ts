import { describe, it, expect } from 'vitest';
import { isDeepSeekProvider, isDeepSeekReasoner } from '../providers/deepseekInjection';
import { stripThinkTags, parseJsonFromText } from '../generate';
import type { APIProfile } from '$lib/types';

const profile = (providerType: string): APIProfile => ({
	id: 'p',
	name: 'p',
	providerType: providerType as APIProfile['providerType'],
	apiKey: 'k',
	baseUrl: '',
	customModels: [],
	fetchedModels: [],
	reasoningModels: [],
	hiddenModels: [],
	favoriteModels: [],
	createdAt: 0,
});

describe('isDeepSeekProvider', () => {
	it('matches the native DeepSeek provider regardless of model name', () => {
		expect(isDeepSeekProvider(profile('deepseek'), 'whatever')).toBe(true);
		expect(isDeepSeekProvider(profile('deepseek'), undefined)).toBe(true);
	});

	it('matches deepseek model names routed through other providers', () => {
		expect(isDeepSeekProvider(profile('openrouter'), 'deepseek/deepseek-v3.2')).toBe(true);
		expect(isDeepSeekProvider(profile('nanogpt'), 'deepseek-r1')).toBe(true);
	});

	it('returns false for non-DeepSeek setups', () => {
		expect(isDeepSeekProvider(profile('openai'), 'gpt-4o')).toBe(false);
		expect(isDeepSeekProvider(profile('anthropic'), 'claude-opus-4-7')).toBe(false);
	});
});

describe('isDeepSeekReasoner', () => {
	it('matches the native deepseek-reasoner model', () => {
		expect(isDeepSeekReasoner(profile('deepseek'), 'deepseek-reasoner')).toBe(true);
	});

	it('matches r1 routes via aggregators', () => {
		expect(isDeepSeekReasoner(profile('openrouter'), 'deepseek/deepseek-r1')).toBe(true);
		expect(isDeepSeekReasoner(profile('openrouter'), 'deepseek/deepseek-r1:free')).toBe(true);
		expect(isDeepSeekReasoner(profile('nanogpt'), 'deepseek-r1-distill')).toBe(true);
	});

	it('does not match deepseek-chat / v3 variants', () => {
		expect(isDeepSeekReasoner(profile('deepseek'), 'deepseek-chat')).toBe(false);
		expect(isDeepSeekReasoner(profile('openrouter'), 'deepseek/deepseek-v3.2')).toBe(false);
		expect(isDeepSeekReasoner(profile('openrouter'), 'deepseek/deepseek-chat')).toBe(false);
	});

	it('does not false-match `r10`-style tokens', () => {
		expect(isDeepSeekReasoner(profile('deepseek'), 'deepseek-r10')).toBe(false);
	});

	it('does not match non-DeepSeek models even if they contain reasoner-like words', () => {
		expect(isDeepSeekReasoner(profile('openai'), 'o1-reasoner')).toBe(false);
	});

	it('returns false when there is no resolved model name', () => {
		expect(isDeepSeekReasoner(profile('deepseek'), undefined)).toBe(false);
	});
});

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

describe('parseJsonFromText', () => {
	it('parses raw JSON', () => {
		expect(parseJsonFromText('{"a":1}')).toEqual({ a: 1 });
	});

	it('parses code-fenced JSON', () => {
		expect(parseJsonFromText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(parseJsonFromText('```\n{"a":2}\n```')).toEqual({ a: 2 });
	});

	it('parses JSON preceded by leaked <think> reasoning', () => {
		const text = '<think>Working through the scene...</think>\n{"characters":[{"name":"Aria"}]}';
		expect(parseJsonFromText(text)).toEqual({ characters: [{ name: 'Aria' }] });
	});

	it('parses JSON wrapped in narrative prose', () => {
		const text = 'Sure! Here is the update:\n\n{"items":[{"name":"sword","quantity":1}]}\n\nLet me know if you need anything else.';
		expect(parseJsonFromText(text)).toEqual({ items: [{ name: 'sword', quantity: 1 }] });
	});

	it('handles strings containing braces', () => {
		const text = '{"label":"a {nested} thing","x":1}';
		expect(parseJsonFromText(text)).toEqual({ label: 'a {nested} thing', x: 1 });
	});

	it('returns null for empty / non-JSON text', () => {
		expect(parseJsonFromText('')).toBeNull();
		expect(parseJsonFromText('just prose, no json')).toBeNull();
	});

	it('extracts the first balanced object even if more text follows', () => {
		expect(parseJsonFromText('{"a":1}\nthen more stuff')).toEqual({ a: 1 });
	});
});
