import { expect, test } from 'vitest';
import { fingerprint } from './intentions';
import { evaluateVerification, personallyReceived, verificationRequestSchema } from './verificationContract';
import { createGrainNegotiationSandbox, negotiationSandboxSchema, runNegotiationStep, type NegotiationAdapters } from './negotiationPrototype';

const subject = { id: 'subject', status: 'committed', body: 'A sourced harvest observation.', metadata: {} };
const condition = { kind: 'verification_received' as const, projectId: 'shipment', requestId: 'shipment:verify', recipientEntityId: 'steward', subjectEventId: 'subject' };
const request = () => verificationRequestSchema.parse({ version: 1, condition, subjectFingerprint: fingerprint(subject), requestedDay: 0, expectedDay: 1, deadlineDay: 3, status: 'pending', receipt: null, reason: null });
const claim = 'The observer reports that the harvest estimate is supported.';
function report(overrides: Record<string, unknown> = {}, eventOverrides: Record<string, unknown> = {}) {
 return { id: 'report', status: 'committed', body: claim, metadata: { actorClaims: [{ text: claim, knownBy: ['steward'], kind: 'learned' }],
  verificationReport: { version: 1, condition, subjectFingerprint: fingerprint(subject), claimText: claim, evidence: claim, receivedWorldTime: 'Day 1', result: 'verified', ...overrides } }, ...eventOverrides };
}
const links = [{ eventId: 'report', npcEntityId: 'steward', role: 'knower' }];
test('expected time is overdue intent and deadline expires without learning or proof', () => {
 expect(evaluateVerification(request(), subject, [], [], 'Day 0')).toMatchObject({ status: 'pending', reason: 'verification_report_pending', receipt: null });
 expect(evaluateVerification(request(), subject, [], [], 'Day 1')).toMatchObject({ status: 'pending', reason: 'verification_report_overdue', receipt: null });
 expect(evaluateVerification(request(), subject, [], [], 'Day 3')).toMatchObject({ status: 'pending', receipt: null });
 expect(evaluateVerification(request(), subject, [], [], 'Day 4')).toMatchObject({ status: 'expired', receipt: null });
});
test.each(['contradictory', 'revoked'])('known %s reports require explicit reconsideration', result => {
 expect(evaluateVerification(request(), subject, [report({ result })], links, 'Day 2')).toMatchObject({ status: 'contradictory' });
});
test.each(['Day 4', 'Day 20', 'unknown', 'Day -1'])('invalid/future/late receipt time %s never becomes later knowledge', receivedWorldTime => {
 const held = evaluateVerification(request(), subject, [report({ receivedWorldTime })], links, 'Day 2');
 expect(held.status).toBe('contradictory');
 expect(evaluateVerification(held, subject, [report({ receivedWorldTime })], links, 'Day 40').status).toBe('contradictory');
});
test.each(['projectId', 'requestId', 'recipientEntityId', 'subjectEventId'])('unrelated %s cannot satisfy exact condition', field => {
 expect(evaluateVerification(request(), subject, [report({ condition: { ...condition, [field]: 'unrelated' } })], links, 'Day 2')).toMatchObject({ status: 'pending', receipt: null });
});
test('public report without explicit personal claim and link creates no receipt', () => {
 expect(evaluateVerification(request(), subject, [report({}, { visibility: 'public' })], [], 'Day 2').status).toBe('pending');
 const e = report(); e.metadata.actorClaims[0].knownBy = ['someone_else'];
 expect(evaluateVerification(request(), subject, [e], links, 'Day 2').status).toBe('pending');
 expect(personallyReceived(report(), links, 'someone_else')).toBe(false);
});
test('received claim has stable exact receipt; revisions, revocations and new contradictory evidence hold', () => {
 const e = report(), received = evaluateVerification(request(), subject, [e], links, 'Day 2');
 expect(received).toMatchObject({ status: 'received', receipt: { eventId: 'report', fingerprint: fingerprint(e) } });
 expect(evaluateVerification(received, subject, [e], links, 'Day 50')).toEqual(received);
 expect(evaluateVerification(received, subject, [report({}, { serverVersion: 3 })], links, 'Day 2').status).toBe('contradictory');
 expect(evaluateVerification(received, subject, [report({}, { status: 'cancelled' })], links, 'Day 2').status).toBe('contradictory');
 expect(evaluateVerification(received, subject, [e, report({ result: 'contradictory' }, { id: 'second' })], [...links, { eventId: 'second', npcEntityId: 'steward', role: 'knower' }], 'Day 2').status).toBe('contradictory');
});
test('source revision and report source mismatch cannot silently change accepted condition', () => {
 expect(evaluateVerification(request(), { ...subject, serverVersion: 2 }, [], [], 'Day 0').status).toBe('contradictory');
 expect(evaluateVerification(request(), subject, [report({ subjectFingerprint: 'revision_two' })], links, 'Day 2').status).toBe('contradictory');
});
test('more than eight received report candidates hold before inference', () => {
 const reports = Array.from({ length: 9 }, (_, i) => report({}, { id: 'report' + i }));
 expect(evaluateVerification(request(), subject, reports, reports.map(e => ({ eventId: e.id, npcEntityId: 'steward', role: 'knower' })), 'Day 2').reason).toBe('verification_report_frontier_exceeded');
});
test.each([{ expectedDay: 3, deadlineDay: 2 }, { expectedDay: 1, deadlineDay: 31 }, { requestedDay: 2, expectedDay: 1 }])('request window is explicitly bounded: %j', change => {
 expect(verificationRequestSchema.safeParse({ ...request(), ...change }).success).toBe(false);
});

const choose: NegotiationAdapters['decide'] = async input => ({ optionId: input.options.at(-1)!.id, confidence: .95, sourceIds: input.sourceIds, model: 'mock', memoryId: null, usage: null });
test('exact sourced condition survives offer/counteroffer/accept; dispatch requires separate receipt context', async () => {
 let state = negotiationSandboxSchema.parse({ ...createGrainNegotiationSandbox(), scope: 'persistent-relief-v3', verificationCondition: condition });
 const adapters: NegotiationAdapters = { plan: async ({ actorPacket: p }) => [{ kind: p.phase === 'idle' ? 'offer' : p.actor.role === 'recipient' ? 'counteroffer' : 'accept',
  ...(p.phase === 'idle' || p.actor.role === 'recipient' ? { terms: { grain: 40, tollDays: 10 } } : {}), condition: p.verificationCondition,
  sourceIds: [p.verificationCondition!.requestId, p.pendingOffer?.id ?? p.actor.id] }], decide: choose };
 for (const [index, actorId] of [state.supplier.id, state.recipient.id, state.supplier.id].entries()) {
  const result = await runNegotiationStep(state, { id: 'step' + index, actorId, day: 0, expectedRevision: state.revision, enabled: true,
   execution: { command: 'advance', confirmedOutcome: null, sourceIds: [] } }, adapters);
  expect(result.outcome).toBe(['offer', 'counteroffer', 'agreed'][index]); state = result.state;
 }
 expect(state.agreement?.condition).toEqual(condition); expect(state.supplier.reservedGrain).toBe(40);
 const step = { id: 'depart', actorId: state.supplier.id, day: 0, expectedRevision: state.revision, enabled: true, execution: { command: 'dispatch' as const, confirmedOutcome: null, sourceIds: [] } };
 expect((await runNegotiationStep(state, step, adapters)).receipt?.reason).toBe('verification_required_before_dispatch');
 const dispatched = await runNegotiationStep(state, { ...step, execution: { ...step.execution, verificationSatisfied: true } }, adapters);
 expect(dispatched.outcome).toBe('dispatched'); expect(dispatched.state.supplier.grain).toBe(100); expect(dispatched.state.recipient.grain).toBe(10);
});
test.each(['missing_condition', 'wrong_request', 'missing_request_evidence'])('unsupported conditional proposal %s is held before Jev', async mode => {
 const state = negotiationSandboxSchema.parse({ ...createGrainNegotiationSandbox(), scope: 'persistent-relief-v3', verificationCondition: condition });
 let decisions = 0;
 const adapters: NegotiationAdapters = { plan: async () => [{ kind: 'offer', terms: { grain: 40, tollDays: 10 },
  ...(mode === 'missing_condition' ? {} : { condition: mode === 'wrong_request' ? { ...condition, requestId: 'other' } : condition }), sourceIds: mode === 'missing_request_evidence' ? [state.supplier.id] : [condition.requestId] }], decide: async input => { decisions++; return choose(input); } };
 const result = await runNegotiationStep(state, { id: 'unsupported', actorId: state.supplier.id, day: 0, expectedRevision: 0, enabled: true, execution: { command: 'advance', confirmedOutcome: null, sourceIds: [] } }, adapters);
 expect(result.receipt?.reason).toBe('planner_rejected'); expect(decisions).toBe(0); expect(result.state.supplier.reservedGrain).toBe(0);
});


test('a conditional Jev selection without the exact request evidence is held despite high confidence',async()=>{
 const state=negotiationSandboxSchema.parse({...createGrainNegotiationSandbox(),scope:'persistent-relief-v3',verificationCondition:condition});
 const adapters:NegotiationAdapters={plan:async()=>[{kind:'offer',terms:{grain:40,tollDays:10},condition,sourceIds:[condition.requestId]}],decide:async input=>({...(await choose(input))!,sourceIds:[state.supplier.id]})};
 const result=await runNegotiationStep(state,{id:'ungrounded',actorId:state.supplier.id,day:0,expectedRevision:0,enabled:true,execution:{command:'advance',confirmedOutcome:null,sourceIds:[]}},adapters);
 expect(result.receipt?.reason).toBe('decision_rejected');expect(result.state.offer).toBeNull();
});


test('verification-gated travel starts at recorded departure rather than the old acceptance date',async()=>{
 const state=negotiationSandboxSchema.parse({...createGrainNegotiationSandbox(),scope:'persistent-relief-v3',verificationCondition:condition,phase:'agreed',agreement:{id:'agreement',terms:{grain:40,tollDays:10},condition,travelDays:2,acceptedDay:0,deliveryDay:2,tollUntilDay:null,supplierObligation:'pending',recipientObligation:'conditional'},supplier:{...createGrainNegotiationSandbox().supplier,reservedGrain:40}});
 const result=await runNegotiationStep(state,{id:'late_departure',actorId:state.supplier.id,day:4,expectedRevision:0,enabled:true,execution:{command:'dispatch',confirmedOutcome:null,sourceIds:[],verificationSatisfied:true}},{plan:async()=>{throw Error('No model work');},decide:async()=>{throw Error('No model work');}});
 expect(result.outcome).toBe('dispatched');expect(result.state.agreement?.deliveryDay).toBe(6);expect(result.state.supplier.grain).toBe(100);expect(result.state.events.at(-1)?.body).toContain('due on day 6');
});
