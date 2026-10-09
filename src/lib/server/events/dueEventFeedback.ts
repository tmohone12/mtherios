import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { stories, storyEntries, storyEvents } from '$lib/server/db/schema';
import { turnStateSourceFingerprint } from '$lib/server/jobs/outbox';
import { createHash } from 'node:crypto';

export const dueEventFeedbackSchema = z.object({
	id: z.string().min(1),
	outcome: z.enum(['realized', 'signal', 'deferred', 'uncertain']),
	evidenceSpan: z.string().max(500),
}).strict();

export type DueEventFeedback = z.infer<typeof dueEventFeedbackSchema>;

export const dueEventCandidateSchema = z.object({
	id: z.string().min(1), title: z.string(), body: z.string(),
	status: z.string(), serverVersion: z.number().int().nonnegative(),
	scheduledTurn: z.number().int().nullable().optional(),
}).strict();
export type DueEventCandidate = z.infer<typeof dueEventCandidateSchema>;

const FACTION_CUE_PREFIX = 'faction_cue_';
export function isFactionCueCandidate(id: string): boolean { return id.startsWith(FACTION_CUE_PREFIX); }

/** A presentation question in the existing extraction pass; it is never a world event. */
export function factionCueCandidate(cue: { sourceKey: string; title: string; logline: string }): DueEventCandidate {
	return { id: `${FACTION_CUE_PREFIX}${createHash('sha256').update(cue.sourceKey).digest('hex').slice(0, 20)}`,
		title: `Scene cue: ${cue.title}`, body: cue.logline, status: 'due', serverVersion: 0, scheduledTurn: null };
}

/** Keep selected, visibly surfaced, and canonically realized as separate facts. */
export async function applyFactionCueFeedback(input: {
	storyId: string; assistantEntryId: string; playerText: string; narration: string;
	sourceFingerprint: string; cue: { cardId: string; sourceKey: string; sceneKey: string; title: string; logline: string };
	feedback: DueEventFeedback[];
}): Promise<'surfaced' | 'not_surfaced' | 'uncertain'> {
	const candidate = factionCueCandidate(input.cue);
	const supported = supportedDueEventFeedback([candidate], input.feedback, input.narration)
		.find(row => row.id === candidate.id);
	const outcome = supported?.outcome === 'signal' ? 'surfaced'
		: supported?.outcome === 'deferred' ? 'not_surfaced' : 'uncertain';
	if (turnStateSourceFingerprint(input.playerText, input.narration) !== input.sourceFingerprint) return 'uncertain';
	return getDb().transaction(async tx => {
		const [story] = await tx.select({ metadata: stories.metadata }).from(stories)
			.where(eq(stories.id, input.storyId)).for('update').limit(1);
		const [entry] = await tx.select({ content: storyEntries.content, metadata: storyEntries.metadata })
			.from(storyEntries).where(and(eq(storyEntries.storyId, input.storyId), eq(storyEntries.id, input.assistantEntryId))).limit(1);
		const receipt = entry?.metadata?.factionCueReceipt;
		if (!story || !entry || entry.content !== input.narration || entry.metadata?.nonCanon === true
			|| entry.metadata?.narrativeMode === 'parallel_pov' || !receipt || typeof receipt !== 'object'
			|| Array.isArray(receipt)) return 'uncertain';
		const prior = receipt as Record<string, unknown>;
		if (prior.sourceKey !== input.cue.sourceKey || prior.cardId !== input.cue.cardId
			|| prior.sceneKey !== input.cue.sceneKey || prior.sourceFingerprint !== input.sourceFingerprint
			|| prior.status === 'omitted_from_request') return 'uncertain';
		if (['surfaced', 'not_surfaced', 'uncertain'].includes(String(prior.status))) return prior.status as typeof outcome;
		const now = new Date().toISOString();
		const nextReceipt = { ...prior, status: outcome, evidenceSpan: outcome === 'surfaced' ? supported?.evidenceSpan : null };
		await tx.update(storyEntries).set({ metadata: sql`${storyEntries.metadata} || ${JSON.stringify({ factionCueReceipt: nextReceipt })}::jsonb`,
			updatedAt: now }).where(and(eq(storyEntries.storyId, input.storyId), eq(storyEntries.id, input.assistantEntryId)));
		const metadata = story.metadata && typeof story.metadata === 'object' ? story.metadata as Record<string, unknown> : {};
		const presentation = metadata.factionPresentation && typeof metadata.factionPresentation === 'object' && !Array.isArray(metadata.factionPresentation)
			? metadata.factionPresentation as Record<string, unknown> : {};
		const latestAttempt = presentation.attemptEntryId === input.assistantEntryId
			&& presentation.attemptedSourceKey === input.cue.sourceKey;
		if (outcome === 'surfaced' || latestAttempt) {
			const previous = Array.isArray(presentation.sourceKeys) ? presentation.sourceKeys.filter((id): id is string => typeof id === 'string') : [];
			const sourceKeys = [...new Set([...previous, input.cue.sourceKey])].slice(-32);
			const update = { ...(outcome === 'surfaced' ? { sourceKeys } : {}), ...(latestAttempt ? { attemptStatus: outcome } : {}) };
			await tx.update(stories).set({ metadata: sql`jsonb_set(coalesce(${stories.metadata}, '{}'::jsonb), '{factionPresentation}',
				coalesce(${stories.metadata}->'factionPresentation', '{}'::jsonb) || ${JSON.stringify(update)}::jsonb)`,
				serverVersion: sql`${stories.serverVersion} + 1`, updatedAt: now }).where(eq(stories.id, input.storyId));
		}
		return outcome;
	});
}

export async function applyDueEventFeedback(input: {
	storyId: string;
	assistantEntryId: string;
	playerText: string;
	narration: string;
	sourceFingerprint: string;
	currentTurn: number;
	candidates: DueEventCandidate[];
	feedback: DueEventFeedback[];
}): Promise<string[]> {
	const supported = supportedDueEventFeedback(input.candidates, input.feedback, input.narration);
	if (!input.candidates.length || turnStateSourceFingerprint(input.playerText, input.narration) !== input.sourceFingerprint) return [];
	return getDb().transaction(async tx => {
		const [story] = await tx.select({ serverVersion: stories.serverVersion }).from(stories)
			.where(eq(stories.id, input.storyId)).for('update');
		if (!story) return [];
		const [source] = await tx.select({ content: storyEntries.content, metadata: storyEntries.metadata })
			.from(storyEntries).where(and(eq(storyEntries.storyId, input.storyId), eq(storyEntries.id, input.assistantEntryId)))
			.limit(1);
		if (!source || source.content !== input.narration || source.metadata?.nonCanon === true
			|| source.metadata?.narrativeMode === 'parallel_pov') return [];
		const priorReceipt = source.metadata?.dueEventFeedbackReceipt;
		if (priorReceipt && typeof priorReceipt === 'object' && !Array.isArray(priorReceipt)) {
			const prior = priorReceipt as Record<string, unknown>;
			if (prior.sourceFingerprint === input.sourceFingerprint && Array.isArray(prior.committedIds))
				return prior.committedIds.filter((id): id is string => typeof id === 'string');
		}
		const accepted: string[] = [];
		const now = new Date().toISOString();
		for (const item of supported.filter(row => row.outcome === 'realized')) {
			const [current] = await tx.select().from(storyEvents).where(and(
				eq(storyEvents.storyId, input.storyId), eq(storyEvents.id, item.id),
			)).for('update').limit(1);
			if (!current || current.serverVersion !== item.candidate.serverVersion
				|| current.status !== item.candidate.status
				|| current.title !== item.candidate.title || current.body !== item.candidate.body
				|| (current.status === 'scheduled' && (current.scheduledTurn == null || current.scheduledTurn > input.currentTurn))) continue;
			await tx.update(storyEvents).set({
				status: 'committed', occurredTurn: input.currentTurn,
				sourceEntryIds: [...new Set([...current.sourceEntryIds, input.assistantEntryId])],
				metadata: { ...current.metadata, realization: { sourceEntryId: input.assistantEntryId,
					sourceFingerprint: input.sourceFingerprint, evidenceSpan: item.evidenceSpan, outcome: item.outcome } },
				serverVersion: story.serverVersion + 1, updatedAt: now,
			}).where(and(eq(storyEvents.storyId, input.storyId), eq(storyEvents.id, item.id),
				inArray(storyEvents.status, ['scheduled', 'due'])));
			accepted.push(item.id);
		}
		if (accepted.length) await tx.update(stories).set({
			serverVersion: sql`${stories.serverVersion} + 1`, updatedAt: now,
		}).where(eq(stories.id, input.storyId));
		await tx.update(storyEntries).set({
			metadata: sql`${storyEntries.metadata} || ${JSON.stringify({ dueEventFeedbackReceipt: {
				candidateIds: input.candidates.map(row => row.id),
				outcomes: supported.map(({ candidate: _candidate, ...row }) => row),
				committedIds: accepted, sourceFingerprint: input.sourceFingerprint,
				rejectedCount: input.feedback.length - supported.length, recordedAt: now,
			} })}::jsonb`, updatedAt: now,
		}).where(and(eq(storyEntries.storyId, input.storyId), eq(storyEntries.id, input.assistantEntryId)));
		return accepted;
	});
}

function hasDirectNarrationEvidence(narration: string, span: string): boolean {
	if (span.length < 12) return false;
	for (let position = narration.indexOf(span); position >= 0; position = narration.indexOf(span, position + 1)) {
		const previousBoundary = Math.max(narration.lastIndexOf('.', position - 1), narration.lastIndexOf('!', position - 1),
			narration.lastIndexOf('?', position - 1), narration.lastIndexOf('\n', position - 1));
		const leadIn = narration.slice(previousBoundary + 1, position);
		const evidenceClause = `${leadIn}${span}`;
		// Explicit counterevidence makes a claimed realization ambiguous. The model's
		// semantic verdict is still advisory and cannot prove causation by itself.
		if (/\b(?:if|would|could|might|may|perhaps|suppose|rumou?r|alleged|claimed|imagined|remembered|previously|once|yesterday|formerly|earlier|not|never|no|didn'?t|doesn'?t|hadn'?t|reports?|says?|said|heard|told)\b/i.test(evidenceClause)) continue;
		if ((leadIn.match(/“/g)?.length ?? 0) > (leadIn.match(/”/g)?.length ?? 0)
			|| ((leadIn.match(/"/g)?.length ?? 0) % 2) === 1
			|| narration[position - 1] === '“' || narration[position - 1] === '"') continue;
		return true;
	}
	return false;
}

/** A model verdict is advisory until its exact final-narration span and candidate revision are checked. */
export function supportedDueEventFeedback(
	candidates: DueEventCandidate[],
	feedback: DueEventFeedback[],
	narration: string,
): Array<DueEventFeedback & { candidate: DueEventCandidate }> {
	const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
	const seen = new Set<string>();
	return feedback.flatMap(item => {
		const candidate = byId.get(item.id);
		if (!candidate || seen.has(item.id) || !['due', 'scheduled'].includes(candidate.status)) return [];
		seen.add(item.id);
		const span = item.evidenceSpan.trim();
		if (item.outcome === 'realized' && !hasDirectNarrationEvidence(narration, span)) return [];
		if (item.outcome === 'signal' && (span.length < 12 || !narration.includes(span))) return [];
		return [{ ...item, evidenceSpan: span, candidate }];
	});
}
