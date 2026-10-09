import { describe, expect, it } from 'vitest';
import { decisionModel, decisionModels, isDecisionModel, modelForDecisionProvider, supportsDecisionModel } from './decisionModels';

describe('decision model catalog', () => {
	it('keeps provider availability separate and rejects yes/no-only and chat models', () => {
		expect(supportsDecisionModel('openrouter', 'openai/gpt-6-luna-decisions')).toBe(true);
		expect(supportsDecisionModel('nanogpt', 'openai/gpt-6-luna-decisions')).toBe(false);
		expect(supportsDecisionModel('nanogpt', 'llmtech/decider-0.8b-fp8')).toBe(true);
		expect(supportsDecisionModel('openrouter', 'llmtech/decider-0.8b-fp8')).toBe(false);
		for (const model of ['respan/span-01', 'typesafe/jev-router', 'gpt-4.1']) expect(isDecisionModel(model)).toBe(false);
		expect(decisionModels('openai-compatible').map(model => model.id)).toEqual(['kev-latest']);
	});
	it('retains a supported selection when switching providers and preserves legacy Jev IDs', () => {
		expect(modelForDecisionProvider('nanogpt', 'liquid/d1')).toBe('liquid/d1');
		expect(modelForDecisionProvider('nanogpt', '~typesafe/jev-latest')).toBe('typesafe/jev-latest');
		expect(modelForDecisionProvider('openrouter', 'typesafe/jev-latest')).toBe('~typesafe/jev-latest');
		expect(modelForDecisionProvider('nanogpt', 'openai/gpt-6-luna-decisions')).toBe('typesafe/jev-1.13');
		expect(supportsDecisionModel('openrouter', 'typesafe/jev-1.13-20260917')).toBe(true);
	});
	it('uses smaller provider-specific context limits for hosted Kev and NanoGPT Clef', () => {
		expect(decisionModel('openrouter', 'jaredpalmer/kev-4b')?.contextWindowTokens).toBe(8192);
		expect(decisionModel('nanogpt', 'cloudflare/clef')?.contextWindowTokens).toBe(1800);
		expect(decisionModel('openrouter', 'cloudflare/clef')?.contextWindowTokens).toBe(32000);
	});
});
