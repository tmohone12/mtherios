import { describe, expect, it } from 'vitest';
import { factionCueCandidate, isFactionCueCandidate, supportedDueEventFeedback } from './dueEventFeedback';

const candidate = { id: 'event_1', title: 'Bread prices rise', body: 'Bread prices rise at the harbor.', status: 'due', serverVersion: 7 };

describe('due event feedback', () => {
	it('requires an exact final-prose span for a surfaced faction cue without realizing a world event', () => {
		const cue = factionCueCandidate({ sourceKey: 'event:harbor_levy', title: 'Harbor levy', logline: 'The dock fee rose.' });
		expect(isFactionCueCandidate(cue.id)).toBe(true);
		const narration = "The ferryman crosses out yesterday's price and names the new harbor fee.";
		expect(supportedDueEventFeedback([cue], [{ id: cue.id, outcome: 'signal', evidenceSpan: "The ferryman crosses out yesterday's price" }], narration)).toHaveLength(1);
		expect(supportedDueEventFeedback([cue], [{ id: cue.id, outcome: 'signal', evidenceSpan: 'The fee rose.' }], narration)).toHaveLength(0);
		expect(supportedDueEventFeedback([cue], [{ id: cue.id, outcome: 'signal', evidenceSpan: '' }], narration)).toHaveLength(0);
	});
	it('accepts an exact account of a realized event and ignores a hypothetical mention', () => {
		const narration = 'The harbor merchant raises the bread price. The crowd objects.';
		expect(supportedDueEventFeedback([candidate], [{ id: candidate.id, outcome: 'realized', evidenceSpan: 'The harbor merchant raises the bread price.' }], narration)).toHaveLength(1);
		const paraphrase = 'At the harbor, each loaf now costs twice as much.';
		expect(supportedDueEventFeedback([candidate], [{ id: candidate.id, outcome: 'realized', evidenceSpan: paraphrase }], paraphrase)).toHaveLength(1);
		expect(supportedDueEventFeedback([candidate], [{ id: candidate.id, outcome: 'realized', evidenceSpan: 'If the harbor merchant raises the bread price, the crowd will object.' }], narration)).toHaveLength(0);
	});
	it('rejects unknown, repeated, and stale candidates', () => {
		const narration = 'The harbor merchant raises the bread price.';
		const feedback = [{ id: 'event_1', outcome: 'realized' as const, evidenceSpan: narration }];
		expect(supportedDueEventFeedback([{ ...candidate, status: 'committed' }], feedback, narration)).toHaveLength(0);
		expect(supportedDueEventFeedback([candidate], [...feedback, ...feedback, { ...feedback[0], id: 'other' }], narration)).toHaveLength(1);
	});
	it('leaves reports, history, negation, and conditional clauses unresolved', () => {
		const cases = [
			['If trade fails, the harbor merchant raises the bread price.', 'the harbor merchant raises the bread price.'],
			['A sailor reports: the harbor merchant raises the bread price.', 'the harbor merchant raises the bread price.'],
			['Yesterday, the harbor merchant raised the bread price.', 'the harbor merchant raised the bread price.'],
			['The harbor merchant does not raise the bread price.', 'raise the bread price.'],
			['Mara says “The harbor merchant raises the bread price.”', 'The harbor merchant raises the bread price.'],
			['The harbor merchant might raise the bread price tomorrow.', 'The harbor merchant might raise the bread price tomorrow.'],
		];
		for (const [narration, evidenceSpan] of cases) expect(supportedDueEventFeedback([candidate], [
			{ id: candidate.id, outcome: 'realized', evidenceSpan },
		], narration)).toHaveLength(0);
	});
	it('accepts a later direct occurrence when the same words appeared in an earlier report', () => {
		const span = 'The harbor merchant raises the bread price.';
		const narration = `Mara says “${span}” The crowd doubts her.\n${span} The crowd objects.`;
		expect(supportedDueEventFeedback([candidate], [{ id: candidate.id, outcome: 'realized', evidenceSpan: span }], narration)).toHaveLength(1);
	});
	it.each([
		['The steward refuses to deliver the promised grain.', 'deliver the promised grain.'],
		['The steward declines to send relief to the village.', 'send relief to the village.'],
		['The relief wagons failed to arrive at the granary.', 'arrive at the granary.'],
		['The relief carts reach the courtyard only if the captain approves.', 'The relief carts reach the courtyard'],
		['The relief carts reach the courtyard—a claim the envoy denies.', 'The relief carts reach the courtyard'],
		['The steward promises to deliver the promised grain.', 'deliver the promised grain.'],
		['The steward will deliver the promised grain.', 'deliver the promised grain.'],
		['The steward won\u2019t deliver the promised grain.', 'deliver the promised grain.'],
		['\u201cThe promised grain arrives at the granary.\u201d', 'The promised grain arrives at the granary.'],
		['\u201cListen closely. The promised grain arrives at the granary.\u201d', 'The promised grain arrives at the granary.'],
		['"Listen closely. The promised grain arrives at the granary."', 'The promised grain arrives at the granary.'],
		['\u2018The promised grain arrives at the granary.\u2019', 'The promised grain arrives at the granary.'],
	])('never realizes a refused, future or quoted delivery: %s', (narration, evidenceSpan) => {
		expect(supportedDueEventFeedback([candidate], [{ id: candidate.id, outcome: 'realized', evidenceSpan }], narration)).toEqual([]);
	});
	it('allows a direct cooperative delivery after a closed quotation', () => {
		const evidenceSpan = 'The promised grain arrives at the granary.';
		const narration = `\u201cA kind offer,\u201d the steward murmurs. ${evidenceSpan}`;
		expect(supportedDueEventFeedback([candidate], [{ id: candidate.id, outcome: 'realized', evidenceSpan }], narration)).toHaveLength(1);
	});
	it('accepts an exact prefix when the rest of the delivery sentence is direct', () => {
		const evidenceSpan = 'The relief carts reach the courtyard';
		expect(supportedDueEventFeedback([candidate], [{ id: candidate.id, outcome: 'realized', evidenceSpan }],
			`${evidenceSpan} at noon, their grain sacks stacked neatly.`)).toHaveLength(1);
	});
});
