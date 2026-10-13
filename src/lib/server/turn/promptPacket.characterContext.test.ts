import { describe, expect, it } from 'vitest';
import type { RetrievedMemoryPacket } from '$lib/contracts/memory';
import type { TurnContext } from './context';
import { buildServerTurnPrompt, unchapteredDialogueEntries } from './promptPacket';
import { buildArcMemoryFields, buildArcSummary } from '$lib/server/jobs/processor';
import { applyPromptContextBudget } from './orchestrator';
import { countTokens } from '$lib/utils/tokens';
import { buildContextSelection } from './promptReceipt';
import { strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';

const now = '2026-06-30T00:00:00.000Z';

function row<T extends Record<string, unknown>>(value: T): T & { serverVersion: number; createdAt: string; updatedAt: string } {
	return { serverVersion: 1, createdAt: now, updatedAt: now, ...value } as T & { serverVersion: number; createdAt: string; updatedAt: string };
}

function entity(
	id: string,
	type: string,
	name: string,
	description: string,
	state: Record<string, unknown> = {},
	metadata: Record<string, unknown> = {},
) {
	return row({
		id,
		storyId: 'story_test',
		type,
		name,
		description,
		status: 'active',
		visibility: 'player_known',
		state,
		metadata,
		sourceEntryIds: [],
		sourceEventIds: [],
		sourcePatchIds: [],
	});
}

function packet(query = ''): RetrievedMemoryPacket {
	return {
		storyId: 'story_test',
		query,
		packet: '',
		nodes: [],
		tokenEstimate: 0,
		retrievalDebug: [],
		retrievalTrace: [],
	};
}

function context(): TurnContext {
	const unrelated = Array.from({ length: 14 }, (_, index) =>
		entity(`npc_history_${index}`, 'character', `Aegon ${index} Targaryen`, `Historical dragon king ${index}.`, { present: true }),
	);
	return {
		story: row({
			id: 'story_test',
			clientStoryId: null,
			title: 'Character Context Test',
			description: 'A test story.',
			genre: 'fantasy',
			mode: 'adventure',
			settings: null,
			headerPrompt: null,
			currentLocationId: 'loc_study',
			metadata: {},
		}),
		recentEntries: [
			row({
				id: 'entry_1',
				storyId: 'story_test',
				type: 'user_action',
				content: 'I ask Maera about Volantis.',
				position: 1,
				parentId: null,
				branchId: null,
				metadata: {},
			}),
			row({
				id: 'narration_1',
				storyId: 'story_test',
				type: 'narration',
				content: '[ Time 7:55 PM | Villa of the Sun - Maera Belaerys\'s private study ] Maera Belaerys stands by the map. The room is empty except for the old woman and Aurion.',
				position: 2,
				parentId: 'entry_1',
				branchId: null,
				metadata: {},
			}),
		],
		entities: [
			entity('loc_study', 'location', 'Maera Belaerys private study', 'A quiet study.', { current: true }),
			entity('pc_aurion', 'character', 'Aurion Belaerys', 'The player character.', { relationship: 'self', present: true }),
			entity('npc_maera', 'character', 'Maera Belaerys', 'The relevant grandmother.', { present: true }),
			entity('npc_addam', 'character', 'Addam Velaryon', 'A dead historical dragonseed.', { present: true }),
			...unrelated,
		],
		factions: [],
		factionMemberships: [],
		factionResources: [],
		factionGoals: [],
		factionProjects: [],
		agreements: [],
		threads: [],
		events: [],
		beliefs: [],
		facts: [],
		patchProposals: [],
		continuityWarnings: [],
		chapters: [],
		arcs: [],
		sagas: [],
		gmBrief: null,
	} as unknown as TurnContext;
}

describe('server turn prompt character context', () => {
	it('places one sourced faction intention in the dynamic tail without moving cached history or forecasts into canon', () => {
		const ctx = context();
		ctx.story.metadata = { factionWorkflow: { version: 1, attempts: [{ id: 'grateful_offer', status: 'intended', factionName: 'Belaerys household', actorEntityIds: ['npc_maera'], locationId: 'loc_study', intention: { action: 'Offer shelter to an old ally.', motive: 'PRIVATE_GRATITUDE', manner: 'Warm and wry.', basis: ['old_kindness'], limits: ['The ally may decline.'], opposition: 'Consent is unresolved.' } }], forecasts: [{ development: 'FORECAST_IS_NOT_CANON' }] } };
		const prepared = buildServerTurnPrompt(ctx, packet('I ask Maera about the offer.'), 'entry_current', { playerAction: 'I ask Maera about the offer.', presentNpcIds: ['npc_maera'] });
		expect(prepared.dynamicPrompt).toContain('PRIVATE_GRATITUDE');
		expect(prepared.stableContext).not.toContain('PRIVATE_GRATITUDE');
		expect(prepared.dynamicPrompt).not.toContain('FORECAST_IS_NOT_CANON');
		expect(prepared.factionCueSelection).toMatchObject({ sourceKey: 'intent:grateful_offer', cardId: 'grateful_offer', mode: 'direct' });
		expect(prepared.dynamicContextRecords.filter(row => row.kind === 'factionCue')).toHaveLength(1);
		const prefix = prepared.stableContext;
		(ctx.story.metadata.factionWorkflow as any).attempts[0].intention.motive = 'CHANGED_PRIVATE_MOTIVE';
		const changed = buildServerTurnPrompt(ctx, packet('I ask Maera about the offer.'), 'entry_current', { playerAction: 'I ask Maera about the offer.', presentNpcIds: ['npc_maera'] });
		expect(changed.stableContext).toBe(prefix);
	});
	it('keeps a scene bystander available to dialogue without sending their full card to the narrator', () => {
		const ctx = context();
		ctx.recentEntries[1].content += ' Addam Velaryon sits near the door.';
		ctx.entities.find(entity => entity.id === 'npc_addam')!.state = { present: true, currentPlan: 'Interrupt Maera to demand the harbor ledger.' };
		ctx.beliefs = [row({ id: 'belief_addam', storyId: ctx.story.id, believerEntityId: 'npc_addam',
			subjectEntityId: null, belief: 'The harbor ledger is hidden in the study.', confidence: 0.9,
			visibility: 'secret', evidenceEventIds: [], sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [] })] as TurnContext['beliefs'];
		const prompt = buildServerTurnPrompt(ctx, packet('I ask Maera about Volantis.'), 'entry_current', {
			playerAction: 'I ask Maera about Volantis.', presentNpcIds: ['npc_maera', 'npc_addam'] });
		expect(prompt.prompt).toContain('Character npc_maera / Maera Belaerys');
		expect(prompt.prompt).not.toContain('Character npc_addam / Addam Velaryon');
		expect(prompt.prompt).not.toContain('Interrupt Maera to demand the harbor ledger.');
		expect(prompt.prompt).not.toContain('The harbor ledger is hidden in the study.');
		expect(prompt.dialogueActorCards.find(card => card.id === 'npc_addam')?.text)
			.toContain('Character npc_addam / Addam Velaryon');
	});
	it('tracks an OOC correction as retained narrator evidence', () => {
		const ctx = context();
		ctx.recentControlEntries = [row({ id: 'entry_correction', storyId: ctx.story.id, type: 'user_action',
			content: 'No, her eyes are green.', position: 3, parentId: null, branchId: null,
			metadata: { nonCanon: true } })] as TurnContext['recentEntries'];
		const prompt = buildServerTurnPrompt(ctx, packet('I ask Maera about her eyes.'), 'entry_current', {
			playerAction: 'I ask Maera about her eyes.' });
		const selection = buildContextSelection({ packet: prompt, ranges: [{ start: 0, end: prompt.prompt.length }],
			loaded: { playerCorrections: 1 }, includeDialogue: true });
		expect(prompt.prompt).toContain('No, her eyes are green.');
		expect(selection.groups[0]).toMatchObject({ sentIds: ['entry_correction'], partialIds: [] });
	});
	it('keeps remote open threads out of a quiet local scene ledger', () => {
		const ctx = context();
		ctx.threads = [row({ id: 'remote_dispute', storyId: ctx.story.id,
			description: 'A distant faction dispute demands a messenger.', status: 'open',
			significance: 'major', relatedEntityIds: ['remote_harbor'] })] as TurnContext['threads'];
		const prompt = buildServerTurnPrompt(ctx, packet('I have breakfast with Maera.'), 'entry_current', {
			playerAction: 'I have breakfast with Maera.', presentNpcIds: ['npc_maera'] });
		expect(prompt.prompt).not.toContain('A distant faction dispute demands a messenger.');
	});
	it('does not treat a bystander as an involved actor for a remote faction cue', () => {
		const ctx = context();
		const frame = strategicWorldFrameSchema.parse({ id: 'frame_scarf', storyId: ctx.story.id,
			plotCards: [{ id: 'remote_scarf', title: 'The Distant Scarf Dispute',
				logline: 'A guild quarrels over blue scarves elsewhere.', pressure: 90, visibility: 'public',
				actorEntityIds: ['npc_addam'], locationIds: ['loc_remote'], playerTouchpoints: ['blue scarf'],
				sourceRefs: [{ sourceType: 'event', sourceId: 'event_remote_scarf', label: 'Scarf dispute' }] }],
			activationPlan: { activateNow: ['remote_scarf'] } });
		ctx.story.currentTurn = 2;
		ctx.story.metadata = { plotBrain: { lastFrame: frame, lastFrameId: frame.id, lastFrameTurn: 2 } };
		const presentNpcIds = ['npc_maera', 'npc_addam'];
		const personal = buildServerTurnPrompt(ctx, packet('I examine Maera Belaerys’s blue scarf.'), 'entry_current', {
			playerAction: 'I examine Maera Belaerys’s blue scarf.', presentNpcIds });
		expect(personal.factionCueSelection).toBeUndefined();
		const involved = buildServerTurnPrompt(ctx, packet('I show Addam Velaryon the blue scarf.'), 'entry_current', {
			playerAction: 'I show Addam Velaryon the blue scarf.', presentNpcIds });
		expect(involved.factionCueSelection).toMatchObject({ cardId: 'remote_scarf', mode: 'ambient' });
	});
	it('holds a selected cue across a scene change until final-source feedback resolves it', () => {
		const ctx = context();
		const sourceKey = 'world_event:event_levy';
		const frame = strategicWorldFrameSchema.parse({ id: 'frame_levy', storyId: ctx.story.id,
			plotCards: [{ id: 'levy', title: 'The Harbor Levy', logline: 'Passage fees rise.',
				visibility: 'public', locationIds: ['loc_study'], playerTouchpoints: ['book passage'],
				sourceRefs: [{ sourceType: 'world_event', sourceId: 'event_levy', label: 'Local fee' }] }],
			activationPlan: { activateNow: ['levy'] } });
		ctx.story.currentTurn = 2;
		const presentation = { sceneKey: 'previous_scene', observedSceneKey: 'previous_scene',
			attemptedSourceKey: sourceKey, attemptEntryId: 'narration_1', attemptStatus: 'selected' };
		ctx.story.metadata = { plotBrain: { lastFrame: frame, lastFrameId: frame.id, lastFrameTurn: 2 }, factionPresentation: presentation };
		const prompt = () => buildServerTurnPrompt(ctx, packet('I book passage.'), 'entry_current', { playerAction: 'I book passage.' });
		expect(prompt().factionCueSelection).toBeUndefined();
		presentation.attemptStatus = 'uncertain';
		expect(prompt().factionCueSelection).toBeUndefined();
		presentation.attemptStatus = 'not_surfaced';
		expect(prompt().factionCueSelection).toMatchObject({ cardId: 'levy', sourceKey });
		presentation.attemptStatus = 'selected';
		expect(buildServerTurnPrompt(ctx, packet('I ask who ordered the levy.'), 'entry_current', {
			playerAction: 'I ask who ordered the levy.' }).factionCueSelection).toMatchObject({ cardId: 'levy', mode: 'direct' });
	});
	it('prioritizes a current-place plot thread over older unrelated threads', () => {
		const ctx = context();
		ctx.threads = [
			...Array.from({ length: 12 }, (_, index) => row({
				id: `remote_${index}`, storyId: 'story_test', description: `Remote dispute ${index}`,
				status: 'open', significance: 'moderate', relatedEntityIds: ['loc_remote'], relatedFactionIds: [],
				sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [], closedAt: null, closureReason: null,
			})),
			row({ id: 'local_plot', storyId: 'story_test', description: 'The harbor pilot contest begins here.',
				status: 'open', significance: 'moderate', relatedEntityIds: ['loc_study'], relatedFactionIds: [],
				sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [], closedAt: null, closureReason: null }),
		] as TurnContext['threads'];
		const prompt = buildServerTurnPrompt(ctx, packet('I ask about the local pilots.'), 'entry_current');
		expect(prompt.prompt).toContain('The harbor pilot contest begins here.');
		expect(prompt.prompt).not.toContain('Remote dispute 11');
	});
	it('keeps every available narrative entry after the latest chapter boundary until the dialogue allowance applies', () => {
		const ctx = context();
		ctx.recentEntries = Array.from({ length: 50 }, (_, index) => row({
			id: `entry_${index + 1}`, storyId: 'story_test', type: 'user_action', content: `Action ${index + 1}`,
			position: index + 1, parentId: null, branchId: null, metadata: {},
		})) as TurnContext['recentEntries'];
		ctx.chapters = [row({ id: 'chapter_1', storyId: 'story_test', number: 1, title: 'Boundary', sceneOutcome: '',
			irreversibleChanges: [], npcKnowledgeChanges: [], promisesDebtsOaths: [], discoveredClues: [],
			relationshipChanges: [], factionChanges: [], openThreads: [], sourceEntryIds: ['entry_10'],
			sourceEventIds: [], metadata: { endPosition: 10 } })] as TurnContext['chapters'];
		expect(unchapteredDialogueEntries(ctx).map(entry => entry.position)).toEqual(Array.from({ length: 40 }, (_, index) => index + 11));
		ctx.chapters[0].metadata = { endPosition: 40 };
		expect(unchapteredDialogueEntries(ctx).map(entry => entry.position)).toEqual(Array.from({ length: 10 }, (_, index) => index + 41));
	});
	it('retains two complete exchanges across a chapter boundary within the configured dialogue allowance', () => {
		const ctx = context();
		const exchange = (turn: number) => [
			row({ id: `entry_${turn}`, storyId: ctx.story.id, type: 'user_action', content: `Action ${turn}`,
				position: turn * 2 - 1, parentId: null, branchId: null, metadata: {} }),
			row({ id: `narration_${turn}`, storyId: ctx.story.id, type: 'narration', content: `Narration ${turn}`,
				position: turn * 2, parentId: `entry_${turn}`, branchId: null, metadata: {} }),
		];
		ctx.recentEntries = Array.from({ length: 12 }, (_, index) => exchange(index + 1)).flat() as TurnContext['recentEntries'];
		const options = { recentDialogueTurns: 20 };
		const firstPacket = buildServerTurnPrompt(ctx, packet(), 'entry_current', options);
		ctx.recentEntries.push(...(exchange(13) as TurnContext['recentEntries']));
		const nextPacket = buildServerTurnPrompt(ctx, packet(), 'entry_current', options);
		expect(firstPacket.messages).toHaveLength(24);
		expect(nextPacket.stableContext).toBe(firstPacket.stableContext);
		expect(nextPacket.messages.slice(0, firstPacket.messages.length)).toEqual(firstPacket.messages);
		ctx.chapters = [row({ id: 'chapter_1', storyId: ctx.story.id, number: 1, title: 'Boundary', sceneOutcome: 'The study changes.',
			irreversibleChanges: [], npcKnowledgeChanges: [], promisesDebtsOaths: [], discoveredClues: [],
			relationshipChanges: [], factionChanges: [], openThreads: [], sourceEntryIds: ['narration_12'],
			sourceEventIds: [], metadata: { endPosition: 24 } })] as TurnContext['chapters'];
		ctx.recentEntries = ctx.recentEntries.filter(entry => entry.position <= 24);
		expect(buildServerTurnPrompt(ctx, packet(), 'entry_current', options).messages.map(message => message.content))
			.toEqual(['Action 11', 'Narration 11', 'Action 12', 'Narration 12']);
		ctx.recentEntries.push(...(exchange(13) as TurnContext['recentEntries']));
		expect(buildServerTurnPrompt(ctx, packet(), 'entry_current', options).messages.map(message => message.content))
			.toEqual(['Action 11', 'Narration 11', 'Action 12', 'Narration 12', 'Action 13', 'Narration 13']);
		expect(buildServerTurnPrompt(ctx, packet(), 'entry_current', { recentDialogueTurns: 1 }).messages.map(message => message.content))
			.toEqual(['Action 13', 'Narration 13']);
	});
	it('keeps an earlier player action paired with its reply after the chapter boundary', () => {
		const ctx = context();
		ctx.recentEntries = [
			row({ id: 'late_action', storyId: ctx.story.id, type: 'user_action', content: 'I ask Mira about the promise.', position: 5, parentId: null, branchId: null, metadata: {} }),
			row({ id: 'late_reply', storyId: ctx.story.id, type: 'narration', content: 'Mira confirms the promise was kept.', position: 21, parentId: 'late_action', branchId: null, metadata: {} }),
		] as TurnContext['recentEntries'];
		ctx.chapters = [row({ id: 'chapter_1', storyId: ctx.story.id, number: 1, title: 'Boundary', sceneOutcome: 'Earlier events.',
			irreversibleChanges: [], npcKnowledgeChanges: [], promisesDebtsOaths: [], discoveredClues: [],
			relationshipChanges: [], factionChanges: [], openThreads: [], sourceEntryIds: [],
			sourceEventIds: [], metadata: { endPosition: 20 } })] as TurnContext['chapters'];
		expect(buildServerTurnPrompt(ctx, packet(), 'entry_current', { recentDialogueTurns: 2 }).messages.map(message => message.content))
			.toEqual(['I ask Mira about the promise.', 'Mira confirms the promise was kept.']);
	});
	it('keeps a called NPC profile and their own remembered belief', () => {
		const ctx = context();
		const addam = ctx.entities.find(entity => entity.id === 'npc_addam')!;
		addam.state = { present: false, appearance: 'A scar across his brow.', personality: 'Dry and guarded.',
			bio: 'Once captained the harbor watch.', goals: ['Find the missing harbor ledger.'] };
		ctx.beliefs = [row({ id: 'belief_addam', believerEntityId: 'npc_addam', subjectEntityId: null,
			belief: 'The watch captain hid the ledger.', confidence: 0.8 })] as TurnContext['beliefs'];
		const prompt = buildServerTurnPrompt(ctx, packet('I call for Addam Velaryon.'), 'entry_current');
		expect(prompt.prompt).toContain('A scar across his brow.');
		expect(prompt.prompt).toContain('Dry and guarded.');
		expect(prompt.prompt).toContain('Once captained the harbor watch.');
		expect(prompt.prompt).toContain('Find the missing harbor ledger.');
		expect(prompt.prompt).toContain('Addam Velaryon: The watch captain hid the ledger.');
	});
	it('shortens recent dialogue only when a source-linked checkpoint carries older scene notes', () => {
		const ctx = context();
		ctx.recentEntries = Array.from({ length: 20 }, (_, index) => [
			row({ id: `entry_${index}`, storyId: 'story_test', type: 'user_action', content: `I speak ${index}.`,
				position: index * 2 + 1, parentId: null, branchId: null, metadata: {} }),
			row({ id: `narration_${index}`, storyId: 'story_test', type: 'narration',
				content: `Mara replies ${index}. ${'scene detail '.repeat(500)}`,
				position: index * 2 + 2, parentId: `entry_${index}`, branchId: null, metadata: {} }),
		]).flat() as TurnContext['recentEntries'];
		ctx.sceneCheckpoint = {
			version: 1, id: 'checkpoint_1', storyId: 'story_test', locationId: 'loc_study', scene: 'The study',
			branchId: null, pov: 'primary', sourceStart: 1, sourceEnd: 40,
			sourceEntryIds: ['narration_9'], sourceHash: 'a'.repeat(32),
			notes: [{ sourceEntryId: 'narration_9', position: 20, kind: 'statement', text: 'Mara promised to wait.' }],
			createdAt: now,
		};
		const withNote = buildServerTurnPrompt(ctx, packet(), 'entry_current', { recentDialogueTokens: 15_000 });
		expect(withNote.prompt).toContain('Mara promised to wait.');
		ctx.sceneCheckpoint.notes = [];
		const withoutNote = buildServerTurnPrompt(ctx, packet(), 'entry_current', { recentDialogueTokens: 15_000 });
		expect(withoutNote.messages.length).toBeGreaterThan(withNote.messages.length);
	});
	it('keeps a remote checkpoint thread out of a quiet scene but retains direct inquiry and commitments', () => {
		const ctx = context();
		ctx.recentEntries[0].position = 100;
		ctx.recentEntries[1].position = 101;
		ctx.threads = [row({ id: 'thread_saffron', storyId: 'story_test', description: 'The Saffron Coup remains unfinished in a distant capital.',
			status: 'open', significance: 'high', relatedFactionIds: [], relatedEntityIds: [],
			sourceEntryIds: ['narration_old'], sourceEventIds: [], sourcePatchIds: [], closedAt: null, closureReason: null })] as TurnContext['threads'];
		ctx.sceneCheckpoint = {
			version: 1, id: 'checkpoint_old', storyId: 'story_test', locationId: 'loc_study', scene: 'The study',
			branchId: null, pov: 'primary', sourceStart: 20, sourceEnd: 20,
			sourceEntryIds: ['narration_old'], sourceHash: 'a'.repeat(32),
			notes: [{ sourceEntryId: 'narration_old', position: 20, kind: 'statement', text: 'Maera promised to wait.' }],
			projection: { compilerVersion: 'scene-projection-v1', participants: [], completedBeats: [],
				unresolvedActions: [
					{ id: 'thread_saffron', kind: 'thread', summary: 'The Saffron Coup remains unfinished in a distant capital.', sourceEntryIds: ['narration_old'], sourceEventIds: [] },
					{ id: 'agreement_maera', kind: 'agreement', summary: 'Maera promised to wait until dusk.', sourceEntryIds: ['narration_old'], sourceEventIds: [] },
				], commitments: [], factIds: [], beliefIds: [] }, createdAt: now,
		};
		const quiet = buildServerTurnPrompt(ctx, packet('I drink tea with Maera.'), 'entry_current', { playerAction: 'I drink tea with Maera.' });
		expect(quiet.prompt).not.toContain('The Saffron Coup remains unfinished');
		expect(quiet.prompt).toContain('Maera promised to wait until dusk.');
		const asked = buildServerTurnPrompt(ctx, packet('I ask about the Saffron Coup.'), 'entry_current', { playerAction: 'I ask about the Saffron Coup.' });
		expect(asked.prompt).toContain('The Saffron Coup remains unfinished');
	});
	it('places sourced campaign facts ahead of history and retains complete bullets under budget', () => {
		const ctx = context();
		ctx.story.metadata = { campaignState: [{ key: 'yin_betrothal', kind: 'current', statement: 'The Yin betrothal was annulled.', evidence: 'The Yin betrothal was annulled.', sourceEntryId: 'entry_annulment', sourcePosition: 20 }] };
		const retrieved = { ...packet(), packet: 'Older history: the betrothal was sealed.' };
		const result = buildServerTurnPrompt(ctx, retrieved, 'entry_current');
		expect(result.prompt.indexOf('The Yin betrothal was annulled.')).toBeLessThan(result.prompt.indexOf('Older history'));
		expect(result.contextRecords).toContainEqual(expect.objectContaining({ kind: 'campaignState', id: 'yin_betrothal' }));
		expect(buildContextSelection({ packet: result, ranges: [{ start: 0, end: result.prompt.length }], loaded: { campaignState: 1 }, includeDialogue: true }).groups[0]).toMatchObject({ sent: 1, sentIds: ['yin_betrothal'], omitted: 0 });
		expect(applyPromptContextBudget(result.prompt, 2000, undefined, result.contextRecords).value).toContain('The Yin betrothal was annulled.');
	});
	it('keeps old open leads out of general news while retaining explicit lookup', () => {
		const ctx = context();
		ctx.recentEntries.at(-1)!.position = 300;
		ctx.story.metadata = { campaignState: [
			{ key: 'skiff', kind: 'open_thread', statement: 'An empty skiff remains at the customs pier.', evidence: 'An empty skiff remains at the customs pier.', sourceEntryId: 'narration_old', sourcePosition: 20 },
			{ key: 'ruler', kind: 'current', statement: 'Aurion rules Volantis as Archon.', evidence: 'Aurion rules Volantis as Archon.', sourceEntryId: 'narration_old', sourcePosition: 20 },
		] };
		const general = buildServerTurnPrompt(ctx, packet('What is happening around the city?'), 'entry_current');
		expect(general.prompt).toContain('Aurion rules Volantis as Archon.');
		expect(general.prompt).not.toContain('An empty skiff remains at the customs pier.');
		const specific = buildServerTurnPrompt(ctx, packet('What happened to the skiff?'), 'entry_current');
		expect(specific.prompt).toContain('An empty skiff remains at the customs pier.');
	});
	it('delivers NPC intent beside belief limits and retains it within a bounded prompt', () => {
		const ctx = context();
		const agency = { currentGoal: 'Keep her younger brother out of royal service.', currentPlan: 'Secure an apprenticeship before the appointment is announced.', lastIndependentAction: 'Asked her merchant cousin to take him aboard.', nextOpportunity: 'The cousin returns tomorrow; she intends to meet him.', constraint: 'She will not openly accuse her husband.' };
		const maera = ctx.entities.find(entity => entity.id === 'npc_maera')!;
		maera.state = { ...maera.state, ...agency, nextOpportunityRecordedAt: 'Evening, September 10' };
		maera.metadata = { promptTemplate: '{{name}}: {{bio}}' };
		ctx.entities.find(entity => entity.id === 'pc_aurion')!.state = { relationship: 'self', currentPlan: 'PRIVATE_PLAYER_INTENT' };
		ctx.entities.find(entity => entity.id === 'npc_addam')!.state = { present: false, currentPlan: 'UNRELATED_OFFSTAGE_PLAN' };
		ctx.beliefs = [row({ id: 'belief_maera', storyId: ctx.story.id, believerEntityId: 'npc_maera', subjectEntityId: null, belief: 'The appointment is still unannounced.', confidence: 0.8, visibility: 'secret', evidenceEventIds: [], sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [] })];
		const result = buildServerTurnPrompt(ctx, packet('I ask Maera about her brother.'), 'entry_current');
		for (const value of Object.values(agency)) expect(result.prompt).toContain(value);
		expect(result.prompt).toContain('recorded at Evening, September 10');
		expect(result.prompt).toContain('The appointment is still unannounced.');
		expect(result.prompt).toContain('plans are not completed actions');
		expect(result.prompt).not.toContain('PRIVATE_PLAYER_INTENT');
		expect(result.prompt).not.toContain('UNRELATED_OFFSTAGE_PLAN');
		const final = applyPromptContextBudget(result.prompt, 1000, undefined, result.contextRecords.filter(record => record.kind === 'entities'));
		for (const value of Object.values(agency)) expect(final.value).toContain(value);
		expect(countTokens(final.value)).toBeLessThanOrEqual(1000);
		const small = applyPromptContextBudget(result.prompt, 160, undefined, result.contextRecords.filter(record => record.kind === 'entities'));
		expect(small.value).not.toContain(agency.currentGoal);
	});
	it('does not invent missing NPC plans or restore an explicitly cleared plan from metadata', () => {
		const ctx = context();
		const maera = ctx.entities.find(entity => entity.id === 'npc_maera')!;
		maera.state = { present: true, currentGoal: 'Protect her brother.', currentPlan: null };
		maera.metadata = { currentPlan: 'OBSOLETE_PLAN' };
		const result = buildServerTurnPrompt(ctx, packet('I ask Maera about her brother.'), 'entry_current');
		expect(result.prompt).toContain('Current plan: not established');
		expect(result.prompt).toContain('Last independent action: not established');
		expect(result.prompt).not.toContain('OBSOLETE_PLAN');
	});
	it('includes saved player capabilities and stops using explicitly cleared buffs', () => {
		const ctx = context();
		const player = ctx.entities.find(row => row.id === 'pc_aurion')!;
		player.state = { ...player.state, playerCapabilities: { abilities: ['Keen senses — tracks faint sounds'], buffs: ['Cold ward — until dawn'] } };
		player.metadata = { originalMetadata: { playerCapabilities: { abilities: ['Obsolete power'], buffs: ['Expired blessing'] } } };
		const prompt = buildServerTurnPrompt(ctx, packet('I listen at the door.'), 'entry_current');
		expect(prompt.prompt).toContain('[Abilities]:\n- Keen senses — tracks faint sounds');
		expect(prompt.prompt).toContain('[Active buffs]:\n- Cold ward — until dawn');
		expect(prompt.prompt).not.toContain('Expired blessing');
		player.state = { ...player.state, playerCapabilities: { abilities: [], buffs: [] } };
		const cleared = buildServerTurnPrompt(ctx, packet('I listen at the door.'), 'entry_current');
		expect(cleared.prompt).not.toContain('[Active buffs]:');
		expect(cleared.prompt).not.toContain('Obsolete power');
	});

	it('retains sourced structured knowledge after older covered chapters leave the bounded narrator prompt', () => {
		const ctx = context();
		ctx.chapters = Array.from({ length: 6 }, (_, index) => row({
			id: `chapter_${index + 1}`, storyId: 'story_test', number: index + 1, title: 'A quiet crossing',
			sceneOutcome: 'The party crossed the river.', irreversibleChanges: [], promisesDebtsOaths: [], openThreads: [],
			discoveredClues: [], factionChanges: [], metadata: {}, sourceEntryIds: [`entry_${index + 1}`], sourceEventIds: [],
			npcKnowledgeChanges: index === 0 ? [{ npc: 'Maera Belaerys', learned: 'The silver chapel key must stay hidden from the harbor watch.' }] : [],
			relationshipChanges: index === 0 ? ['Maera trusts Aurion because he rescued her daughter at the bridge.'] : [],
		}));
		const fields = buildArcMemoryFields(ctx.chapters);
		ctx.arcs = [row({ id: 'arc_1', storyId: 'story_test', number: 1, title: 'The river journey', chapterIds: ctx.chapters.map((chapter) => chapter.id),
			// A long overview must preserve the sourced character history after it.
			summary: `${'A long atmospheric overview of the river journey. '.repeat(90)}${buildArcSummary(ctx.chapters)}`,
			openThreadIds: [], sourceEventIds: [], metadata: { characterArcs: fields.characterArcs },
		})];
		const prompt = buildServerTurnPrompt(ctx, packet('I ask Maera about the silver chapel key and the bridge rescue.'), 'entry_current');
		expect(prompt.prompt).not.toContain('- Chapter 1:');
		expect(prompt.prompt).toContain('The silver chapel key must stay hidden from the harbor watch.');
		expect(prompt.prompt).toContain('Maera trusts Aurion because he rescued her daughter at the bridge.');
		expect(prompt.prompt).toContain('[source chapters: 1]');
		expect(ctx.arcs[0].metadata.characterArcs).toEqual(fields.characterArcs);
		const records = prompt.contextRecords.filter(record => record.kind === 'arcs' || record.kind === 'chapters');
		const arcRecord = records.find(record => record.kind === 'arcs')!;
		const fullArc = prompt.prompt.slice(arcRecord.start, arcRecord.end);
		const final = applyPromptContextBudget(prompt.prompt, 1000, undefined, records);
		expect(countTokens(final.value)).toBeLessThanOrEqual(1000);
		// A budget too small for the record omits it with an explicit warning;
		// it cannot send an opening fragment that loses the later knowledge.
		expect(final.value.includes('- Arc 1:')).toBe(final.value.includes(fullArc));
		if (!final.value.includes(fullArc)) expect(final.value).toContain('Whole records crossing this boundary were omitted');
		const sufficient = applyPromptContextBudget(prompt.prompt, countTokens(prompt.prompt), undefined, records);
		expect(sufficient.value).toContain(fullArc);
	});
	it('keeps established local due effects when optional context is clipped', () => {
		const ctx = context();
		ctx.arcs = [row({ id: 'arc_crowded', storyId: 'story_test', number: 1, title: 'Long crossing',
			chapterIds: [], summary: 'A detailed older crossing continues. '.repeat(200),
			openThreadIds: [], sourceEventIds: [], metadata: {} })] as TurnContext['arcs'];
		ctx.gmBrief = { storyId: 'story_test', currentTurn: 8, currentWorldTime: null,
			dueEvents: ['The study door jams', 'Maera drops the lamp'].map((title, index) => ({
				id: `local_due_${index}`, type: 'scheme', status: 'due', title, body: `${title} during this exchange.`,
				turnsUntilDue: 0, worldTime: null, npcEntityIds: [], factionIds: [], locationIds: ['loc_study'],
				visibility: 'player_known',
			})), recentEvents: [], scheduledEvents: [], npcEvents: [] };
		const prompt = buildServerTurnPrompt(ctx, packet('I speak with Maera.'), 'entry_current', { playerAction: 'I speak with Maera.' });
		expect(countTokens(prompt.prompt)).toBeGreaterThan(600);
		expect(prompt.requiredDueEventIds).toEqual(['local_due_0', 'local_due_1']);
		const whole = prompt.contextRecords.filter(record => ['campaignState', 'locationLore', 'locationPlaces', 'entities', 'chapters', 'arcs', 'timelineEvents', 'playerCorrections', 'requiredPlayer', 'requiredScene', 'requiredActors', 'requiredBeliefs', 'contentPinned', 'contentPartial'].includes(record.kind));
		const required = prompt.contextRecords.filter(record => ['playerCorrections', 'requiredPlayer', 'requiredScene', 'requiredActors', 'requiredBeliefs', 'contentPinned', 'contentPartial'].includes(record.kind)
			|| prompt.requiredDueEventIds.includes(record.id));
		const final = applyPromptContextBudget(prompt.prompt, 400, undefined, whole, required);
		expect(final.truncated).toBe(true);
		expect(countTokens(final.value)).toBeLessThanOrEqual(400);
		expect(final.value).toContain('The study door jams');
		expect(final.value).toContain('Maera drops the lamp');
	});
	it('uses arc accounts for covered chapters and chapter accounts only for loose chapters', () => {
		const ctx = context();
		ctx.chapters = [
			row({ id: 'chapter_1', storyId: 'story_test', number: 1, title: 'Covered', sceneOutcome: 'Covered chapter duplicate.',
				irreversibleChanges: [], npcKnowledgeChanges: [], promisesDebtsOaths: [], discoveredClues: [],
				relationshipChanges: [], factionChanges: [], openThreads: [], sourceEntryIds: [], sourceEventIds: [], metadata: {} }),
			row({ id: 'chapter_2', storyId: 'story_test', number: 2, title: 'Loose', sceneOutcome: 'The new harbor toll is in force.',
				irreversibleChanges: [], npcKnowledgeChanges: [], promisesDebtsOaths: [], discoveredClues: [],
				relationshipChanges: [], factionChanges: [], openThreads: [], sourceEntryIds: [], sourceEventIds: [], metadata: {} }),
		] as TurnContext['chapters'];
		ctx.arcs = [row({ id: 'arc_1', storyId: 'story_test', number: 1, title: 'Harbor', chapterIds: ['chapter_1'],
			summary: 'The old toll was abolished.', openThreadIds: [], sourceEventIds: [], metadata: {} })] as TurnContext['arcs'];
		const prompt = buildServerTurnPrompt(ctx, packet(), 'entry_current');
		expect(prompt.prompt).toContain('The old toll was abolished.');
		expect(prompt.prompt).toContain('The new harbor toll is in force.');
		expect(prompt.prompt).not.toContain('Covered chapter duplicate.');
		expect(prompt.contextRecords.filter(record => record.kind === 'chapters').map(record => record.id)).toEqual(['chapter_2']);
	});

	it('sends an oversized arc whole in the cached history, never its covered chapters again', () => {
		const ctx = context();
		ctx.chapters = Array.from({ length: 10 }, (_, index) => row({
			id: `chapter_${index + 1}`, storyId: 'story_test', number: index + 1, title: `Chapter ${index + 1}`,
			sceneOutcome: `Chapter ${index + 1} account. ${'scene detail '.repeat(4_000)}`,
			irreversibleChanges: [], promisesDebtsOaths: [], openThreads: [], discoveredClues: [], factionChanges: [],
			npcKnowledgeChanges: [], relationshipChanges: [], metadata: {}, sourceEntryIds: [], sourceEventIds: [],
		}));
		ctx.arcs = [row({
			id: 'arc_1', storyId: 'story_test', number: 1, title: 'The full campaign', chapterIds: ctx.chapters.map(chapter => chapter.id),
			summary: `Arc account. ${'historical detail '.repeat(6_000)}`, openThreadIds: [], sourceEventIds: [], metadata: {},
		})];
		const prompt = buildServerTurnPrompt(ctx, packet('What does Maera know?'), 'entry_current');
		// Complete arc history is mandatory context; the arc stands in for its chapters.
		expect(prompt.contextRecords.filter(record => record.kind === 'chapters')).toEqual([]);
		expect(prompt.stableHistoryContext).toContain(ctx.arcs[0].summary.trim());
		expect(prompt.dynamicPrompt).not.toContain('historical detail');
		expect(countTokens(prompt.dynamicPrompt)).toBeLessThan(16_500);
	});

	it('preserves what an NPC learned after a long conversation recap without sharing it with another actor', () => {
		const ctx = context();
		const learned = 'The silver key opens the chapel crypt only after sunset; Aurion entrusted it to Maera because the harbor watch cannot be trusted.';
		ctx.beliefs = [
			row({ id: 'belief_maera', believerEntityId: 'npc_maera', subjectEntityId: null, belief: `${'A long discussion of court manners. '.repeat(20)}\nPlayer revealed: ${'Earlier details about the dinner. '.repeat(20)}\nNPC learned: ${learned}\nEmotional shift: cautious trust`, confidence: 0.9 }),
			row({ id: 'belief_absent', believerEntityId: 'npc_addam', subjectEntityId: null, belief: 'An absent actor knows the secret tunnel.', confidence: 1 }),
		] as unknown as TurnContext['beliefs'];

		const prompt = buildServerTurnPrompt(ctx, packet('I follow Maera into the corridor.'), 'entry_current');
		expect(prompt.prompt).toContain(`Maera Belaerys: NPC learned: ${learned}`);
		expect(prompt.prompt).not.toContain('An absent actor knows the secret tunnel.');
		expect(prompt.prompt).not.toContain('A long discussion of court manners.');
	});

	it('keeps the relevant earned relationship reason with its source inside the existing character budget', () => {
		const ctx = context();
		ctx.entities.find((entity) => entity.id === 'npc_maera')!.state = {
			present: true,
			appearance: 'Elaborate embroidered robes. '.repeat(40),
			personality: 'Patient but unwilling to concede authority. '.repeat(40),
			knownFacts: ['The chapel crypt is sealed.'],
			relationship: { status: 'trusted ally', level: 62, history: [
				{ description: '[+12] Aurion rescued her daughter at the bridge, earning her trust despite their earlier quarrel.', entryId: 'entry_rescue', timestamp: 1 },
				{ description: '[+1] They shared a quiet supper.', entryId: 'entry_supper', timestamp: 2 },
			] },
		};
		const prompt = buildServerTurnPrompt(ctx, packet('I ask why she trusted me after the rescue at the bridge.'), 'entry_current');
		const block = prompt.prompt.split('Character npc_maera / Maera Belaerys')[1].split('\n\n')[0];
		expect(block).toContain('Aurion rescued her daughter at the bridge, earning her trust despite their earlier quarrel.');
		expect(block).toContain('[entry:entry_rescue]');
		expect(block).not.toContain('quiet supper');
		expect(block.length + 'Character npc_maera / Maera Belaerys'.length).toBeLessThanOrEqual(1800);
	});

	it('prioritizes an old scene participant oath beyond the former agreement caps and leaves fulfilled oaths closed', () => {
		const ctx = context();
		ctx.agreements = [
			...Array.from({ length: 90 }, (_, index) => row({ id: `agreement_${index}`, parties: ['pc_aurion', `npc_other_${index}`], category: 'debt', status: 'active', terms: `Unrelated cargo obligation ${index}.`, updatedAt: '2026-08-01T00:00:00.000Z' })),
			row({ id: 'agreement_maera', parties: ['pc_aurion', 'npc_maera'], category: 'oath', status: 'active', terms: 'Maera will shelter Aurion until the magistrate is brought to trial.', updatedAt: now }),
			row({ id: 'agreement_fulfilled', parties: ['npc_maera'], category: 'oath', status: 'fulfilled', terms: 'Already fulfilled: return the silver bell.' }),
		] as unknown as TurnContext['agreements'];
		const prompt = buildServerTurnPrompt(ctx, packet('I follow her into the corridor.'), 'entry_current');
		expect(prompt.prompt).toContain('Maera will shelter Aurion until the magistrate is brought to trial.');
		expect(prompt.prompt).not.toContain('Already fulfilled: return the silver bell.');
		expect(prompt.prompt.match(/^- active (?:debt|oath):/gm)).toHaveLength(8);
	});

	it('reserves remembered continuity when current state and portrayal fill a character card', () => {
		const ctx = context();
		const maera = ctx.entities.find((entity) => entity.id === 'npc_maera')!;
		maera.state = {
			present: true,
			appearance: 'Silver hair and embroidered robes. '.repeat(20),
			personality: 'Patient, observant, and fiercely independent. '.repeat(20),
			rank: 'Keeper of the imperial archives. '.repeat(10),
			currentAction: 'Inspecting the tiled floor beside the map table. '.repeat(10),
			emotionalState: 'Wary of the arriving messengers. '.repeat(10),
			currentDisposition: 'Protective but unwilling to concede authority. '.repeat(10),
			goals: Array.from({ length: 6 }, (_, index) => `Goal ${index}: ${'Find the hidden collection. '.repeat(10)}`),
			knownFacts: ['The silver key opens the chapel crypt.'],
			eventMemory: {
				did: ['Promised to keep Aurion hidden.'],
				saw: ['Saw the magistrate burn the ledger.'],
				knew: ['Aurion once trusted the magistrate.'],
				knows: ['The magistrate betrayed that trust.'],
			},
		};

		const prompt = buildServerTurnPrompt(ctx, packet('I follow her into the corridor.'), 'entry_current');
		const block = prompt.prompt.split('Character npc_maera / Maera Belaerys')[1].split('\n\n')[0];

		expect(block).toContain('known fact: The silver key opens the chapel crypt.');
		expect(block).toContain('did: Promised to keep Aurion hidden.');
		expect(block).toContain('saw: Saw the magistrate burn the ledger.');
		expect(block).toContain('knew: Aurion once trusted the magistrate.');
		expect(block).toContain('knows: The magistrate betrayed that trust.');
		expect(block.length + 'Character npc_maera / Maera Belaerys'.length).toBeLessThanOrEqual(1800);
	});

	it('keeps a complete relevant memory among many facts instead of clipping every fact into a fragment', () => {
		const ctx = context();
		const completeFact = 'Maera knows the silver chapel key came from Aurion: he entrusted it to her after the magistrate burned the ledger, on condition that she never surrender it to the harbor watch.';
		ctx.entities.find((entity) => entity.id === 'npc_maera')!.state = {
			present: true,
			appearance: 'Silver hair and embroidered robes. '.repeat(20),
			personality: 'Patient, observant, and fiercely independent. '.repeat(20),
			knownFacts: [completeFact, ...Array.from({ length: 5 }, (_, index) => `Unrelated recent fact ${index}.`)],
			eventMemory: {
				did: ['Old action.', 'Promised to conceal Aurion from the harbor watch until his innocence could be proved; she gave her word because he protected her daughter at the bridge.'],
				saw: ['Old sight.', 'Saw the magistrate burn the ledger.'],
				knew: ['Old knowledge.', 'Aurion once trusted the magistrate.'],
				knows: ['Old belief.', 'The magistrate betrayed that trust.'],
			},
		};

		const prompt = buildServerTurnPrompt(ctx, packet('I ask her about the silver chapel key.'), 'entry_current');
		const block = prompt.prompt.split('Character npc_maera / Maera Belaerys')[1].split('\n\n')[0];

		expect(block).toContain(completeFact);
		expect(block).toContain('Promised to conceal Aurion from the harbor watch until his innocence could be proved; she gave her word because he protected her daughter at the bridge.');
		expect(block).not.toContain('Unrelated recent fact');
		expect(block).not.toContain('Old action.');
		expect(block.match(/^- /gm)).toHaveLength(5);
		expect(block.length + 'Character npc_maera / Maera Belaerys'.length).toBeLessThanOrEqual(1800);
	});

	it('keeps beliefs for a scene-grounded actor despite a stale absent flag', () => {
		const ctx = context();
		ctx.entities.find((entity) => entity.id === 'npc_maera')!.state = { present: false };
		ctx.entities.push(entity('npc_scout', 'character', 'Nessa Vale', 'The party scout remains outside.', {
			present: false, partyMember: true,
		}));
		ctx.beliefs = [
			row({ id: 'belief_maera', believerEntityId: 'npc_maera', subjectEntityId: 'pc_aurion', belief: 'Aurion entrusted her with the silver key.', confidence: 1 }),
			row({ id: 'belief_scout', believerEntityId: 'npc_scout', subjectEntityId: null, belief: 'The distant scout knows the watch password.', confidence: 1 }),
		] as unknown as TurnContext['beliefs'];

		const prompt = buildServerTurnPrompt(ctx, packet('I answer her.'), 'entry_current');

		expect(prompt.prompt).toContain('Actor belief limits:');
		expect(prompt.prompt).toContain('Aurion entrusted her with the silver key.');
		expect(prompt.prompt).not.toContain('The distant scout knows the watch password.');
	});

	it('keeps OOC exchanges out of narrator history and labels private thoughts', () => {
		const ctx = context();
		ctx.recentEntries.push(
			row({ id: 'entry_ooc_legacy', storyId: 'story_test', type: 'user_action', content: 'OOC: stop making the port mystical.', position: 3, parentId: null, branchId: null, metadata: {} }),
			row({ id: 'narration_ooc_legacy', storyId: 'story_test', type: 'narration', content: 'You are right. I will rewrite the port.', position: 4, parentId: 'entry_ooc_legacy', branchId: null, metadata: {} }),
			row({ id: 'entry_gm_control', storyId: 'story_test', type: 'user_action', content: '> Game Master: reset to the emperor\'s offer.', position: 5, parentId: null, branchId: null, metadata: {} }),
			row({ id: 'entry_ooc_tagged', storyId: 'story_test', type: 'user_action', content: 'Keep the correction concise.', position: 5, parentId: null, branchId: null, metadata: { actionType: 'ooc', nonCanon: true } }),
			row({ id: 'narration_ooc_tagged', storyId: 'story_test', type: 'narration', content: 'Tagged control response.', position: 6, parentId: 'entry_ooc_tagged', branchId: null, metadata: { actionType: 'ooc', nonCanon: true } }),
			row({ id: 'entry_gm_mention', storyId: 'story_test', type: 'user_action', content: 'I tell the GM of the merchant guild that the levy is late.', position: 6, parentId: null, branchId: null, metadata: {} }),
			row({ id: 'narration_gm_mention', storyId: 'story_test', type: 'narration', content: 'The guild master closes his ledger.', position: 6, parentId: 'entry_gm_mention', branchId: null, metadata: {} }),
			row({ id: 'narration_gm_control', storyId: 'story_test', type: 'narration', content: 'Control response that must not survive.', position: 6, parentId: 'entry_gm_control', branchId: null, metadata: {} }),
			row({ id: 'entry_pov_control', storyId: 'story_test', type: 'user_action', content: '/pov Maera | studies the harbor ledger.', position: 6, parentId: null, branchId: null, metadata: { actionType: 'pov' } }),
			row({ id: 'narration_pov_control', storyId: 'story_test', type: 'narration', content: 'Maera studies the harbor ledger alone.', position: 6, parentId: 'entry_pov_control', branchId: null, metadata: { actionType: 'pov' } }),
			row({ id: 'entry_think', storyId: 'story_test', type: 'user_action', content: '> I think to myself: "Maera is hiding something."', position: 7, parentId: null, branchId: null, metadata: { actionType: 'think' } }),
			row({ id: 'narration_think', storyId: 'story_test', type: 'narration', content: '[ Maera\'s Study ] Maera folds the map without looking up.', position: 8, parentId: 'entry_think', branchId: null, metadata: { actionType: 'think' } }),
		);

		const prompt = buildServerTurnPrompt(ctx, packet('I wait.'), 'entry_current');
		const history = prompt.messages.map((message) => message.content).join('\n');

		expect(history).not.toContain('stop making the port mystical');
		expect(history).not.toContain('I will rewrite the port');
		expect(history).not.toContain('Tagged control response');
		expect(history).not.toContain('reset to the emperor\'s offer');
		expect(history).not.toContain('Control response that must not survive');
		expect(history).not.toContain('/pov Maera');
		expect(history).toContain('Maera studies the harbor ledger alone');
		expect(history).toContain('I tell the GM of the merchant guild');
		expect(history).toContain('The guild master closes his ledger');
		expect(history).toContain('[PRIVATE THOUGHT — narrator only; not spoken or observable to NPCs]');
		expect(history).toContain('Maera is hiding something');
		expect(history).toContain("Maera folds the map without looking up");
		expect(prompt.prompt).not.toContain("Maera folds the map without looking up");
		expect(prompt.prompt).not.toContain('Tagged control response');
	});

	it('guards against over-broad client sceneEntityIds from loading unrelated active NPCs', () => {
		const ctx = context();
		const allEntityIds = ctx.entities.map((item) => item.id);
		const prompt = buildServerTurnPrompt(ctx, packet('I ask Maera what comes next'), 'entry_1', {
			sceneEntityIds: allEntityIds,
			presentNpcIds: allEntityIds.filter((id) => id.startsWith('npc_')),
		});

		expect(prompt.prompt).toContain('Maera Belaerys');
		expect(prompt.prompt).toContain('Player character:');
		expect(prompt.prompt).not.toContain('Addam Velaryon');
		expect(prompt.prompt).not.toContain('Aegon 0 Targaryen');
	});

	it('keeps stored context subordinate to the current scene and drops generated placeholder noise', () => {
		const ctx = context();
		ctx.entities.push(entity(
			'npc_first_self_stub',
			'character',
			'First Self',
			'First Self is important in this chapter checkpoint.',
			{ present: true, eventMemory: { did: ['Turn resolved'] } },
			{ createdFrom: 'character_reference_review' },
		));
		ctx.events = [
			row({ id: 'event_generic', storyId: 'story_test', type: 'scene', title: 'Turn resolved', body: 'Turn resolved.', status: 'resolved', metadata: {} }),
			row({ id: 'event_signal', storyId: 'story_test', type: 'political', title: 'The harbor pact fractures', body: 'Maera receives proof that the pact was altered.', status: 'committed', metadata: {} }),
		] as TurnContext['events'];

		const prompt = buildServerTurnPrompt(ctx, packet('I ask Maera about the altered pact'), 'entry_1', {
			sceneEntityIds: ['pc_aurion', 'npc_maera', 'npc_first_self_stub'],
			presentNpcIds: ['npc_maera', 'npc_first_self_stub'],
		});

		expect(prompt.system.startsWith('ROLEPLAY AUTHORITY:')).toBe(true);
		expect(prompt.system).toContain('SOURCE PRIORITY: Player input supplies only player-character intent');
		expect(prompt.prompt).toContain('<context_data>');
		expect(prompt.prompt).toContain('</context_data>');
		expect(prompt.prompt).not.toContain('First Self is important in this chapter checkpoint');
		expect(prompt.prompt).toContain('The harbor pact fractures');
		expect(prompt.prompt).not.toContain('Turn resolved.');
	});

	it('uses the story currentLocationId before stale entity current flags', () => {
		const ctx = context();
		ctx.recentEntries = ctx.recentEntries.filter((entry) => entry.type !== 'narration');
		ctx.entities[0] = entity('loc_study', 'location', 'Maera Belaerys private study', 'The authoritative room.', { current: false });
		ctx.entities.unshift(entity('loc_stale', 'location', 'Old Harbor', 'A stale location.', { current: true }));

		const prompt = buildServerTurnPrompt(ctx, packet(), 'entry_1');

		expect(prompt.prompt).toContain('Current location:\nMaera Belaerys private study');
		expect(prompt.prompt).not.toContain('Current location:\nOld Harbor');
	});

	it('gives a named current-scene actor a rich block before stale client scene ids', () => {
		const ctx = context();
		const stale = Array.from({ length: 6 }, (_, index) =>
			entity(`npc_stale_${index}`, 'character', `Stale Courtier ${index}`, `Stale courtier ${index}.`, { present: true, currentLocation: 'Occult Research Club Room' }),
		);
		ctx.entities.splice(2, 0, ...stale);
		ctx.entities.push(entity('npc_amaterasu', 'character', 'Amaterasu', 'The sun goddess refuses to be treated as an accessory.', {
			present: false,
			personality: 'patient but sovereign',
			speechStyle: 'measured and final',
		}));
		ctx.recentEntries[1] = row({
			id: 'narration_1', storyId: 'story_test', type: 'narration',
			content: '[ Inner Residence ] Amaterasu turns toward Aurion and waits for his answer.',
			position: 2, parentId: 'entry_1', branchId: null, metadata: {},
		});

		const prompt = buildServerTurnPrompt(ctx, packet('I answer her.'), 'entry_1', {
			sceneEntityIds: ['pc_aurion', ...stale.map((character) => character.id)],
			presentNpcIds: stale.map((character) => character.id),
		});

		expect(prompt.prompt).toContain('Character npc_amaterasu / Amaterasu');
		expect(prompt.prompt).toContain('The sun goddess refuses to be treated as an accessory.');
		expect(prompt.prompt).not.toContain('Character npc_stale_0 / Stale Courtier 0');
		expect(prompt.prompt.match(/^Character npc_/gm)).toHaveLength(1);
	});

	it('uses the final beat of a montage for actor grounding', () => {
		const ctx = context();
		ctx.entities.push(
			entity('npc_sona', 'character', 'Sona Sitri', 'The student council president.', { present: false }),
			entity('npc_amaterasu', 'character', 'Amaterasu', 'The sun goddess beside the player.', { present: false }),
		);
		ctx.recentEntries[1] = row({
			id: 'narration_1', storyId: 'story_test', type: 'narration',
			content: '[ Tamegura - Inner Residence, Bedroom ]\n\nSona Sitri signs the repair report at Kuoh.\n\nTuesday passes in rain.\n\nWednesday passes quietly.\n\nThursday brings a distant letter.\n\nAmaterasu settles beside you in the bedroom.\n\nThe house is still around you both.',
			position: 2, parentId: 'entry_1', branchId: null, metadata: {},
		});

		const prompt = buildServerTurnPrompt(ctx, packet('I remain beside her.'), 'entry_1');

		expect(prompt.prompt).toContain('Character npc_amaterasu / Amaterasu');
		expect(prompt.prompt).not.toContain('Character npc_sona / Sona Sitri');
		expect(prompt.prompt).not.toContain('Sona Sitri signs the repair report');
	});

	it('does not treat a reference-only comparison as current-scene presence', () => {
		const ctx = context();
		ctx.entities.push(
			entity('npc_amaterasu', 'character', 'Amaterasu', 'The sun goddess beside the player.', { present: false }),
			entity('npc_great_red', 'character', 'Great Red', 'A dragon who remains in the Dimensional Gap.', { present: false }),
		);
		ctx.recentEntries[1] = row({
			id: 'narration_1', storyId: 'story_test', type: 'narration',
			content: '[ Inner Residence, Nursery ]\n\nAmaterasu stands beside you at the cradle.\n\nYour diminished power is no longer enough to challenge Great Red.',
			position: 2, parentId: 'entry_1', branchId: null, metadata: {},
		});

		const prompt = buildServerTurnPrompt(ctx, packet('I answer Amaterasu.'), 'entry_1');

		expect(prompt.prompt).toContain('Character npc_amaterasu / Amaterasu');
		expect(prompt.prompt).not.toContain('Character npc_great_red / Great Red');
	});

	it('keeps an off-screen active party member available to the narrator', () => {
		const ctx = context();
		ctx.entities.push(entity('npc_scout', 'character', 'Nessa Vale', 'The party scout watches the road ahead.', {
			present: false,
			partyMember: true,
			partyRole: 'Scout',
		}));

		const prompt = buildServerTurnPrompt(ctx, packet('I ask Maera about the map.'), 'entry_1');

		expect(prompt.prompt).toContain('Character npc_scout / Nessa Vale');
		expect(prompt.prompt).toContain('active party member (Scout)');
	});

	it('includes rich canon cards for at most four exact scene actors', () => {
		const ctx = context();
		const actors = Array.from({ length: 5 }, (_, index) =>
			entity(`npc_actor_${index}`, 'character', `Scene Actor ${index}`, `Distinct scene actor ${index}.`, { present: true }),
		);
		ctx.entities.push(...actors);
		ctx.recentEntries[1] = row({
			id: 'narration_1', storyId: 'story_test', type: 'narration',
			content: `[ Great Hall ] ${actors.map((actor) => actor.name).join(', ')} wait around the table.`,
			position: 2, parentId: 'entry_1', branchId: null, metadata: {},
		});

		const prompt = buildServerTurnPrompt(ctx, packet('I study the room.'), 'entry_1');

		expect(prompt.prompt.match(/^Character npc_actor_/gm)).toHaveLength(4);
		expect(prompt.prompt).not.toContain('Character npc_actor_4 / Scene Actor 4');
	});

	it('preserves durable player identity without repeating stale travel or relationship fields', () => {
		const ctx = context();
		ctx.entities[1] = entity(
			'pc_aurion',
			'character',
			'Aurion Belaerys',
			'A young Valyrian noble of House Belaerys. He is currently sailing toward Asshai. He is unattached and seeking a match.',
			{
				relationship: 'self',
				present: true,
				background: 'Dragonlord-trained courtier; presently heading to Asshai.',
			},
		);
		ctx.recentEntries[1] = row({
			id: 'narration_1', storyId: 'story_test', type: 'narration',
			content: '[ Imperial Residence - Private Room ] Mei-Lin closes the door. The two of you now have a small private room to yourselves.',
			position: 2, parentId: 'entry_1', branchId: null, metadata: {},
		});

		const prompt = buildServerTurnPrompt(ctx, packet('I answer Mei-Lin.'), 'entry_1');

		expect(prompt.prompt).toContain('A young Valyrian noble of House Belaerys');
		expect(prompt.prompt).not.toContain('sailing toward Asshai');
		expect(prompt.prompt).not.toContain('heading to Asshai');
		expect(prompt.prompt).not.toContain('unattached');
	});

	it('lets an exclusive current scene override a stale NPC present flag and action', () => {
		const ctx = context();
		ctx.entities.push(
			entity('npc_mei_lin', 'character', 'Mei-Lin', 'The emperor\'s daughter.', { present: true }),
			entity('npc_bu_gai', 'character', 'Bu Gai', 'The emperor.', {
				present: true,
				currentAction: 'Offers his daughter in marriage before the assembled court.',
			}),
		);
		ctx.recentEntries[1] = row({
			id: 'narration_1', storyId: 'story_test', type: 'narration',
			content: '[ Imperial Residence - Private Room ] Mei-Lin closes the door behind you. The two of you are alone together in the small private room.',
			position: 2, parentId: 'entry_1', branchId: null, metadata: {},
		});

		const prompt = buildServerTurnPrompt(ctx, packet('I answer Mei-Lin.'), 'entry_1', {
			sceneEntityIds: ['pc_aurion', 'npc_mei_lin', 'npc_bu_gai'],
			presentNpcIds: ['npc_mei_lin', 'npc_bu_gai'],
		});

		expect(prompt.prompt).toContain('Character npc_mei_lin / Mei-Lin');
		expect(prompt.prompt).not.toContain('Character npc_bu_gai / Bu Gai');
		expect(prompt.prompt).not.toContain('Offers his daughter in marriage before the assembled court');
	});
});

 it('retains detailed lore beyond the old 4000-character cap in the actual GM packet', () => {
	const lore = '# Wiki Context\n' + 'A city custom with its condition. '.repeat(220) + '\nOnly invited guests are exempt.';
	const prompt = buildServerTurnPrompt(context(), packet(), 'lore_test', { wikiContextMarkdown: lore });
	expect(prompt.prompt).toContain('Only invited guests are exempt.');
	expect(prompt.contextRecords.find(record => record.kind === 'wikiBlocks')).toBeDefined();
 });
