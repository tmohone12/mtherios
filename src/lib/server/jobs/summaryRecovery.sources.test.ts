import {expect,it} from 'vitest';
import {planSummaryRecovery} from './summaryRecovery';

it('keeps supplementary narration at its actual chronological turn',async()=>{
 const entries=Array.from({length:20},(_,i)=>[
  {id:`p${i}`,type:'user_action',content:`Action ${i}`,position:i*2+1,parent_id:null,branch_id:null,metadata:{}},
  {id:`n${i}`,type:'narration',content:`Outcome ${i}`,position:i*2+2,parent_id:`p${i}`,branch_id:null,metadata:{}},
 ]).flat();
 entries.push({...entries[1],id:'correction',position:15.5,parent_id:null,content:'The captain withdraws the previously offered passage.'});
 const db={unsafe:async(sql:string)=>sql.includes('from story_entries')?entries:sql.includes('from stories')?[{id:'story',server_version:1}]:[]};
 const m=await planSummaryRecovery(db as Parameters<typeof planSummaryRecovery>[0],'story','chapter');
 expect(m.sources[0].text).not.toContain('withdraws');
 expect(m.sources[7].text).toContain('withdraws');
 expect(m.sources[7].text.indexOf('Action 7')).toBeLessThan(m.sources[7].text.indexOf('withdraws'));
 expect(m.sources[7].text.indexOf('withdraws')).toBeLessThan(m.sources[7].text.indexOf('Outcome 7'));
});

it('prepares recovery arcs from retained accounts including details omitted from prose',async()=>{
 const chapters=Array.from({length:10},(_,i)=>({id:`c${i}`,number:i+1,title:'Passage',scene_outcome:'Lossy synopsis.',
  source_entry_ids:Array.from({length:20},(_,j)=>`c${i}n${j}`),
  metadata:{startPosition:i*40+1,endPosition:(i+1)*40,turnCount:20,sourceAccounts:Array.from({length:20},(_,j)=>({sourceId:`c${i}n${j}`,summary:`Condition ${j}: seven coins only after boarding.`}))},
  irreversible_changes:['INVENTED_CORONATION'],
 }));
 const db={unsafe:async(sql:string)=>sql.includes('from chapters')?chapters:sql.includes('from stories')?[{id:'story',server_version:1}]:[]};
 const m=await planSummaryRecovery(db as Parameters<typeof planSummaryRecovery>[0],'story','arc');
 expect(m.sources).toHaveLength(10);
 for(const s of m.sources){expect(s.text).toContain('Condition 10: seven coins only after boarding.');expect(s.text).not.toMatch(/Lossy|INVENTED/);expect(s.evidence[s.id]).toBe(s.text);}
});

it('starts the next recovery arc after actual partial-arc coverage',async()=>{
 const chapters=Array.from({length:96},(_,i)=>({id:`c${i+1}`,number:i+1,title:'History',scene_outcome:'An attributed historical account.',source_entry_ids:[],metadata:{startPosition:i*40+1,endPosition:(i+1)*40}}));
 const arcs=Array.from({length:9},(_,i)=>({id:`a${i+1}`,number:i+1,chapter_ids:chapters.slice(i*10,i===8?86:(i+1)*10).map(c=>c.id)}));
 const db={unsafe:async(sql:string)=>sql.includes('from chapters')?chapters:sql.includes('from arcs')?arcs:sql.includes('from stories')?[{id:'story',server_version:1}]:[]};
 const m=await planSummaryRecovery(db as Parameters<typeof planSummaryRecovery>[0],'story','arc');
 expect(m.number).toBe(10);expect(m.sourceIds).toEqual(chapters.slice(86,96).map(c=>c.id));
});
