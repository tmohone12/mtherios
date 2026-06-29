import { describe, expect, it } from 'vitest';
import { parseReplayScenarioJsonl, scoreReplayResult } from './replayRunner';

describe('replay eval runner', () => {
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
