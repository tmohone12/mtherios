import { z } from 'zod';
import { fingerprint, record, strings, worldDay } from './intentions';

const id = z.string().min(1).max(160);
const day = z.number().int().nonnegative();
import { verificationConditionSchema } from './negotiationPrototype';
export { verificationConditionSchema } from './negotiationPrototype';
export const verificationRequestSchema = z.object({
 version: z.literal(1), condition: verificationConditionSchema,
 subjectFingerprint: id, requestedDay: day, expectedDay: day, deadlineDay: day,
 status: z.enum(['pending', 'received', 'expired', 'contradictory']),
 receipt: z.object({ eventId: id, fingerprint: id }).strict().nullable(),
 reason: z.string().max(160).nullable(),
}).strict().refine(r => r.requestedDay <= r.expectedDay && r.expectedDay <= r.deadlineDay && r.deadlineDay - r.requestedDay <= 30, 'Use an ordered world-day window of at most thirty days.');
export type VerificationRequest = z.infer<typeof verificationRequestSchema>;
export const verificationReportSchema = z.object({
 version: z.literal(1), condition: verificationConditionSchema, subjectFingerprint: id,
 claimText: z.string().trim().min(1).max(360), evidence: z.string().trim().min(12).max(1200),
 receivedWorldTime: z.string().min(1).max(120), result: z.enum(['verified', 'contradictory', 'revoked']),
}).strict();

/** Exact personal receipt. Public visibility, faction membership and a timer grant no knowledge. */
export function personallyReceived(event: Record<string, unknown>, links: Record<string, unknown>[], actorId: string, claimText?: string) {
 if (event.status !== 'committed') return false;
 const claims = record(event.metadata).actorClaims;
 return Array.isArray(claims) && claims.some(raw => {
  const c = record(raw);
  return typeof c.text === 'string' && (!claimText || c.text === claimText)
   && ['learned', 'witnessed', 'shared'].includes(String(c.kind)) && strings(c.knownBy).includes(actorId);
 }) && links.some(l => l.eventId === event.id && l.npcEntityId === actorId && ['actor', 'witness', 'knower', 'witnessed', 'learned', 'shared'].includes(String(l.role)));
}

/** A report verifies that an actor received a claim; it never proves physical delivery or universal truth. */
export function evaluateVerification(request: VerificationRequest, subject: Record<string, unknown> | undefined,
 reports: Record<string, unknown>[], links: Record<string, unknown>[], worldTime: string | null): VerificationRequest {
 const result = structuredClone(request), now = worldDay(worldTime);
 const hold = (reason: string) => { result.status = 'contradictory'; result.reason = reason; return result; };
 // Reconsideration is explicit. An edited/late report cannot silently heal a rejected receipt.
 if (['expired', 'contradictory'].includes(request.status)) return result;
 if (!subject || ['scheme','rumor'].includes(String(subject.type)) || subject.status !== 'committed' || fingerprint(subject) !== request.subjectFingerprint) return hold('verification_subject_revised_or_revoked');
 if (now === null) { result.reason = 'verification_world_time_required'; return result; }
 if (reports.length > 8) return hold('verification_report_frontier_exceeded');
 const matching = reports.filter(e => {
  const parsed = verificationReportSchema.safeParse(record(e.metadata).verificationReport);
  return parsed.success && !['scheme','rumor'].includes(String(e.type)) && fingerprint(parsed.data.condition) === fingerprint(request.condition)
   && personallyReceived(e, links, request.condition.recipientEntityId, parsed.data.claimText);
 });
 if (request.receipt && !matching.some(e => e.id === request.receipt!.eventId && fingerprint(e) === request.receipt!.fingerprint)) return hold('verification_receipt_revised_or_revoked');
 let received: Record<string, unknown> | undefined;
 for (const event of matching) {
  const report = verificationReportSchema.parse(record(event.metadata).verificationReport), at = worldDay(report.receivedWorldTime);
  if (report.subjectFingerprint !== request.subjectFingerprint) return hold('verification_report_source_revision');
  if (report.result !== 'verified') return hold('verification_report_' + report.result);
  if (at === null || at < request.requestedDay || at > now || at > request.deadlineDay) return hold('verification_report_outside_world_window');
  if (!event.body || !String(event.body).includes(report.evidence) || !report.evidence.includes(report.claimText)) return hold('verification_report_evidence_changed');
  received ??= event;
 }
 if (received) { result.status = 'received'; result.receipt ??= { eventId: String(received.id), fingerprint: fingerprint(received) }; result.reason = null; return result; }
 if (now > request.deadlineDay) { result.status = 'expired'; result.reason = 'verification_deadline_expired'; return result; }
 result.status = 'pending'; result.reason = now >= request.expectedDay ? 'verification_report_overdue' : 'verification_report_pending';
 return result;
}
