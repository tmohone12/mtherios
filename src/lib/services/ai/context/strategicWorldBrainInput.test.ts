import { describe, expect, it } from 'vitest';
import { buildStrategicWorldBrainSystemPrompt, buildStrategicWorldBrainUserPrompt } from './strategicWorldBrainInput';

const STATE_TAXONOMY = 'Faction goals define why a faction fights; schemes define how they try to win; story threads define how the war becomes player-facing plot; world events record what actually happened.';

describe('buildStrategicWorldBrainUserPrompt', () => {
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
