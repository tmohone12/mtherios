import { it, expect } from 'vitest';
import fs from 'node:fs';
import { renderArcMemory, renderCampaignMemory } from './promptPacket';
import { countTokens } from '$lib/utils/tokens';
it('removes repeated opaque IDs without changing the budget or ranking',()=> {
	const f=JSON.parse(fs.readFileSync('../recovery-source-fixture.json','utf8'));
	const arcs=f.arcs.map((a:any)=>({...a,chapterIds:a.chapter_ids,openThreadIds:a.open_thread_ids}));
	const chapters=f.chapters.map((c:any)=>({...c,sceneOutcome:c.scene_outcome,irreversibleChanges:c.irreversible_changes,
		npcKnowledgeChanges:c.npc_knowledge_changes,promisesDebtsOaths:c.promises_debts_oaths,discoveredClues:c.discovered_clues,
		relationshipChanges:c.relationship_changes,factionChanges:c.faction_changes,openThreads:c.open_threads}));
	let remaining=2000;
	const trace=[...arcs].reverse().map(a=> {
		const rendered=renderArcMemory(a,chapters),tokens=countTokens(rendered)+2;
		const sourceIdChars=(a.metadata.characterArcs??[]).slice(0,6).reduce((n:number,c:any)=>n+(c.sourceChapterIds??[]).slice(0,10).join(',').length,0);
		const result={number:a.number,id:a.id,tokens,remainingBefore:remaining,sourceIdChars,selected:tokens<=remaining,
			reason:tokens<=remaining?'fits current arc allowance':'rendered arc exceeds remaining arc allowance'};
		if(result.selected)remaining-=tokens;return result;
	});
	const selected:string[]=[]; const rendered=renderCampaignMemory({arcs,chapters} as any,(table,id,text)=>{if(table==='arcs')selected.push(id);return text;});
	expect(selected).toEqual(trace.filter(a=>a.selected).map(a=>a.id).reverse());
	const before=JSON.parse(fs.readFileSync('../arc-selection-before.json','utf8'));
	expect(before.trace.filter((a:any)=>a.selected).map((a:any)=>a.number)).toEqual([3]);
	expect(before.trace.find((a:any)=>a.number===8).tokens).toBe(4207);
	expect(rendered).toContain('Chapter 81'); expect(rendered).toContain('Arc 8:'); expect(rendered).not.toContain('Arc 3:');
	expect(rendered).toContain('[source chapters:');
	expect(rendered).not.toContain(arcs[7].chapterIds[0]);
	fs.writeFileSync('../arc-selection-trace.json',JSON.stringify({observedAt:f.observedAt,budget:2000,trace,selected},null,2));
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
