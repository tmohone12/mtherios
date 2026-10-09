import { afterEach, describe, expect, it } from 'vitest';
import { strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
import { settings } from './settings.svelte';
import { story } from './story.svelte';

function promptStory() {
	return {
		id: 'story_strategic_prompt', title: 'Strategic Prompt', description: null, genre: null,
		templateId: null, mode: 'adventure' as const, createdAt: 1, updatedAt: 1, settings: null,
		memoryConfig: null, retryState: null, styleReviewState: null, timeTracker: null,
		currentBranchId: null, currentBgImage: null, headerPrompt: null,
		lastWorldSimDay: null, compactedLore: null, compactedLoreHistory: null, meters: null,
	};
}

function frame(title: string, id: string) {
	return strategicWorldFrameSchema.parse({
		id: `frame_${id}`,
		storyId: 'story_strategic_prompt',
		narratorPromptCard: `Frame-level ${title} secret should not leak.`,
		plotCards: [{
			id, title, logline: `${title} creates visible pressure.`,
			lifecycleStage: 'simmer', urgency: 'emerging', visibility: 'player_known', pressure: 50,
			playerTouchpoints: ['visible receipts'], antiRailroadNotes: ['Do not force travel.'],
		}],
		activationPlan: { activateNow: [id] },
	});
}

describe('browser narrator strategic pressure', () => {
	afterEach(() => story.clear());

	it('leaves Director cue selection to the server turn', () => {
		story.currentStory = promptStory();
		story.campaignProjection = {
			story: {
				id: 'story_strategic_prompt',
				currentTurn: 10,
				metadata: {
					plotBrain: {
						lastFrame: frame('Applied Levy', 'plot_applied'),
						lastFrameId: 'frame_plot_applied',
						lastFrameTurn: 9,
						pendingFrame: frame('Pending Coup', 'plot_pending'),
					},
				},
			},
		} as never;

		const prompt = story.buildSystemPrompt();

		expect(prompt).not.toContain('## Plot Director Pressure');
		expect(prompt).not.toContain('Applied Levy');
		expect(prompt).not.toContain('Pending Coup');
		expect(prompt).not.toContain('Frame-level Applied Levy secret');
		expect(story.lastPromptSectionUsage?.strategicPressure).toBeUndefined();
	});

	it('does not inject an unversioned legacy frame or a pending Plot Director draft', () => {
		story.currentStory = promptStory();
		story.campaignProjection = {
			story: {
				id: 'story_strategic_prompt',
				metadata: {
					strategicWorldFrame: frame('Legacy Applied Levy', 'plot_legacy'),
					plotBrain: { pendingFrame: frame('Pending Coup', 'plot_pending') },
				},
			},
		} as never;

		const prompt = story.buildSystemPrompt();

		expect(prompt).not.toContain('Legacy Applied Levy');
		expect(prompt).not.toContain('Pending Coup');
	});

	it('keeps unselected world-simulation pressure out of browser narration', () => {
		story.currentStory = promptStory();
		const snapshot = {
			arcs: [], chapters: [], storyBeats: [], currentLocation: null, presentCharacters: [], equippedItems: [],
			activeAgreements: [], recentWorldEvents: [], reachableRumors: [], factionActions: [
				{ status: 'active', urgency: 'critical', factionName: 'Distant Court', action: 'Send an unsought envoy.' },
			], relevantFactions: [], retrievedEntries: [], retrievedChapters: [], retrievedChapterReason: null,
			relevantConversationMemories: [], backendMemoryPacket: null, backendMemoryIds: [], backendMemoryDebug: [],
			worldSim: { worldNarrative: 'An unrelated war begins.', worldTension: 10,
				plotInjection: { prose: 'Interrupt the meal.', urgency: 'immediate' }, plotSeeds: ['A new courier arrives.'],
				seasonEffect: { narrativeNote: 'Rain falls outside.' } }, threads: [],
		} as never;
		const prompt = story.buildSystemPrompt(snapshot);
		expect(prompt).not.toContain('Send an unsought envoy');
		expect(prompt).not.toContain('Interrupt the meal');
		expect(prompt).not.toContain('A new courier arrives');
		expect(prompt).not.toContain('An unrelated war begins');
		expect(prompt).toContain('Rain falls outside.');
	});

	it('keeps antagonist scheme pressure out of browser narration', () => {
		story.currentStory = promptStory();
		story.schemes = [{ id: 'secret_scheme', storyId: 'story_strategic_prompt', ownerType: 'faction',
			ownerEntryId: 'house_a', ownerName: 'House A', goal: 'Seize the harbor', trigger: 'old insult',
			triggerChapter: 1, triggerEntryId: null, stages: [{ index: 0, label: 'Ambush', hook: 'Attack at breakfast',
				condition: 'time', conditionPayload: {}, completed: false, completedAt: null }], currentStageIndex: 0,
			pressure: 95, status: 'active', secrecy: 'secret', nextTickAtDay: null, branchId: null,
			createdAt: 1, updatedAt: 1 }] as never;
		const prompt = story.buildSystemPrompt();
		expect(prompt).not.toContain('Attack at breakfast');
		expect(prompt).not.toContain('Seize the harbor');
	});

	it('selects factions by player topic or a present member instead of remote standing', async () => {
		story.currentStory = promptStory();
		story.characters = [{ id: 'harbor_clerk', name: 'Harbor Clerk', status: 'active', relationship: 'neutral' }] as never;
		story.lorebookEntries = [
			{ id: 'distant_court', type: 'faction', name: 'Distant Court', aliases: ['Silver Court'], description: 'A remote court.',
				state: { type: 'faction', playerStanding: -95, status: 'hostile', knownMembers: [] } },
			{ id: 'harbor_guild', type: 'faction', name: 'Harbor Guild', description: 'The clerk’s guild.',
				state: { type: 'faction', playerStanding: 0, status: 'neutral', knownMembers: ['harbor_clerk'] } },
			{ id: 'new_consulate', type: 'faction', name: 'New Consulate', description: 'An imported civic council.', state: null },
		] as never;
		story.factionActions = [{ factionName: 'Distant Court', action: 'Send an unsought envoy.' }] as never;
		const priorLimit = settings.uiSettings.retrievedLoreEntryLimit;
		settings.uiSettings.retrievedLoreEntryLimit = 0;
		try {
			const quiet = await story.buildStateSnapshot('I buy breakfast.');
			expect(quiet.relevantFactions.map(faction => faction.id)).toEqual(['harbor_guild']);
			const prompt = story.buildSystemPrompt(quiet);
			expect(prompt).not.toContain('Distant Court');
			expect(prompt).not.toContain('Send an unsought envoy');
			expect(prompt).toContain('Harbor Guild');
			const inquiry = await story.buildStateSnapshot('I ask about the Distant Court.');
			expect(inquiry.relevantFactions.map(faction => faction.id)).toContain('distant_court');
			const aliasInquiry = await story.buildStateSnapshot('Who rules the Silver Court?');
			expect(aliasInquiry.relevantFactions.map(faction => faction.id)).toContain('distant_court');
			const importedInquiry = await story.buildStateSnapshot('Who leads the New Consulate?');
			expect(story.buildSystemPrompt(importedInquiry)).toContain('An imported civic council.');
		} finally {
			settings.uiSettings.retrievedLoreEntryLimit = priorLimit;
		}
	});

	it('keeps unselected open threads and old beats out of a browser scene', () => {
		story.currentStory = promptStory();
		const snapshot = {
			arcs: [{ arcNumber: 1, title: 'Harbor Days', chapterRange: '1–2', summary: 'The harbor remained busy.',
				unresolvedThreads: ['Remote coup begins tonight'], keyPlotPoints: [], characterArcs: [], chapterIds: [] }],
			chapters: [], storyBeats: [{ status: 'active', title: 'Remote raid planned' }],
			threads: [{ status: 'imminent', significance: 'critical', description: 'A courier demands an audience elsewhere.', updatedAt: 1 }],
			activeAgreements: [{ id: 'promise_map', category: 'promise', parties: ['Mara', 'Player'], terms: 'Deliver the map.', secrecy: 'public' }],
			currentLocation: null, presentCharacters: [], equippedItems: [], recentWorldEvents: [], reachableRumors: [],
			factionActions: [], relevantFactions: [], retrievedEntries: [], retrievedChapters: [], retrievedChapterReason: null,
			relevantConversationMemories: [], backendMemoryPacket: null, backendMemoryIds: [], backendMemoryDebug: [], worldSim: null,
		} as never;
		const prompt = story.buildSystemPrompt(snapshot);
		expect(prompt).not.toContain('Remote coup begins tonight');
		expect(prompt).not.toContain('Remote raid planned');
		expect(prompt).not.toContain('A courier demands an audience elsewhere');
		expect(prompt).toContain('Deliver the map.');
		expect(prompt).toContain('The harbor remained busy.');
	});

	it('shows applied scene effects without pulling in remote events or hidden causes', async () => {
		story.currentStory = promptStory();
		story.locations = [{ id: 'hall', name: 'Great Hall', current: true }] as never;
		story.characters = [{ id: 'mara', name: 'Mara', status: 'active', relationship: 'neutral' }] as never;
		const effect = (description: string, targetEntityId: string | null, targetEntityName: string) => ({
			description, targetEntityId, targetEntityName, status: 'applied',
		});
		const event = (id: string, name: string, description: string, consequences: ReturnType<typeof effect>[], appliedAt: number) => ({
			id, name, description, consequences, appliedAt,
		});
		story.worldEvents = [
			event('local', 'Secret Harbor Sabotage', 'A hidden order caused the damage.', [
				effect('The hall doors are blocked.', 'hall', 'Great Hall'),
				effect('Mara sees the broken lock.', 'mara', 'Mara'),
				effect('A distant garrison mobilizes.', 'garrison', 'Distant Garrison'),
			], 2),
			event('remote', 'Distant War', 'Armies gather beyond the sea.', [
				effect('The distant army advances.', 'army', 'Distant Army'),
			], 3),
			event('untargeted', 'Unplaced Danger', 'An unknown plot is underway.', [
				effect('An unknown consequence occurs.', null, ''),
			], 4),
		] as never;
		const quiet = await story.buildStateSnapshot('I speak with Mara about breakfast.');
		expect(quiet.recentWorldEvents.map(row => row.id)).toEqual(['local']);
		const prompt = story.buildSystemPrompt(quiet);
		expect(prompt).toContain('The hall doors are blocked.');
		expect(prompt).toContain('Mara sees the broken lock.');
		expect(prompt).not.toContain('Secret Harbor Sabotage');
		expect(prompt).not.toContain('A hidden order caused the damage.');
		expect(prompt).not.toContain('A distant garrison mobilizes.');
		expect(prompt).not.toContain('Distant War');
		expect(prompt).not.toContain('Unplaced Danger');
		const inquiry = await story.buildStateSnapshot('What happened in the Distant War?');
		expect(inquiry.recentWorldEvents.map(row => row.id)).toEqual(['remote', 'local']);
		expect(story.buildSystemPrompt(inquiry)).toContain('Armies gather beyond the sea.');
		expect(story.buildSystemPrompt(inquiry)).not.toContain('The distant army advances.');
	});

	it('uses stored reachable rumors without reviving stale or secret world-simulation output', async () => {
		story.currentStory = promptStory();
		story.locations = [{ id: 'hall', name: 'Great Hall', current: true }] as never;
		const rumor = (id: string, spreadRadius: 'local' | 'regional', originRegion: string, status = 'spreading') => ({
			id, storyId: 'story_strategic_prompt', content: id, truthfulness: 0.5, originRegion,
			spreadRadius, sourceType: 'gossip', relatedFaction: null, chapterNumber: null,
			staleAfterChapters: 5, status, createdAt: 1,
		});
		story.rumors = [
			rumor('Hall ledger rumor', 'local', 'Great Hall'),
			rumor('Distant alley rumor', 'local', 'Distant Alley'),
			rumor('Regional ferry rumor', 'regional', 'Riverlands'),
			rumor('Stale tax rumor', 'regional', 'Riverlands', 'stale'),
			rumor('Debunked watch rumor', 'regional', 'Riverlands', 'debunked'),
		] as never;
		const snapshot = await story.buildStateSnapshot();
		expect(snapshot.reachableRumors.map(row => row.content)).toEqual(['Hall ledger rumor', 'Regional ferry rumor']);
		const prompt = story.buildSystemPrompt(snapshot);
		expect(prompt).toContain('These are claims. Mention one only when the current exchange naturally raises it.');
		expect(prompt).toContain('Hall ledger rumor');
		expect(prompt).not.toContain('Distant alley rumor');
		expect(prompt).not.toContain('Stale tax rumor');
		expect((story as any).serverMemoryNodeToRumor({ visibility: 'secret', metadata: { sourceType: 'rumor_import' }, content: 'Private rumor' })).toBeNull();
	});
});
