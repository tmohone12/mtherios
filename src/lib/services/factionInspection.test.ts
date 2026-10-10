import { describe, expect, it, vi } from 'vitest';
import { createFactionInspectionLoader, emptyFactionInspection, factionReviewMessages,persistentProjectInspection } from './factionInspection';

function pending<T>() {
 let resolve!: (value: T) => void;
 let reject!: (reason: unknown) => void;
 const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
 return { promise, resolve, reject };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('faction inspection requests', () => {
 it('distinguishes an arrival window, confirmation and a cancellation request using the persistent ledger',()=>{
  const row=(id:string,phase:string,status='active')=>({id,project:'Provide relief',status,metadata:{persistentProject:{version:1,kind:'relief',phase,nextStep:'Await the sourced receipt.',committedMeans:{amount:40},dueWorldTime:'Day 4',outcomeSourceId:phase==='confirmation'?'observed_receipt':null}}});
  const view=persistentProjectInspection([row('due','arrival'),row('confirmed','confirmation'),row('cancel','dispatch','cancelled'),{id:'legacy',metadata:{}}]);
  expect(view).toHaveLength(3);expect(view[0]).toMatchObject({label:'Arrival window; unconfirmed',reserved:40,confirmationSourceId:null});
  expect(view[1]).toMatchObject({label:'Delivery confirmed',confirmationSourceId:'observed_receipt'});expect(view[2].label).toBe('Cancellation requested');
 });
 it('shows held manual review receipts even when the HTTP request succeeded and the old plan remains', async () => {
  let state = emptyFactionInspection();
  const receipt = { factions: { status: 'held', reason: 'interactive_turn_has_priority' }, gardener: { status: 'held', reason: 'extraction_has_priority' } };
  const request = vi.fn().mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response({ workflow: { attempts: [{ id: 'prior-intent' }] } }));
  const loader = createFactionInspectionLoader({ currentStoryId: () => 'a', update: next => { state = next; }, request });
  await loader.load('a', true);
  expect(state).toMatchObject({ busy: false, error: '', reviewReceipt: receipt, data: { workflow: { attempts: [{ id: 'prior-intent' }] } } });
  expect(factionReviewMessages(state.reviewReceipt)).toEqual([
   'Faction review: held. Waiting for the current story turn to finish.',
   'Forecast review: held. Waiting for canonical state extraction to finish.',
  ]);
 });

 it('clears private state on story switch and ignores a late previous-story response', async () => {
  let story = 'a', state = emptyFactionInspection();
  const old = pending<Response>();
  const request = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response({ workflow: { attempts: [{ id: 'b-private-intent' }] } }));
  const loader = createFactionInspectionLoader({ currentStoryId: () => story, update: next => { state = next; }, request });
  const first = loader.load('a');
  story = 'b'; loader.reset();
  expect(state).toEqual(emptyFactionInspection());
  await loader.load('b');
  old.resolve(response({ workflow: { attempts: [{ id: 'a-private-intent' }] } }));
  await first;
  expect(state.data?.workflow.attempts).toEqual([{ id: 'b-private-intent' }]);
 });

 it('does not follow up an old manual review or overwrite a current loading/error state', async () => {
  let story = 'a', state = emptyFactionInspection();
  const old = pending<Response>(), latest = pending<Response>();
  const request = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  const loader = createFactionInspectionLoader({ currentStoryId: () => story, update: next => { state = next; }, request });
  const first = loader.load('a', true);
  story = 'b'; loader.reset();
  const second = loader.load('b');
  old.resolve(response({ factions: { status: 'reviewed' } }));
  await first;
  expect(request).toHaveBeenCalledTimes(2);
  expect(state).toMatchObject({ busy: true, reviewReceipt: null, error: '' });
  latest.reject(new Error('Disconnected'));
  await second;
  expect(state).toMatchObject({ busy: false, error: 'Disconnected', data: null });
 });

 it('retains a successful review receipt when its follow-up inspection fails', async () => {
  let state = emptyFactionInspection();
  const receipt = { factions: { status: 'held', reason: 'stale_snapshot' }, gardener: { status: 'skipped', reason: 'unchanged_context' } };
  const request = vi.fn().mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response({}, 503));
  const loader = createFactionInspectionLoader({ currentStoryId: () => 'a', update: next => { state = next; }, request });
  await loader.load('a', true);
  expect(state).toMatchObject({ reviewReceipt: receipt, busy: false, error: 'Unable to inspect faction workflow.' });
  expect(factionReviewMessages(state.reviewReceipt)).toContain('Faction review: held. Story context changed during this review; its proposed changes were not saved.');
 });
});
