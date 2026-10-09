import { describe, expect, it } from 'vitest';
import { buildStrategicWorldBrainSystemPrompt, buildStrategicWorldBrainUserPrompt } from './strategicWorldBrainInput';

const STATE_TAXONOMY = 'Faction goals define why a faction fights; schemes define how they try to win; story threads define how the war becomes player-facing plot; world events record what actually happened.';

describe('buildStrategicWorldBrainUserPrompt', () => {
	it('retains current faction consequences and commitments when bulk dossiers exceed the budget', () => {
		const scheme = { id: 'project_active', ownerName: 'Harbor Council', ownerType: 'faction', status: 'active', secrecy: 'known', pressure: 20, goal: 'Deliver the agreed grain.', stages: [], currentStageIndex: 0 };
		const prompt = buildStrategicWorldBrainUserPrompt({
			story: { id: 'story', title: 'Harbor' }, trigger: 'manual', mode: 'adventure', pov: 'second', tense: 'present',
			currentArc: null, recentArcs: [], relevantOlderArcs: [], currentArcChapters: [], recentChapters: [],
			recentEntries: [{ id: 'latest', type: 'narration', content: 'The treaty is signed and the siege is over.' }],
			factions: [], characters: Array.from({ length: 32 }, (_, i) => ({ id: `character_${i}`, name: `Character ${i}`, state: { currentDisposition: 'Long unrelated history. '.repeat(120) } })),
			activeSchemes: [scheme], recentlyResolvedSchemes: [{ ...scheme, id: 'project_done', status: 'resolved', goal: 'The old embargo is settled.' }],
			factionActions: [{ id: 'action_compact', factionName: 'Harbor Council', action: 'The council honors the compact.', actionType: 'diplomatic', urgency: 'low' }],
			worldEvents: [{ id: 'event_grain', name: 'Grain arrives', description: 'The first promised shipment reaches the quay.', consequences: [] }],
			agreements: [{ id: 'treaty', parties: ['Harbor Council', 'Eastern House'], category: 'treaty', status: 'active', secrecy: 'known', terms: 'Keep the harbor open.' }],
			storyThreads: [], rumors: [], previousStrategicFrame: null, contextBudget: 8000,
		} as any, { fastDraft: true });
		expect(prompt).toContain('[Context truncated to configured budget.]');
		for (const value of ['The treaty is signed and the siege is over.', '[id:action_compact]', 'The council honors the compact.', '[id:event_grain]', 'Keep the harbor open.', 'Deliver the agreed grain.', 'The old embargo is settled.', 'BUILD THE NEXT STRATEGIC WORLD FRAME']) expect(prompt).toContain(value);
		expect(prompt.length).toBeLessThanOrEqual(32000);
	});
	it('surfaces sourced independent NPC moves beside the newest story front', () => {
		const prompt = buildStrategicWorldBrainUserPrompt({
			story: { id: 'story', title: 'Harbor' }, trigger: 'manual', mode: 'adventure', pov: 'second', tense: 'present',
			currentArc: null, recentArcs: [], relevantOlderArcs: [], currentArcChapters: [], recentChapters: [],
			recentEntries: [{ id: 'latest', type: 'narration', content: 'The king asks after the city.' }],
			worldEvents: [{ id: 'event_npc_background_1', name: 'Vaeron prepares', description: 'Vaeron offers a new charter to lesser houses.', consequences: [] }],
			factions: [], characters: [], activeSchemes: [], recentlyResolvedSchemes: [], storyThreads: [], rumors: [], agreements: [], factionActions: [], previousStrategicFrame: null,
		} as any, { fastDraft: true });
		expect(prompt.indexOf('The king asks after the city.')).toBeLessThan(prompt.indexOf('Vaeron offers a new charter'));
		expect(prompt).toContain('RECENT INDEPENDENT NPC MOVES');
	});

	it('keeps the scene body, relevant large-cast dossiers and every citable evidence ID', () => {
		const characters = Array.from({ length: 45 }, (_, i) => ({ id: `extra_${i}`, name: `Extra ${i}`, state: {} }));
		characters.push({ id: 'zhen', name: 'Vermillion Zhen Lian', state: { background: 'The empress', traits: ['calculating'], speechStyle: 'Measured' } }, { id: 'player', name: 'Player', state: {} });
		const prompt = buildStrategicWorldBrainUserPrompt({
			story: { id: 'story', title: 'Audit' }, trigger: 'manual', currentArc: null,
			recentArcs: [{ id: 'arc-id', arcNumber: 1, title: 'Arc', chapterRange: '1-2', summary: 'Earlier events.' }], relevantOlderArcs: [], currentArcChapters: [],
			recentChapters: [{ id: 'chapter-id', number: 2, title: 'Chapter', summary: 'Events.' }],
			recentEntries: [{ id: 'entry-id', type: 'narration', content: `[ Time 14:10 | Location ${'Palace '.repeat(100)} | Weather Clear ]\nZhen closes the fan. ${'The courtiers wait. '.repeat(60)}The inspection is finished.` }],
			characters, factions: [], activeSchemes: [], recentlyResolvedSchemes: [], storyThreads: [],
			worldEvents: [{ id: 'event-id', name: 'Observed event', description: 'An event.' }],
			rumors: [{ id: 'rumor-id', content: 'A rumor', status: 'active' }],
			agreements: [{ id: 'agreement-id', parties: ['A', 'B'], terms: 'Terms', status: 'active' }],
			factionActions: [], previousStrategicFrame: null, mode: 'adventure', pov: 'second', tense: 'present',
		} as any);
		for (const id of ['zhen', 'player', 'arc-id', 'chapter-id', 'event-id', 'rumor-id', 'agreement-id']) expect(prompt).toContain(`[id:${id}]`);
		expect(prompt).toContain('Zhen closes the fan.');
		expect(prompt).toContain('The inspection is finished.');
		expect(prompt).toContain('Personality: calculating');
		expect(prompt).toContain('Voice: Measured');
	});

	it('includes character operational state dossiers', () => {
		const prompt = buildStrategicWorldBrainUserPrompt({
			story: {
				id: 'story-1',
				title: 'Storm Ledger',
				description: 'A political fantasy test story.',
			},
			trigger: 'manual_debug_run',
			currentArc: null,
			recentArcs: [],
			relevantOlderArcs: [],
			currentArcChapters: [],
			recentChapters: [],
			recentEntries: [],
			factions: [],
			characters: [{
				id: 'char-mira',
				name: 'Mira Velaryon',
				type: 'character',
				description: 'A sea captain.',
				hiddenInfo: 'She has already opened talks with a rival admiral.',
				aliases: [],
				state: {
					type: 'character',
					isPresent: false,
					lastSeenLocation: null,
					currentDisposition: 'publicly cordial',
					relationship: { level: 35, status: 'trusted', history: [] },
					knownFacts: ['The player paid the harbor debt.'],
					revealedSecrets: [],
					bio: 'Mira commands a lean fleet and understands court finance.',
					motivations: ['Secure her fleet payroll'],
					personality: 'Courteous, exacting, and slow to forgive.',
					pressures: ['sailors have gone unpaid for two months'],
					factionTags: ['House Velaryon'],
				},
			}],
			activeSchemes: [],
			recentlyResolvedSchemes: [],
			storyThreads: [],
			worldEvents: [],
			rumors: [],
			agreements: [],
			factionActions: [],
			playerLedger: null,
			playerReputation: null,
			previousStrategicFrame: null,
			mode: 'adventure',
			pov: 'second',
			tense: 'present',
			timeTracker: null,
		} as any);

		expect(prompt).toContain('CHARACTER STATE DOSSIERS');
		expect(prompt).toContain('Mira Velaryon');
		expect(prompt).toContain('Pressures: sailors have gone unpaid for two months');
		expect(prompt).toContain('factions: House Velaryon');
		expect(prompt).toContain('factionOperations');
		expect(prompt).toContain('warPressureCard');
		expect(prompt).toContain('forward planning pass');
		expect(prompt).toContain(STATE_TAXONOMY);
	});

	it('keeps the state taxonomy in the strategic system prompt', () => {
		const prompt = buildStrategicWorldBrainSystemPrompt();
		expect(prompt).toContain(STATE_TAXONOMY);
		expect(prompt).toContain('WAR DOCTRINE');
		expect(prompt).toContain('warPressureCard');
		expect(prompt).toContain('tensionSeeds');
		expect(prompt).toContain('antagonistCandidates');
		expect(prompt).toContain('plotCards');
		expect(prompt).toContain('activationPlan');
		expect(prompt).toContain('plotBrainWritePlan');
		expect(prompt).toContain('Pressure, not rails');
		expect(prompt).toContain('distinct unresolved story tension');
		expect(prompt).toContain('Open threads preserve continuity; they are not activation orders');
	});

	it('feeds previous plot cards back as durable plot-brain memory', () => {
		const prompt = buildStrategicWorldBrainUserPrompt({
			story: { id: 'story-1', title: 'Bread Ledger', description: 'A city pressure test.' },
			trigger: 'manual_debug_run',
			currentArc: null,
			recentArcs: [],
			relevantOlderArcs: [],
			currentArcChapters: [],
			recentChapters: [],
			recentEntries: [],
			factions: [],
			characters: [],
			activeSchemes: [],
			recentlyResolvedSchemes: [],
			storyThreads: [],
			worldEvents: [],
			rumors: [],
			agreements: [],
			factionActions: [],
			playerLedger: null,
			playerReputation: null,
			previousStrategicFrame: {
				arcNumber: 2,
				publicSummary: 'The bakeries are becoming political.',
				hiddenStrategicSummary: 'A merchant ring is hiding flour.',
				fastWorldSimInstructions: 'Let prices rise in small visible increments.',
				strategicClocks: [],
				factionOperations: [],
				plotCards: [{
					id: 'plot_flour_ring',
					storyThreadId: 'thread_flour_ring',
					title: 'The Flour Ring',
					lifecycleStage: 'simmer',
					pressure: 66,
					urgency: 'emerging',
					visibility: 'rumored',
					logline: 'Merchants hide flour and blame the watch.',
					playerTouchpoints: ['bakers complain about identical invoices'],
				}],
			} as any,
			mode: 'adventure',
			pov: 'second',
			tense: 'present',
			timeTracker: null,
		} as any);

		expect(prompt).toContain('Previous plot cards');
		expect(prompt).toContain('The Flour Ring');
		expect(prompt).toContain('[thread:thread_flour_ring]');
		expect(prompt).toContain('simmer/emerging/rumored/66');
		expect(prompt).toContain('bakers complain about identical invoices');
	});

	it('keeps plot continuity ahead of oversized dossiers when applying a token budget', () => {
		const prompt = buildStrategicWorldBrainUserPrompt({
			story: { id: 'story-1', title: 'Continuity Ledger', description: 'A planner context test.' },
			trigger: 'manual_debug_run',
			currentArc: null,
			recentArcs: [],
			relevantOlderArcs: [],
			currentArcChapters: [],
			recentChapters: [],
			recentEntries: [{ id: 'entry_latest', type: 'narration', content: 'The harbor inspection ends, and the company leaves for dinner.' }],
			factions: [],
			characters: Array.from({ length: 32 }, (_, index) => ({
				id: `char-dossier-${index}`,
				name: `Dossier Character ${index}`,
				type: 'character',
				description: 'Bulk character lore.',
				hiddenInfo: null,
				aliases: [],
				state: {
					type: 'character',
					currentDisposition: `DOSSIER_BULK_${index}_${'x'.repeat(2000)}`,
				},
			})),
			activeSchemes: [],
			recentlyResolvedSchemes: [],
			storyThreads: [{
				id: 'thread-unfinished-oath',
				status: 'open',
				significance: 'major',
				description: 'The unfinished oath still binds the regent.',
			}],
			worldEvents: [],
			rumors: [],
			agreements: [],
			factionActions: [],
			playerLedger: null,
			playerReputation: null,
			retiredPlotDirectives: ['The harbor inspection plot is finished.'],
			previousStrategicFrame: {
				arcNumber: 4,
				publicSummary: 'The regent has not answered the oath.',
				hiddenStrategicSummary: 'The council is preparing a quiet challenge.',
				fastWorldSimInstructions: 'Advance the council challenge without reopening the harbor inspection.',
				strategicClocks: [],
				factionOperations: [],
				plotCards: [],
			} as any,
			mode: 'adventure',
			pov: 'second',
			tense: 'present',
			timeTracker: null,
			contextBudget: 8000,
		} as any);

		expect(prompt).toContain('[Context truncated to configured budget.]');
		expect(prompt).toContain('PREVIOUS STRATEGIC FRAME');
		expect(prompt).toContain('The regent has not answered the oath.');
		expect(prompt).toContain('RETIRED BY PLAYER - DO NOT RECREATE OR RESKIN');
		expect(prompt).toContain('The harbor inspection plot is finished.');
		expect(prompt).toContain('CURRENT STORY FRONT - NEWEST EVIDENCE');
		expect(prompt).toContain('[entry_latest; narration] The harbor inspection ends');
		expect(prompt).toContain('OPEN STORY THREADS / PLOTS / SUBPLOTS');
		expect(prompt).toContain('The unfinished oath still binds the regent.');
		expect(prompt.indexOf('PREVIOUS STRATEGIC FRAME')).toBeLessThan(prompt.indexOf('FACTION DOSSIERS AND VERBOSE GOALS'));
		expect(prompt.indexOf('CURRENT STORY FRONT')).toBeLessThan(prompt.indexOf('PREVIOUS STRATEGIC FRAME'));
		expect(prompt.indexOf('OPEN STORY THREADS / PLOTS / SUBPLOTS')).toBeLessThan(prompt.indexOf('CHARACTER STATE DOSSIERS'));
		expect(prompt.length).toBeGreaterThan(8000);
	});

	it('keeps unresolved faction member names in strategic context without making them canon', () => {
		const prompt = buildStrategicWorldBrainUserPrompt({
			story: {
				id: 'story-1',
				title: 'Border Ledger',
				description: 'A faction context test story.',
			},
			trigger: 'manual_debug_run',
			currentArc: null,
			recentArcs: [],
			relevantOlderArcs: [],
			currentArcChapters: [],
			recentChapters: [],
			recentEntries: [],
			factions: [{
				id: 'faction-ridge-watch',
				name: 'Ridge Watch',
				type: 'faction',
				description: 'A faction watching the high passes.',
				hiddenInfo: null,
				aliases: [],
				state: {
					type: 'faction',
					playerStanding: 0,
					status: 'unknown',
					knownMembers: ['char-established-ally'],
					unresolvedKnownMembers: ['Unnamed Scout'],
				},
			}],
			characters: [{
				id: 'char-established-ally',
				name: 'Established Ally',
				type: 'character',
				description: 'A known canonical ally.',
				hiddenInfo: null,
				aliases: [],
				state: { type: 'character' },
			}],
			activeSchemes: [],
			recentlyResolvedSchemes: [],
			storyThreads: [],
			worldEvents: [],
			rumors: [],
			agreements: [],
			factionActions: [],
			playerLedger: null,
			playerReputation: null,
			previousStrategicFrame: null,
			mode: 'adventure',
			pov: 'second',
			tense: 'present',
			timeTracker: null,
		} as any);

		expect(prompt).toContain('Members: Established Ally');
		expect(prompt).toContain('Unresolved member references: Unnamed Scout (review context; not character canon)');
	});
});
