import {describe,it,expect} from 'vitest';
import {sourceEvidenceCatalog,materializeReferenceSelection} from './summaryEvidenceReferences';
import {validateRecoveryDraft} from './summaryRecovery';
const sources=[{id:'n',text:'[p type=user_action]\nI’ll order the bay cleaned.\n[n type=narration]\nThe clerk opens the box; Tycho watches.',evidence:{p:'I’ll order the bay cleaned.',n:'The clerk opens the box; Tycho watches.'}}];
const selected={accounts:[{sourceId:'n',evidenceRefs:['r0.0','r1.0']}]};
describe('server-observed evidence references',()=>{
 it('keeps original apostrophes, attribution and future intentions without model transcription or paraphrase',()=>{
  const d=materializeReferenceSelection(selected,sources,88);expect(d.narrative).toContain('I’ll order the bay cleaned.');expect(d.narrative).toContain('The clerk opens the box; Tycho watches.');expect(d.narrative).not.toContain('Tycho opens');expect(d.narrative).not.toContain('The bay was cleaned');expect(validateRecoveryDraft(d,sources)).toEqual(d);expect(d.accounts[0].evidence.every(e=>e.status==='reported'&&!!e.speaker)).toBe(true);
 });
 it.each([
  {accounts:[{sourceId:'other',evidenceRefs:['r0.0','r1.0']}]},
  {accounts:[{sourceId:'n',evidenceRefs:['r0.0','invented']}]},
  {accounts:[{sourceId:'n',evidenceRefs:['r0.0','r0.0']}]},
  {accounts:[{sourceId:'n',evidenceRefs:['r1.0']}]},
  {accounts:[{sourceId:'n',evidenceRefs:['r0.0','r1.0'],summary:'The bay was cleaned.'}]},
  {...selected,narrative:'Tycho opened the box.'}
 ])('rejects unsupported references, incomplete records and free prose %j',raw=>expect(()=>materializeReferenceSelection(raw,sources,88)).toThrow());
 it('uses exact bounded source spans even for long Unicode records',()=>{const s={id:'n',text:'',evidence:{n:'😀 '+('Quoted text with curly punctuation’s original meaning. '.repeat(80))}};const catalog=sourceEvidenceCatalog(s);expect(catalog.length).toBeGreaterThan(1);for(const e of catalog){expect(e.quote.length).toBeLessThanOrEqual(400);expect(s.evidence.n.slice(e.start,e.end)).toBe(e.quote);}expect(catalog.map(e=>e.quote).join('')).toBe(s.evidence.n);});
 it('retains multiple developments and restores chronological order within each original record',()=>{
  const s={id:'n',text:'[p type=user_action]\nI ask the terms.\n[n type=narration]',evidence:{p:'I ask the terms.',n:'The envoy proposes passage. '+('context '.repeat(60))+'Payment is refused. '+('later '.repeat(60))+'The captain cancels the offer.'}};
  const catalog=sourceEvidenceCatalog(s),refs=catalog.map(e=>e.ref).reverse();
  const d=materializeReferenceSelection({accounts:[{sourceId:'n',evidenceRefs:refs}]},[s],88);
  expect(d.accounts[0].evidence.map(e=>e.quote)).toEqual(catalog.map(e=>e.quote));
  expect(d.narrative).toContain('Payment is refused.');expect(d.narrative).toContain('The captain cancels the offer.');
  expect(validateRecoveryDraft(d,[s])).toEqual(d);
 });
 it('keeps reference IDs and record attribution stable through JSONB object-key reordering and unmatched narration',()=>{const original=sources[0],reordered={...original,evidence:{n:original.evidence.n,p:original.evidence.p}};expect(sourceEvidenceCatalog(reordered)).toEqual(sourceEvidenceCatalog(original));expect(materializeReferenceSelection(selected,[reordered],88)).toEqual(materializeReferenceSelection(selected,sources,88));const extra={id:'new',text:'[old position=1 type=narration]\nReported rumor\n[new position=2 type=narration]\nAction',evidence:{old:'Reported rumor',new:'Action'}};expect(materializeReferenceSelection({accounts:[{sourceId:'new',evidenceRefs:['r0.0','r1.0']}]},[extra],88).accounts[0].evidence.every(e=>e.speaker==='Story narration record')).toBe(true);});
});
