export type FactionInspectionData = Record<string, any>;
export type FactionReviewReceipt = { factions?: unknown; gardener?: unknown };
export type FactionInspectionState = {
 data: FactionInspectionData | null;
 busy: boolean;
 error: string;
 reviewReceipt: FactionReviewReceipt | null;
};

export const emptyFactionInspection = (): FactionInspectionState => ({ data: null, busy: false, error: '', reviewReceipt: null });

/** Show the execution ledger separately from intention and forecast text. Time readiness is never reported as delivery. */
export function persistentProjectInspection(value:unknown){
 const rows=Array.isArray(value)?value:[];
 const labels:Record<string,string>={preparation:'Preparing',authorization:'Awaiting agreement',commitment:'Committed; awaiting dispatch',dispatch:'Dispatched; unconfirmed',arrival:'Arrival window; unconfirmed',confirmation:'Delivery confirmed',completed:'Completed',blocked:'Blocked',replan:'Needs reconsideration',failed:'Failed',cancelled:'Cancelled',adjudication:'Awaiting adjudication'};
 return rows.flatMap(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return [];
  const row=raw as Record<string,any>,plan=row.metadata?.persistentProject;
  if(plan?.version!==1||plan?.kind!=='relief'||!labels[plan.phase])return [];
  return [{id:String(row.id),serverVersion:row.serverVersion,reusable:[2,3].includes(row.metadata?.reliefAdapter?.version),negotiationPhase:row.metadata?.reliefAdapter?.state?.phase,objective:String(row.project),phase:plan.phase,
   label:row.status==='cancelled'&&plan.phase!=='cancelled'?'Cancellation requested':row.status==='completed'&&plan.phase!=='completed'?'Project status needs review':labels[plan.phase],
   nextStep:typeof plan.nextStep==='string'?plan.nextStep:'Await a canonical review.',dueWorldTime:typeof plan.dueWorldTime==='string'?plan.dueWorldTime:null,
   reserved:typeof plan.committedMeans?.amount==='number'?plan.committedMeans.amount:null,
   verification:plan.verification?{...plan.verification,subjectEventId:plan.verification.condition?.subjectEventId,recipientEntityId:plan.verification.condition?.recipientEntityId}:null,
   confirmationSourceId:typeof plan.outcomeSourceId==='string'?plan.outcomeSourceId:null}];
 });
}

/** Own asynchronous inspection reads so a late response cannot cross story boundaries. */
export function createFactionInspectionLoader(options: {
 currentStoryId: () => string | undefined;
 update: (state: FactionInspectionState) => void;
 request?: typeof fetch;
}) {
 const request = options.request ?? fetch;
 let generation = 0;
 let state = emptyFactionInspection();
 const publish = (patch: Partial<FactionInspectionState>) => { state = { ...state, ...patch }; options.update(state); };
 return {
  reset() { generation++; state = emptyFactionInspection(); options.update(state); },
  async load(storyId: string, review = false) {
   const ownGeneration = ++generation;
   const current = () => ownGeneration === generation && options.currentStoryId() === storyId;
   publish({ busy: true, error: '', ...(review ? { reviewReceipt: null } : {}) });
   try {
    const url = `/api/factions/${encodeURIComponent(storyId)}`;
    if (review) {
     const response = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'review' }) });
     const receipt = await response.json();
     if (!current()) return;
     if (!response.ok) throw new Error(receipt.error ?? 'Review failed.');
     // A held or skipped review is a successful HTTP request, with a meaningful receipt.
     publish({ reviewReceipt: receipt });
    }
    if (!current()) return;
    const response = await request(url);
    if (!response.ok) throw new Error('Unable to inspect faction workflow.');
    const data = await response.json();
    if (current()) publish({ data });
   } catch (error) {
    if (current()) publish({ error: error instanceof Error ? error.message : 'Inspection failed.' });
   } finally {
    if (current()) publish({ busy: false });
   }
  },
 };
}

const reasons: Record<string, string> = {
 background_lane_busy: 'Another background review is running.',
 interactive_turn_has_priority: 'Waiting for the current story turn to finish.',
 extraction_has_priority: 'Waiting for canonical state extraction to finish.',
 stale_snapshot: 'Story context changed during this review; its proposed changes were not saved.',
 unchanged_context: 'The reviewed context is unchanged.',
 unchanged_or_no_relevant_faction: 'No relevant faction has changed context.',
};

export function factionReviewMessages(receipt: FactionReviewReceipt | null): string[] {
 if (!receipt) return [];
 return (['factions', 'gardener'] as const).flatMap(key => {
  const result = receipt[key];
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const row = result as Record<string, unknown>;
  const label = key === 'factions' ? 'Faction review' : 'Forecast review';
  const status = typeof row.status === 'string' ? row.status : 'unknown';
  const reason = typeof row.reason === 'string' && row.reason ? reasons[row.reason] ?? row.reason : '';
  return [`${label}: ${status}.${reason ? ` ${reason}` : ''}`];
 });
}
