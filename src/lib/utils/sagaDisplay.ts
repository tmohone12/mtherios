import type { Arc, Chapter, Saga } from '$lib/types';

export interface SagaBlock { heading: string | null; lines: string[] }

/**
 * A saga's stored text as readable blocks: paragraphs are separated by blank lines, and a short
 * first line followed by more lines is that block's heading ("The Journey East", "Continuity:").
 */
export function sagaBlocks(summary: string): SagaBlock[] {
	return summary.split(/\n{2,}/).map(block => block.trim()).filter(Boolean).map(block => {
		const [first, ...rest] = block.split('\n');
		return rest.length && first.length <= 140 && !first.startsWith('- ')
			? { heading: first, lines: rest }
			: { heading: null, lines: block.split('\n') };
	});
}

const CONSEQUENCE_PREFIX = 'Saga consequence:';

/** The saga's closing consequence, its one-paragraph account of what it changed, and the other blocks. */
export function splitSagaConsequence(blocks: SagaBlock[]): { consequence: string | null; rest: SagaBlock[] } {
	const index = blocks.findIndex(block => !block.heading && block.lines[0]?.startsWith(CONSEQUENCE_PREFIX));
	if (index < 0) return { consequence: null, rest: blocks };
	return { consequence: blocks[index].lines.join(' ').slice(CONSEQUENCE_PREFIX.length).trim(), rest: blocks.filter((_, other) => other !== index) };
}

/** "Arcs 1–2 · Chapters 1–20" from the arcs and chapters a saga covers, as far as they are loaded. */
export function sagaSpan(saga: Pick<Saga, 'arcIds' | 'arcRange'>, arcs: Array<Pick<Arc, 'id' | 'arcNumber' | 'chapterIds'>>, chapters: Array<Pick<Chapter, 'id' | 'number'>>): string {
	const sagaArcs = arcs.filter(arc => saga.arcIds.includes(arc.id)).sort((a, b) => a.arcNumber - b.arcNumber);
	const covered = new Set(sagaArcs.flatMap(arc => arc.chapterIds));
	const numbers = chapters.filter(chapter => covered.has(chapter.id)).map(chapter => chapter.number);
	const arcSpan = sagaArcs.length > 1 ? `Arcs ${sagaArcs[0].arcNumber}–${sagaArcs[sagaArcs.length - 1].arcNumber}`
		: sagaArcs.length ? `Arc ${sagaArcs[0].arcNumber}` : saga.arcRange;
	const chapterSpan = numbers.length ? `Chapters ${Math.min(...numbers)}–${Math.max(...numbers)}` : '';
	return [arcSpan, chapterSpan].filter(Boolean).join(' · ');
}
