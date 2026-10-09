import { describe, expect, it } from 'vitest';
import { forwardReplayModelRequest, parseReplayScenarioJsonl, parseReplaySpendCap, replayModelConfig, scoreReplayResult } from './replayRunner';

describe('replay eval runner', () => {
	it('requires an explicit positive spend cap for provider-backed replay', () => {
		expect(parseReplaySpendCap(undefined, false)).toBeNull();
		expect(() => parseReplaySpendCap(undefined, true)).toThrow('max-cost-usd');
		expect(() => parseReplaySpendCap('0', true)).toThrow('positive');
		expect(() => parseReplaySpendCap('not-a-number', true)).toThrow('finite');
		expect(parseReplaySpendCap('0.06', true)).toBe(0.06);
		expect(() => parseReplaySpendCap('0.06', false)).toThrow('requires --model');
	});

	it('keeps model use opt-in with an explicit key and forwards only the bounded requested model', async () => {
		expect(replayModelConfig(undefined, undefined, 'unused-key')).toBeNull();
		expect(() => replayModelConfig('test-model', 'openai', undefined)).toThrow('REPLAY_MODEL_API_KEY');
		expect(() => replayModelConfig('test-model', 'other', 'explicit-key')).toThrow('provider');
		const config = replayModelConfig('test-model', 'openrouter', 'explicit-key')!;
		const calls: string[] = [];
		const fakeFetch: typeof fetch = async (input) => { calls.push(String(input)); return Response.json({ usage: { cost: 0.003 } }); };
		const init = { method: 'POST', headers: { Authorization: 'Bearer explicit-key' }, body: JSON.stringify({ model: 'test-model', max_tokens: 2048 }) };
		const result = await forwardReplayModelRequest(config, `${config.baseUrl}/chat/completions`, init, fakeFetch);
		expect(calls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
		expect(result.costUsd).toBe(0.003);
		await expect(forwardReplayModelRequest(config, 'https://example.com', init, fakeFetch)).rejects.toThrow('endpoint');
		await expect(forwardReplayModelRequest(config, `${config.baseUrl}/chat/completions`, { ...init, body: JSON.stringify({ model: 'other', max_tokens: 9000 }) }, fakeFetch)).rejects.toThrow('unbounded');
		let forwardedBody: Record<string, unknown> = {};
		await forwardReplayModelRequest(config, `${config.baseUrl}/chat/completions`, { ...init, body: JSON.stringify({ model: 'test-model' }) }, async (_url, request) => {
			forwardedBody = JSON.parse(String(request?.body));
			return Response.json({ usage: { cost: 0.003 } });
		});
		expect(forwardedBody.max_tokens).toBe(4096);
	});

	it('reports unavailable model cost separately and fails a required cost gate', async () => {
		const config = replayModelConfig('test-model', 'openai', 'explicit-key')!;
		const fakeFetch: typeof fetch = async () => Response.json({ usage: { prompt_tokens: 123 } });
		const result = await forwardReplayModelRequest(config, `${config.baseUrl}/chat/completions`, { headers: { Authorization: 'Bearer explicit-key' }, body: JSON.stringify({ model: 'test-model', max_tokens: 2048 }) }, fakeFetch);
		expect(result.costUsd).toBeNull();
		const scenario = parseReplayScenarioJsonl('{"id":"cost","storyFixture":"court-intrigue","playerAction":"Give Mara the letter.","maxCostUsd":0.02}')[0];
		expect(scoreReplayResult(scenario, { estimatedCostUsd: result.costUsd }).findings).toEqual([{ passed: false, label: 'max cost (unavailable)', detail: 'unknown/0.02' }]);
	});

	it('rejects malformed expectations instead of silently dropping evaluation gates', () => {
		const base = { id: 'invalid', storyFixture: 'court-intrigue', playerAction: 'Give Mara the letter.' };
		expect(() => parseReplayScenarioJsonl(JSON.stringify({ ...base, mustNotRevealFactIds: 'secret' }), 'bad.jsonl')).toThrow('bad.jsonl:1');
		expect(() => parseReplayScenarioJsonl(JSON.stringify({ ...base, mustIncludeFactIds: [''] }))).toThrow('mustIncludeFactIds');
		expect(() => parseReplayScenarioJsonl(JSON.stringify({ ...base, maxCostUsd: -1 }))).toThrow('maxCostUsd');
	});

	it('distinguishes private narrator context from visible disclosure and explicit prompt exclusions', () => {
		const scenario = parseReplayScenarioJsonl('{"id":"privacy","storyFixture":"court-intrigue","playerAction":"Give Mara the letter.","mustIncludeFactIds":["poisoner_identity"],"mustNotRevealFactIds":["poisoner_identity"],"mustNotIncludeFactIds":["foreign_story_fact"]}')[0];
		expect(scoreReplayResult(scenario, { includedFactIds: ['poisoner_identity'], revealedFactIds: [] }).passed).toBe(true);
		expect(scoreReplayResult(scenario, { includedFactIds: ['poisoner_identity'], revealedFactIds: ['poisoner_identity'] }).passed).toBe(false);
		expect(scoreReplayResult(scenario, { includedFactIds: ['poisoner_identity', 'foreign_story_fact'] }).passed).toBe(false);
	});

	it('parses scenario jsonl with useful line errors', () => {
		const scenarios = parseReplayScenarioJsonl([
			'{"id":"npc-does-not-know-secret-001","storyFixture":"court-intrigue","playerAction":"Ask Mara who poisoned the envoy.","mustIncludeFactIds":["mara_location"],"mustNotRevealFactIds":["poisoner_identity"],"expectedStatePatch":{"relationshipChanges":[],"newCanonicalFacts":[]},"maxCostUsd":0.03}',
			'',
		].join('\n'), 'evals/scenarios/basic-continuity.jsonl');

		expect(scenarios).toEqual([
			{
				id: 'npc-does-not-know-secret-001',
				storyFixture: 'court-intrigue',
				playerAction: 'Ask Mara who poisoned the envoy.',
				mustIncludeFactIds: ['mara_location'],
				mustNotRevealFactIds: ['poisoner_identity'],
				expectedStatePatch: {
					relationshipChanges: [],
					newCanonicalFacts: [],
				},
				maxCostUsd: 0.03,
			},
		]);
		expect(() => parseReplayScenarioJsonl('{"id":""}', 'bad.jsonl')).toThrow('bad.jsonl:1');
	});

	it('scores deterministic replay expectations before any llm judging', () => {
		const scenario = parseReplayScenarioJsonl('{"id":"state-001","storyFixture":"fixture","playerAction":"Give Mara the letter.","mustIncludeFactIds":["mara_present"],"mustNotRevealFactIds":["poisoner_identity"],"expectedStatePatch":{"newCanonicalFacts":["mara_has_letter"]},"maxCostUsd":0.02}')[0];

		const passing = scoreReplayResult(scenario, {
			includedFactIds: ['mara_present'],
			revealedFactIds: [],
			statePatch: { newCanonicalFacts: ['mara_has_letter'] },
			estimatedCostUsd: 0.012,
			cachedInputTokens: 1200,
			timeToFirstTokenMs: 450,
			totalLatencyMs: 1200,
		});
		const failing = scoreReplayResult(scenario, {
			includedFactIds: [],
			revealedFactIds: ['poisoner_identity'],
			statePatch: { newCanonicalFacts: [] },
			estimatedCostUsd: 0.03,
		});

		expect(passing.passed).toBe(true);
		expect(passing.metrics).toMatchObject({
			estimatedCostUsd: 0.012,
			cachedInputTokens: 1200,
			timeToFirstTokenMs: 450,
			totalLatencyMs: 1200,
		});
		expect(failing.passed).toBe(false);
		expect(failing.findings.map((finding) => finding.label)).toEqual([
			'include fact mara_present',
			'do not reveal fact poisoner_identity',
			'expected state patch',
			'max cost',
		]);
	});
});
