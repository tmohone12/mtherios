import { describe, expect, it } from 'vitest';
import { factionCueCandidate, isFactionCueCandidate, supportedDueEventFeedback } from './dueEventFeedback';

const candidate = { id: 'event_1', title: 'Bread prices rise', body: 'Bread prices rise at the harbor.', status: 'due', serverVersion: 7 };

describe('due event feedback', () => {
	it('requires an exact final-prose span for a surfaced faction cue without realizing a world event', () => {
		const cue = factionCueCandidate({ sourceKey: 'event:harbor_levy', title: 'Harbor levy', logline: 'The dock fee rose.' });
		expect(isFactionCueCandidate(cue.id)).toBe(true);
		const narration = 'The ferryman crosses out yesterday’s price and names the new harbor fee.';
		expect(supportedDueEventFeedback([cue], [{ id: cue.id, outcome: 'signal', evidenceSpan: 'The ferryman crosses out yesterday’s price' }], narration)).toHaveLength(1);
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
});
