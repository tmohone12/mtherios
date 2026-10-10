import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { factionProjects, npcEventLinks, stories, storyEvents } from '$lib/server/db/schema';
import { patchWorldRecord } from '$lib/server/engine/worldRecords';
import { fingerprint, record, worldDay } from './intentions';
import { personallyReceived, verificationReportSchema, verificationRequestSchema } from './verificationContract';
import { persistentProjectSchema } from './projectLifecycle';
import { reliefAdapter } from './reliefAdapter';

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];
export const verificationAuthoringSchema = z.object({
 recipientEntityId: z.string().min(1).max(160), subjectEventId: z.string().min(1).max(160),
 expectedDay: z.number().int().nonnegative(), deadlineDay: z.number().int().nonnegative(),
}).strict();

/** A human-authored request is intent, not a discovery or a report. Atomic with explicit project creation. */
export async function createVerificationRequest(tx: Tx, story: { id: string; currentWorldTime: string | null }, projectId: string, owners: string[], raw: unknown) {
 const input = verificationAuthoringSchema.parse(raw), now = worldDay(story.currentWorldTime);
 if (now === null || !owners.includes(input.recipientEntityId)) throw new Error('Verification requires a current authorized decision owner and canonical world time.');
 const [subject] = await tx.select().from(storyEvents).where(and(eq(storyEvents.storyId, story.id), eq(storyEvents.id, input.subjectEventId))).for('update').limit(1);
 const links = subject ? await tx.select().from(npcEventLinks).where(and(eq(npcEventLinks.storyId, story.id), eq(npcEventLinks.eventId, subject.id), inArray(npcEventLinks.npcEntityId, owners))).for('update') : [];
 if (!subject || subject.status !== 'committed' || ['scheme', 'rumor'].includes(subject.type) || owners.some(id => !personallyReceived(subject, links, id))) throw new Error('Select an existing committed subject personally known to both decision owners. A request shares no private evidence.');
 return verificationRequestSchema.parse({ version: 1, condition: { kind: 'verification_received', projectId,
  requestId: projectId + ':verify', recipientEntityId: input.recipientEntityId, subjectEventId: subject.id },
  subjectFingerprint: fingerprint(subject), requestedDay: now, expectedDay: input.expectedDay, deadlineDay: input.deadlineDay,
  status: 'pending', receipt: null, reason: 'verification_report_pending' });
}

/** Sourced human review uses the canonical event writer. It cannot create actor knowledge or change a relationship. */
export async function recordVerificationReport(storyId: string, raw: unknown) {
 const input = z.object({ projectId: z.string().min(1).max(80), eventId: z.string().min(1).max(160), expectedVersion: z.number().int().nonnegative(),
  expectedProjectVersion: z.number().int().nonnegative(), claimText: z.string().trim().min(1).max(360), evidence: z.string().trim().min(12).max(1200),
  result: z.enum(['verified', 'contradictory', 'revoked']), reviewedSourcedReceipt: z.literal(true),
 }).strict().parse(raw);
 return getDb().transaction(async tx => {
  const [story] = await tx.select().from(stories).where(eq(stories.id, storyId)).for('update').limit(1);
  const [project] = await tx.select().from(factionProjects).where(and(eq(factionProjects.storyId, storyId), eq(factionProjects.id, input.projectId))).for('update').limit(1);
  const adapter = reliefAdapter(project?.metadata), plan = persistentProjectSchema.safeParse(record(project?.metadata).persistentProject);
  if (!story || !project || !adapter.success || adapter.data.version !== 3 || !plan.success || !plan.data.verification) throw new Error('Select an explicitly authored verification project.');
  const request = plan.data.verification;
  const [event] = await tx.select().from(storyEvents).where(and(eq(storyEvents.storyId, storyId), eq(storyEvents.id, input.eventId))).for('update').limit(1);
  const links = event ? await tx.select().from(npcEventLinks).where(and(eq(npcEventLinks.storyId, storyId), eq(npcEventLinks.eventId, event.id), eq(npcEventLinks.npcEntityId, request.condition.recipientEntityId))).for('update') : [];
  if (!event || event.id===request.condition.subjectEventId || ['rumor', 'scheme'].includes(event.type) || !event.body.includes(input.evidence) || !input.evidence.includes(input.claimText)
   || !personallyReceived(event, links, request.condition.recipientEntityId, input.claimText)) throw new Error('Quote an actual committed report claim already personally received by the specified actor. Annotation cannot grant knowledge.');
  const at = worldDay(event.worldTime), now = worldDay(story.currentWorldTime);
  if (at === null || now === null || at < request.requestedDay || at > now) throw new Error('Use the source’s established receipt world time, within the existing request and current world time.');
  const value = verificationReportSchema.parse({ version: 1, condition: request.condition, subjectFingerprint: request.subjectFingerprint,
   claimText: input.claimText, evidence: input.evidence, receivedWorldTime: event.worldTime, result: input.result });
  const old = verificationReportSchema.safeParse(record(event.metadata).verificationReport);
  if (old.success && fingerprint(old.data.condition) !== fingerprint(request.condition)) throw new Error('This report is bound to another request; preserve its provenance.');
  if (old.success && fingerprint(old.data) === fingerprint(value)) return { status: 'recorded', eventId: event.id, projectId: project.id, repeated: true };
  if (project.serverVersion !== input.expectedProjectVersion) throw new Error('Verification project changed. Refresh before recording a report.');
  const result = await patchWorldRecord(storyId, 'events', event.id, { updates: { metadata: { verificationReport: value,
   verificationEvidenceReview: { reviewedBy: 'human', evidence: input.evidence } } }, expectedVersion: input.expectedVersion, jsonMode: 'merge',
   reason: 'Human review of a sourced, personally received verification claim; no delivery or relationship effect.' }, { role: 'human', id: 'local-human' }, tx);
  return { status: 'recorded', eventId: event.id, projectId: project.id, serverVersion: result.serverVersion };
 });
}
