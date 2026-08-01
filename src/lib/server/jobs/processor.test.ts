import { describe, expect, it } from 'vitest';
import { backendJobTypes, continuityAuditDedupeKey, shouldQueueTurnStoryVaultSync, turnStateExtractionDedupeKey } from './outbox';
import { selectStoryMemory } from '$lib/services/ai/context/storyMemorySelector';
import {
	backendJobStatusEventData,
	buildArcMemoryFields,
	buildArcSummary,
	buildEventMemoryNodeValues,
	chapterCharacterContextPatch,
	chapterCharacterContextProposalValues,
	chapterCharacterNamesMatch,
	chapterCharacterSummaryContextPatch,
	chapterMemoryEntityIds,
	buildChapterMemoryDigest,
	buildChapterSummary,
	chapterCharacterReferenceCandidates,
	refreshChapterCharacterContextProposalValues,
	replaceCharacterContextOperationState,
	isSupersededJobFailure,
	selectArcRollupBatches,
	shouldAutoApplyChapterCharacterContext,
	shouldProjectEventToMemory,
	storyVaultFollowupVersion,
	summarizeBackendJobs,
} from './processor';

describe('turn state extraction jobs', () => {
	it('exposes a stable background job type and dedupe key', () => {
		expect(backendJobTypes).toContain('extract_turn_state');
		expect(turnStateExtractionDedupeKey({ assistantEntryId: 'entry_assistant' })).toBe('turn-state-entry_assistant');
	});
});

describe('continuity audit jobs', () => {
	it('exposes a stable background job type and dedupe key', () => {
		expect(backendJobTypes).toContain('continuity_audit');
		expect(backendJobTypes).toContain('plan_plot_brain');
		expect(continuityAuditDedupeKey({ assistantEntryId: 'entry_assistant' })).toBe('continuity-audit-entry_assistant');
	});
});

describe('turn story vault sync cadence', () => {
	it('does not queue generated wiki sync on every turn by default', () => {
		expect(shouldQueueTurnStoryVaultSync(11, 5)).toBe(false);
		expect(shouldQueueTurnStoryVaultSync(12, 5)).toBe(false);
		expect(shouldQueueTurnStoryVaultSync(15, 5)).toBe(true);
	});

	it('can disable automatic turn wiki sync', () => {
		expect(shouldQueueTurnStoryVaultSync(20, 0)).toBe(false);
	});
});

describe('story vault sync catch-up', () => {
	it('queues the current backend version when the manifest trails canon', () => {
		expect(storyVaultFollowupVersion({
			serverVersion: 101,
			manifestVersion: 100,
		})).toBe(101);
	});

	it('queues a follow-up when no manifest exists yet', () => {
		expect(storyVaultFollowupVersion({
			serverVersion: 7,
			manifestVersion: null,
		})).toBe(7);
	});

	it('does not queue when the manifest is current or newer', () => {
		expect(storyVaultFollowupVersion({
			serverVersion: 12,
			manifestVersion: 12,
		})).toBeNull();
		expect(storyVaultFollowupVersion({
			serverVersion: 12,
			manifestVersion: 13,
		})).toBeNull();
	});
});

describe('job status summaries', () => {
	it('treats an older failed job as superseded by a newer complete job in the same story/type family', () => {
		const latestCompletedAt = new Map([['story_1:sync_story_vault', '2026-06-05T20:00:00.000Z']]);

		expect(isSupersededJobFailure({
			storyId: 'story_1',
			type: 'sync_story_vault',
			status: 'failed',
			updatedAt: '2026-06-05T19:00:00.000Z',
		}, latestCompletedAt)).toBe(true);
	});

	it('does not supersede newer failures or failures from another job family', () => {
		const latestCompletedAt = new Map([['story_1:sync_story_vault', '2026-06-05T20:00:00.000Z']]);

		expect(isSupersededJobFailure({
			storyId: 'story_1',
			type: 'sync_story_vault',
			status: 'failed',
			updatedAt: '2026-06-05T21:00:00.000Z',
		}, latestCompletedAt)).toBe(false);
		expect(isSupersededJobFailure({
			storyId: 'story_2',
			type: 'sync_story_vault',
			status: 'failed',
			updatedAt: '2026-06-05T19:00:00.000Z',
		}, latestCompletedAt)).toBe(false);
	});

	it('does not count superseded failures as active startup failures', () => {
		const rows = [
			{
				id: 'job_old_failed',
				storyId: 'story_1',
				type: 'sync_story_vault',
				status: 'failed',
				attemptCount: 3,
				maxAttempts: 3,
				runAfter: '2026-06-05T19:00:00.000Z',
				lockedAt: null,
				lockedBy: null,
				lastError: 'Missing column before migration.',
				createdAt: '2026-06-05T18:59:00.000Z',
				updatedAt: '2026-06-05T19:00:00.000Z',
			},
			{
				id: 'job_new_complete',
				storyId: 'story_1',
				type: 'sync_story_vault',
				status: 'complete',
				attemptCount: 1,
				maxAttempts: 3,
				runAfter: '2026-06-05T20:00:00.000Z',
				lockedAt: null,
				lockedBy: null,
				lastError: null,
				createdAt: '2026-06-05T20:00:00.000Z',
				updatedAt: '2026-06-05T20:10:00.000Z',
			},
		];

		expect(summarizeBackendJobs(rows).failed).toBe(0);
		expect(summarizeBackendJobs(rows).failedByType).toEqual({});
		expect(summarizeBackendJobs(rows).recentFailures).toEqual([]);
	});
});

describe('job status stream events', () => {
	it('builds a compact job status payload for the control-surface stream', () => {
		expect(backendJobStatusEventData({
			id: 'job_1',
			storyId: 'story_1',
			type: 'extract_turn_state',
			attemptCount: 2,
			maxAttempts: 3,
		}, 'completed', {
			result: { status: 'applied', patchIds: ['patch_1'] },
		})).toEqual({
			jobId: 'job_1',
			storyId: 'story_1',
			type: 'extract_turn_state',
			status: 'completed',
			attemptCount: 2,
			maxAttempts: 3,
			result: { status: 'applied', patchIds: ['patch_1'] },
		});
	});
});

describe('deterministic chapter summaries', () => {
	it('covers the beginning, middle, and ending of a full chapter window', () => {
		const entries = Array.from({ length: 12 }, (_, index) => ({
			id: `entry_${index + 1}`,
			type: index % 2 === 0 ? 'user_action' : 'narration',
			content: [
				'Opening beat: Aurion is still angry that House Balaerys sent him east.',
				'Early beat: the heat of Yin presses against the trading post.',
				'Early beat: Ser Davos and Malyrio fall into watchful silence.',
				'Middle beat: Xanda sends a lapis-sealed dinner invitation.',
				'Middle beat: the Copper Court feels rich, dangerous, and unfamiliar.',
				'Middle beat sentinel: Aurion admits the exile wound still has teeth.',
				'Middle beat: Xanda listens with polished courtly interest.',
				'Late beat: honeyed locusts arrive with the warning of poison.',
				'Late beat: Aurion jokes that Xanda may smile while deciding to kill him.',
				'Late beat sentinel: Aurion eats the locusts anyway.',
				'Ending beat: Xanda laughs and becomes more intrigued.',
				'Ending beat sentinel: romance, manipulation, and political danger remain open.',
			][index],
			position: index + 1,
		})) as any[];

		const summary = buildChapterSummary(entries, []);

		expect(summary).toContain('Opening beat: Aurion is still angry');
		expect(summary).toContain('Middle beat sentinel: Aurion admits the exile wound still has teeth.');
		expect(summary).toContain('Late beat sentinel: Aurion eats the locusts anyway.');
		expect(summary).toContain('Ending beat sentinel: romance, manipulation, and political danger remain open.');
		expect(summary).toContain('Time passed in this chapter: not established.');
		expect(summary).not.toContain('more transcript entries are covered by this checkpoint');
	});

	it('writes a continuity rollup with source coverage and tracked entity ids', () => {
		const entries = [
			{
				id: 'entry_62',
				type: 'user_action',
				content: '> I say, "Yes, Aelyx\'s younger better-looking brother."',
				position: 62,
			},
			{
				id: 'entry_63',
				type: 'narration',
				content: '[ Time 15:30 | Day 3, Seventh Moon, 295 AC | Location The Black Walls - Fountain of the First Flame | Weather Sweltering, 34 C ] Aerene teases Aurion while Serala watches from the fountain.',
				position: 63,
			},
			{
				id: 'entry_64',
				type: 'user_action',
				content: '> I ask, "Dragonlord blood?"',
				position: 64,
			},
			{
				id: 'entry_65',
				type: 'narration',
				content: '[ Time 15:31 | Day 3, Seventh Moon, 295 AC | Location The Black Walls - Fountain of the First Flame | Weather Sweltering, 34 C ] Serala explains that House Balaerys is still remembered for dragonlord blood and relics.',
				position: 65,
			},
		] as any[];
		const events = [
			{
				type: 'scene_transition',
				title: 'Turn resolved',
				body: entries[1].content,
				actorEntityIds: ['npc_serala'],
			},
			{
				type: 'scene_transition',
				title: 'Turn resolved',
				body: entries[3].content,
				actorEntityIds: ['npc_serala'],
			},
		] as any[];

		const summary = buildChapterSummary(entries, events);

		expect(summary).toContain('[CHECKPOINT = Chapter checkpoint covering transcript positions 62-65.]');
		expect(summary).toContain('[SOURCE COVERAGE =');
		expect(summary).toContain('- Transcript positions 62-65.');
		expect(summary).toContain('- 4 entries covered.');
		expect(summary).toContain('- 2 source event records.');
		expect(summary).toContain('[CURRENT SCENE = Day 3, Seventh Moon, 295 AC | 15:31 | The Black Walls - Fountain of the First Flame | Sweltering, 34 C]');
		expect(summary).toContain('[RECENT STORY STATE =');
		expect(summary).toContain('- The player character says, "Yes, Aelyx\'s younger better-looking brother."');
		expect(summary).toContain('- Serala explains that House Balaerys is still remembered for dragonlord blood and relics.');
		expect(summary).toContain('- Time passed in this chapter: a minute or less.');
		expect(summary).toContain('[CHARACTER STATE =');
		expect(summary).toContain('Serala [npc_serala]:');
		expect(summary).toContain('[ACTIVE THREADS =');
		expect(summary).toContain('[TONE TO CONTINUE = Continue from the established scene pressure, character choices, and unresolved consequences.]');
		expect(summary).not.toContain('Terminal checkpoint');
		expect(summary).not.toContain('[IMPORTANT STRINGS=');
		expect(summary).not.toContain('- - Turn resolved');
		expect(summary).not.toContain('Transcript trace:');
		expect(summary).not.toContain('not established by deterministic terminal checkpoint');
	});

	it('builds typed memory fields for the chapter editor and retrieval', () => {
		const entries = [
			{
				id: 'entry_91',
				type: 'narration',
				content: '[ Time 15:30 | Day Tenth Moon, 296 AC | Location Yi Ti, Yin, the Merchants’ Quarter, the Balaerys Trading Post | Weather Sweltering heat, 36 C ] Aurion arrives beneath date palms while Ser Davos and Malyrio watch the crowds.',
				position: 91,
			},
			{
				id: 'entry_92',
				type: 'narration',
				content: 'Xanda sends an invitation sealed in lapis-blue wax and draws Aurion toward dinner at the Copper Court.',
				position: 92,
			},
		] as any[];
		const events = [
			{
				type: 'scene_transition',
				title: 'Aurion reaches the Balaerys Trading Post in Yin',
				body: entries[0].content,
				actorEntityIds: ['pc_aurion', 'npc_ser_davos', 'npc_malyrio'],
				metadata: { location: 'Yi Ti, Yin, the Merchants’ Quarter' },
			},
			{
				type: 'relationship_shift',
				title: 'Xanda tests Aurion with courtly dinner politics',
				body: entries[1].content,
				actorEntityIds: ['pc_aurion', 'npc_xanda'],
				threadIds: ['thread_xanda_dinner'],
			},
		] as any[];

		const digest = buildChapterMemoryDigest(3, entries, events);

		expect(digest.title).toContain('Aurion reaches');
		expect(digest.summary).toContain('[CHARACTER STATE =');
		expect(digest.keyCharacters).toEqual(expect.arrayContaining(['Aurion', 'Ser Davos', 'Malyrio', 'Xanda']));
		expect(digest.keyLocations).toEqual(expect.arrayContaining(['Yi Ti, Yin, the Merchants’ Quarter']));
		expect(digest.keywords).toEqual(expect.arrayContaining(['relationship shift', 'scene transition']));
		expect(digest.plotThreads).toEqual(expect.arrayContaining(['thread_xanda_dinner', 'Xanda tests Aurion with courtly dinner politics']));
		expect(digest.emotionalTone).not.toBe('');
	});

	it('keeps long chapter windows as readable beats instead of one blocked paragraph', () => {
		const entries = Array.from({ length: 15 }, (_, index) => ({
			id: `entry_${index + 1}`,
			type: 'narration',
			content: `Readable beat ${index + 1}: Aurion and Zhen move through a distinct court consequence that must stay legible.`,
			position: index + 1,
		})) as any[];

		const summary = buildChapterSummary(entries, []);
		const openingLine = summary.split(/\r?\n/).find((line) => line.includes('Opening:'));

		expect(summary).toContain('- Opening:');
		expect(summary).toContain('- Readable beat 1: Aurion and Zhen move through a distinct court consequence');
		expect(summary).toContain('- Readable beat 5: Aurion and Zhen move through a distinct court consequence');
		expect(openingLine).toBeDefined();
		expect(openingLine?.length).toBeLessThan(80);
		expect(openingLine).not.toContain('Readable beat 2:');
	});
});

describe('deterministic arc summaries', () => {
	it('selects every full uncovered chapter batch for arc catch-up', () => {
		const chapters = Array.from({ length: 15 }, (_, index) => ({ id: `chapter_${index + 1}` }));
		const batches = selectArcRollupBatches(chapters, [{ chapterIds: ['chapter_1', 'chapter_2', 'chapter_3', 'chapter_4', 'chapter_5'] }], 5);

		expect(batches.map((batch) => batch.map((chapter) => chapter.id))).toEqual([
			['chapter_6', 'chapter_7', 'chapter_8', 'chapter_9', 'chapter_10'],
			['chapter_11', 'chapter_12', 'chapter_13', 'chapter_14', 'chapter_15'],
		]);
	});

	it('rolls chapter summaries into a cohesive arc overview instead of a chapter list', () => {
		const chapterSummary = buildChapterSummary([
			{
				id: 'entry_91',
				type: 'narration',
				content: 'Aurion reaches Yin under heat, incense, silk, trade-gold, and foreign perfume.',
				position: 91,
			},
			{
				id: 'entry_92',
				type: 'narration',
				content: 'Xanda draws him into dinner politics at the Copper Court.',
				position: 92,
			},
			{
				id: 'entry_93',
				type: 'narration',
				content: 'Arc-summary sentinel: the dinner may become romance, manipulation, political danger, or all three.',
				position: 93,
			},
		] as any[], [{
			type: 'relationship_shift',
			title: 'Xanda tests Aurion with courtly dinner politics',
			body: 'Xanda tests Aurion with courtly dinner politics.',
			actorEntityIds: ['pc_aurion', 'npc_xanda'],
			targetEntityIds: [],
			threadIds: ['thread_xanda_dinner'],
		}] as any[]);

		const summary = buildArcSummary([{
			id: 'chapter_yin',
			storyId: 'story_balaerys',
			number: 7,
			title: 'Dinner in Yin',
			sceneOutcome: chapterSummary,
			irreversibleChanges: [],
			promisesDebtsOaths: [],
			openThreads: ['thread_xanda_dinner'],
		}] as any[]);

		expect(summary).toContain('Arc overview:');
		expect(summary).toContain('Arc-summary sentinel: the dinner may become romance');
		expect(summary).toContain('Character movement:');
		expect(summary).toContain('Aurion [pc_aurion]');
		expect(summary).toContain('Open threads:');
		expect(summary).not.toMatch(/^Chapter \d+/);
		expect(summary).not.toContain('[CHECKPOINT = Chapter checkpoint');
		expect(summary).not.toContain('...');
	});

	it('derives the editable arc fields from covered chapter memory', () => {
		const chapterSummary = buildChapterSummary([
			{
				id: 'entry_91',
				type: 'narration',
				content: 'Aurion reaches Yin under heat, incense, silk, trade-gold, and foreign perfume.',
				position: 91,
			},
			{
				id: 'entry_92',
				type: 'narration',
				content: 'Xanda draws him into dinner politics at the Copper Court.',
				position: 92,
			},
			{
				id: 'entry_93',
				type: 'narration',
				content: 'Arc-field sentinel: Xanda may become ally, lover, rival, threat, or all of them.',
				position: 93,
			},
		] as any[], [{
			type: 'relationship_shift',
			title: 'Xanda tests Aurion with courtly dinner politics',
			body: 'Xanda tests Aurion with courtly dinner politics.',
			actorEntityIds: ['pc_aurion', 'npc_xanda'],
			targetEntityIds: [],
			threadIds: ['thread_xanda_dinner'],
		}] as any[]);

		const fields = buildArcMemoryFields([{
			id: 'chapter_yin',
			storyId: 'story_balaerys',
			number: 7,
			title: 'Dinner in Yin',
			sceneOutcome: chapterSummary,
			irreversibleChanges: ['Aurion accepts the danger of Xanda dinner politics'],
			promisesDebtsOaths: [],
			openThreads: ['thread_xanda_dinner'],
			metadata: { emotionalTone: 'courtly danger, flirtation, and exile ache' },
		}] as any[]);

		expect(fields.keyPlotPoints.join('\n')).toContain('Chapter 7 (Dinner in Yin):');
		expect(fields.keyPlotPoints.join('\n')).toContain('Arc-field sentinel: Xanda may become ally');
		expect(fields.characterArcs).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: 'Aurion' }),
			expect.objectContaining({ name: 'Xanda' }),
		]));
		expect(fields.unresolvedThreads).toEqual(expect.arrayContaining([
			'thread_xanda_dinner',
			'Xanda tests Aurion with courtly dinner politics',
		]));
		expect(fields.emotionalProgression).toBe('courtly danger, flirtation, and exile ache');
	});

	it('keeps generated arc rollup fields compact enough for prompt use', () => {
		const chapterSummary = [
			'[CHECKPOINT = Chapter checkpoint covering transcript positions 1-40.]',
			'[RECENT STORY STATE =',
			`- Arc-rollup opening fact survives. ${'raw checkpoint wall '.repeat(1000)} Arc-rollup tail sentinel.`,
			']',
			'[CHARACTER STATE =',
			`Aurion [pc_aurion]:\n- ${'heavy character detail '.repeat(200)} character tail sentinel.`,
			']',
			'[ACTIVE THREADS =',
			`- thread opening ${'thread filler '.repeat(200)} thread tail sentinel`,
			']',
		].join('\n');

		const fields = buildArcMemoryFields([{
			id: 'chapter_yin',
			storyId: 'story_balaerys',
			number: 7,
			title: 'Dinner in Yin',
			sceneOutcome: chapterSummary,
			irreversibleChanges: [],
			promisesDebtsOaths: [],
			openThreads: [],
			metadata: {},
		}] as any[]);
		const summary = buildArcSummary([{
			id: 'chapter_yin',
			storyId: 'story_balaerys',
			number: 7,
			title: 'Dinner in Yin',
			sceneOutcome: chapterSummary,
			irreversibleChanges: [],
			promisesDebtsOaths: [],
			openThreads: [],
			metadata: {},
		}] as any[]);

		expect(summary).toContain('Arc-rollup opening fact survives.');
		expect(summary).not.toContain('Arc-rollup tail sentinel');
		expect(summary).not.toContain('...');
		expect(fields.characterArcs[0]?.development).not.toContain('character tail sentinel');
		expect(fields.unresolvedThreads.join(' ')).not.toContain('thread tail sentinel');
		expect(summary.length).toBeLessThan(2600);
	});

	it('carries canonical chapter character tags into arc rollups', () => {
		const firstChapterEntityIds = chapterMemoryEntityIds({
			eventEntityIds: ['npc_event_actor'],
			keyCharacters: ['Kiba Yuuto', 'Red Dragon Emperor'],
			canonicalCharacters: [
				{ id: 'npc_kiba', name: 'Yuuto Kiba', state: {}, metadata: {} },
				{ id: 'npc_issei', name: 'Issei Hyoudou', state: { aliases: ['Red Dragon Emperor'] }, metadata: {} },
				{ id: 'npc_rias', name: 'Rias Gremory', state: {}, metadata: {} },
			] as any[],
		});
		const fields = buildArcMemoryFields([
			{
				number: 1,
				title: 'First',
				sceneOutcome: 'Kiba keeps watch.',
				irreversibleChanges: [],
				promisesDebtsOaths: [],
				openThreads: [],
				metadata: { trackedEntityIds: firstChapterEntityIds },
			},
			{
				number: 2,
				title: 'Second',
				sceneOutcome: 'Rias takes command.',
				irreversibleChanges: [],
				promisesDebtsOaths: [],
				openThreads: [],
				metadata: { trackedEntityIds: ['npc_rias', 'npc_kiba'] },
			},
		] as any[]);

		expect(firstChapterEntityIds).toEqual(['npc_event_actor', 'npc_kiba', 'npc_issei']);
		expect(fields.trackedEntityIds).toEqual(['npc_event_actor', 'npc_kiba', 'npc_issei', 'npc_rias']);
	});

	it('selects story memory using current and legacy character metadata', () => {
		const selected = selectStoryMemory([
			{ id: 'chapter_legacy', number: 1, title: 'First', sceneOutcome: 'Old consequence.', metadata: { legacyCharacters: ['Akeno Himejima'] } },
			{ id: 'chapter_current', number: 2, title: 'Second', sceneOutcome: 'New consequence.', metadata: { characters: ['Rias Gremory'] } },
		], [
			{ id: 'arc_tracked', number: 1, title: 'First Arc', summary: 'Long consequence.', metadata: { trackedEntityIds: ['npc_kiba'] } },
		], {
			query: 'Akeno Himejima Rias Gremory npc_kiba',
			recentCount: 0,
			relevantCount: 3,
			resurfacedCount: 0,
			tokenBudget: 800,
		});

		expect(selected.selectedIds).toEqual(expect.arrayContaining([
			'chapter:chapter_legacy',
			'chapter:chapter_current',
			'arc:arc_tracked',
		]));
	});
});

describe('event memory projection hygiene', () => {
	it('does not project deleted transcript correction events into durable memory', () => {
		expect(shouldProjectEventToMemory({
			type: 'correction',
			title: 'Transcript context removed',
			body: 'Player deleted a poisoned context message.',
		} as any)).toBe(false);
		expect(shouldProjectEventToMemory({
			type: 'promise',
			title: 'Gate promise',
			body: 'Arlan promised to open the postern gate.',
		} as any)).toBe(true);
	});

	it('projects timeline events with factions, temporal metadata, and memory-impact importance', () => {
		const values = buildEventMemoryNodeValues({
			id: 'event_secret_pact',
			storyId: 'story_balaerys',
			type: 'agreement',
			status: 'scheduled',
			title: 'A secret pact ripens',
			body: 'The harbor families will reveal their pact when the moon turns.',
			actorEntityIds: ['npc_xanda'],
			targetEntityIds: ['npc_aurion'],
			locationId: 'loc_harbor',
			locationIds: ['loc_harbor'],
			factionIds: ['faction_copper_court'],
			threadIds: ['thread_harbor_pact'],
			visibility: 'secret',
			createdTurn: 11,
			occurredTurn: null,
			scheduledTurn: 14,
			worldTime: 'Third night of the moon',
			memoryImpact: {
				importance: 0.97,
				emotionalValence: -0.35,
				emotions: ['dread', 'anticipation'],
				durability: 'long_term',
				requiresReflection: true,
			},
			sourceEntryIds: ['entry_11'],
			sourcePatchIds: ['patch_11'],
			metadata: { source: 'timeline_test' },
			serverVersion: 22,
			createdAt: '2026-06-28T10:00:00.000Z',
			updatedAt: '2026-06-28T10:05:00.000Z',
		} as any, {
			jobId: 'job_memory_projection',
			updatedAt: '2026-06-28T10:10:00.000Z',
		});

		expect(values).toMatchObject({
			id: 'mem_event_event_secret_pact',
			storyId: 'story_balaerys',
			type: 'plot_ledger',
			keywords: ['agreement', 'scheduled', 'long_term', 'requires_reflection'],
			entityIds: ['npc_xanda', 'npc_aurion'],
			factionIds: ['faction_copper_court'],
			threadIds: ['thread_harbor_pact'],
			locationId: 'loc_harbor',
			importance: 0.97,
			sourceEntryIds: ['entry_11'],
			sourceEventIds: ['event_secret_pact'],
			sourcePatchIds: ['patch_11'],
			serverVersion: 22,
			createdAt: '2026-06-28T10:00:00.000Z',
			updatedAt: '2026-06-28T10:10:00.000Z',
		});
		expect(values.metadata).toMatchObject({
			sourceType: 'event_projection',
			jobId: 'job_memory_projection',
			memoryKind: 'prospective',
			status: 'scheduled',
			validFromTurn: 11,
			occurredTurn: null,
			scheduledTurn: 14,
			worldTime: 'Third night of the moon',
			emotionalValence: -0.35,
			emotions: ['dread', 'anticipation'],
			durability: 'long_term',
			requiresReflection: true,
		});
	});
});

describe('chapter character reference candidates', () => {
	it('keeps important unresolved chapter characters and skips duplicates or one-off mentions', () => {
		const candidates = chapterCharacterReferenceCandidates({
			digest: {
				title: 'Xanda tests Aurion',
				summary: 'Aurion dines with Xanda while the boy-guide fades back into the Copper Court.',
				keywords: [],
				keyCharacters: ['Aurion', 'Xanda', 'Boy-guide', 'Consort', 'Dancer', 'Jogos Nhai warrior', 'the fire-wyrm', 'Vermillion Zhen Lian'],
				keyLocations: [],
				plotThreads: [],
				emotionalTone: 'courtly danger',
				source: 'llm',
			},
			events: [
				{
					id: 'event_1',
					title: 'Xanda invites Aurion to dinner',
					body: 'The invitation pulls Aurion into Xanda’s orbit.',
				},
				{
					id: 'event_2',
					title: 'Xanda tests Aurion with honeyed locusts',
					body: 'Xanda laughs when Aurion eats despite the warning.',
				},
				{
					id: 'event_3',
					title: 'Boy-guide haggles with the innkeep',
					body: 'The boy-guide runs ahead through the Copper Court.',
				},
				{
					id: 'event_4',
					title: 'Consort rumor spreads',
					body: 'The court calls Aurion the Consort, and the Consort title echoes through the hall.',
				},
				{
					id: 'event_5',
					title: 'Consort title repeated',
					body: 'The Consort is only a title attached to Aurion, not a separate person.',
				},
				{
					id: 'event_6',
					title: 'Dancer crosses the room',
					body: 'The dancer and the Dancer are role labels in the court scene.',
				},
				{
					id: 'event_7',
					title: 'Jogos Nhai warrior threatens the gate',
					body: 'The Jogos Nhai warrior remains an unnamed role, not a durable NPC.',
				},
				{
					id: 'event_8',
					title: 'The fire-wyrm is named',
					body: 'The fire-wyrm is a beast label, not a person in this chapter.',
				},
			],
			existingNames: ['Aurion', 'Vermillion Zhen Lian'],
		});

		expect(candidates.map((candidate) => candidate.name)).toEqual(['Xanda']);
		expect(candidates[0].sourceEventIds).toEqual(['event_1', 'event_2']);
	});
});

describe('chapter character context patches', () => {
	it('applies automatic character continuity on every second completed chapter', () => {
		expect(shouldAutoApplyChapterCharacterContext(1)).toBe(false);
		expect(shouldAutoApplyChapterCharacterContext(2)).toBe(true);
		expect(shouldAutoApplyChapterCharacterContext(3)).toBe(false);
		expect(shouldAutoApplyChapterCharacterContext(4)).toBe(true);
	});

	it('replaces only the audited character state operation before batch apply', () => {
		const operations = replaceCharacterContextOperationState([
			{ op: 'replace', path: '/characters/npc_xanda/state', value: { currentAction: 'old' } },
			{ op: 'review', path: '/unrelated', value: { keep: true } },
		], {
			currentAction: 'kept deterministic action',
			currentDisposition: 'new durable disposition',
		});

		expect(operations).toEqual([
			{
				op: 'replace',
				path: '/characters/npc_xanda/state',
				value: {
					currentAction: 'kept deterministic action',
					currentDisposition: 'new durable disposition',
				},
			},
			{ op: 'review', path: '/unrelated', value: { keep: true } },
		]);
	});

	it('turns source events into reviewable current state without erasing old memory', () => {
		const patch = chapterCharacterContextPatch({
			entityId: 'npc_xanda',
			currentState: {
				relationship: 'testing Aurion',
				eventMemory: { saw: ['Xanda watched Aurion enter the Copper Court.'] },
			},
			digest: {
				title: 'Dinner in Yin',
				summary: 'Xanda tests Aurion with dinner politics.',
				keywords: [],
				keyCharacters: ['Xanda', 'Aurion'],
				keyLocations: ['The Copper Court'],
				plotThreads: [],
				emotionalTone: 'courtly danger',
				source: 'llm',
			},
			events: [
				{
					id: 'event_1',
					type: 'relationship_shift',
					title: 'Xanda tests Aurion with honeyed locusts',
					body: 'Xanda laughs when Aurion eats despite the warning.',
					actorEntityIds: ['npc_xanda'],
					targetEntityIds: ['pc_aurion'],
				},
			] as any[],
		});

		expect(patch?.sourceEventIds).toEqual(['event_1']);
		expect(patch?.state).toMatchObject({
			relationship: 'testing Aurion',
			currentLocation: 'The Copper Court',
			currentAction: 'relationship_shift: Xanda tests Aurion with honeyed locusts - Xanda laughs when Aurion eats despite the warning.',
			eventMemory: {
				saw: ['Xanda watched Aurion enter the Copper Court.'],
				did: ['relationship_shift: Xanda tests Aurion with honeyed locusts - Xanda laughs when Aurion eats despite the warning.'],
			},
		});
	});

	it('falls back to chapter character summaries when extracted events lack entity ids', () => {
		expect(chapterCharacterNamesMatch('Yuuto Kiba', 'Kiba Yuuto')).toBe(true);
		expect(chapterCharacterNamesMatch('Kaelion', 'Kaelion Primoris')).toBe(true);
		const patch = chapterCharacterSummaryContextPatch({
			entityName: 'Yuuto Kiba',
			currentState: { eventMemory: { did: ['Chapter 18: guarded the church perimeter.'] } },
			digest: {
				title: 'The Rescue',
				summary: [
					'[CHARACTER STATE =',
					'Kiba Yuuto [unknown_entity]: Fought in the rescue with a holy sword and kept watch over Kaelion.',
					'Rias Gremory [unknown_entity]: Led the rescue against orders.',
					']',
				].join('\n'),
				keywords: [],
				keyCharacters: ['Kiba Yuuto', 'Rias Gremory'],
				keyLocations: [],
				plotThreads: [],
				emotionalTone: 'aftermath',
				source: 'llm',
			},
			chapterNumber: 19,
			events: [{ id: 'event_unlinked', actorEntityIds: [], targetEntityIds: [] }] as any[],
		});

		expect(patch).toMatchObject({
			sourceEventIds: ['event_unlinked'],
			state: {
				eventMemory: {
					did: [
						'Chapter 18: guarded the church perimeter.',
						'Chapter 19: Fought in the rescue with a holy sword and kept watch over Kaelion.',
					],
				},
			},
		});
	});

	it('builds a reusable review proposal payload for chapter character refreshes', () => {
		const values = chapterCharacterContextProposalValues({
			storyId: 'story_balaerys',
			entityId: 'npc_xanda',
			entityName: 'Xanda',
			chapterId: 'chapter_7',
			chapterNumber: 7,
			chapterTitle: 'Dinner in Yin',
			patch: {
				state: {
					currentAction: 'testing Aurion at dinner',
					eventMemory: { did: ['tested Aurion at dinner'] },
				},
				sourceEventIds: ['event_dinner'],
				did: ['tested Aurion at dinner'],
				saw: [],
			},
			sourceEntryIds: ['entry_91', 'entry_92'],
			serverVersion: 12,
			now: '2026-06-18T12:00:00.000Z',
		});

		expect(values).toMatchObject({
			id: 'proposal_chapter_character_context_story_balaerys_chapter_7_npc_xanda',
			proposalType: 'character_context_update',
			targetRecordId: 'npc_xanda',
			operations: [{
				op: 'replace',
				path: '/characters/npc_xanda/state',
				value: {
					currentAction: 'testing Aurion at dinner',
					eventMemory: { did: ['tested Aurion at dinner'] },
				},
			}],
			reason: 'Xanda appears in chapter 7: Dinner in Yin.',
			sourceEntryIds: ['entry_91', 'entry_92'],
			sourceEventIds: ['event_dinner'],
			metadata: {
				sourceType: 'chapter_character_context',
				characterName: 'Xanda',
				chapterId: 'chapter_7',
				chapterNumber: 7,
			},
		});
	});

	it('refreshes pending chapter character context proposals instead of losing newer evidence', () => {
		const values = chapterCharacterContextProposalValues({
			storyId: 'story_balaerys',
			entityId: 'npc_xanda',
			entityName: 'Xanda',
			chapterId: 'chapter_8',
			chapterNumber: 8,
			chapterTitle: 'After the Dinner',
			patch: {
				state: {
					currentAction: 'pressing Aurion after dinner',
					eventMemory: { did: ['pressed Aurion after dinner'] },
				},
				sourceEventIds: ['event_new'],
				did: ['pressing Aurion after dinner'],
				saw: [],
			},
			sourceEntryIds: ['entry_new'],
			serverVersion: 13,
			now: '2026-06-18T13:00:00.000Z',
		});

		const refreshed = refreshChapterCharacterContextProposalValues({
			operations: [{
				op: 'replace',
				path: '/characters/npc_xanda/state',
				value: {
					currentAction: 'testing Aurion at dinner',
					eventMemory: { did: ['tested Aurion at dinner'] },
				},
			}],
			sourceEntryIds: ['entry_old'],
			sourceEventIds: ['event_old'],
			metadata: { firstChapterId: 'chapter_7', chapterId: 'chapter_7' },
		}, values);

		expect(refreshed).toMatchObject({
			operations: [{
				op: 'replace',
				path: '/characters/npc_xanda/state',
				value: {
					currentAction: 'pressing Aurion after dinner',
					eventMemory: {
						did: ['tested Aurion at dinner', 'pressed Aurion after dinner'],
						saw: [],
						knew: [],
					},
				},
			}],
			sourceEntryIds: ['entry_old', 'entry_new'],
			sourceEventIds: ['event_old', 'event_new'],
			metadata: {
				firstChapterId: 'chapter_7',
				chapterId: 'chapter_8',
				chapterNumber: 8,
				refreshedFromChapterId: 'chapter_8',
				refreshedFromChapterNumber: 8,
			},
			serverVersion: 13,
			updatedAt: '2026-06-18T13:00:00.000Z',
		});
	});
});
