import { describe, expect, it } from 'vitest';
import { appliedStrategicFrameFromProjection, storedStrategicFrameForStory, buildStrategicNarratorBlock, buildStrategicWorldSimBlock, normalizeStrategicFrameActivations, selectStrategicSceneCue } from './strategicFramePromptCard';
import { strategicEvidenceRefSchema, strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
import type { StrategicWorldFrame } from '$lib/types';

const frame = {
	storyId: 'story_alpha',
	arcNumber: 3,
	worldMood: { politicalTemperature: 'tense' },
	narratorPromptCard: 'Market rumors should create pressure without spoilers.',
	fastWorldSimInstructions: 'Let prices and rumors move first.',
	warPressureCard: null,
	factionOperations: [],
	strategicClocks: [],
	activationPlan: { activateNow: ['plot_flour_ring'], keepDormant: [], retireOrMerge: [], rationale: '' },
	plotCards: [{
		id: 'plot_flour_ring',
		title: 'The Flour Ring',
		logline: 'Merchants hide flour and blame the watch.',
		lifecycleStage: 'simmer',
		pressure: 66,
		urgency: 'emerging',
		visibility: 'rumored',
		playerTouchpoints: ['identical invoices', 'locked warehouses'],
		clueTrail: [{ clue: 'Two bakers repeat the same phrase.', delivery: 'rumor', truth: 'The phrase was planted.', visibility: 'subtle', evidenceRefs: [] }],
		pressureBeats: [{ title: 'Bread prices rise early', body: 'Bakers raise prices before public notice.', delayTurns: 2, urgency: 'emerging', visibility: 'player_known', actorEntityIds: [], targetEntityIds: [], locationIds: [], factionIds: [], memoryImpact: {} }],
		antiRailroadNotes: ['Do not force the player to visit the market.'],
	}],
} as unknown as StrategicWorldFrame;

describe('strategic frame prompt-card plot pressure', () => {
	it('selects one sourced local cue only when the action touches it, and accepts quiet', () => {
		const local = { ...frame.plotCards[0], id: 'levy', title: 'The Harbor Levy', logline: 'Dock fees rise for passage.',
			pressure: 15, visibility: 'public', locationIds: ['dock'], actorEntityIds: [], targetEntityIds: [],
			playerTouchpoints: ['booking passage'], sourceRefs: [{ sourceType: 'event', sourceId: 'event_levy', label: 'Dock levy' }] };
		const remote = { ...local, id: 'remote', title: 'The Distant War', logline: 'A war grows far away.',
			pressure: 95, urgency: 'critical', locationIds: ['other'], playerTouchpoints: ['war'], sourceRefs: [{ sourceType: 'event', sourceId: 'event_war', label: 'Distant war' }] };
		const sceneFrame = { ...frame, plotCards: [remote, local],
			activationPlan: { ...frame.activationPlan, activateNow: ['remote', 'levy'] } } as StrategicWorldFrame;
		expect(selectStrategicSceneCue(sceneFrame, { playerAction: 'I eat breakfast.', locationId: 'dock' })).toBeNull();
		const hallTitle = { ...sceneFrame.plotCards.find(card => card.id === 'levy')!, title: 'The Dock Levy', logline: 'A levy reaches the dock.' };
		const hallFrame = { ...sceneFrame, plotCards: [hallTitle], activationPlan: { ...sceneFrame.activationPlan, activateNow: ['levy'] } };
		expect(selectStrategicSceneCue(hallFrame, { playerAction: 'I sit at the dock.', locationId: 'dock' })).toBeNull();
		expect(selectStrategicSceneCue(hallFrame, { playerAction: 'I ask who imposed the levy.', locationId: 'dock' })?.mode).toBe('direct');
		expect(selectStrategicSceneCue(sceneFrame, { playerAction: 'I book passage.', locationId: 'dock' }))
			.toEqual({ cardId: 'levy', sourceKey: 'event:event_levy', mode: 'ambient' });
		expect(selectStrategicSceneCue(sceneFrame, { playerAction: 'I book passage.', locationId: 'dock', sceneAlreadyUsed: true })).toBeNull();
		expect(selectStrategicSceneCue(sceneFrame, { playerAction: 'I ask why passage costs more.', locationId: 'dock', sceneAlreadyUsed: true })?.mode).toBe('direct');
		expect(selectStrategicSceneCue(sceneFrame, { playerAction: 'I book passage.', locationId: 'dock', usedSourceKeys: ['event:event_levy'] })).toBeNull();
		expect(selectStrategicSceneCue(sceneFrame, { playerAction: 'I ask who ordered the passage levy.', locationId: 'dock', usedSourceKeys: ['event:event_levy'], sceneAlreadyUsed: true }))
			.toEqual({ cardId: 'levy', sourceKey: 'event:event_levy', mode: 'direct' });
		expect(buildStrategicNarratorBlock(sceneFrame, 'levy')).toContain('The Harbor Levy');
		expect(buildStrategicNarratorBlock(sceneFrame, 'levy')).not.toContain('The Distant War');
	});
	it('keeps one cue identity when a Director reorders evidence refs', () => {
		const card = { ...frame.plotCards[0], id: 'levy', title: 'The Harbor Levy', visibility: 'public',
			locationIds: ['dock'], actorEntityIds: [], targetEntityIds: [], playerTouchpoints: ['book passage'],
			sourceRefs: [{ sourceType: 'thread', sourceId: 'thread_levy', label: 'Levy thread' },
				{ sourceType: 'world_event', sourceId: 'event_levy', label: 'Levy event' }] };
		const makeFrame = (sourceRefs: typeof card.sourceRefs) => ({ ...frame, plotCards: [{ ...card, sourceRefs }],
			activationPlan: { ...frame.activationPlan, activateNow: ['levy'] } }) as StrategicWorldFrame;
		const action = { playerAction: 'I book passage.', locationId: 'dock' };
		expect(selectStrategicSceneCue(makeFrame(card.sourceRefs), action)?.sourceKey).toBe('world_event:event_levy');
		expect(selectStrategicSceneCue(makeFrame([...card.sourceRefs].reverse()), action)?.sourceKey).toBe('world_event:event_levy');
		expect(selectStrategicSceneCue(makeFrame([...card.sourceRefs].reverse()), {
			...action, usedSourceKeys: ['world_event:event_levy'] })).toBeNull();
		expect(selectStrategicSceneCue(makeFrame(card.sourceRefs), {
			...action, usedSourceKeys: ['event:event_levy'] })).toBeNull();
		const legacyEventRef = [{ sourceType: 'event', sourceId: 'event_levy', label: 'Levy event' }];
		expect(selectStrategicSceneCue(makeFrame(legacyEventRef), {
			...action, usedSourceKeys: ['world_event:event_levy'] })).toBeNull();
		const legacyWithThread = [{ sourceType: 'thread', sourceId: 'thread_levy', label: 'Levy thread' },
			...legacyEventRef];
		expect(selectStrategicSceneCue(makeFrame(legacyWithThread), action)?.sourceKey).toBe('event:event_levy');
		expect(strategicEvidenceRefSchema.parse(legacyEventRef[0])).toMatchObject({
			sourceType: 'world_event', sourceId: 'event_levy' });
		expect(selectStrategicSceneCue(makeFrame([...legacyWithThread].reverse()), {
			...action, usedSourceKeys: ['world_event:event_levy'] })).toBeNull();
	});
	it('uses exact entry evidence across regenerated thread IDs', () => {
		const card = { ...frame.plotCards[0], id: 'old_card', storyThreadId: 'thread_old',
			title: 'The Harbor Levy', logline: 'Dock fees rise for passage.', visibility: 'public',
			locationIds: ['dock'], actorEntityIds: [], targetEntityIds: [], playerTouchpoints: ['book passage'],
			sourceRefs: [{ sourceType: 'thread', sourceId: 'thread_old', label: 'Levy thread' },
				{ sourceType: 'entry', sourceId: 'entry_levy_notice', label: 'Posted levy' }] };
		const makeFrame = (next: typeof card) => ({ ...frame, plotCards: [next],
			activationPlan: { ...frame.activationPlan, activateNow: [next.id] } }) as StrategicWorldFrame;
		const action = { playerAction: 'I book passage.', locationId: 'dock' };
		expect(selectStrategicSceneCue(makeFrame(card), action)?.sourceKey).toBe('entry:entry_levy_notice');
		const renamed = { ...card, id: 'new_card', storyThreadId: 'thread_new',
			sourceRefs: [{ sourceType: 'thread', sourceId: 'thread_new', label: 'New levy thread' }, card.sourceRefs[1]] };
		expect(selectStrategicSceneCue(makeFrame(renamed), {
			...action, usedSourceKeys: ['entry:entry_levy_notice'] })).toBeNull();
		const advanced = { ...renamed, sourceRefs: [renamed.sourceRefs[0],
			{ sourceType: 'entry', sourceId: 'entry_new_fee', label: 'New fee posted' }] };
		expect(selectStrategicSceneCue(makeFrame(advanced), {
			...action, usedSourceKeys: ['entry:entry_levy_notice'] })?.sourceKey).toBe('entry:entry_new_fee');
	});
	it('holds a local plan until it has an observable source', () => {
		const card = { ...frame.plotCards[0], id: 'planned_levy', storyThreadId: 'thread_levy',
			title: 'The Harbor Levy', logline: 'Dock fees may rise for passage.', visibility: 'public',
			locationIds: ['dock'], actorEntityIds: [], targetEntityIds: [], playerTouchpoints: ['book passage'],
			sourceRefs: [{ sourceType: 'thread', sourceId: 'thread_levy', label: 'Levy plan' }] };
		const makeFrame = (sourceRefs: typeof card.sourceRefs) => ({ ...frame, plotCards: [{ ...card, sourceRefs }],
			activationPlan: { ...frame.activationPlan, activateNow: [card.id] } }) as StrategicWorldFrame;
		const action = { playerAction: 'I book passage.', locationId: 'dock' };
		expect(selectStrategicSceneCue(makeFrame(card.sourceRefs), action)).toBeNull();
		expect(selectStrategicSceneCue(makeFrame([...card.sourceRefs,
			{ sourceType: 'world_event', sourceId: 'event_posted_fee', label: 'Posted fee' }]), action))
			.toMatchObject({ sourceKey: 'world_event:event_posted_fee' });
	});
	it('does not reopen a shown summons because an unrelated challenge mentions the city', () => {
		const card = { ...frame.plotCards[0], id: 'qarth_summons_001', title: 'The Hall Awaits',
			logline: 'The Pureborn have summoned Aurion to appear before noon tomorrow, and their agents observe his movements through the city.',
			visibility: 'public', locationIds: ['qarth_hall'], actorEntityIds: [], targetEntityIds: [],
			playerTouchpoints: ['the Pureborn summons'], sourceRefs: [{ sourceType: 'world_event', sourceId: 'summons_event', label: 'Summons' }] };
		const summonsFrame = { ...frame, plotCards: [card],
			activationPlan: { ...frame.activationPlan, activateNow: [card.id] } } as StrategicWorldFrame;
		const shown = { locationId: 'qarth_hall', sceneAlreadyUsed: true,
			usedSourceKeys: ['world_event:summons_event'] };
		expect(selectStrategicSceneCue(summonsFrame, { ...shown,
			playerAction: 'I ask what one war galley could do to your free city and its trade.' })).toBeNull();
		expect(selectStrategicSceneCue(summonsFrame, { ...shown,
			playerAction: 'Tell me why I would disrupt your city when I came for adventure and trade.' })).toBeNull();
		expect(selectStrategicSceneCue(summonsFrame, { ...shown,
			playerAction: 'Why did the Pureborn summon me to Qarth?' })?.mode).toBe('direct');
	});
	it('does not rotate minor cues through one ongoing personal conversation', () => {
		const cards = ['herbs', 'linen', 'candles'].map((item, index) => ({ ...frame.plotCards[0],
			id: item, title: `The ${item} guild`, logline: `${item} guild prices change.`, pressure: 15 + index,
			visibility: 'public', locationIds: ['market'], actorEntityIds: [], targetEntityIds: [],
			playerTouchpoints: [`buy ${item}`], sourceRefs: [{ sourceType: 'event', sourceId: `event_${item}`, label: item }] }));
		const sceneFrame = { ...frame, plotCards: cards,
			activationPlan: { ...frame.activationPlan, activateNow: cards.map(card => card.id) } } as StrategicWorldFrame;
		expect(selectStrategicSceneCue(sceneFrame, { playerAction: 'I buy herbs.', locationId: 'market' })?.cardId).toBe('herbs');
		for (const item of ['linen', 'candles']) {
			expect(selectStrategicSceneCue(sceneFrame, { playerAction: `I buy ${item} and continue talking.`,
				locationId: 'market', sceneAlreadyUsed: true, usedSourceKeys: ['event:event_herbs'] })).toBeNull();
		}
		expect(selectStrategicSceneCue(sceneFrame, { playerAction: 'I buy linen.', locationId: 'market',
			sceneAlreadyUsed: false, usedSourceKeys: ['event:event_herbs'] })?.cardId).toBe('linen');
	});
	it('keeps an expired frame available for review without injecting it into narration', () => {
		const stored = strategicWorldFrameSchema.parse({ id: 'old-frame', storyId: 'story_alpha' });
		const metadata = { plotBrain: { lastFrame: stored, lastFrameId: stored.id, lastFrameTurn: 10 } };
		expect(storedStrategicFrameForStory('story_alpha', metadata)?.id).toBe(stored.id);
		expect(storedStrategicFrameForStory('other_story', metadata)).toBeNull();
		expect(appliedStrategicFrameFromProjection({ story: { id: 'story_alpha', currentTurn: 230, metadata } })).toBeNull();
	});
	it('selects only an applied projection frame and never a pending draft', () => {
		const applied = strategicWorldFrameSchema.parse({
			id: 'frame-applied',
			storyId: 'story_alpha',
			plotCards: [{ id: 'plot-active', title: 'The Applied Levy' }],
			activationPlan: { activateNow: ['plot-active'] },
		});
		const pending = strategicWorldFrameSchema.parse({
			id: 'frame-pending',
			storyId: 'story_alpha',
			plotCards: [{ id: 'plot-pending', title: 'The Pending Coup' }],
			activationPlan: { activateNow: ['plot-pending'] },
		});

		expect(appliedStrategicFrameFromProjection({
			story: { id: 'story_alpha', currentTurn: 10, metadata: { plotBrain: { lastFrame: applied, lastFrameId: applied.id, lastFrameTurn: 9, pendingFrame: pending } } },
		})?.id).toBe('frame-applied');
		expect(appliedStrategicFrameFromProjection({
			story: { id: 'story_alpha', currentTurn: 10, metadata: { plotBrain: { pendingFrame: pending } } },
		})).toBeNull();
	});

	it('keeps refresh-due applied frames visible until retirement or hard staleness', () => {
		const applied = strategicWorldFrameSchema.parse({
			id: 'frame-applied',
			storyId: 'story_alpha',
			plotCards: [{ id: 'plot-active', title: 'The Applied Levy' }],
			activationPlan: { activateNow: ['plot-active'] },
		});
		const projection = (plotBrain: Record<string, unknown>) => ({
			story: { id: 'story_alpha', currentTurn: 30, metadata: { plotBrain: { lastFrame: applied, lastFrameId: applied.id, ...plotBrain } } },
		});

		expect(appliedStrategicFrameFromProjection(projection({ lastFrameTurn: 29 }))?.id).toBe('frame-applied');
		expect(appliedStrategicFrameFromProjection(projection({ lastFrameId: 'frame-other', lastFrameTurn: 29 }))).toBeNull();
		expect(appliedStrategicFrameFromProjection({
			...projection({ lastFrameTurn: 29 }),
			story: { ...projection({ lastFrameTurn: 29 }).story, id: 'story_other' },
		})).toBeNull();
		expect(appliedStrategicFrameFromProjection(projection({ lastFrameTurn: 29, active: false }))).toBeNull();
		expect(appliedStrategicFrameFromProjection(projection({ lastFrameTurn: 29, needsDevelopment: true }))?.id).toBe('frame-applied');
		expect(appliedStrategicFrameFromProjection(projection({ lastFrameTurn: 21 }))?.id).toBe('frame-applied');
		expect(appliedStrategicFrameFromProjection(projection({ lastFrameTurn: 18 }))?.id).toBe('frame-applied');
		expect(appliedStrategicFrameFromProjection(projection({}))).toBeNull();
		expect(appliedStrategicFrameFromProjection(projection({ lastFrameTurn: 17 }))).toBeNull();
	});

	it('remaps unambiguous thread activation aliases and drops unrelated legacy ids', () => {
		const imported = {
			...frame,
			id: 'frame-imported',
			plotCards: [{ ...frame.plotCards[0], id: 'import_a05', storyThreadId: 'thread_revenge', title: 'A Reckoning at Sea' }],
			activationPlan: { activateNow: ['thread_revenge', 'plot_nyessos_revenge'], keepDormant: [], retireOrMerge: [], rationale: '' },
		} as StrategicWorldFrame;

		expect(normalizeStrategicFrameActivations(imported).activationPlan.activateNow).toEqual(['import_a05']);
	});

	it('shows narrator-safe plot cards without exposing hidden truths', () => {
		const block = buildStrategicNarratorBlock(frame);

		expect(block).toContain('Plot Director Pressure');
		expect(block).toContain('soft story steering, not a script');
		expect(block).toContain('Advance at most one scene-relevant active pressure this turn');
		expect(block).toContain('do not restage a beat the recent scene already completed');
		expect(block).toContain('Do not force player action, travel, discovery, loyalty, injury, or outcomes');
		expect(block).toContain('Active plot pressure');
		expect(block).toContain('The Flour Ring');
		expect(block).toContain('identical invoices');
		expect(block).toContain('Agency guard: Do not force the player');
		expect(block).not.toContain('Use this as hidden world pressure');
		expect(block).not.toContain('The phrase was planted');
	});
	it('sends the selected scene development without planned clues or numeric pressure', () => {
		const block = buildStrategicNarratorBlock(frame, 'plot_flour_ring');
		expect(block).toContain('The Flour Ring: Merchants hide flour and blame the watch.');
		expect(block).toContain('Agency guard: Do not force the player to visit the market.');
		expect(block).not.toContain('identical invoices');
		expect(block).not.toContain('Two bakers repeat the same phrase');
		expect(block).not.toContain('[simmer/emerging/rumored/66]');
	});

	it('feeds plot pressure beats to world simulation', () => {
		const block = buildStrategicWorldSimBlock(frame);

		expect(block).toContain('Plot pressure cards');
		expect(block).toContain('The Flour Ring');
		expect(block).toContain('Beat: Bread prices rise early');
		expect(block).toContain('clue: Two bakers repeat the same phrase.');
		expect(block).not.toContain('Let prices and rumors move first.');
	});

	it('preserves a separate bullet line for every active card', () => {
		const twoCards = {
			...frame,
			activationPlan: { ...frame.activationPlan, activateNow: ['plot_flour_ring', 'plot_second'] },
			plotCards: [
				...frame.plotCards,
				{ ...frame.plotCards[0], id: 'plot_second', title: 'The Harbor Levy' },
			],
		} as unknown as StrategicWorldFrame;

		for (const block of [buildStrategicNarratorBlock(twoCards), buildStrategicWorldSimBlock(twoCards)]) {
			expect(block.split('\n').filter(line => line.startsWith('- ['))).toHaveLength(2);
		}
	});

	it('emits nothing when the frame activates no plot cards', () => {
		const dormant = {
			...frame,
			activationPlan: { ...frame.activationPlan, activateNow: [] },
		} as unknown as StrategicWorldFrame;

		expect(buildStrategicNarratorBlock(dormant)).toBe('');
		expect(buildStrategicWorldSimBlock(dormant)).toBe('');
	});

	it('tells the narrator to leave explicitly dormant choices pending', () => {
		const mixed = {
			...frame,
			activationPlan: { ...frame.activationPlan, keepDormant: ['plot_old'] },
			plotCards: [...frame.plotCards, { ...frame.plotCards[0], id: 'plot_old', title: 'Old Deadline' }],
		} as unknown as StrategicWorldFrame;

		const block = buildStrategicNarratorBlock(mixed);
		expect(block).toContain('Dormant ongoing pressure: Old Deadline');
		expect(block).toContain('do not restage their reports or choices');
		expect(block).not.toContain('- [simmer/emerging/rumored/66] Old Deadline');
		expect(buildStrategicNarratorBlock(mixed, 'plot_flour_ring')).not.toContain('Old Deadline');
	});

	it('does not leak frame-level cards or dormant plot content beside an active card', () => {
		const mixed = {
			...frame,
			narratorPromptCard: 'Secret dormant master plan.',
			fastWorldSimInstructions: 'Advance the dormant master plan.',
			plotCards: [
				...frame.plotCards,
				{ ...frame.plotCards[0], id: 'plot_dormant', title: 'Dormant Coup', logline: 'A hidden coup waits.', pressureBeats: [{ ...frame.plotCards[0].pressureBeats[0], title: 'Coup begins' }] },
			],
		} as unknown as StrategicWorldFrame;

		for (const block of [buildStrategicNarratorBlock(mixed), buildStrategicWorldSimBlock(mixed)]) {
			expect(block).toContain('The Flour Ring');
			expect(block).not.toContain('Secret dormant master plan');
			expect(block).not.toContain('Advance the dormant master plan');
			expect(block).not.toContain('Dormant Coup');
			expect(block).not.toContain('Coup begins');
		}
	});

	it('chooses the strongest linked canon antagonist for each active plot', () => {
		const block = buildStrategicNarratorBlock({
			...frame,
			plotCards: [{ ...frame.plotCards[0], antagonistCandidateIds: ['invented', 'watch_captain', 'merchant_ring'] }],
			antagonistCandidates: [
				{ id: 'invented', name: 'The Paper Devil', role: 'primary_antagonist', actorEntityId: null, actorFactionId: null, motive: 'Be feared.', method: 'Threats.', escalationTrigger: '', hesitationTrigger: '', lineTheyWillNotCross: '', plausibilityScore: 100, dramaticScore: 100, agencyRisk: 0 },
				{ id: 'watch_captain', name: 'Captain Vey', role: 'rival', actorEntityId: 'npc_vey', actorFactionId: null, motive: 'Protect the watch.', method: 'Quiet arrests.', escalationTrigger: 'the warehouses are searched', hesitationTrigger: 'innocents would be harmed', lineTheyWillNotCross: 'hurting children', plausibilityScore: 75, dramaticScore: 70, agencyRisk: 10 },
				{ id: 'merchant_ring', name: 'The Flour Consortium', role: 'subplot_antagonist', actorEntityId: null, actorFactionId: 'faction_flour', motive: 'Keep its monopoly.', method: 'Engineered shortages.', escalationTrigger: 'a ledger is found', hesitationTrigger: 'the guild fractures', lineTheyWillNotCross: 'burning its own stores', plausibilityScore: 85, dramaticScore: 80, agencyRisk: 8 },
				{ id: 'unlinked', name: 'The Unlinked Prince', role: 'primary_antagonist', actorEntityId: 'npc_prince', actorFactionId: null, motive: 'Rule.', method: 'War.', escalationTrigger: '', hesitationTrigger: '', lineTheyWillNotCross: '', plausibilityScore: 100, dramaticScore: 100, agencyRisk: 0 },
			],
		} as unknown as StrategicWorldFrame);

		expect(block).toContain('Antagonist pressure: The Flour Consortium [subplot_antagonist; faction faction_flour]');
		expect(block).toContain('Motive: Keep its monopoly.');
		expect(block).toContain('Method: Engineered shortages.');
		expect(block).not.toContain('The Paper Devil');
		expect(block).not.toContain('The Unlinked Prince');
	});

	it('retains an unbound opposition candidate but marks its identity as provisional', () => {
		const unbound = {
			...frame,
			plotCards: [{ ...frame.plotCards[0], antagonistCandidateIds: ['paper_devil'] }],
			antagonistCandidates: [{
				id: 'paper_devil', name: 'The Paper Devil', role: 'primary_antagonist',
				actorEntityId: null, actorFactionId: null, motive: 'Control the grain route.',
				method: 'Forged manifests.', escalationTrigger: 'a manifest is seized',
				hesitationTrigger: 'the guild turns witness', lineTheyWillNotCross: 'burning the granary',
				plausibilityScore: 80, dramaticScore: 70, agencyRisk: 10,
			}],
		} as unknown as StrategicWorldFrame;

		for (const block of [buildStrategicNarratorBlock(unbound), buildStrategicWorldSimBlock(unbound)]) {
			expect(block).toContain('Opposition candidate (unbound): The Paper Devil');
			expect(block).toContain('Treat this identity as provisional');
			expect(block).toContain('Motive: Control the grain route.');
			expect(block).toContain('Method: Forged manifests.');
		}
		expect(buildStrategicNarratorBlock(unbound, 'plot_flour_ring')).not.toContain('The Paper Devil');
	});
});
