import { createHash } from 'node:crypto';
import type { StrategicCanonPatch, StrategicEvidenceRef, StrategicWorldFrame } from '$lib/types';
import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import { patchProposals, storyEvents, storyThreads, npcEventLinks, stories } from '$lib/server/db/schema';
import { getDb } from '$lib/server/db/client';
import { collectRetiredPlotDirectives } from './lifecycle';
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
	lifecycle: {
		storyId: string;
		activeThreadIds: string[];
		dormantThreadIds?: string[];
		retiredThreadIds: string[];
		desiredEventIds: string[];
		now: string;
		serverVersion: number;
	};
	storyThreads: Array<typeof storyThreads.$inferInsert>;
	storyThreadUpdates: Array<{ storyId: string; threadId: string; updates: Partial<typeof storyThreads.$inferInsert> }>;
	storyEvents: StoryEventInsert[];
	npcEventLinks: NpcEventLinkInsert[];
	patchProposals: Array<typeof patchProposals.$inferInsert>;
	warnings: string[];
}

export interface PlotBrainApplyResult {
	retiredStoryThreads: number;
	retiredStoryEvents: number;
	reactivatedStoryEvents: number;
	storyThreads: number;
	storyThreadUpdates: number;
	storyEvents: number;
	npcEventLinks: number;
	patchProposals: number;
	warnings: string[];
}

type DbLike = ReturnType<typeof getDb>;
type TransactionLike = Parameters<Parameters<DbLike['transaction']>[0]>[0];
type ThreadBoundPlotCard = StrategicWorldFrame['plotCards'][number] & { storyThreadId?: string | null };

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function slug(value: string): string {
	const clean = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
	return clean || 'plot';
}

function tupleHash(...parts: string[]): string {
	return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
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
	return `${threadIdPrefix(storyId)}${slug(cardIdOrTitle)}_${tupleHash('plot_thread', storyId, cardIdOrTitle)}`;
}

function threadIdPrefix(storyId: string): string {
	return `plot_thread_${slug(storyId)}_`;
}

function referencedStoryThreadId(card: ThreadBoundPlotCard): string | null {
	const explicit = card.storyThreadId?.trim();
	if (explicit) return explicit;
	return card.sourceRefs?.find(ref => ref.sourceType === 'thread' && ref.sourceId?.trim())?.sourceId?.trim() ?? null;
}

function threadIdForPlotCard(storyId: string, card: ThreadBoundPlotCard, fallbackLabel: string): string {
	return referencedStoryThreadId(card) ?? threadIdForCard(storyId, fallbackLabel);
}

export function frameStoryThreadIds(storyId: string, frameValue: unknown): string[] {
	const frame = asRecord(frameValue);
	const cards = Array.isArray(frame.plotCards)
		? frame.plotCards.filter((card): card is ThreadBoundPlotCard => Boolean(card && typeof card === 'object' && !Array.isArray(card)))
		: [];
	const titleCounts = new Map<string, number>();
	for (const card of cards) {
		const title = typeof card.title === 'string' ? card.title.trim().toLowerCase() : '';
		if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
	}
	return cards.map((card, index) => {
		const key = typeof card.id === 'string' && card.id.trim()
			? card.id.trim()
			: `${typeof card.title === 'string' && card.title.trim() ? card.title.trim() : 'plot'}_${index + 1}`;
		const title = typeof card.title === 'string' ? card.title.trim() : '';
		const fallbackLabel = title && titleCounts.get(title.toLowerCase()) === 1 ? title : key;
		return threadIdForPlotCard(storyId, card, fallbackLabel);
	});
}

function cardKey(card: StrategicWorldFrame['plotCards'][number], index: number): string {
	return card.id.trim() || `${card.title.trim() || 'plot'}_${index + 1}`;
}

function beatContentFingerprint(
	threadId: string,
	beat: StrategicWorldFrame['plotCards'][number]['pressureBeats'][number],
): string {
	const normalize = (value: string) => value
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
	return [normalize(threadId) || 'plot', normalize(beat.title), normalize(beat.body)].join('\u241f');
}

function eventIdForBeat(storyId: string, plotCardKey: string, fingerprint: string): string {
	const digest = tupleHash('plot_event', storyId, plotCardKey, fingerprint);
	return `plot_event_${slug(storyId)}_${slug(plotCardKey)}_${digest}`;
}

function patchIdForProposal(storyId: string, frameId: string, index: number): string {
	return `patch_plot_brain_${slug(storyId)}_${slug(frameId)}_${index}_${tupleHash('plot_patch', storyId, frameId, String(index))}`;
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

function cardReferenceSet(values: string[]): Set<string> {
	return new Set(unique(values).flatMap(value => [value, slug(value)]));
}

function isActivated(
	activated: Set<string>,
	card: StrategicWorldFrame['plotCards'][number],
	key: string,
): boolean {
	return unique([card.id, card.title, key, referencedStoryThreadId(card as ThreadBoundPlotCard)])
		.some(value => activated.has(value) || activated.has(slug(value)));
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
	const activated = cardReferenceSet(frame.activationPlan.activateNow);
	const dormant = cardReferenceSet(frame.activationPlan.keepDormant);
	const retired = cardReferenceSet(frame.activationPlan.retireOrMerge);
	const terminalUpdatedThreadIds = new Set(frame.plotBrainWritePlan.storyThreadUpdates
		.filter(update => update.status === 'closed' || update.status === 'abandoned')
		.map(update => update.threadId.trim())
		.filter(Boolean));
	const activeCardCandidates = frame.plotCards
		.map((card, index) => ({ card, key: cardKey(card, index) }))
		.filter(({ card, key }) => card.lifecycleStage !== 'resolved'
			&& card.lifecycleStage !== 'dormant'
			&& isActivated(activated, card, key)
			&& !isActivated(retired, card, key)
			&& !terminalUpdatedThreadIds.has(referencedStoryThreadId(card as ThreadBoundPlotCard) ?? ''));
	const activeTitleCounts = new Map<string, number>();
	for (const { card } of activeCardCandidates) {
		const title = card.title.trim().toLowerCase();
		activeTitleCounts.set(title, (activeTitleCounts.get(title) ?? 0) + 1);
	}
	const activeCards = activeCardCandidates.map(({ card, key }) => {
		const title = card.title.trim();
		const threadLabel = title && activeTitleCounts.get(title.toLowerCase()) === 1 ? title : key;
		return { card, key, threadId: threadIdForPlotCard(frame.storyId, card as ThreadBoundPlotCard, threadLabel) };
	}).filter(({ threadId }) => !terminalUpdatedThreadIds.has(threadId));
	const retiredCardCandidates = frame.plotCards
		.map((card, index) => ({ card, key: cardKey(card, index) }))
		.filter(({ card, key }) => card.lifecycleStage === 'resolved'
			|| isActivated(retired, card, key)
			|| terminalUpdatedThreadIds.has(referencedStoryThreadId(card as ThreadBoundPlotCard) ?? ''));
	const retiredTitleCounts = new Map<string, number>();
	for (const { card } of retiredCardCandidates) {
		const title = card.title.trim().toLowerCase();
		retiredTitleCounts.set(title, (retiredTitleCounts.get(title) ?? 0) + 1);
	}
	const retiredCardThreadIds = retiredCardCandidates.map(({ card, key }) => {
		const title = card.title.trim();
		const threadLabel = title && retiredTitleCounts.get(title.toLowerCase()) === 1 ? title : key;
		return threadIdForPlotCard(frame.storyId, card as ThreadBoundPlotCard, threadLabel);
	});
	const activeCardObjects = new Set(activeCards.map(({ card }) => card));
	const retiredCardObjects = new Set(retiredCardCandidates.map(({ card }) => card));
	const dormantCardCandidates = frame.plotCards
		.map((card, index) => ({ card, key: cardKey(card, index) }))
		.filter(({ card, key }) => (card.lifecycleStage === 'dormant' || isActivated(dormant, card, key))
			&& !activeCardObjects.has(card)
			&& !retiredCardObjects.has(card));
	const dormantTitleCounts = new Map<string, number>();
	for (const { card } of dormantCardCandidates) {
		const title = card.title.trim().toLowerCase();
		dormantTitleCounts.set(title, (dormantTitleCounts.get(title) ?? 0) + 1);
	}
	const dormantCardThreadIds = dormantCardCandidates.map(({ card, key }) => {
		const title = card.title.trim();
		const threadLabel = title && dormantTitleCounts.get(title.toLowerCase()) === 1 ? title : key;
		return threadIdForPlotCard(frame.storyId, card as ThreadBoundPlotCard, threadLabel);
	}).filter(threadId => !terminalUpdatedThreadIds.has(threadId));

	const storyThreadRows: Array<typeof storyThreads.$inferInsert> = [];
	for (const { card, key, threadId: id } of activeCards) {
		for (const alias of unique([card.id, card.title, key, referencedStoryThreadId(card as ThreadBoundPlotCard)]).flatMap(value => [value, slug(value)])) {
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
	const ignoredThreadDescriptionUpdates = frame.plotBrainWritePlan.storyThreadUpdates
		.filter(update => update.threadId.trim() && update.description?.trim()).length;
	const storyThreadUpdates = frame.plotBrainWritePlan.storyThreadUpdates.filter(update => update.threadId.trim()).map(update => ({
		storyId: frame.storyId,
		threadId: update.threadId.trim(),
		updates: {
			status: update.status,
			significance: update.significance,
			updatedAt: now,
			serverVersion,
		},
	}));
	const retiredThreadIds = unique([
		...retiredCardThreadIds,
		...storyThreadUpdates
			.filter(update => update.updates.status === 'closed' || update.updates.status === 'abandoned')
			.map(update => update.threadId),
	]);
	if (invalidThreadUpdates > 0) warnings.push(`Ignored ${invalidThreadUpdates} story thread update(s) with blank IDs.`);
	if (ignoredThreadDescriptionUpdates > 0) {
		warnings.push(`Ignored ${ignoredThreadDescriptionUpdates} Plot Director thread description rewrite(s); canonical thread text is evidence-owned.`);
	}

	const storyEventRows: StoryEventInsert[] = [];
	const eventContentFingerprints = new Set<string>();
	let duplicateTimelineEvents = 0;
	for (const { card, key, threadId } of activeCards) {
		card.pressureBeats.forEach((beat) => {
			const contentFingerprint = beatContentFingerprint(threadId, beat);
			if (eventContentFingerprints.has(contentFingerprint)) {
				duplicateTimelineEvents += 1;
				return;
			}
			eventContentFingerprints.add(contentFingerprint);
			storyEventRows.push(buildScheduledTimelineEventInsert({
				id: eventIdForBeat(frame.storyId, threadId, contentFingerprint),
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
					semanticKey: contentFingerprint,
				},
				serverVersion,
			}));
		});
	}

	let inactiveTimelineEvents = 0;
	frame.plotBrainWritePlan.timelineEvents.forEach((beat) => {
		const plotCardId = beat.plotCardId.trim();
		const explicitActiveCard = activeCards.find(item => item.threadId === beat.threadId?.trim());
		const mappedThreadId = (plotCardId
			? threadIdByPlotCardId.get(plotCardId) ?? threadIdByPlotCardId.get(slug(plotCardId))
			: undefined) ?? explicitActiveCard?.threadId;
		if (!mappedThreadId) {
			inactiveTimelineEvents += 1;
			return;
		}
		const activePlotCard = activeCards.find(item => item.threadId === mappedThreadId);
		if (!activePlotCard) {
			inactiveTimelineEvents += 1;
			return;
		}
		const contentFingerprint = beatContentFingerprint(mappedThreadId, beat);
		if (eventContentFingerprints.has(contentFingerprint)) {
			duplicateTimelineEvents += 1;
			return;
		}
		eventContentFingerprints.add(contentFingerprint);
		storyEventRows.push(buildScheduledTimelineEventInsert({
			id: eventIdForBeat(frame.storyId, mappedThreadId, contentFingerprint),
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
			threadIds: [mappedThreadId],
			visibility: beat.visibility,
			memoryImpact: beat.memoryImpact,
			sourceEntryIds: sourceEntryIds(beat.sourceRefs),
			metadata: { plotBrain: true, plotCardId: activePlotCard.key, writePlan: true, sourceRefs: beat.sourceRefs, semanticKey: contentFingerprint },
			serverVersion,
		}));
	});
	if (duplicateTimelineEvents > 0) warnings.push(`Ignored ${duplicateTimelineEvents} duplicate timeline event(s).`);
	if (inactiveTimelineEvents > 0) warnings.push(`Ignored ${inactiveTimelineEvents} timeline event(s) not linked to an activated plot card.`);

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
		lifecycle: {
			storyId: frame.storyId,
			activeThreadIds: storyThreadRows.map(row => row.id),
			dormantThreadIds: dormantCardThreadIds,
			retiredThreadIds,
			desiredEventIds: storyEventRows.map(row => row.id),
			now,
			serverVersion,
		},
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
				setWhere: notInArray(storyThreads.status, ['closed', 'abandoned']),
				set: {
					status: sql.raw('excluded.status'),
					significance: sql.raw('excluded.significance'),
					relatedFactionIds: sql.raw('excluded.related_faction_ids'),
					relatedEntityIds: sql.raw('excluded.related_entity_ids'),
					sourceEntryIds: sql`(
						select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
						from (
							select distinct value
							from jsonb_array_elements_text(coalesce(${storyThreads.sourceEntryIds}, '[]'::jsonb) || excluded.source_entry_ids) as source(value)
						) as distinct_values
					)`,
					sourceEventIds: sql`(
						select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
						from (
							select distinct value
							from jsonb_array_elements_text(coalesce(${storyThreads.sourceEventIds}, '[]'::jsonb) || excluded.source_event_ids) as source(value)
						) as distinct_values
					)`,
					closedAt: null,
					closureReason: null,
					serverVersion: sql.raw('excluded.server_version'),
					updatedAt: sql.raw('excluded.updated_at'),
				},
			}).returning({ id: storyThreads.id })
			: [];
		const reconciledThreadIds = new Set(insertedThreads.map(thread => thread.id));
		const currentEvents = plan.storyEvents.filter(event => {
			const threadIds = unique(event.threadIds ?? []);
			return threadIds.length > 0 && threadIds.every(threadId => reconciledThreadIds.has(threadId));
		});
		const desiredEventIds = currentEvents.map(event => event.id);
		const replacedThreadIds = unique([
			...plan.lifecycle.activeThreadIds,
			...(plan.lifecycle.dormantThreadIds ?? []),
			...plan.lifecycle.retiredThreadIds,
		]);
		const retiredEvents = replacedThreadIds.length > 0
			? await tx.update(storyEvents).set({
				status: 'cancelled',
				serverVersion: plan.lifecycle.serverVersion,
				updatedAt: plan.lifecycle.now,
			}).where(and(
				eq(storyEvents.storyId, plan.lifecycle.storyId),
				inArray(storyEvents.status, ['scheduled', 'due']),
				sql`${storyEvents.metadata}->>'plotBrain' = 'true'`,
				or(...replacedThreadIds.map(threadId => sql`${storyEvents.threadIds} ? ${threadId}`)),
				...(desiredEventIds.length > 0
					? [notInArray(storyEvents.id, desiredEventIds)]
					: []),
			)).returning({ id: storyEvents.id })
			: [];

		const retiredThreads = plan.lifecycle.retiredThreadIds.length > 0
			? await tx.update(storyThreads).set({
				status: 'closed',
				closedAt: plan.lifecycle.now,
				closureReason: 'Retired or merged by Plot Director activation plan.',
				serverVersion: plan.lifecycle.serverVersion,
				updatedAt: plan.lifecycle.now,
			}).where(and(
				eq(storyThreads.storyId, plan.lifecycle.storyId),
				inArray(storyThreads.id, plan.lifecycle.retiredThreadIds),
				inArray(storyThreads.status, ['open', 'imminent', 'stalled']),
			)).returning({ id: storyThreads.id })
			: [];

		let reactivatedEvents = 0;
		const refreshedEventIds: string[] = [];
		for (const event of currentEvents) {
			const { id: eventId, storyId: _storyId, createdAt: _createdAt, ...eventUpdates } = event;
			const rows = await tx.update(storyEvents).set({
				...eventUpdates,
				status: 'scheduled',
				occurredTurn: null,
				serverVersion: plan.lifecycle.serverVersion,
				updatedAt: plan.lifecycle.now,
			}).where(and(
				eq(storyEvents.storyId, plan.lifecycle.storyId),
				eq(storyEvents.id, eventId),
				inArray(storyEvents.status, ['scheduled', 'due']),
				sql`${storyEvents.metadata}->>'plotBrain' = 'true'`,
			)).returning({ id: storyEvents.id });
			if (rows.length > 0) refreshedEventIds.push(eventId);
		}

		const reactivatedEventIds: string[] = [];
		for (const event of currentEvents) {
			const { id: eventId, storyId: _storyId, createdAt: _createdAt, ...eventUpdates } = event;
			const rows = await tx.update(storyEvents).set({
				...eventUpdates,
				status: 'scheduled',
				occurredTurn: null,
				serverVersion: plan.lifecycle.serverVersion,
				updatedAt: plan.lifecycle.now,
			}).where(and(
				eq(storyEvents.storyId, plan.lifecycle.storyId),
				eq(storyEvents.id, eventId),
				eq(storyEvents.status, 'cancelled'),
				sql`${storyEvents.metadata}->>'plotBrain' = 'true'`,
			)).returning({ id: storyEvents.id });
			reactivatedEvents += rows.length;
			if (rows.length > 0) reactivatedEventIds.push(eventId);
		}

		let updatedThreads = 0;
		for (const update of plan.storyThreadUpdates) {
			const rows = await tx.update(storyThreads).set(update.updates).where(and(
				eq(storyThreads.id, update.threadId),
				eq(storyThreads.storyId, update.storyId),
				sql`coalesce(${storyThreads.closureReason}, '') not like '[player:%'`,
			)).returning({ id: storyThreads.id });
			updatedThreads += rows.length;
		}
		const insertedEvents = currentEvents.length > 0
			? await tx.insert(storyEvents).values(currentEvents).onConflictDoNothing().returning({ id: storyEvents.id })
			: [];
		const staleNpcLinkEventIds = unique([
			...retiredEvents.map(event => event.id),
			...refreshedEventIds,
			...reactivatedEventIds,
		]);
		if (staleNpcLinkEventIds.length > 0) {
			await tx.delete(npcEventLinks).where(and(
				eq(npcEventLinks.storyId, plan.lifecycle.storyId),
				inArray(npcEventLinks.eventId, staleNpcLinkEventIds),
			));
		}
		const writableEventIds = new Set([...refreshedEventIds, ...reactivatedEventIds, ...insertedEvents.map(event => event.id)]);
		const currentNpcEventLinks = plan.npcEventLinks.filter(link => writableEventIds.has(link.eventId));
		const insertedNpcLinks = currentNpcEventLinks.length > 0
			? await tx.insert(npcEventLinks).values(currentNpcEventLinks).onConflictDoNothing().returning({ id: npcEventLinks.id })
			: [];
		const insertedProposals = plan.patchProposals.length > 0
			? await tx.insert(patchProposals).values(plan.patchProposals).onConflictDoNothing().returning({ id: patchProposals.id })
			: [];
		return {
			retiredStoryThreads: retiredThreads.length,
			retiredStoryEvents: retiredEvents.length,
			reactivatedStoryEvents: reactivatedEvents,
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

export interface RetirePlotBrainFrameInput {
	storyId: string;
	currentTurn: number;
	serverVersion: number;
	reason: string;
	quietTurns?: number;
	now?: string;
}

export interface RetirePlotBrainFrameResult {
	retiredStoryThreads: number;
	retiredStoryEvents: number;
	retiredPlotDirectives: string[];
	quietUntilTurn: number;
}

export async function retirePlotBrainFrame(
	input: RetirePlotBrainFrameInput,
	options: { db?: DbLike | TransactionLike } = {},
): Promise<RetirePlotBrainFrameResult> {
	const apply = async (tx: TransactionLike): Promise<RetirePlotBrainFrameResult> => {
		const [story] = await tx.select().from(stories).where(and(
			eq(stories.id, input.storyId),
			eq(stories.serverVersion, input.serverVersion),
		)).limit(1);
		if (!story) throw new Error('Story changed while retiring Plot Director pressure.');

		const now = input.now ?? new Date().toISOString();
		const metadata = asRecord(story.metadata);
		const plotBrain = { ...asRecord(metadata.plotBrain) };
		const quietUntilTurn = Math.max(0, Math.floor(input.currentTurn)) + Math.max(1, Math.floor(input.quietTurns ?? 5));
		const retiredPlotDirectives = collectRetiredPlotDirectives(
			plotBrain.lastFrame ?? metadata.strategicWorldFrame,
			plotBrain.retiredPlotDirectives,
		);
		const retiredFrameThreadIds = frameStoryThreadIds(
			input.storyId,
			plotBrain.lastFrame ?? metadata.strategicWorldFrame,
		);
		for (const key of ['pendingFrame', 'pendingFrameId', 'pendingBaseServerVersion', 'pendingCurrentTurn', 'pendingPlanAt']) {
			delete plotBrain[key];
		}
		Object.assign(plotBrain, {
			active: false,
			quietUntilTurn,
			retiredAt: now,
			retirementReason: input.reason.trim().slice(0, 400),
			retiredPlotDirectives,
			retiredFrameId: typeof plotBrain.lastFrameId === 'string' ? plotBrain.lastFrameId : null,
		});
		const updated = await tx.update(stories).set({
			metadata: { ...metadata, plotBrain },
			updatedAt: now,
		}).where(and(
			eq(stories.id, input.storyId),
			eq(stories.serverVersion, input.serverVersion),
		)).returning({ id: stories.id });
		if (updated.length !== 1) throw new Error('Story changed while retiring Plot Director pressure.');

		const retiredEvents = await tx.update(storyEvents).set({
			status: 'cancelled',
			serverVersion: input.serverVersion,
			updatedAt: now,
		}).where(and(
			eq(storyEvents.storyId, input.storyId),
			inArray(storyEvents.status, ['scheduled', 'due']),
			sql`${storyEvents.metadata}->>'plotBrain' = 'true'`,
		)).returning({ id: storyEvents.id });
		if (retiredEvents.length > 0) {
			await tx.delete(npcEventLinks).where(and(
				eq(npcEventLinks.storyId, input.storyId),
				inArray(npcEventLinks.eventId, retiredEvents.map(event => event.id)),
			));
		}
		const retiredThreads = retiredFrameThreadIds.length > 0
			? await tx.update(storyThreads).set({
				status: 'closed',
				closedAt: now,
				closureReason: 'Retired at the player\'s request.',
				serverVersion: input.serverVersion,
				updatedAt: now,
			}).where(and(
				eq(storyThreads.storyId, input.storyId),
				inArray(storyThreads.id, retiredFrameThreadIds),
				inArray(storyThreads.status, ['open', 'imminent', 'stalled']),
			)).returning({ id: storyThreads.id })
			: [];
		return {
			retiredStoryThreads: retiredThreads.length,
			retiredStoryEvents: retiredEvents.length,
			retiredPlotDirectives,
			quietUntilTurn,
		};
	};
	if (options.db) return apply(options.db as TransactionLike);
	return getDb().transaction(apply);
}
