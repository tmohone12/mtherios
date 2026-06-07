import { describe, expect, it } from 'vitest';

// @ts-ignore The benchmark helper is a plain ESM script module exercised through Vitest.
const {
	buildBenchCampaignBootstrapCommandRequest,
	buildBenchCampaignStatusCommandRequest,
	buildBenchTranscriptPageCommandRequest,
	buildBenchTurnCommandRequest,
	buildBenchWorldSimCommandRequest,
	buildLongCampaignBenchmark,
	unwrapBenchTurnPayload,
	unwrapBenchWorldSimPayload,
	verifyDbLongCampaignBenchmark,
} = await import('../../../../scripts/bench-generation-core.mjs') as {
	buildBenchCampaignBootstrapCommandRequest: (args: Record<string, unknown>) => {
		requestPath: string;
		body: Record<string, unknown>;
	};
	buildBenchCampaignStatusCommandRequest: (args: Record<string, unknown>) => {
		requestPath: string;
		body: Record<string, unknown>;
	};
	buildBenchTranscriptPageCommandRequest: (args: Record<string, unknown>) => {
		requestPath: string;
		body: Record<string, unknown>;
	};
	buildBenchTurnCommandRequest: (args: Record<string, unknown>) => {
		requestPath: string;
		body: Record<string, unknown>;
		timeoutMs: number;
	};
	buildBenchWorldSimCommandRequest: (args: Record<string, unknown>) => {
		requestPath: string;
		body: Record<string, unknown>;
	};
	buildLongCampaignBenchmark: (args: Record<string, unknown>) => Record<string, any>;
	unwrapBenchTurnPayload: (payload: unknown) => Record<string, unknown>;
	unwrapBenchWorldSimPayload: (payload: unknown) => Record<string, unknown>;
	verifyDbLongCampaignBenchmark: (args: Record<string, unknown>) => Record<string, any>;
};

describe('generation benchmark turn mode', () => {
	it('routes benchmark world-sim jobs through the engine command gateway', () => {
		const request = buildBenchWorldSimCommandRequest({
			storyId: 'story_alpha',
			workerId: 'bench_worker',
			localVersion: 4,
		});

		expect(request).toEqual({
			requestPath: '/api/engine/command',
			body: {
				storyId: 'story_alpha',
				command: 'jobs.worldSim',
				args: {
					workerId: 'bench_worker',
					localVersion: 4,
					force: true,
				},
			},
		});

		expect(unwrapBenchWorldSimPayload({
			commandId: 'cmd_world',
			command: 'jobs.worldSim',
			status: 'succeeded',
			result: { ok: true, jobId: 'job_1' },
		})).toEqual({ ok: true, jobId: 'job_1' });
	});

	it('routes benchmark turns through the engine command gateway', () => {
		const request = buildBenchTurnCommandRequest({
			storyId: 'story_alpha',
			playerText: 'Ask what changed in the city.',
			localVersion: 4,
		});

		expect(request).toEqual({
			requestPath: '/api/engine/command',
			timeoutMs: 180_000,
			body: {
				storyId: 'story_alpha',
				command: 'turn.submit',
				clientCommandId: expect.stringMatching(/^bench_/),
				args: {
					storyId: 'story_alpha',
					clientTurnId: expect.stringMatching(/^bench_/),
					playerText: 'Ask what changed in the city.',
					localVersion: 4,
					clientContext: {},
				},
			},
		});
	});

	it('unwraps engine command turn results for existing benchmark timing output', () => {
		expect(unwrapBenchTurnPayload({
			commandId: 'cmd_1',
			command: 'turn.submit',
			status: 'succeeded',
			result: {
				narration: 'The city stirs.',
				timings: { phases: [{ phase: 'turn.generate', durationMs: 1200 }] },
				generationTimings: [{ operation: 'narration', durationMs: 900 }],
			},
		})).toEqual({
			narration: 'The city stirs.',
			timings: { phases: [{ phase: 'turn.generate', durationMs: 1200 }] },
			generationTimings: [{ operation: 'narration', durationMs: 900 }],
		});
	});

	it('keeps the deterministic 10k-turn benchmark bounded for projections, prompts, and cache invalidation', () => {
		const result = buildLongCampaignBenchmark({
			turns: 10_000,
			entryLimit: 80,
			promptLimit: 120,
		});

		expect(result.ok).toBe(true);
		expect(result.turns).toBe(10_000);
		expect(result.entryCount).toBe(20_000);
		expect(result.projection).toEqual(expect.objectContaining({
			limit: 80,
			selected: 80,
			firstPosition: 19_920,
			lastPosition: 19_999,
		}));
		expect(result.prompt).toEqual(expect.objectContaining({
			limit: 120,
			selected: 120,
			firstPosition: 19_880,
			lastPosition: 19_999,
		}));
		expect(result.cache.warmAssembly.hits).toBe(result.cache.stableSegmentCount);
		expect(result.cache.afterCharacterEdit.changedKeys).toEqual(['character_sheet:party']);
	});

	it('builds gateway requests for a DB-backed long-campaign benchmark', () => {
		expect(buildBenchCampaignStatusCommandRequest({
			storyId: 'story_seed',
			entryLimit: 80,
			clientCommandId: 'cmd_status',
		})).toEqual({
			requestPath: '/api/engine/command',
			body: {
				storyId: 'story_seed',
				command: 'campaign.status',
				clientCommandId: 'cmd_status',
				args: { entryLimit: 80 },
			},
		});

		expect(buildBenchTranscriptPageCommandRequest({
			storyId: 'story_seed',
			limit: 80,
			clientCommandId: 'cmd_transcript',
		})).toEqual({
			requestPath: '/api/engine/command',
			body: {
				storyId: 'story_seed',
				command: 'campaign.transcriptPage',
				clientCommandId: 'cmd_transcript',
				args: { limit: 80 },
			},
		});

		expect(buildBenchCampaignBootstrapCommandRequest({
			storyId: 'story_seed',
			entryLimit: 80,
			clientCommandId: 'cmd_bootstrap',
		}).body).toEqual(expect.objectContaining({
			storyId: 'story_seed',
			command: 'campaign.bootstrap',
			clientCommandId: 'cmd_bootstrap',
			args: expect.objectContaining({ entryLimit: 80, entityLimit: 1 }),
		}));
	});

	it('verifies DB-backed long-campaign projections and transcript pages are bounded', () => {
		const entries = Array.from({ length: 80 }, (_, index) => ({
			id: `entry_${19_920 + index}`,
			position: 19_920 + index,
		}));

		const result = verifyDbLongCampaignBenchmark({
			turns: 10_000,
			entryLimit: 80,
			transcriptLimit: 80,
			status: {
				counts: { entries: 20_000 },
				entries,
			},
			transcript: {
				entryCount: 20_000,
				entries,
				hasMore: true,
				nextBeforePosition: 19_920,
			},
			bootstrap: {
				entryCount: 20_000,
				entries,
				projection: {
					counts: { entries: 20_000 },
					entries,
				},
			},
		});

		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.projection).toEqual(expect.objectContaining({
			limit: 80,
			length: 80,
			firstPosition: 19_920,
			lastPosition: 19_999,
		}));
		expect(result.transcript).toEqual(expect.objectContaining({
			limit: 80,
			length: 80,
			hasMore: true,
			nextBeforePosition: 19_920,
		}));
		expect(result.bootstrap).toEqual(expect.objectContaining({
			entryCount: 20_000,
			projectionCountEntries: 20_000,
			selectedLength: 80,
		}));
	});
});
