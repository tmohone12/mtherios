import { describe, expect, it } from 'vitest';
import { anthropicModelRules } from './claudeModelRules';

describe('Claude model rules', () => {
	it.each([
		['claude-opus-5-5', { adaptive: true, sampling: false, xhigh: true, thinksByDefault: true }],
		['claude-fable-5-1', { adaptive: true, sampling: false, xhigh: true, thinksByDefault: true }],
		['claude-opus-4-8', { adaptive: true, sampling: false, xhigh: true, thinksByDefault: false }],
		['claude-sonnet-4-6', { adaptive: true, sampling: true, xhigh: false, thinksByDefault: false }],
		['claude-haiku-4-5-20251001', { adaptive: false, sampling: true, xhigh: false, thinksByDefault: false }],
		// A date suffix is not a minor version.
		['claude-opus-4-20250514', { adaptive: false, sampling: true, xhigh: false, thinksByDefault: false }],
		['anthropic.claude-sonnet-5-5', { adaptive: true, sampling: false, xhigh: true, thinksByDefault: true }],
		['gpt-5', { adaptive: false, sampling: true, xhigh: false, thinksByDefault: false }],
	])('reads %s', (model, rules) => {
		expect(anthropicModelRules(model)).toEqual(rules);
	});
});
