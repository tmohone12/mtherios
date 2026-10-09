import { describe, expect, it } from 'vitest';
import { countTokens } from '$lib/utils/tokens';
import { selectRecentDialogue, type DialogueMessage } from './recentDialogue';

describe('recent dialogue allowance', () => {
	const exchange = (id: string, repeat = 1): DialogueMessage[] => [
		{ role: 'user', content: `I ask about ${id}. `, sourceId: `${id}-user` },
		{ role: 'assistant', content: `The witness answers about ${id}. `.repeat(repeat), sourceId: `${id}-reply` },
	];
	const tokens = (messages: DialogueMessage[]) => messages.reduce((sum, message) => sum + countTokens(message.content), 0);
	it('preserves full text, including the middle of long narration, when it fits', () => {
		const messages = exchange('source-1', 300);
		expect(selectRecentDialogue(messages, 12_000)).toEqual(messages.map(message => ({ ...message, content: message.content.trim() })));
	});
	it('grows the selected history with the setting and never splits an old exchange', () => {
		const messages = Array.from({ length: 30 }, (_, i) => exchange(`turn-${i}`, 40)).flat();
		const small = selectRecentDialogue(messages, 2_000);
		const large = selectRecentDialogue(messages, 8_000);
		expect(tokens(small)).toBeLessThanOrEqual(2_000);
		expect(tokens(large)).toBeLessThanOrEqual(8_000);
		expect(large.length).toBeGreaterThan(small.length);
		for (const selected of [small, large]) {
			expect(selected[0].role).toBe('user');
			expect(selected.at(-1)?.sourceId).toBe('turn-29-reply');
			expect(selected.length % 2).toBe(0);
		}
	});
	it('keeps the latest 20 complete player-and-GM turns when they fit the safety cap', () => {
		const messages = Array.from({ length: 25 }, (_, i) => exchange(`turn-${i}`, 10)).flat();
		const selected = selectRecentDialogue(messages, 24_000, 20);
		expect(selected).toHaveLength(40);
		expect(selected[0].sourceId).toBe('turn-5-user');
		expect(selected.at(-1)?.sourceId).toBe('turn-24-reply');
		expect(selected.every(message => !message.partial)).toBe(true);
	});
	it('resets the reusable opening only when the token allowance evicts an old exchange', () => {
		const first = selectRecentDialogue([...exchange('one', 30), ...exchange('two', 30)], 512, 20);
		const next = selectRecentDialogue([...exchange('one', 30), ...exchange('two', 30), ...exchange('three', 30)], 512, 20);
		expect(first[0].sourceId).toBe('one-user');
		expect(next[0].sourceId).toBe('two-user');
		expect(next.at(-1)?.sourceId).toBe('three-reply');
	});
	it('fits a multilingual oversized pair without broken surrogate pairs and marks it partial', () => {
		const messages = exchange('latest');
		messages[0].content = `Opening input ${'ꙮ😀'.repeat(3_000)} ending input`;
		messages[1].content = `Opening reply ${'ꙮ😀'.repeat(8_000)} ending reply`;
		const selected = selectRecentDialogue(messages, 1_500);
		expect(tokens(selected)).toBeLessThanOrEqual(1_500);
		expect(selected.map(message => message.partial)).toEqual([true, true]);
		for (const message of selected) {
			expect(message.content).toContain('Opening');
			expect(message.content).toContain('ending');
			expect(message.content.isWellFormed()).toBe(true);
		}
	});
});
