import { describe, expect, it } from 'vitest';
import { buildActionContent, decodeActionDraft, encodeActionDraft, turnActionTypeForInput } from './actionInput';

describe('action input helpers', () => {
	it('round-trips private draft mode and reads legacy text drafts', () => {
		expect(decodeActionDraft(encodeActionDraft({ text: 'keep this private', actionType: 'think' })))
			.toEqual({ text: 'keep this private', actionType: 'think' });
		expect(decodeActionDraft('legacy draft')).toEqual({ text: 'legacy draft', actionType: 'do' });
	});

	it('routes prefixed GM controls to OOC without matching in-world mentions', () => {
		expect(turnActionTypeForInput('GM: reset to the emperor\'s offer.', 'do')).toBe('ooc');
		expect(turnActionTypeForInput('> Game Master: keep Leng separate from Yi Ti.', 'say')).toBe('ooc');
		expect(turnActionTypeForInput('Narrator: correct the location.', 'story')).toBe('ooc');
		expect(turnActionTypeForInput('/pov Bu Gai | considers the offer.', 'pov')).toBe('pov');
		expect(turnActionTypeForInput('I tell the GM of the merchant guild that the levy is late.', 'do')).toBe('do');
	});

	it('does not duplicate punctuation or dialogue quotes', () => {
		expect(buildActionContent('attack him!', 'do', { thirdPerson: false, protagonistName: 'Aurion' }))
			.toBe('> I attack him!');
		expect(buildActionContent('"Who are you?"', 'say', { thirdPerson: false, protagonistName: 'Aurion' }))
			.toBe('> I ask, "Who are you?"');
	});

	it('renders third-person commands with usable grammar and pronouns', () => {
		expect(buildActionContent('open my bag', 'do', { thirdPerson: true, protagonistName: 'Aurion' }))
			.toBe('> Aurion opens their bag.');
		expect(buildActionContent('i', 'do', { thirdPerson: true, protagonistName: 'Aurion' }))
			.toBe('> Aurion checks their inventory.');
	});
});
