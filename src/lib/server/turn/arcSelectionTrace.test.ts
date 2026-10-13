import { it, expect } from 'vitest';
import { renderArcMemory, renderCanonTimeline } from './promptPacket';
import { countTokens } from '$lib/utils/tokens';

// Eight completed arcs of ten chapters with long opaque chapter IDs repeated in every
// character history, plus one chapter not yet covered by an arc.
function recoveryShapedFixture() {
	const chapterId = (number: number) => `chapter_${String(number).padStart(3, '0')}_${'7f3c9a1e5b2d4086'.repeat(3)}`;
	const chapters = Array.from({ length: 81 }, (_, index) => ({ id: chapterId(index + 1), number: index + 1,
		title: `Passage ${index + 1}`, sceneOutcome: `The court weighed the consequences of passage ${index + 1}.`,
		irreversibleChanges: [], npcKnowledgeChanges: [], promisesDebtsOaths: [], discoveredClues: [],
		relationshipChanges: [], factionChanges: [], openThreads: [] }));
	const arcs = Array.from({ length: 8 }, (_, index) => {
		const covered = chapters.slice(index * 10, index * 10 + 10).map(chapter => chapter.id);
		return { id: `arc_${index + 1}`, number: index + 1, title: `Season ${index + 1}`,
			summary: `Season ${index + 1} of the succession dispute. ${'Envoys argued, ledgers changed hands, and old oaths were tested. '.repeat(14)}`,
			chapterIds: covered, openThreadIds: [],
			metadata: { characterArcs: ['Mara', 'Ilan', 'The Warden', 'Sera', 'Old Tom', 'The Envoy'].map(name => ({ name,
				development: `${name} changed allegiance after the events of season ${index + 1}.`,
				sourceChapterIds: [...covered, ...covered] })) } };
	});
	return { arcs, chapters };
}

it('renders every arc whole, in order, with readable chapter references instead of opaque IDs',()=> {
	const { arcs, chapters } = recoveryShapedFixture();
	const selected:string[]=[];
	const rendered=renderCanonTimeline({arcs,chapters,sagas:[]} as any,(table:string,id:string,text:string)=>{if(table==='arcs')selected.push(id);return text;});
	expect(selected).toEqual(arcs.map(arc=>arc.id));
	// Rendering the raw IDs would have cost more than an arc's whole text.
	const rawIdTokens=countTokens(arcs[7].metadata.characterArcs.map(c=>c.sourceChapterIds.slice(0,10).join(',')).join('\n'));
	expect(rawIdTokens).toBeGreaterThan(2000);
	expect(rendered).toContain('- Arc 1: Season 1 (chapters 1-10)');
	expect(rendered).toContain('- Arc 8: Season 8 (chapters 71-80)');
	expect(rendered.indexOf('- Arc 8:')).toBeLessThan(rendered.indexOf('Chapter 81'));
	expect(rendered).toContain('[source chapters: 71,72,73');
	expect(rendered).not.toContain(arcs[7].chapterIds[0]);
	expect(rendered).not.toContain('omitted');
});
it('preserves ordered repeated references and separate actor knowledge; unresolved IDs remain discoverable',()=> {
	const metadata={characterArcs:[{name:'Alice',development:'Alice heard a rumor; it remains uncertain.',sourceChapterIds:['c2','c1','c1','missing']},
		{name:'Bob',development:'Bob privately learned a different report.',sourceChapterIds:['c1']}]};
	const arc={id:'a',number:1,title:'Attributed reports',summary:'The actors heard separate reports.',metadata,chapterIds:['c1','c2'],openThreadIds:[]} as any;
	const before=JSON.stringify(arc),text=renderArcMemory(arc,[{id:'c1',number:1},{id:'c2',number:2}]);
	expect(text).toContain('Alice heard a rumor; it remains uncertain. [source chapters: 2,1,1; 1 unresolved source references]');
	expect(text).toContain('Bob privately learned a different report. [source chapters: 1]');
	expect(JSON.stringify(arc)).toBe(before);
});
