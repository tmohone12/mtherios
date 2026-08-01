import type { StrategicCanonPatch, StrategicEvidenceRef, StrategicWorldFrame } from '$lib/types';
import { and, eq, sql } from 'drizzle-orm';
import { patchProposals, storyEvents, storyThreads, npcEventLinks } from '$lib/server/db/schema';
import { getDb } from '$lib/server/db/client';
import {
	buildNpcEventLinksForEvent,
	buildScheduledTimelineEventInsert,
	type NpcEventLinkInsert,
	type StoryEventInsert,
} from '$lib/server/events/timeline';

export interface PlotBrainReconciliationInput {
	frame: StrategicWorldFrame;
	currentTurn?: number;
	now?: string;
	serverVersion?: number;
}

export interface PlotBrainReconciliationPlan {
	storyThreads: Array<typeof storyThreads.$inferInsert>;
	storyThreadUpdates: Array<{ storyId: string; threadId: string; updates: Partial<typeof storyThreads.$inferInsert> }>;
	storyEvents: StoryEventInsert[];
	npcEventLinks: NpcEventLinkInsert[];
	patchProposals: Array<typeof patchProposals.$inferInsert>;
	warnings: string[];
}

export interface PlotBrainApplyResult {
	storyThreads: number;
	storyThreadUpdates: number;
	storyEvents: number;
	npcEventLinks: number;
	patchProposals: number;
	warnings: string[];
}

type DbLike = ReturnType<typeof getDb>;
type TransactionLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];

function slug(value: string): string {
	const clean = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
	return clean || 'plot';
}

function unique(values: Array<string | null | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const clean = (value ?? '').trim();
		if (!clean || seen.has(clean)) continue;
		seen.add(clean);
		out.push(clean);
	}
	return out;
}

function sourceEntryIds(refs: StrategicEvidenceRef[] = []): string[] {
	return unique(refs.filter(ref => ref.sourceType === 'entry').map(ref => ref.sourceId));
}

function sourceEventIds(refs: StrategicEvidenceRef[] = []): string[] {
	return unique(refs.filter(ref => ref.sourceType === 'world_event').map(ref => ref.sourceId));
}

function significanceForPressure(pressure: number): 'minor' | 'moderate' | 'major' | 'critical' {
	if (pressure >= 85) return 'critical';
	if (pressure >= 60) return 'major';
	if (pressure >= 30) return 'moderate';
	return 'minor';
}

function threadStatusForUrgency(urgency: StrategicWorldFrame['plotCards'][number]['urgency']): 'open' | 'imminent' {
	return urgency === 'immediate' ? 'imminent' : 'open';
}

function threadIdForCard(storyId: string, cardIdOrTitle: string): string {
	return `plot_thread_${slug(storyId)}_${slug(cardIdOrTitle)}`;
}

function eventIdForBeat(storyId: string, frameId: string, cardIdOrTitle: string, index: number): string {
	return `plot_event_${slug(storyId)}_${slug(frameId)}_${slug(cardIdOrTitle)}_${index}`;
}

function cardKey(card: StrategicWorldFrame['plotCards'][number], index: number): string {
	return card.id.trim() || `${card.title.trim() || 'plot'}_${index + 1}`;
}

function eventFingerprint(
	threadId: string | null,
	beat: StrategicWorldFrame['plotCards'][number]['pressureBeats'][number],
): string {
	const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
	const delayTurns = Math.max(0, Math.floor(Number.isFinite(beat.delayTurns) ? beat.delayTurns : 0));
	return [threadId ?? '', delayTurns, normalize(beat.title), normalize(beat.body)].join('\u0000');
}

function patchIdForProposal(storyId: string, frameId: string, index: number): string {
	return `patch_plot_brain_${slug(storyId)}_${slug(frameId)}_${index}`;
}

function describePlotCard(card: StrategicWorldFrame['plotCards'][number]): string {
	return [
		`${card.title}: ${card.logline}`,
		card.goal ? `Goal: ${card.goal}` : '',
		card.motive ? `Motive: ${card.motive}` : '',
		card.method ? `Method: ${card.method}` : '',
		card.stakes ? `Stakes: ${card.stakes}` : '',
		card.playerTouchpoints.length ? `Player touchpoints: ${card.playerTouchpoints.join('; ')}` : '',
		card.ignoredOutcome ? `If ignored: ${card.ignoredOutcome}` : '',
		card.antiRailroadNotes.length ? `Agency guard: ${card.antiRailroadNotes.join('; ')}` : '',
	].filter(Boolean).join('\n');
}

function activatedCardIds(frame: StrategicWorldFrame): Set<string> {
	return new Set(unique(frame.activationPlan.activateNow).flatMap(value => [value, slug(value)]));
}

function isActivated(
	activated: Set<string>,
	card: StrategicWorldFrame['plotCards'][number],
	key: string,
): boolean {
	return unique([card.id, card.title, key]).some(value => activated.has(value) || activated.has(slug(value)));
}

function proposalSuggestion(proposal: StrategicCanonPatch): string {
	if ('reason' in proposal && proposal.reason) return proposal.reason;
	return `Review strategic plot brain proposal of type ${proposal.type}.`;
}

export function buildPlotBrainReconciliationPlan(input: PlotBrainReconciliationInput): PlotBrainReconciliationPlan {
	const now = input.now ?? new Date().toISOString();
	const currentTurn = Math.max(0, Math.floor(input.currentTurn ?? 0));
	const serverVersion = input.serverVersion ?? 1;
	const frame = input.frame;
	const warnings: string[] = [];
	const threadIdByPlotCardId = new Map<string, string>();
	const activated = activatedCardIds(frame);
	const activeCards = frame.plotCards
		.map((card, index) => ({ card, key: cardKey(card, index) }))
		.filter(({ card, key }) => isActivated(activated, card, key))
		.map(({ card, key }) => ({ card, key, threadId: threadIdForCard(frame.storyId, key) }));

	const storyThreadRows: Array<typeof storyThreads.$inferInsert> = [];
	for (const { card, key, threadId: id } of activeCards) {
		for (const alias of unique([card.id, card.title, key]).flatMap(value => [value, slug(value)])) {
			if (!threadIdByPlotCardId.has(alias)) threadIdByPlotCardId.set(alias, id);
		}
		storyThreadRows.push({
			id,
			storyId: frame.storyId,
			description: describePlotCard(card),
			status: threadStatusForUrgency(card.urgency),
			significance: significanceForPressure(card.pressure),
			relatedFactionIds: unique([...card.actorFactionIds, ...card.targetFactionIds]),
			relatedEntityIds: unique([...card.actorEntityIds, ...card.targetEntityIds]),
			sourceEntryIds: sourceEntryIds(card.sourceRefs),
			sourceEventIds: sourceEventIds(card.sourceRefs),
			sourcePatchIds: [],
			closedAt: null,
			closureReason: null,
			serverVersion,
			createdAt: now,
			updatedAt: now,
		});
	}

	const invalidThreadUpdates = frame.plotBrainWritePlan.storyThreadUpdates.filter(update => !update.threadId.trim()).length;
	const storyThreadUpdates = frame.plotBrainWritePlan.storyThreadUpdates.filter(update => update.threadId.trim()).map(update => ({
		storyId: frame.storyId,
		threadId: update.threadId.trim(),
		updates: {
			status: update.status,
			significance: update.significance,
			description: update.description,
			updatedAt: now,
			serverVersion,
		},
	}));
	if (invalidThreadUpdates > 0) warnings.push(`Ignored ${invalidThreadUpdates} story thread update(s) with blank IDs.`);

	const storyEventRows: StoryEventInsert[] = [];
	const eventFingerprints = new Set<string>();
	let duplicateTimelineEvents = 0;
	for (const { card, key, threadId } of activeCards) {
		card.pressureBeats.forEach((beat, index) => {
			const fingerprint = eventFingerprint(threadId, beat);
			if (eventFingerprints.has(fingerprint)) {
				duplicateTimelineEvents += 1;
				return;
			}
			eventFingerprints.add(fingerprint);
			storyEventRows.push(buildScheduledTimelineEventInsert({
				id: eventIdForBeat(frame.storyId, frame.id, key, index),
				storyId: frame.storyId,
				type: 'clue_discovery',
				title: beat.title,
				body: beat.body,
				currentTurn,
				delayTurns: beat.delayTurns,
				now,
				actorEntityIds: unique(beat.actorEntityIds),
				targetEntityIds: unique(beat.targetEntityIds),
				locationId: unique(beat.locationIds)[0] ?? null,
				locationIds: unique(beat.locationIds),
				factionIds: unique(beat.factionIds),
				threadIds: [threadId],
				visibility: beat.visibility,
				memoryImpact: beat.memoryImpact,
				sourceEntryIds: sourceEntryIds(card.sourceRefs),
				metadata: {
					plotBrain: true,
					plotCardId: key,
					plotCardTitle: card.title,
					lifecycleStage: card.lifecycleStage,
					urgency: card.urgency,
					antiRailroadNotes: card.antiRailroadNotes,
					sourceRefs: card.sourceRefs,
				},
				serverVersion,
			}));
		});
	}

	frame.plotBrainWritePlan.timelineEvents.forEach((beat, index) => {
		const plotCardId = beat.plotCardId.trim();
		const mappedThreadId = plotCardId
			? threadIdByPlotCardId.get(plotCardId) ?? threadIdByPlotCardId.get(slug(plotCardId))
			: undefined;
		const threadId = mappedThreadId ?? (beat.threadId?.trim() || null);
		const fingerprint = eventFingerprint(threadId, beat);
		if (eventFingerprints.has(fingerprint)) {
			duplicateTimelineEvents += 1;
			return;
		}
		eventFingerprints.add(fingerprint);
		storyEventRows.push(buildScheduledTimelineEventInsert({
			id: eventIdForBeat(frame.storyId, frame.id, beat.plotCardId || beat.title, index + 1000),
			storyId: frame.storyId,
			type: 'world_tick',
			title: beat.title,
			body: beat.body,
			currentTurn,
			delayTurns: beat.delayTurns,
			now,
			actorEntityIds: unique(beat.actorEntityIds),
			targetEntityIds: unique(beat.targetEntityIds),
			locationId: unique(beat.locationIds)[0] ?? null,
			locationIds: unique(beat.locationIds),
			factionIds: unique(beat.factionIds),
			threadIds: threadId ? [threadId] : [],
			visibility: beat.visibility,
			memoryImpact: beat.memoryImpact,
			sourceEntryIds: sourceEntryIds(beat.sourceRefs),
			metadata: { plotBrain: true, plotCardId: beat.plotCardId, writePlan: true, sourceRefs: beat.sourceRefs },
			serverVersion,
		}));
	});
	if (duplicateTimelineEvents > 0) warnings.push(`Ignored ${duplicateTimelineEvents} duplicate timeline event(s).`);

	const npcEventLinkRows = storyEventRows.flatMap(event => buildNpcEventLinksForEvent({
		storyId: frame.storyId,
		eventId: event.id,
		actorEntityIds: event.actorEntityIds ?? [],
		targetEntityIds: event.targetEntityIds ?? [],
		visibility: event.visibility ?? 'secret',
		sourceEntryIds: event.sourceEntryIds ?? [],
		sourcePatchIds: event.sourcePatchIds ?? [],
		serverVersion,
		now,
	}));

	const patchProposalRows = frame.plotBrainWritePlan.patchProposals.map((proposal, index) => ({
		id: patchIdForProposal(frame.storyId, frame.id, index),
		storyId: frame.storyId,
		proposalType: `plot_brain_${proposal.type}`,
		targetTable: 'stories',
		targetRecordId: frame.storyId,
		proposedBy: 'strategic_plot_brain',
		operations: [{ op: 'review_strategic_proposal', proposal }],
		reason: proposalSuggestion(proposal),
		suggestion: proposalSuggestion(proposal),
		status: 'pending',
		decision: null,
		validatedBy: null,
		affectedEntityIds: [],
		confidence: 'confidence' in proposal && typeof proposal.confidence === 'number' ? proposal.confidence : 0.75,
		sourceEntryIds: sourceEntryIds('evidenceRefs' in proposal ? proposal.evidenceRefs : []),
		sourceEventIds: sourceEventIds('evidenceRefs' in proposal ? proposal.evidenceRefs : []),
		sourcePatchIds: [],
		metadata: { plotBrain: true, frameId: frame.id, proposalType: proposal.type, evidenceRefs: 'evidenceRefs' in proposal ? proposal.evidenceRefs : [] },
		serverVersion,
		createdAt: now,
		updatedAt: now,
	}));

	if (storyThreadRows.length === 0 && frame.plotCards.length > 0) {
		warnings.push('No plot cards were activated; reconciliation produced no new story threads.');
	}

	return {
		storyThreads: storyThreadRows,
		storyThreadUpdates,
		storyEvents: storyEventRows,
		npcEventLinks: npcEventLinkRows,
		patchProposals: patchProposalRows,
		warnings,
	};
}

export async function applyPlotBrainReconciliationPlan(
	plan: PlotBrainReconciliationPlan,
	options: { db?: DbLike | TransactionLike } = {},
): Promise<PlotBrainApplyResult> {
	const apply = async (tx: TransactionLike): Promise<PlotBrainApplyResult> => {
		const insertedThreads = plan.storyThreads.length > 0
			? await tx.insert(storyThreads).values(plan.storyThreads).onConflictDoUpdate({
				target: storyThreads.id,
				set: {
					description: sql.raw('excluded.description'),
					status: sql.raw('excluded.status'),
					significance: sql.raw('excluded.significance'),
					relatedFactionIds: sql.raw('excluded.related_faction_ids'),
					relatedEntityIds: sql.raw('excluded.related_entity_ids'),
					sourceEntryIds: sql.raw('excluded.source_entry_ids'),
					sourceEventIds: sql.raw('excluded.source_event_ids'),
					closedAt: null,
					closureReason: null,
					serverVersion: sql.raw('excluded.server_version'),
					updatedAt: sql.raw('excluded.updated_at'),
				},
			}).returning({ id: storyThreads.id })
			: [];
		let updatedThreads = 0;
		for (const update of plan.storyThreadUpdates) {
			const rows = await tx.update(storyThreads).set(update.updates).where(and(
				eq(storyThreads.id, update.threadId),
				eq(storyThreads.storyId, update.storyId),
			)).returning({ id: storyThreads.id });
			updatedThreads += rows.length;
		}
		const insertedEvents = plan.storyEvents.length > 0
			? await tx.insert(storyEvents).values(plan.storyEvents).onConflictDoNothing().returning({ id: storyEvents.id })
			: [];
		const insertedNpcLinks = plan.npcEventLinks.length > 0
			? await tx.insert(npcEventLinks).values(plan.npcEventLinks).onConflictDoNothing().returning({ id: npcEventLinks.id })
			: [];
		const insertedProposals = plan.patchProposals.length > 0
			? await tx.insert(patchProposals).values(plan.patchProposals).onConflictDoNothing().returning({ id: patchProposals.id })
			: [];
		return {
			storyThreads: insertedThreads.length,
			storyThreadUpdates: updatedThreads,
			storyEvents: insertedEvents.length,
			npcEventLinks: insertedNpcLinks.length,
			patchProposals: insertedProposals.length,
			warnings: plan.warnings,
		};
	};
	if (options.db) return apply(options.db as TransactionLike);
	return getDb().transaction(apply);
}
