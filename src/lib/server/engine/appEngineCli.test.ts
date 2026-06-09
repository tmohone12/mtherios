import { describe, expect, it } from 'vitest';

// @ts-ignore The CLI is a plain ESM script module exercised through Vitest.
const { buildEngineCommandPayload, formatEngineHelp, printResult } = await import('../../../../scripts/app-engine.mjs') as {
	buildEngineCommandPayload: (argv: string[]) => {
		help?: boolean;
		requestPath: string;
		json: boolean;
		body: Record<string, unknown>;
	};
	formatEngineHelp: () => string;
	printResult: (result: Record<string, unknown>, payload: Record<string, unknown>) => void;
};

describe('app-engine CLI payload builder', () => {
	it('prints help without requiring a story id', () => {
		const payload = buildEngineCommandPayload(['help']);

		expect(payload.help).toBe(true);
		expect(formatEngineHelp()).toContain('npm run app:engine -- turn --story <storyId>');
	});

	it('builds a delayed timeline schedule command with faction and npc tags', () => {
		const payload = buildEngineCommandPayload([
			'timeline:schedule',
			'--story',
			'story_alpha',
			'--client-command-id',
			'cmd_schedule',
			'--type',
			'alliance',
			'--title',
			'Marriage alliance',
			'--body',
			'Two factions bind themselves by marriage.',
			'--delay-turns',
			'2',
			'--faction-ids',
			'faction_harbor,faction_mira',
			'--actor-npc-ids',
			'npc_mira',
			'--target-npc-ids',
			'npc_harbor_lord',
		]);

		expect(payload.requestPath).toBe('/api/engine/command');
		expect(payload.body).toEqual({
			storyId: 'story_alpha',
			command: 'timeline.schedule',
			clientCommandId: 'cmd_schedule',
			args: {
				type: 'alliance',
				title: 'Marriage alliance',
				body: 'Two factions bind themselves by marriage.',
				delayTurns: 2,
				factionIds: ['faction_harbor', 'faction_mira'],
				actorNpcEntityIds: ['npc_mira'],
				targetNpcEntityIds: ['npc_harbor_lord'],
			},
		});
	});

	it('builds a timeline advance command that can request npc-scoped due context', () => {
		const payload = buildEngineCommandPayload([
			'timeline:advance',
			'--story=story_alpha',
			'--delta=2',
			'--present-npc-ids=npc_mira,npc_harbor_lord',
			'--include-secret',
			'--json',
		]);

		expect(payload.json).toBe(true);
		expect(payload.body).toEqual({
			storyId: 'story_alpha',
			command: 'timeline.advance',
			clientCommandId: expect.stringMatching(/^cli_cmd_/),
			args: {
				delta: 2,
				presentNpcIds: ['npc_mira', 'npc_harbor_lord'],
				includeSecret: true,
			},
		});
	});

	it('builds a cache diagnostics command through the engine envelope', () => {
		const payload = buildEngineCommandPayload([
			'cache',
			'--story',
			'story_alpha',
			'--client-command-id',
			'cmd_cache',
			'--segments',
			'--segment-limit',
			'5',
			'--kind',
			'rules_pack',
			'--json',
		]);

		expect(payload.json).toBe(true);
		expect(payload.body).toEqual({
			storyId: 'story_alpha',
			command: 'campaign.cacheStatus',
			clientCommandId: 'cmd_cache',
			args: {
				includeSegments: true,
				segmentLimit: 5,
				kind: 'rules_pack',
			},
		});
	});

	it('builds campaign page read and write commands through the engine envelope', () => {
		const readPayload = buildEngineCommandPayload([
			'page:read',
			'--story',
			'story_alpha',
			'--client-command-id',
			'cmd_page_read',
			'--kind',
			'character_page',
			'--name',
			'Mira of the Harbor',
		]);
		const writePayload = buildEngineCommandPayload([
			'page:write',
			'--story',
			'story_alpha',
			'--client-command-id',
			'cmd_page_write',
			'--kind',
			'character_page',
			'--name',
			'Mira of the Harbor',
			'--body',
			'## Looks\nSalt-dark hair.',
			'--entity-ids',
			'npc_mira',
			'--source-event-ids',
			'event_alliance',
		]);

		expect(readPayload.body).toEqual({
			storyId: 'story_alpha',
			command: 'campaign.page.read',
			clientCommandId: 'cmd_page_read',
			args: {
				kind: 'character_page',
				name: 'Mira of the Harbor',
			},
		});
		expect(writePayload.body).toEqual({
			storyId: 'story_alpha',
			command: 'campaign.page.write',
			clientCommandId: 'cmd_page_write',
			args: {
				kind: 'character_page',
				name: 'Mira of the Harbor',
				body: '## Looks\nSalt-dark hair.',
				entityIds: ['npc_mira'],
				sourceEventIds: ['event_alliance'],
			},
		});
	});

	it('routes text RPG turns through the engine command envelope', () => {
		const payload = buildEngineCommandPayload([
			'turn',
			'--story',
			'story_alpha',
			'--client-command-id',
			'cmd_turn',
			'I ask who benefits from the marriage.',
		]);

		expect(payload.body).toEqual({
			storyId: 'story_alpha',
			command: 'turn.submit',
			clientCommandId: 'cmd_turn',
			args: {
				playerText: 'I ask who benefits from the marriage.',
				clientTurnId: 'cmd_turn',
			},
		});
	});

	it('builds turn preparation commands for warming backend prompt context', () => {
		const payload = buildEngineCommandPayload([
			'prepare',
			'--story',
			'story_alpha',
			'--client-command-id',
			'cmd_prepare',
			'--present-npc-ids',
			'npc_mira',
			'--memory-token-budget',
			'640',
			'I ask who benefits from the marriage.',
		]);

		expect(payload.body).toEqual({
			storyId: 'story_alpha',
			command: 'turn.prepare',
			clientCommandId: 'cmd_prepare',
			args: {
				playerText: 'I ask who benefits from the marriage.',
				clientTurnId: 'cmd_prepare',
				clientContext: {
					presentNpcIds: ['npc_mira'],
					memoryTokenBudget: 640,
				},
			},
		});
	});

	it('builds orchestrator runs through the shared engine command envelope', () => {
		const payload = buildEngineCommandPayload([
			'orchestrate',
			'--story',
			'story_alpha',
			'--client-command-id',
			'cmd_orchestrate',
			'--mode',
			'turn',
			'--goal',
			'Prepare the next text RPG response.',
			'--present-npc-ids',
			'npc_mira',
			'--scene-entity-ids',
			'npc_mira,faction_harbor',
			'--memory-token-budget',
			'640',
			'--context-budget',
			'8000',
			'--execute',
			'I ask who benefits from the marriage.',
		]);

		expect(payload.body).toEqual({
			storyId: 'story_alpha',
			command: 'orchestrator.run',
			clientCommandId: 'cmd_orchestrate',
			args: {
				mode: 'turn',
				goal: 'Prepare the next text RPG response.',
				playerText: 'I ask who benefits from the marriage.',
				clientTurnId: 'cmd_orchestrate',
				execute: true,
				context: {
					sceneEntityIds: ['npc_mira', 'faction_harbor'],
					presentNpcIds: ['npc_mira'],
					memoryTokenBudget: 640,
					contextBudget: 8000,
				},
			},
		});
	});

	it('supports arbitrary engine commands with JSON args', () => {
		const payload = buildEngineCommandPayload([
			'command',
			'--story',
			'story_alpha',
			'--command',
			'timeline.brief',
			'--args',
			'{"includeSecret":true,"dueLimit":3}',
		]);

		expect(payload.body).toEqual({
			storyId: 'story_alpha',
			command: 'timeline.brief',
			clientCommandId: expect.stringMatching(/^cli_cmd_/),
			args: {
				includeSecret: true,
				dueLimit: 3,
			},
		});
	});

	it('prints compact turn performance diagnostics for CLI speed checks', () => {
		const lines: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			lines.push(args.join(' '));
		};
		try {
			printResult({
				command: 'turn.submit',
				status: 'succeeded',
				storyId: 'story_alpha',
				commandId: 'cmd_turn',
				result: {
					narration: 'Mira answers from the harbor steps.',
					performance: {
						preparedCacheHit: true,
						prompt: {
							tokenEstimate: 1663,
							totalChars: 6652,
							messageCount: 12,
						},
						cache: {
							hitCount: 4,
							missCount: 1,
							tokenEstimate: 6000,
							segmentCount: 4,
						},
						generation: {
							operationCount: 1,
							durationMs: 900,
							requestTokens: 1000,
							responseTokens: 120,
							totalTokens: 1120,
						},
						waterfall: {},
						topSpans: [],
						slowTimings: [
							{ operation: 'turn.context_assembly', durationMs: 410 },
						],
					},
				},
			}, {
				json: false,
				body: {
					storyId: 'story_alpha',
					command: 'turn.submit',
					clientCommandId: 'cmd_turn',
				},
			});
		} finally {
			console.log = originalLog;
		}

		expect(lines.join('\n')).toContain('performance: prepared-cache hit');
		expect(lines.join('\n')).toContain('prompt: 1663 tokens, 6652 chars, 12 messages');
		expect(lines.join('\n')).toContain('cache: 4 hits, 1 misses, 4 segments, 6000 tokens');
		expect(lines.join('\n')).toContain('generation: 900ms, tokens 1000 in / 120 out / 1120 total');
		expect(lines.join('\n')).toContain('slow: turn.context_assembly 410ms');
	});
});
