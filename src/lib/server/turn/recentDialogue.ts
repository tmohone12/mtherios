import { countTokens } from '$lib/utils/tokens';
import { toWellFormedText } from './wellFormedText';

import { DEFAULT_RECENT_DIALOGUE_TOKENS, normalizeRecentDialogueTokens, normalizeRecentDialogueTurns } from '$lib/services/memorySettings';

export type DialogueMessage = { role: 'user' | 'assistant'; content: string; sourceId: string; partial?: boolean };

/** Keep the opening and latest consequence when one exchange alone exceeds the allowance. */
function fitMessage(message: DialogueMessage, budget: number): DialogueMessage {
	if (countTokens(message.content) <= budget) return message;
	const points = Array.from(message.content);
	const marker = message.role === 'assistant' ? '\n\n[... earlier narration omitted ...]\n\n' : '\n\n[... earlier input omitted ...]\n\n';
	let low = 0;
	let high = points.length;
	let content = '';
	while (low <= high) {
		const keep = Math.floor((low + high) / 2);
		const head = Math.floor(keep / 3);
		const tail = keep - head;
		const candidate = points.slice(0, head).join('') + marker + (tail ? points.slice(-tail).join('') : '');
		if (countTokens(candidate) <= budget) { content = candidate; low = keep + 1; }
		else high = keep - 1;
	}
	return { ...message, content, partial: true };
}

export function selectRecentDialogue(input: DialogueMessage[], requestedBudget = DEFAULT_RECENT_DIALOGUE_TOKENS, requestedTurns?: number): DialogueMessage[] {
	const budget = normalizeRecentDialogueTokens(requestedBudget);
	const groups: DialogueMessage[][] = [];
	for (const item of input) {
		const message = { ...item, content: toWellFormedText(item.content).trim() };
		if (!message.content) continue;
		if (message.role === 'user' || !groups.length) groups.push([]);
		groups.at(-1)!.push(message);
	}
	const eligible = requestedTurns === undefined ? groups : groups.slice(-normalizeRecentDialogueTurns(requestedTurns));
	const selected: DialogueMessage[][] = [];
	let used = 0;
	for (let i = eligible.length - 1; i >= 0; i--) {
		const group = eligible[i];
		const tokens = group.map(message => countTokens(message.content));
		const total = tokens.reduce((sum, count) => sum + count, 0);
		if (used + total > budget) {
			if (!selected.length) {
				// Protect short input and private-thought labels before sharing the rest.
				const minimum = Math.min(64, Math.floor(budget / group.length));
				const allowances = tokens.map(count => Math.min(count, minimum));
				const remaining = budget - allowances.reduce((sum, count) => sum + count, 0);
				const deficit = total - (budget - remaining);
				selected.unshift(group.map((message, index) => fitMessage(message,
					allowances[index] + Math.floor(remaining * (tokens[index] - allowances[index]) / deficit))));
			}
			break;
		}
		// An old opening narration is useful only if the whole available history fits.
		selected.unshift(group);
		used += total;
	}
	return selected.flat();
}
