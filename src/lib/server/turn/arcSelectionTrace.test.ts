import { it, expect } from 'vitest';
import { renderArcMemory, renderCampaignMemory } from './promptPacket';
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

it('removes repeated opaque IDs without changing the budget or ranking',()=> {
	const { arcs, chapters } = recoveryShapedFixture();
	let remaining=2000;
	const trace=[...arcs].reverse().map(a=> {
		const rendered=renderArcMemory(a as never,chapters),tokens=countTokens(rendered)+2;
		const sourceIdChars=(a.metadata.characterArcs??[]).slice(0,6).reduce((n:number,c:any)=>n+(c.sourceChapterIds??[]).slice(0,10).join(',').length,0);
		const result={number:a.number,id:a.id,tokens,remainingBefore:remaining,sourceIdChars,selected:tokens<=remaining,
			reason:tokens<=remaining?'fits current arc allowance':'rendered arc exceeds remaining arc allowance'};
		if(result.selected)remaining-=tokens;return result;
	});
	const selected:string[]=[]; const rendered=renderCampaignMemory({arcs,chapters} as any,(table,id,text)=>{if(table==='arcs')selected.push(id);return text;});
	expect(selected).toEqual(trace.filter(a=>a.selected).map(a=>a.id).reverse());
	// Rendering the raw IDs would make even the newest arc exceed the whole allowance.
	const rawIdTokens=countTokens(arcs[7].metadata.characterArcs.map(c=>c.sourceChapterIds.slice(0,10).join(',')).join('\n'));
	expect(rawIdTokens).toBeGreaterThan(2000);
	expect(trace.filter(a=>a.selected).length).toBeGreaterThanOrEqual(2);
	expect(rendered).toContain('Chapter 81'); expect(rendered).toContain('Arc 8:'); expect(rendered).not.toContain('Arc 1:');
	expect(rendered).toContain('[source chapters: 71,72,73');
	expect(rendered).not.toContain(arcs[7].chapterIds[0]);
	expect(rendered).toMatch(/Historical summaries omitted for the context budget: .*arcs \(1,/);
});
it('preserves ordered repeated references and separate actor knowledge; unresolved IDs remain discoverable',()=> {
	const metadata={characterArcs:[{name:'Alice',development:'Alice heard a rumor; it remains uncertain.',sourceChapterIds:['c2','c1','c1','missing']},
		{name:'Bob',development:'Bob privately learned a different report.',sourceChapterIds:['c1']}]};
	const arc={id:'a',number:1,title:'Attributed reports',summary:'The actors heard separate reports.',metadata,chapterIds:['c1','c2'],openThreadIds:[]} as any;
	const before=JSON.stringify(arc),text=renderArcMemory(arc,[{id:'c1',number:1},{id:'c2',number:2}]);
	expect(text).toContain('Alice heard a rumor; it remains uncertain. [source chapters: 2,1,1; 1 unresolved references available in the full arc]');
	expect(text).toContain('Bob privately learned a different report. [source chapters: 1]');
	expect(JSON.stringify(arc)).toBe(before);
});
