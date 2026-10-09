import { describe, expect, it } from 'vitest';
import { applyNpcDialogue, buildNpcDialoguePrompt, npcDialogueSpans, selectNpcDialogueSpans } from './dialoguePass';

describe('NPC dialogue pass', () => {
 it('carries psychology into expression without instructing spoken scores or affinity writes',()=>{
  const psychology={judgment:'threatened' as const,emotionalIntensity:4,relationshipDelta:-1,actionTriage:'controlled' as const,confidence:0.9,advisory:true as const,affinityApplied:false as const};
  const packet=JSON.parse(buildNpcDialoguePrompt({draft:'Silas says “Wait.”',spans:[],playerAction:'Make a demand.',context:'',contextRecords:[],messages:[],gmToolObservations:'',speakerDecision:{immediateAction:null,sourceIds:['fact-1'],psychology}}));
  expect(packet.speakerDecision.psychology).toEqual(psychology);
  expect(packet.psychologyDirection).toContain('Keep private judgments private');
  expect(packet.psychologyDirection).toContain('no internal monologue');
  expect(packet.speakerDecision.immediateAction).toBeNull();
  expect(packet.psychologyDirection).toContain('do not invent a decision from psychology alone');
 });
	it('uses a speaker card kept outside the narrator context', () => {
		const card = { id: 'serra', name: 'Serra', text: 'Character serra / Serra\n[Voice]: brisk.' };
		const packet = JSON.parse(buildNpcDialoguePrompt({
			draft: 'Serra says “Go.”', spans: [{ index: 0, start: 11, end: 16, text: 'Go.', quote: '“', speakerId: 'serra', speakerName: 'Serra' }],
			playerAction: 'Ask Serra to leave.', context: 'Current scene.', contextRecords: [], actorCards: [card],
			messages: [], gmToolObservations: '',
		}));
		expect(packet.actorContext).toContain('requiredActors [serra]: Character serra / Serra\n[Voice]: brisk.');
	});
	it('skips routine greetings only in important mode and retains meaningful speech', () => {
		const draft = 'Mara says “Hello.” The captain says “Your passage is booked.”';
		const spans = npcDialogueSpans(draft, '', [{ id: 'mara', name: 'Mara' }, { id: 'captain', name: 'Captain' }]);
		const input = { playerAction: 'Hello.', consequentialActorIds: new Set<string>() };
		expect(selectNpcDialogueSpans(spans, { ...input, mode: 'all' })).toHaveLength(2);
		const selected = selectNpcDialogueSpans(spans, { ...input, mode: 'important' });
		expect(selected.map(span => span.text)).toEqual(['Your passage is booked.']);
		expect(applyNpcDialogue(draft, selected, { lines: [{ index: 0, text: 'Your berth is ready.' }] }))
			.toBe('Mara says “Hello.” The captain says “Your berth is ready.”');
		expect(selectNpcDialogueSpans(spans, { ...input, mode: 'important', consequentialActorIds: new Set(['mara']) })).toHaveLength(2);
		expect(selectNpcDialogueSpans(spans, { ...input, mode: 'important', playerAction: 'I accept your offer.' })).toHaveLength(2);
	});
	it('sends bounded speech context without the full GM packet or private thoughts', () => {
		const draft = 'At the gate, Mara says “Wait here.” The guard turns away.';
		const spans = npcDialogueSpans(draft, 'I ask Mara to wait.');
		const context = `CURRENT SCENE\nMara stands at the gate.\nACTORS\nMara speaks carefully.\n${'old chapter '.repeat(20_000)}`;
		const actorStart = context.indexOf('Mara speaks carefully.');
		const packet = JSON.parse(buildNpcDialoguePrompt({
			draft, spans, playerAction: 'I ask Mara to wait.', context,
			contextRecords: [
				{ kind: 'requiredScene', start: 0, end: actorStart },
				{ kind: 'requiredActors', start: actorStart, end: context.length },
			],
			messages: [
				{ role: 'user', content: '[PRIVATE THOUGHT — narrator only] I distrust Mara.' },
				{ role: 'assistant', content: 'Mara watches the gate.' },
			],
			gmToolObservations: 'The guard is present.',
		}));
		expect(packet.actorContext.join(' ')).toContain('Mara speaks carefully.');
		expect(packet.utterances[0].sceneExcerpt).toContain('Mara says');
		expect(packet.recentExchanges).toEqual([{ role: 'assistant', content: 'Mara watches the gate.' }]);
		expect(JSON.stringify(packet)).not.toContain('I distrust Mara');
		expect(JSON.stringify(packet).length).toBeLessThan(8_000);
	});
	it('includes only the attributed speaker’s validated immediate intent', () => {
		const draft = 'Mara says “The gate is open.”';
		const spans = npcDialogueSpans(draft, 'I accept.', [{ id: 'mara', name: 'Mara' }]);
		const packet = JSON.parse(buildNpcDialoguePrompt({ draft, spans, playerAction: 'I accept.',
			context: 'Character mara / Mara', contextRecords: [{ kind: 'requiredActors', id: 'mara', start: 0, end: 21 }],
			messages: [], gmToolObservations: '', speakerDecision: { immediateAction: 'Honor the passage agreement.', sourceIds: ['agreement_1'] } }));
		expect(packet.speakerDecision).toEqual({ immediateAction: 'Honor the passage agreement.', sourceIds: ['agreement_1'] });
		expect(JSON.stringify(packet)).not.toContain('secret_other_actor');
	});
	it('changes only NPC speech and preserves scene prose, header, and player words', () => {
		const draft = '[ 🕰️ Time 10:00 ]\nThe guard blocks the gate. “No passage,” she says. You said “Let me through” and wait.';
		const spans = npcDialogueSpans(draft, 'Let me through');
		expect(spans.map(span => span.text)).toEqual(['No passage,']);
		expect(applyNpcDialogue(draft, spans, { lines: [{ index: 0, text: 'The gate stays shut,' }] }))
			.toBe('[ 🕰️ Time 10:00 ]\nThe guard blocks the gate. “The gate stays shut,” she says. You said “Let me through” and wait.');
	});
	it('rejects extra lines and turn markers rather than changing the scene', () => {
		const draft = '“Stay back.” He steps away.';
		const spans = npcDialogueSpans(draft, '');
		expect(() => applyNpcDialogue(draft, spans, { lines: [] })).toThrow();
		expect(() => applyNpcDialogue(draft, spans, { lines: [{ index: 0, text: '{{roll:1d20:20}}' }] })).toThrow();
	});
	it('keeps multiple straight and curly quoted lines in their original places', () => {
		const draft = 'The captain says "Hold." The scout replies, “They are here.”';
		const spans = npcDialogueSpans(draft, '');
		expect(applyNpcDialogue(draft, spans, { lines: [
			{ index: 0, text: 'Wait.' }, { index: 1, text: 'They have arrived.' },
		] })).toBe('The captain says "Wait." The scout replies, “They have arrived.”');
	});
	it('keeps each actor card and relevant personal beliefs when several speakers are present', () => {
		const names = ['Mara', 'Ilyan', 'Serra', 'Tomas'];
		const cards = names.map((name, index) => `Character npc_${index} / ${name}\n[Voice]: ${name} voice.\n[Goals]: ${name} goal.`);
		const context = cards.join('\n') + '\n' + names.map(name => `- ${name}: remembers the sealed offer.`).join('\n');
		let position = 0;
		const records = cards.map((card, index) => {
			const start = position;
			position += card.length + 1;
			return { kind: 'requiredActors', id: `npc_${index}`, start, end: start + card.length };
		});
		for (const name of names) {
			const text = `- ${name}: remembers the sealed offer.`;
			const start = context.indexOf(text);
			records.push({ kind: 'beliefs', id: name, start, end: start + text.length });
		}
		const draft = names.map(name => `${name} says “I heard you.”`).join(' ');
		const packet = JSON.parse(buildNpcDialoguePrompt({ draft, spans: npcDialogueSpans(draft, ''),
			playerAction: 'I ask everyone.', context, contextRecords: records, messages: [], gmToolObservations: '' }));
		for (const name of names) {
			expect(packet.actorContext.join(' ')).toContain(`${name} voice`);
			expect(packet.actorContext.join(' ')).toContain(`- ${name}: remembers`);
		}
	});
	it('keeps a speaker\'s private belief out of the other speaker\'s prompt', () => {
		const first = 'Character mara / Mara\n[Voice]: careful.\n[Secret]: northern key.';
		const second = 'Character serra / Serra\n[Voice]: brisk.\n[Secret]: southern tunnel.';
		const beliefOne = '- Mara: trusts only the red seal.';
		const beliefTwo = '- Serra: knows the blue cipher.';
		const context = [first, second, beliefOne, beliefTwo].join('\n');
		const records = [
			{ kind: 'requiredActors', id: 'mara', start: 0, end: first.length },
			{ kind: 'requiredActors', id: 'serra', start: first.length + 1, end: first.length + 1 + second.length },
			{ kind: 'beliefs', id: 'mara-belief', start: context.indexOf(beliefOne), end: context.indexOf(beliefOne) + beliefOne.length },
			{ kind: 'beliefs', id: 'serra-belief', start: context.indexOf(beliefTwo), end: context.indexOf(beliefTwo) + beliefTwo.length },
		];
		const draft = 'Mara says “Wait.” Serra says “Go.”';
		const spans = npcDialogueSpans(draft, '', [{ id: 'mara', name: 'Mara' }, { id: 'serra', name: 'Serra' }]);
		const packet = buildNpcDialoguePrompt({ draft, spans: [{ ...spans[0], index: 0 }], playerAction: 'I ask them.',
			context, contextRecords: records, messages: [], gmToolObservations: '' });
		expect(packet).toContain('northern key');
		expect(packet).toContain('red seal');
		expect(packet).not.toContain('southern tunnel');
		expect(packet).not.toContain('blue cipher');
	});
	it('rejects a rewritten number or reversal of an offer', () => {
		const draft = 'Mara says “I accept the offer for 20 coins.”';
		const spans = npcDialogueSpans(draft, '');
		expect(() => applyNpcDialogue(draft, spans, { lines: [{ index: 0, text: 'I refuse the offer for 20 coins.' }] })).toThrow();
		expect(() => applyNpcDialogue(draft, spans, { lines: [{ index: 0, text: 'I accept the offer for 30 coins.' }] })).toThrow();
		expect(() => applyNpcDialogue(draft, spans, { lines: [{ index: 0, text: 'I accept the offer for 20 coins. I promise a ship.' }] })).toThrow();
	});
	it('keeps named people and places in an NPC line', () => {
		const draft = 'Mara says “I met Serra in Qarth.”';
		const spans = npcDialogueSpans(draft, '');
		expect(() => applyNpcDialogue(draft, spans, { lines: [{ index: 0, text: 'I met Tomas in Qarth.' }] })).toThrow();
		expect(() => applyNpcDialogue(draft, spans, { lines: [{ index: 0, text: 'I met Serra in Volantis.' }] })).toThrow();
		expect(applyNpcDialogue(draft, spans, { lines: [{ index: 0, text: 'I crossed paths with Serra in Qarth.' }] }))
			.toContain('“I crossed paths with Serra in Qarth.”');
	});
	it('attributes speech to a known NPC and skips quoted labels or ambiguous voices', () => {
		const actors = [{ id: 'mara', name: 'Mara' }, { id: 'serra', name: 'Serra' }];
		const draft = 'Mara reads the label “Oath of Ash.” Mara says “I accept.” Serra replies “I refuse.”';
		const spans = npcDialogueSpans(draft, '', actors);
		expect(spans.map(span => [span.speakerId, span.text])).toEqual([['mara', 'I accept.'], ['serra', 'I refuse.']]);
		expect(npcDialogueSpans('A voice calls “Wait.”', '', actors)).toEqual([]);
	});
	it('recognizes a named NPC speaking after an action paragraph without voicing a read label', () => {
		const actors = [{ id: 'osho', name: 'Osho mo Xhall' }];
		const draft = 'Osho mo Xhall blinks, then lets out a breath that is almost a laugh.\n\n"Back to business. Yes."\n\nHe reaches for the ledger.';
		expect(npcDialogueSpans(draft, '', actors).map(span => [span.speakerId, span.text]))
			.toEqual([['osho', 'Back to business. Yes.']]);
		expect(npcDialogueSpans('Osho mo Xhall reads the label on the case.\n\n"Sea Green House."', '', actors)).toEqual([]);
	});
});
