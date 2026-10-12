import { describe, expect, it } from 'vitest';
import type { RetrievedMemoryPacket } from '$lib/contracts/memory';
import type { TurnContext } from './context';
import { buildServerTurnPrompt } from './promptPacket';
import { normalizeCharacterCard, renderCharacterCard } from './characterContext';
import { chapterCharacterContextPatch } from '$lib/server/jobs/processor';

const now = '2026-10-10T00:00:00.000Z';
const row = <T extends Record<string, unknown>>(value: T) => ({ serverVersion: 1, createdAt: now, updatedAt: now, ...value });
const character = (id: string, name: string, state: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => row({
	id, storyId: 'story_cards', type: 'character', name, description: `${name} of the harbor.`, status: 'active', visibility: 'player_known',
	state, metadata, sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [] });
const packet = (query: string): RetrievedMemoryPacket => ({ storyId: 'story_cards', query, packet: '', nodes: [], tokenEstimate: 0, retrievalDebug: [], retrievalTrace: [] });

const LONG_VOICE = 'Speaks in clipped harbor cant, swallows the ends of words when angry, never raises her voice, answers questions with questions, and calls everyone "tidewalker" until they have earned a name. She counts coins aloud in Low Valyrian when she is stalling, and she will not swear oaths on gods she does not keep.';
const LONG_PERSONALITY = 'Patient, observant and fiercely independent; she trades favours rather than coin and remembers every debt. Loyal to her granddaughter above any house, distrustful of magistrates, generous to sailors, and quietly ashamed of the bargain that bought her villa. She tests strangers with small kindnesses and judges them by what they do with them.';

function scene(): TurnContext {
	return {
		story: row({ id: 'story_cards', clientStoryId: null, title: 'Harbor Cards', description: '', genre: 'fantasy', mode: 'adventure',
			settings: { playerEntityId: 'pc_aurion' }, headerPrompt: null, currentLocationId: 'loc_quay', metadata: {} }),
		recentEntries: [
			row({ id: 'entry_1', storyId: 'story_cards', type: 'user_action', content: 'I wait on the quay.', position: 1, parentId: null, branchId: null, metadata: {} }),
			row({ id: 'narration_1', storyId: 'story_cards', type: 'narration', content: 'Maera Belaerys and Corlys stand on the quay beside you.', position: 2, parentId: 'entry_1', branchId: null, metadata: {} }),
		],
		entities: [
			row({ id: 'loc_quay', storyId: 'story_cards', type: 'location', name: 'The quay', description: 'Wet stone.', status: 'active', visibility: 'player_known', state: { current: true }, metadata: {}, sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [] }),
			character('pc_aurion', 'Aurion Belaerys', { present: true }),
			character('npc_maera', 'Maera Belaerys', { present: true, personality: LONG_PERSONALITY, speechStyle: LONG_VOICE, appearance: 'Silver hair, salt-stained robes.',
				knownFacts: ['The harbor watch changes at dusk.'], eventMemory: { saw: ['Saw the magistrate burn the ledger.'] } }),
			character('npc_corlys', 'Corlys', { present: true, voice: 'Gruff.' }),
		],
		factions: [], factionMemberships: [], factionResources: [], factionGoals: [], factionProjects: [], agreements: [], threads: [], events: [],
		beliefs: [], facts: [], patchProposals: [], continuityWarnings: [], chapters: [], arcs: [], sagas: [],
		gmBrief: { storyId: 'story_cards', currentTurn: 4, currentWorldTime: null, dueEvents: [], recentEvents: [], scheduledEvents: [],
			npcEvents: [{ npcEntityId: 'npc_maera', eventIds: ['event_poison'], summary: 'The magistrate plans to poison Maera at the feast', visibility: 'secret' }] },
	} as unknown as TurnContext;
}

describe('character contract in turn context', () => {
	it("keeps the addressed character's full personality and voice through context assembly", () => {
		const action = 'I ask Maera Belaerys what she wants for the ledger.';
		const prompt = buildServerTurnPrompt(scene(), packet(action), 'entry_current', { playerAction: action, presentNpcIds: ['npc_maera', 'npc_corlys'] });
		const narratorCard = prompt.prompt.split('Character npc_maera / Maera Belaerys')[1] ?? '';
		expect(narratorCard).toContain(LONG_VOICE);
		expect(narratorCard).toContain(LONG_PERSONALITY);
		const speakerCard = prompt.dialogueActorCards.find(card => card.id === 'npc_maera')!.text;
		expect(speakerCard).toContain(LONG_VOICE);
	});

	it('keeps secret GM links out of the NPC packet while the narrator still sees them labelled', () => {
		const action = 'I ask Maera Belaerys about the feast.';
		const prompt = buildServerTurnPrompt(scene(), packet(action), 'entry_current', { playerAction: action, presentNpcIds: ['npc_maera'] });
		expect(prompt.prompt).toContain('[secret narrator-only] linked: The magistrate plans to poison Maera at the feast');
		const speakerCard = prompt.dialogueActorCards.find(card => card.id === 'npc_maera')!.text;
		expect(speakerCard).not.toContain('poison');
		expect(speakerCard).toContain('saw: Saw the magistrate burn the ledger.');
	});

	it('never turns a secret event or a private thought aimed at a character into that character\'s memory', () => {
		const event = (id: string, visibility: string, metadata: Record<string, unknown> = {}) => ({ id, title: id, body: `${id} body`, visibility, metadata,
			actorEntityIds: ['npc_magistrate'], targetEntityIds: ['npc_maera'], status: 'committed', type: 'action' });
		const patch = chapterCharacterContextPatch({ entityId: 'npc_maera', currentState: {}, digest: { summary: '' } as never,
			events: [event('poison_plot', 'secret'), event('private_thought', 'player_known', { actionType: 'think' }), event('public_toast', 'public')] as never });
		expect(patch?.saw.join(' ')).toContain('public_toast');
		expect(patch?.saw.join(' ')).not.toContain('poison_plot');
		expect(patch?.saw.join(' ')).not.toContain('private_thought');
	});

	it('names omitted sections instead of presenting a partial card as complete', () => {
		const long = (word: string) => `${word} `.repeat(60).trim();
		const card = normalizeCharacterCard({ affiliations: [long('guild'), long('house')], entity: { id: 'npc_long', name: 'Long', description: long('harbor'),
			state: { personality: long('calm'), speechStyle: long('soft'), appearance: long('tall'), goals: [long('profit')], bio: long('born'),
				currentAction: long('mending'), emotionalState: long('wary'), currentDisposition: long('guarded'), rank: long('captain'),
				knownFacts: [long('fact'), long('rumor')], eventMemory: { did: [long('did')], saw: [long('saw')], knew: [long('knew')] } } } });
		const rendered = renderCharacterCard(card, { tier: 'scene', view: 'actor' });
		expect(rendered.text.length).toBeLessThanOrEqual(1800 + 'Character npc_long / Long'.length);
		expect(rendered.omittedSections.length).toBeGreaterThan(0);
		expect(rendered.text).toContain(`[Omitted for context budget: ${rendered.omittedSections.join(', ')}]`);
		expect(rendered.includedSections).toEqual(expect.arrayContaining(['Personality', 'Voice']));
	});

	it('adapts legacy metadata aliases with provenance and leaves the stored record untouched', () => {
		const metadata = { speechStyle: 'Old voice', bio: 'Imported biography', npcEventMemory: { knew: ['Knew the old pact.'] }, aliases: ['The Widow'] };
		const snapshot = structuredClone(metadata);
		const card = normalizeCharacterCard({ entity: { id: 'npc_import', name: 'Imported', state: {}, metadata } });
		expect(card).toMatchObject({ contractVersion: 1, voice: { guidance: 'Old voice' }, identity: { biography: 'Imported biography' }, aliases: ['The Widow'],
			knowledge: { memories: [{ kind: 'knew', text: 'Knew the old pact.' }] } });
		expect(card.provenance).toMatchObject({ 'voice.guidance': 'metadata.speechStyle', 'identity.biography': 'metadata.bio', 'knowledge.memories': 'metadata.eventMemory' });
		expect(metadata).toEqual(snapshot);
	});
});

describe('story developments on character cards', () => {
	it('shows the newest developments that fit, after the authored bio', () => {
		const developments = Array.from({ length: 10 }, (_, index) => `Development ${index + 1} happened at the harbor.`);
		const entity = character('npc_dev', 'Mira', { bio: 'Raised behind the Black Walls.', personality: 'Patient.', developments });
		const scene = renderCharacterCard(normalizeCharacterCard({ entity }), { tier: 'scene', view: 'narrator' }).text;
		expect(scene).toContain('[bio]: Mira of the harbor.; Raised behind the Black Walls.');
		expect(scene).toContain('[Developments]: ');
		expect(scene).toContain('Development 10 happened at the harbor.');
		expect(scene).not.toContain('Development 1 happened');
		const addressed = renderCharacterCard(normalizeCharacterCard({ entity }), { tier: 'addressed', view: 'narrator' }).text;
		expect(addressed).toContain('Development 1 happened at the harbor.; Development 2');
	});
});
