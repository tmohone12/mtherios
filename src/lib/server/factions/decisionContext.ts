/** Stage-one decision context only: no execution, settlement, or invented authority. */
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const text = (v: unknown, max = 240) => typeof v === 'string' ? v.trim().slice(0, max) : '';
export function factionActorGoals(faction: Record<string, unknown>, rows: Record<string, unknown>[]) {
 const own = rows.filter(r => r.factionId === faction.id);
 const goals = own.length ? own.filter(r => r.status === undefined || ['active','in_progress'].includes(String(r.status)))
  : strings(faction.goals).filter(g => g.trim()).map(goal => ({id:faction.id,goal}));
 return goals.map(r => { const m = record(record(r).metadata); return {
  id:String(r.id), goal:text(r.goal,500), priority:typeof record(r).priority === 'number' && Number.isFinite(record(r).priority) ? Number(record(r).priority) : 5,
  urgency:text(m.urgency) || null, constraints:strings(m.constraints).slice(0,3).map(s=>text(s)), deadlineWorldTime:text(m.deadlineWorldTime) || null,
 }; }).sort((a,b)=>b.priority-a.priority || a.id.localeCompare(b.id));
}
export type DecisionAuthority = {status:'ready'|'held';reason:string|null;ownerEntityId:string|null;principalEntityId:string|null;sourceIds:string[];scope:'faction_intentions'};
export function resolveDecisionAuthority(faction:Record<string,unknown>, members:Record<string,unknown>[], actors:Record<string,unknown>[] = [], events:Record<string,unknown>[] = []):DecisionAuthority {
 const active = (id:unknown) => actors.some(a=>a.id===id && a.type==='character' && (!a.status || a.status==='active') && record(a.state).isProtagonist!==true && record(a.state).relationship!=='self' && record(record(a.state).relationship).status!=='player_character');
 const own = members.filter(m=>m.factionId===faction.id && m.status==='active');
 const leaders = [...new Set(own.filter(m=>m.role==='leader' && active(m.entityId)).map(m=>String(m.entityId)))];
 const principal = active(faction.entityId) ? String(faction.entityId) : leaders.length===1 ? leaders[0] : null;
 const held = (reason:string):DecisionAuthority => ({status:'held',reason,ownerEntityId:null,principalEntityId:principal,sourceIds:[],scope:'faction_intentions'});
 const explicit = record(faction.metadata).decisionOwnerEntityId;
 const declarations = own.filter(m=>record(record(m.metadata).decisionAuthority).scope==='faction_intentions');
 const delegates = declarations.filter(m=>{
  const d=record(record(m.metadata).decisionAuthority), source=events.find(e=>e.id===d.sourceEventId && e.status==='committed');
  const mandate=record(record(source?.metadata).factionDecisionAuthority);
  return principal && active(m.entityId) && d.grantorEntityId===principal && mandate.status==='active' && mandate.scope==='faction_intentions'
   && mandate.factionId===faction.id && mandate.grantorEntityId===principal && mandate.delegateEntityId===m.entityId;
 });
 if(declarations.length!==delegates.length)return held('decision_authority_invalid_delegation');
 let owner:string|null=null;
 if(typeof explicit==='string') {
  if(active(explicit) && (explicit===principal || leaders.includes(explicit) || delegates.some(m=>m.entityId===explicit)))owner=explicit;
  else return held('decision_authority_invalid_owner');
 } else if(delegates.length===1)owner=String(delegates[0].entityId);
 else if(delegates.length>1 || !principal && leaders.length>1)return held('decision_authority_ambiguous');
 else owner=principal;
 if(!owner)return held('decision_authority_missing');
 const membership=own.find(m=>m.entityId===owner), delegation=delegates.find(m=>m.entityId===owner);
 return {status:'ready',reason:null,ownerEntityId:owner,principalEntityId:principal??owner,scope:'faction_intentions',
  sourceIds:[...new Set([String(faction.id),...(membership?.id?[String(membership.id)]:[]),...(delegation?[String(record(record(delegation.metadata).decisionAuthority).sourceEventId)]:[])])].sort()};
}
export function factionKnowledgeActors(faction:Record<string,unknown>,members:Record<string,unknown>[],actors:Record<string,unknown>[],authority:DecisionAuthority) {
 const institutional=actors.find(a=>a.id===faction.entityId && a.type!=='character');
 // A delegate does not acquire the principal's private mind. Explicitly shared members retain the established sharing contract.
 return [...new Set([String(faction.id),...(institutional?[String(institutional.id)]:[]),...(authority.ownerEntityId?[authority.ownerEntityId]:[]),
  ...members.filter(m=>m.factionId===faction.id&&m.status==='active'&&record(m.metadata).sharesKnowledgeWithFaction===true&&typeof m.entityId==='string'&&m.entityId.length>0).map(m=>String(m.entityId))])].sort();
}
export function objectiveWords(goals:Record<string,unknown>[],projects:unknown) {
 const corpus=goals.map(g=>`${g.goal} ${strings(g.constraints).join(' ')}`).join(' ')+' '+JSON.stringify(projects??'');
 return [...new Set(corpus.toLowerCase().match(/[a-z]{4,}/g)??[])].slice(0,24);
}
export function selectFactionReviews<T extends {faction:{id:string;pressure:number}}>(candidates:T[],reviews:Record<string,unknown>,limit:number):T[] {
 const turn=(id:string)=>{const t=record(reviews[id]).lastTurn;return typeof t==='number'?t:-1;};
 return [...candidates].sort((a,b)=>turn(a.faction.id)-turn(b.faction.id) || b.faction.pressure-a.faction.pressure || a.faction.id.localeCompare(b.faction.id)).slice(0,limit);
}
export function decisionClock(goals:ReturnType<typeof factionActorGoals>,projects:Record<string,unknown>[],worldTime:string|null) {
 const day=(v:unknown)=>typeof v==='string'? /^day\s+(\d+)$/i.exec(v.trim()) ? Number(/^day\s+(\d+)$/i.exec(v.trim())![1]) : /^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v))?Math.floor(Date.parse(v)/86400000):null:null;
 const current=day(worldTime);
 // Only crossing a canonical objective/project threshold changes the clock evidence; ordinary timestamps do not.
 return [...goals.map(g=>({id:g.id,time:g.deadlineWorldTime})),...projects.map(p=>({id:String(p.id),time:p.worldTime}))]
  .flatMap(p=>{const due=day(p.time);return due===null?[]:[{id:p.id,time:p.time,reached:current!==null&&current>=due}];}).sort((a,b)=>a.id.localeCompare(b.id));
}
