import { describe, expect, it } from 'vitest';
import { buildContextSelection, promptPayloadSections, promptRequestSummary, requestSourceSpansFromMappings, retainedBlockUsage, type RetainedRange } from './promptReceipt';
import { applyPromptContextBudget, buildTurnContextReceipt } from './orchestrator';
import { countTokens } from '$lib/utils/tokens';
import type { ServerTurnPromptPacket } from './promptPacket';
import { turnContextReceiptSchema } from '$lib/contracts/memory';

describe('final prompt receipts', () => {
	it('attributes repeated text by compiler coordinates through a head and tail budget', () => {
		const source = 'A repeated sentence. Unique middle. A repeated sentence.';
		const records = [
			{ kind: 'requiredActors', id: 'first', start: 0, end: 20 },
			{ kind: 'requiredActors', id: 'last', start: source.lastIndexOf('A repeated sentence.'), end: source.length },
		];
		const spans = requestSourceSpansFromMappings(records, [
			{ sourceStart: 0, sourceEnd: 20, targetStart: 0, targetEnd: 20 },
			{ sourceStart: records[1].start, sourceEnd: source.length, targetStart: 60, targetEnd: 80 },
		]);
		expect(spans).toEqual([
			{ kind: 'requiredActors', id: 'first', section: 'context', start: 0, end: 20 },
			{ kind: 'requiredActors', id: 'last', section: 'context', start: 60, end: 80 },
		]);
	});
	it('distinguishes clipped dialogue from fully sent source entries', () => {
		const packet = { dialogueSourceIds: ['user', 'reply'], dialoguePartialSourceIds: ['reply'], contextRecords: [] } as unknown as ServerTurnPromptPacket;
		const group = buildContextSelection({ packet, ranges: [], loaded: { recentEntries: 10 }, includeDialogue: true }).groups[0];
		expect(group).toMatchObject({ loaded: 10, selected: 2, sent: 1, partial: 1, omitted: 8,
			sentIds: ['user'], partialIds: ['reply'] });
	});
	it('counts cached history as sent alongside budgeted scene context', () => {
		const packet = {
			contextRecords: [], dynamicContextRecords: [{ kind: 'requiredScene', id: 'scene', start: 0, end: 5 }],
			stableContextRecords: [{ kind: 'chapters', id: 'chapter-1', start: 0, end: 12 }],
			dialogueSourceIds: [],
		} as unknown as ServerTurnPromptPacket;
		const selection = buildContextSelection({ packet, ranges: [{ start: 0, end: 5 }],
			loaded: { chapters: 1, requiredScene: 1 }, includeDialogue: false });
		expect(selection.groups.map(group => [group.kind, group.sent])).toEqual([['chapters', 1], ['requiredScene', 1]]);
		const receipt = promptRequestSummary('primary', 'Rules and chapter history', 'Scene', [], 'Act', [
			{ kind: 'chapters', id: 'chapter-1', section: 'system', start: 10, end: 22 },
		]);
		const stored = buildTurnContextReceipt({ turnId: 'turn', storyId: 'story',
			selection: { ...selection, requests: [receipt] }, budgets: {} });
		expect(turnContextReceiptSchema.parse(stored).selection?.requests?.[0].sourceSpans?.[0].section).toBe('system');
	});
	it('keeps the prefix truncation marker inside even a small final context budget', () => {
		for (const budget of [1, 10, 50]) {
			const clipped = applyPromptContextBudget('The witness remembers the promise. '.repeat(200), budget);
			expect(countTokens(clipped.value)).toBeLessThanOrEqual(budget);
		}
	});
	it('records primary and roll payloads separately without replacing primary selection', () => {
		const spans = [{ kind: 'contentPinned', id: 'content:one@2', section: 'context' as const, start: 0, end: 14 }];
		const primary = promptRequestSummary('primary', 'Rules', 'Scene memories', [{ content: 'Earlier narration' }], 'Player action and tool evidence', spans);
		const roll = promptRequestSummary('roll_continuation', 'Rules', 'Scene memories', [{ content: 'Earlier narration' }, { content: 'The courier reaches for the letter.' }], 'The roll succeeds. Continue immediately.', spans);
		expect(roll.sections.find(section => section.id === 'history')?.chars).toBe('Earlier narrationThe courier reaches for the letter.'.length);
		expect(roll.sections.find(section => section.id === 'action')?.chars).toBe('The roll succeeds. Continue immediately.'.length);
		expect(roll.sections[1]).toEqual(primary.sections[1]);
		const receipt = buildTurnContextReceipt({ turnId: 't', storyId: 's', selection: { version: 1, groups: [], sections: primary.sections, requests: [primary, roll] }, budgets: { dynamicContextTokensMax: 500, recentDialogueTokensMax: 24000, recentDialogueTurnsMax: 20 } });
		const stored = turnContextReceiptSchema.parse(JSON.parse(JSON.stringify(receipt)));
		expect(stored.selection?.sections).toEqual(primary.sections);
		expect(stored.selection?.requests).toEqual([primary, roll]);
		expect(stored.selection?.requests?.every(request => request.sourceSpans?.[0]?.id === 'content:one@2')).toBe(true);
		expect(stored.budgets.dynamicContextTokensMax).toBe(500);
		expect(stored.budgets.recentDialogueTokensMax).toBe(24000);
		expect(stored.budgets.recentDialogueTurnsMax).toBe(20);
	});
	it('shows NanoGPT dialogue before the current scene in primary and roll receipts', () => {
		const primary = promptRequestSummary('primary', 'Stable rules', 'Current scene', [{ content: 'Earlier dialogue' }], 'Player action', [], true);
		const roll = promptRequestSummary('roll_continuation', 'Stable rules', 'Current scene', [{ content: 'Earlier dialogue' }], 'Continue after roll', [], true);
		expect(primary.sections.map(section => section.id)).toEqual(['system', 'history', 'context', 'action']);
		expect(roll.sections.find(section => section.id === 'history')?.label).toBe('Recent dialogue and pre-roll narration');
		expect(roll.sections.find(section => section.id === 'action')?.label).toBe('Resolved roll and continuation instruction');
	});
	it('measures only the surviving parts of a compiler-produced memory or wiki block', () => {
		const prompt = 'Header\nMemory begins here and ends here.\nFooter';
		const block = 'Memory begins here and ends here.';
		expect(retainedBlockUsage(prompt, block, [{ start: 0, end: 20 }, { start: 35, end: prompt.length }]).chars).toBe(18);
		expect(retainedBlockUsage(prompt, block, [])).toEqual({ chars: 0, tokens: 0 });
		expect(retainedBlockUsage(prompt, 'Absent block', [{ start: 0, end: prompt.length }])).toEqual({ chars: 0, tokens: 0 });
	});
	it('distinguishes retained excerpts, partially clipped records, omitted records and unselected rows', () => {
		const content = 'Opening record. ' + 'The witness remembered a long conversation. '.repeat(70) + 'Final agreement.';
		const packet = { prompt: content, dialogueSourceIds: ['entry_a', 'entry_b'], contextRecords: [
			{ kind: 'memoryNodes', id: 'opening', start: 0, end: 15 },
			{ kind: 'memoryNodes', id: 'long', start: 16, end: content.length - 16 },
			{ kind: 'memoryNodes', id: 'ending', start: content.length - 16, end: content.length },
		] } as ServerTurnPromptPacket;
		let ranges: RetainedRange[] = [];
		const final = applyPromptContextBudget(content, 50, value => { ranges = value; });
		const receipt = buildContextSelection({ packet, ranges, loaded: { memoryNodes: 8, recentEntries: 200 }, includeDialogue: true });
		expect(final.truncated).toBe(true);
		expect(receipt.groups[0]).toMatchObject({ loaded: 8, selected: 3, sent: 1, partial: 1, omitted: 6,
			sentIds: ['opening'], partialIds: ['long'], omittedIds: ['ending'] });
		expect(receipt.groups[1]).toMatchObject({ loaded: 200, selected: 2, sent: 2, omitted: 198, sentIds: ['entry_a', 'entry_b'] });
		for (const range of ranges) expect(final.value).toContain(content.slice(range.start, range.end));
		expect(ranges[0].end).toBe(final.value.length - 3); // ellipsis is not retained source text
	});

	it('marks dynamic context and dialogue omitted in OOC mode and counts updated outgoing payloads', () => {
		const packet = { dialogueSourceIds: ['entry_a'], contextRecords: [{ kind: 'factionSheets', id: 'ally', start: 0, end: 20 }] } as ServerTurnPromptPacket;
		const selection = buildContextSelection({ packet, ranges: [], loaded: { factionSheets: 40, recentEntries: 10 }, includeDialogue: false });
		expect(selection.groups.every(group => group.sent === 0 && group.partial === 0)).toBe(true);
		const base = promptPayloadSections('Instructions', '', [], 'Please correct the time.');
		const withTools = promptPayloadSections('Instructions', '', [], 'Please correct the time. Evidence: the clock reads noon.');
		expect(withTools[3].chars).toBeGreaterThan(base[3].chars);
		expect(withTools[1].tokens).toBe(0);
	});

	it('accepts old saved receipts without inventing selection telemetry', () => {
		const old = turnContextReceiptSchema.parse({ turnId: 't', storyId: 's', included: {}, budgets: { memoryTokensUsed: 0, memoryTokensMax: 2400, wikiCharsUsed: 0, wikiCharsMax: 4000 } });
		expect(old.selection).toBeUndefined();
	});
});
