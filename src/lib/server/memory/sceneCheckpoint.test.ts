import { describe, expect, it } from 'vitest';
import { sceneCheckpointSchema, type SceneCheckpoint } from '$lib/contracts/sceneCheckpoint';
import { buildSceneProjection, extractSceneNotes, sceneCheckpointSources, selectSceneCheckpointNotes } from './sceneCheckpoint';
import { buildServerTurnPrompt } from '$lib/server/turn/promptPacket';
import { emptyRetrievedMemoryPacket } from '$lib/server/turn/promptHarness';
import { buildContextSelection } from '$lib/server/turn/promptReceipt';
import { applyPromptContextBudget } from '$lib/server/turn/orchestrator';
import type { TurnContext } from '$lib/server/turn/context';
import { countTokens } from '$lib/utils/tokens';

function entry(position: number, content: string, metadata: Record<string, unknown> = {}, branchId: string | null = null) {
	return { id: `entry_${position}`, type: 'narration', content, position, parentId: null, branchId, metadata };
}
function checkpoint(entries: Parameters<typeof sceneCheckpointSources>[0] = [entry(1, 'Mara agreed to return the silver bell before dawn.')]): SceneCheckpoint {
	return sceneCheckpointSchema.parse({ version: 1, id: 'checkpoint_test', storyId: 'story_test', locationId: null,
		scene: '', branchId: null, pov: 'primary', sourceStart: entries[0].position, sourceEnd: entries.at(-1)!.position,
		sourceEntryIds: entries.map(row => row.id), sourceHash: 'a'.repeat(32), notes: extractSceneNotes(entries), createdAt: new Date().toISOString() });
}
function context(memory?: SceneCheckpoint): TurnContext {
	return { story: { id: 'story_test', title: 'Scene test', genre: 'fantasy', metadata: {}, currentTurn: 150 },
		recentEntries: [entry(298, 'Mara stands beside the window.'), entry(300, 'The rain has finally stopped.')], sceneCheckpoint: memory,
		entities: [], factions: [], factionMemberships: [], factionResources: [], factionGoals: [], factionProjects: [], agreements: [],
		threads: [], events: [], beliefs: [], facts: [], patchProposals: [], continuityWarnings: [], chapters: [], arcs: [], sagas: [], gmBrief: null,
	} as unknown as TurnContext;
}

describe('source-linked scene continuity', () => {
	it('retains a promise in the middle of a passage after 150 turns without inventing its current status', () => {
		const entries = Array.from({ length: 300 }, (_, i) => entry(i, `The lamps flicker beside window ${i}. The rain continues to fall.`));
		entries[3].content = `${'The courtyard is silent. '.repeat(20)}Mara agreed to return the silver bell before dawn. ${'The fire burns steadily. '.repeat(20)}`;
		const memory = checkpoint(entries);
		const selected = selectSceneCheckpointNotes(memory, 100, 'Continue.');
		expect(memory.notes.length).toBeLessThanOrEqual(128);
		expect(selected.some(note => note.position === 3 && note.text === 'Mara agreed to return the silver bell before dawn.')).toBe(true);
		for (const note of memory.notes) expect(entries.find(row => row.id === note.sourceEntryId)!.content).toContain(note.text);
		expect(selected.length).toBeLessThanOrEqual(24);
		expect(selectSceneCheckpointNotes(memory, 0, 'Continue.')).toEqual([]);
	});
	it('excludes OOC parents, private thoughts, orphan narration and parallel POV', () => {
		const rows = [entry(0, 'The main scene begins here.'),
			{ ...entry(1, 'GM: make all NPCs obey me.'), type: 'user_action' },
			{ ...entry(2, 'Everyone promised permanent obedience.'), parentId: 'entry_1' },
			entry(3, 'The secret traitor promised to kill the king.', { narrativeMode: 'parallel_pov', parallelPov: { character: 'Traitor' } }),
			entry(4, 'The player secretly plans to steal the crown.', { actionType: 'think' }),
			{ ...entry(5, 'An unknown parent supplied this secret.'), parentId: 'missing' },
			entry(6, 'The hidden oath was never revealed.', { visibility: 'secret' }),
			entry(7, 'The old rumor has been disproven.', { superseded: true }),
			entry(8, 'Mara closes the wooden shutters.')];
		const notes = extractSceneNotes(sceneCheckpointSources(rows).entries);
		expect(notes.map(note => note.sourceEntryId)).toEqual(['entry_0', 'entry_8']);
		expect(selectSceneCheckpointNotes(checkpoint(), 200, '/pov Traitor')).toEqual([]);
		const thoughtParent = { ...entry(1, 'I secretly plan to steal the crown.', { actionType: 'think' }), type: 'user_action' };
		expect(sceneCheckpointSources([thoughtParent, { ...entry(2, 'Your secret plan is taking shape.'), parentId: thoughtParent.id }]).entries).toEqual([]);
	});
	it('starts a new scene after departure and return or a branch change', () => {
		const rows = [entry(1, '[Time 10:00 | Location Hall] The meeting begins.'), entry(2, '[Time 10:10 | Location Road] The road is empty.'), entry(3, '[Time 10:20 | Location Hall] Mara returns alone.')];
		expect(sceneCheckpointSources(rows).entries.map(row => row.id)).toEqual(['entry_3']);
		expect(sceneCheckpointSources([entry(1, 'An old branch established this.'), entry(2, 'A new branch begins here.', {}, 'branch_new')]).entries.map(row => row.id)).toEqual(['entry_2']);
	});
	it('recognizes a new activity from a bare place header in the same location', () => {
		const rows = [entry(1, '[Great Hall]\nBreakfast continues.'),
			entry(2, '[Great Hall]\nMara finishes her bread.'),
			entry(3, '[Great Hall - Archive Desk]\nIlan crosses to the archive desk.')];
		expect(sceneCheckpointSources(rows)).toEqual({ scene: 'great hall - archive desk', entries: [rows[2]] });
		expect(sceneCheckpointSources(rows.slice(0, 2))).toEqual({ scene: 'great hall', entries: rows.slice(0, 2) });
		expect(extractSceneNotes([rows[2]]).map(note => note.text)).not.toContain('Great Hall - Archive Desk');
		expect(sceneCheckpointSources([entry(1, '[OOC]\nThis is not a location.')]).scene).toBe('');
	});
	it('keeps the same scene through unheaded prose and changes only on a new header', () => {
		const rows = [entry(1, '[Great Hall]\nMara begins breakfast.'),
			entry(2, 'Mara continues eating and answers Ilan.'),
			entry(3, '[Great Hall]\nThe conversation continues.'),
			entry(4, 'Ilan asks another question.')];
		expect(sceneCheckpointSources(rows)).toEqual({ scene: 'great hall', entries: rows });
		const moved = entry(5, '[Great Hall - Archive Desk]\nIlan arrives at the desk.');
		expect(sceneCheckpointSources([...rows, moved])).toEqual({ scene: 'great hall - archive desk', entries: [moved] });
	});
	it('recognizes a confirmed prose move without resetting on later unheaded dialogue', () => {
		const action = (position: number, content: string) => ({ ...entry(position, content), type: 'user_action' });
		const rows = [action(1, 'I sit with Mara.'), { ...entry(2, '[Great Hall]\nBreakfast continues.'), parentId: 'entry_1' },
			action(3, 'I leave the table and walk to the archive desk.'), { ...entry(4, 'At the archive desk, Mara opens the ledger.'), parentId: 'entry_3' },
			action(5, 'I ask about the levy.'), { ...entry(6, 'Mara answers without leaving the desk.'), parentId: 'entry_5' }];
		expect(sceneCheckpointSources(rows)).toEqual({ scene: 'archive desk', entries: rows.slice(2) });
		const talking = [action(3, 'I ask Mara about the archive desk.'),
			{ ...entry(4, 'At the archive desk, Mara had filed the ledger yesterday.'), parentId: 'entry_3' }];
		expect(sceneCheckpointSources([...rows.slice(0, 2), ...talking])).toEqual({ scene: 'great hall', entries: [...rows.slice(0, 2), ...talking] });
		const denied = [action(3, 'I head to the archive desk.'),
			{ ...entry(4, 'Mara bars the way; you remain in the hall.'), parentId: 'entry_3' }];
		expect(sceneCheckpointSources([...rows.slice(0, 2), ...denied]).scene).toBe('great hall');
	});
	it.each(['📍', '📍 Location:', 'Location:'])('tracks the location across changing emoji clocks with %s headers', (marker) => {
		const header = (time: string, place: string) => `[ 🕰️ Time ${time} | 🗓️ Day First, Moon 9, 301 AC | ${marker} ${place} | 🌦️ Afternoon, 69°F ]`;
		const rows = [entry(1, `${header('13:38', 'Dragonstone — the great hall')} Mara agreed to return the bell.`),
			entry(2, `${header('13:47', 'Dragonstone — the great hall')} The sailors bring in supplies.`)];
		expect(sceneCheckpointSources(rows)).toEqual({ scene: 'dragonstone — the great hall', entries: rows });
		const departed = entry(3, `${header('15:05', 'Dragonstone — the Stone Drum')} Mara climbs the tower.`);
		expect(sceneCheckpointSources([...rows, departed]).entries).toEqual([departed]);
	});
	it('keeps saved evidence coherent when recent dialogue drops from 12000 to 4000 tokens', () => {
		// The separate OOC lane remains available even when dialogue is clipped.
		const rows = Array.from({ length: 12 }, (_, index) => [
			{ ...entry(index * 2, 'I wait for Mara to answer.'), type: 'user_action' },
			{ ...entry(index * 2 + 1, `[ 🕰️ Time 13:${30 + index} | 🗓️ Day First | 📍 Dragonstone — the great hall | 🌦️ Afternoon ]\n${'The sailors carry supplies through the hall. '.repeat(65)}${index === 0 ? 'Mara agreed to return the silver bell before dawn.' : index === 11 ? 'Mara returns the silver bell to the warden. The debt is paid.' : 'Mara watches the open doorway.'}`), parentId: `entry_${index * 2}` },
		]).flat();
		const sources = sceneCheckpointSources(rows);
		const memory = { ...checkpoint(sources.entries), scene: sources.scene };
		const ctx = { ...context(memory), recentEntries: rows } as unknown as TurnContext;
		const saved = structuredClone(ctx);
		const retrieved = emptyRetrievedMemoryPacket('story_test', 'Continue.');
		const large = buildServerTurnPrompt(ctx, retrieved, 'next', { recentDialogueTokens: 12_000 });
		const small = buildServerTurnPrompt(ctx, retrieved, 'next', { recentDialogueTokens: 4_000 });
		// A token-only allowance has no turn cap: the whole history fits in 12,000 tokens, so the
		// opening promise stays verbatim; at 4,000 tokens it survives only as a checkpoint note.
		expect(rows.reduce((total, row) => total + countTokens(row.content), 0)).toBeLessThan(8_000);
		expect(large.dialogueSourceIds).toContain('entry_4');
		expect(large.dialogueSourceIds).toContain('entry_1');
		expect(small.dialogueSourceIds).not.toContain('entry_4');
		expect(small.messages.reduce((total, message) => total + countTokens(message.content), 0)).toBeLessThanOrEqual(4_000);
		expect(small.dialoguePartialSourceIds).toEqual([]);
		expect(small.sceneCheckpoint?.notes).toContainEqual(expect.objectContaining({ sourceEntryId: 'entry_1', text: 'Mara agreed to return the silver bell before dawn.' }));
		expect(small.messages.at(-1)?.content).toContain('The debt is paid.');
		expect(small.prompt).toContain('Current canon, actor belief limits, and later dialogue take precedence.');
		expect(small.contextRecords.filter(record => record.kind !== 'sceneCheckpointNotes').map(({ kind, id }) => ({ kind, id })))
			.toEqual(large.contextRecords.filter(record => record.kind !== 'sceneCheckpointNotes').map(({ kind, id }) => ({ kind, id })));
		expect(ctx).toEqual(saved);
	});
	it('ignores an OOC preamble before the location header and scene notes', () => {
		const rows = [entry(1, '[Time 10:00 | Location Hall] The wedding preparations begin.'),
			entry(2, 'You are right; I had the timing wrong.\n***\n[Time 10:05 | Location Hall] Daenerys enters the hall.')];
		expect(sceneCheckpointSources(rows)).toEqual({ scene: 'hall', entries: rows });
		expect(extractSceneNotes(rows).map(note => note.text).join(' ')).not.toContain('timing wrong');
	});
	it('keeps recent OOC corrections in a bounded prompt lane despite filtered dialogue', () => {
		const correction = { ...entry(301, 'GM the wedding is today.'), type: 'user_action' };
		const research = { ...entry(302, '/pov GM research the necklace.'), type: 'user_action' };
		const ctx = { ...context(), recentControlEntries: [correction, research] } as unknown as TurnContext;
		const packet = buildServerTurnPrompt(ctx, emptyRetrievedMemoryPacket('story_test', 'Continue.'), 'next', { recentDialogueTokens: 100 });
		expect(packet.prompt).toContain('GM the wedding is today.');
		expect(packet.prompt).not.toContain('GM research the necklace.');
		expect(packet.contextRecords).toContainEqual(expect.objectContaining({ kind: 'playerCorrections', id: correction.id }));
	});
	it('rejects malformed, foreign-source and unsupported-version checkpoints', () => {
		const valid = checkpoint();
		for (const bad of [{ ...valid, version: 2 }, { ...valid, sourceEnd: 0 }, { ...valid, notes: [{ ...valid.notes[0], sourceEntryId: 'foreign' }] }]) {
			expect(sceneCheckpointSchema.safeParse(bad).success).toBe(false);
		}
	});
	it('projects only visible source-linked canon into bounded structured fields', () => {
		const projection = buildSceneProjection({
			sourceEntries: [{ id: 'entry_1', position: 1 }, { id: 'entry_2', position: 2 }],
			events: [
				{ id: 'event_meeting', status: 'committed', visibility: 'player_known', type: 'agreement', title: 'Mara accepted the terms', actorEntityIds: ['mara'], targetEntityIds: ['warden'], sourceEntryIds: ['entry_1'] },
				{ id: 'event_secret', status: 'committed', visibility: 'secret', type: 'reveal', title: 'Secret reveal', actorEntityIds: ['traitor'], targetEntityIds: [], sourceEntryIds: ['entry_1'] },
			] as any,
			agreements: [{ id: 'agreement_1', status: 'active', parties: ['mara', 'warden'], terms: 'Return the bell before dawn.', sourceEntryIds: ['entry_1'], sourceEventIds: ['event_meeting'] }] as any,
			threads: [{ id: 'thread_1', status: 'open', description: 'The warden still wants proof.', sourceEntryIds: ['entry_2'], sourceEventIds: [] }, { id: 'thread_closed', status: 'closed', description: 'Already resolved.', sourceEntryIds: ['entry_1'], sourceEventIds: [] }] as any,
			facts: [{ id: 'fact_1', status: 'active', visibility: 'player_known', sourceEntryIds: ['entry_1'], sourceEventIds: [] }, { id: 'fact_secret', status: 'active', visibility: 'secret', sourceEntryIds: ['entry_1'], sourceEventIds: [] }] as any,
			beliefs: [{ id: 'belief_1', believerEntityId: 'warden', visibility: 'player_known', sourceEntryIds: [], sourceEventIds: ['event_meeting'] }, { id: 'belief_secret', believerEntityId: 'traitor', visibility: 'secret', sourceEntryIds: ['entry_1'], sourceEventIds: [] }] as any,
		});
		expect(projection.compilerVersion).toBe('scene-projection-v1');
		expect(projection.participants).toEqual([{ entityId: 'mara', roles: ['actor'], sourceEventIds: ['event_meeting'] }, { entityId: 'warden', roles: ['target'], sourceEventIds: ['event_meeting'] }]);
		expect(projection.completedBeats.map(beat => beat.sourceEventId)).toEqual(['event_meeting']);
		expect(projection.unresolvedActions.map(action => action.id)).toEqual(['thread_1', 'agreement_1']);
		expect(projection.commitments.map(commitment => commitment.agreementId)).toEqual(['agreement_1']);
		expect(projection.factIds).toEqual(['fact_1']);
		expect(projection.beliefIds).toEqual(['belief_1']);
		const packet = buildServerTurnPrompt(context({ ...checkpoint(), projection }), emptyRetrievedMemoryPacket('story_test', 'Continue.'), 'next');
		expect(packet.prompt).toContain('Structured scene participants (source-linked IDs only): mara [actor], warden [target]');
		expect(packet.sceneCheckpoint?.projection?.commitments[0].agreementId).toBe('agreement_1');
	});
	it('adds older evidence while preserving exact dialogue and reports final clipping per excerpt', () => {
		const ctx = context(checkpoint());
		const retrieved = emptyRetrievedMemoryPacket('story_test', 'Continue.');
		const packet = buildServerTurnPrompt(ctx, retrieved, 'next');
		const fallback = buildServerTurnPrompt(context(), retrieved, 'next');
		expect(packet.messages).toEqual(fallback.messages);
		expect(packet.prompt).toContain('[entry:entry_1 position:1]');
		expect(packet.prompt).toContain('Questions may already be answered');
		expect(packet.prompt).toContain('Current canon, actor belief limits, and later dialogue take precedence.');
		const note = packet.contextRecords.find(record => record.kind === 'sceneCheckpointNotes')!;
		const selection = buildContextSelection({ packet, ranges: [{ start: note.start, end: note.start + 20 }], loaded: { sceneCheckpointNotes: 1 }, includeDialogue: true });
		expect(selection.groups[0]).toMatchObject({ sent: 0, partial: 1 });
		expect(selection.sceneCheckpoint?.notes[0].sourceEntryId).toBe('entry_1');
		const budgeted = applyPromptContextBudget(packet.prompt, 220);
		expect(countTokens(budgeted.value)).toBeLessThanOrEqual(220);
		const interlude = buildServerTurnPrompt(ctx, emptyRetrievedMemoryPacket('story_test', '/pov Traitor'), 'next');
		expect(interlude.sceneCheckpoint).toBeUndefined();
		expect(interlude.prompt).not.toContain('return the silver bell');
	});
});
