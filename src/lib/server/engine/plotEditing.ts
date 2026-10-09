import { and, eq, inArray, sql } from 'drizzle-orm';
import { plotEditSchema, type PlotEdit } from '$lib/contracts/plotEditing';
import { strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
import { getDb } from '$lib/server/db/client';
import { agreements, stories, storyThreads, storyEvents, npcEventLinks, memoryNodes, statePatches } from '$lib/server/db/schema';
import { frameStoryThreadIds } from '$lib/server/plotBrain/reconciler';
import { collectRetiredPlotDirectives } from '$lib/server/plotBrain/lifecycle';
import type { StrategicWorldFrame } from '$lib/types';
import { randomUUID } from 'node:crypto';
import { enqueueBackendJob, enqueueStoryVaultSyncJob } from '$lib/server/jobs/outbox';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function listPlotCommitments(storyId: string) {
	const db = getDb();
	const [story] = await db.select({ serverVersion: stories.serverVersion }).from(stories).where(eq(stories.id, storyId));
	if (!story) throw new Error('Story not found.');
	const [agreementRows, schemeRows] = await Promise.all([
		db.select().from(agreements).where(eq(agreements.storyId, storyId)),
		db.select().from(memoryNodes).where(and(eq(memoryNodes.storyId, storyId), sql`${memoryNodes.metadata}->>'sourceType' = 'scheme_import'`)),
	]);
	return { serverVersion: story.serverVersion, agreements: agreementRows.map(row => ({ ...row, deleted: row.status === 'deleted' })), schemes: schemeRows.map(row => ({ ...record(record(row.metadata).legacyRecord), id: row.id.replace(/^mem_scheme_/, ''), storyId, deleted: record(row.metadata).playerDeleted === true })) };
}

export function removeThreadPressure(value: unknown, storyId: string, threadId: string) {
	const parsed = strategicWorldFrameSchema.safeParse(value);
	if (!parsed.success) return { frame: value, removed: [] };
	const frame = parsed.data as StrategicWorldFrame;
	const threadIds = frameStoryThreadIds(storyId, frame);
	const removed = frame.plotCards.filter((_card, index) => threadIds[index] === threadId);
	const aliases = new Set(removed.flatMap(card => [card.id, card.title, threadId]));
	return {
		removed,
		frame: {
			...frame,
			plotCards: frame.plotCards.filter(card => !removed.includes(card)),
			activationPlan: {
				...frame.activationPlan,
				activateNow: frame.activationPlan.activateNow.filter(id => !aliases.has(id)),
				keepDormant: frame.activationPlan.keepDormant.filter(id => !aliases.has(id)),
				retireOrMerge: frame.activationPlan.retireOrMerge.filter(id => !aliases.has(id)),
			},
		},
	};
}

export function closeThreadPressure(value: unknown, storyId: string, threadIds: string[]) {
	const plotBrain = { ...record(value) };
	const closed = new Set(Array.isArray(plotBrain.closedThreadIds)
		? plotBrain.closedThreadIds.filter((id): id is string => typeof id === 'string') : []);
	for (const threadId of threadIds) {
		closed.add(threadId);
		for (const key of ['lastFrame', 'pendingFrame']) {
			const filtered = removeThreadPressure(plotBrain[key], storyId, threadId);
			plotBrain[key] = filtered.frame;
			plotBrain.retiredPlotDirectives = collectRetiredPlotDirectives({ plotCards: filtered.removed }, plotBrain.retiredPlotDirectives);
		}
	}
	plotBrain.closedThreadIds = [...closed];
	return plotBrain;
}

/** A manual guidance edit never replays a frame's write plan or changes past events. */
export async function editPlotState(storyId: string, input: PlotEdit) {
	let edit = plotEditSchema.parse(input);
	const requestedEdit = edit;
	return getDb().transaction(async tx => {
		const [story] = await tx.select().from(stories).where(eq(stories.id, storyId)).for('update');
		if (!story) throw new Error('Story not found.');
		if (story.serverVersion !== edit.serverVersion) throw new Error('Story changed. Refresh before saving your edits.');
		const now = new Date().toISOString();
		const patchId = `manual_plot_${randomUUID()}`;
		const serverVersion = story.serverVersion + 1;
		const metadata = record(story.metadata);
		const plotBrain = { ...record(metadata.plotBrain) };
		const deletedCommitments = { ...record(metadata.deletedCommitments) };
		let previous: unknown = metadata.plotBrain;
		const closedThreadIds = new Set(Array.isArray(plotBrain.closedThreadIds) ? plotBrain.closedThreadIds.filter((id): id is string => typeof id === 'string') : []);
		let eventFilter = sql`${storyEvents.metadata}->>'plotBrain' = 'true'`;
		if (edit.target === 'commitment') {
			const { kind, recordId, action } = edit;
			const key = `${kind}:${recordId}`;
			const saved = record(deletedCommitments[key]);
			if (action === 'restore' && !saved.status) throw new Error('Deleted record not found. Refresh first.');
			if (action === 'delete' && saved.status) throw new Error('Record is already deleted.');
			if (kind === 'agreement') {
				const [row] = await tx.select().from(agreements).where(and(eq(agreements.storyId, storyId), eq(agreements.id, recordId))).for('update');
				if (!row) throw new Error('Agreement not found in this story.');
				previous = row;
				if (action === 'delete') deletedCommitments[key] = { status: row.status, deletedAt: now };
				await tx.update(agreements).set({ status: action === 'delete' ? 'deleted' : String(saved.status), sourcePatchIds: [...row.sourcePatchIds, patchId], serverVersion, updatedAt: now }).where(and(eq(agreements.storyId, storyId), eq(agreements.id, recordId)));
			} else {
				const [node] = await tx.select().from(memoryNodes).where(and(eq(memoryNodes.storyId, storyId), eq(memoryNodes.id, `mem_scheme_${recordId}`), sql`${memoryNodes.metadata}->>'sourceType' = 'scheme_import'`)).for('update');
				const [thread] = await tx.select().from(storyThreads).where(and(eq(storyThreads.storyId, storyId), eq(storyThreads.id, recordId))).for('update');
				if (!node || !thread) throw new Error('Scheme or linked thread not found in this story.');
				previous = { node, thread };
				if (action === 'delete') deletedCommitments[key] = { status: thread.status, closedAt: thread.closedAt, closureReason: thread.closureReason, deletedAt: now };
				await tx.update(memoryNodes).set({ metadata: { ...record(node.metadata), playerDeleted: action === 'delete' }, sourcePatchIds: [...node.sourcePatchIds, patchId], serverVersion, updatedAt: now }).where(and(eq(memoryNodes.storyId, storyId), eq(memoryNodes.id, node.id)));
				await tx.update(storyThreads).set({ status: action === 'delete' ? 'closed' : String(saved.status), closedAt: action === 'delete' ? now : typeof saved.closedAt === 'string' ? saved.closedAt : null, closureReason: action === 'delete' ? '[player:deleted] Scheme removed by player.' : typeof saved.closureReason === 'string' ? saved.closureReason : null, serverVersion, updatedAt: now }).where(and(eq(storyThreads.storyId, storyId), eq(storyThreads.id, recordId)));
				if (action === 'delete' || ['closed', 'abandoned', 'resolved'].includes(String(saved.status))) closedThreadIds.add(recordId); else closedThreadIds.delete(recordId);
			}
			if (action === 'restore') delete deletedCommitments[key];
			eventFilter = sql`false`;
			if (action === 'delete') {
				const linked = new Set<string>(kind === 'scheme' ? [recordId] : []);
				for (const frameKey of ['lastFrame', 'pendingFrame']) {
					const parsed = strategicWorldFrameSchema.safeParse(plotBrain[frameKey]);
					if (!parsed.success) continue;
					const bindings = frameStoryThreadIds(storyId, parsed.data);
					for (const [index, card] of parsed.data.plotCards.entries()) if (card.sourceRefs.some(ref => ref.sourceType === kind && ref.sourceId === recordId)) linked.add(bindings[index]);
				}
				for (const threadId of linked) {
					closedThreadIds.add(threadId);
					await tx.update(storyThreads).set({ status: 'closed', closedAt: now, closureReason: `[player:deleted] Linked ${kind} removed by player.`, serverVersion, updatedAt: now }).where(and(eq(storyThreads.storyId, storyId), eq(storyThreads.id, threadId)));
					for (const frameKey of ['lastFrame', 'pendingFrame']) plotBrain[frameKey] = removeThreadPressure(plotBrain[frameKey], storyId, threadId).frame;
					eventFilter = sql`(${eventFilter} or ${storyEvents.threadIds} ? ${threadId})`;
				}
			}
		}
		if (edit.target === 'scheme') {
			if (edit.currentStageIndex >= edit.stages.length || edit.stages.some((stage, index) => stage.index !== index)) throw new Error('Scheme stages must have consecutive indexes and a valid current stage.');
			const [node] = await tx.select().from(memoryNodes).where(and(eq(memoryNodes.storyId, storyId), eq(memoryNodes.id, `mem_scheme_${edit.recordId}`), sql`${memoryNodes.metadata}->>'sourceType' = 'scheme_import'`)).for('update');
			if (!node) throw new Error('Scheme not found in this story.');
			if (record(node.metadata).playerDeleted) throw new Error('Restore the deleted scheme before editing it.');
			previous = node;
			const legacy = record(record(node.metadata).legacyRecord);
			const { target: _target, serverVersion: _version, recordId, ...changes } = edit;
			const description = [`${String(legacy.ownerName ?? 'Unknown actor')}: ${edit.goal}`, ...edit.stages.map(stage => `${stage.label} ${stage.hook}`)].join(' ').replace(/\s+/g, ' ').trim();
			await tx.update(memoryNodes).set({
				title: `Scheme: ${edit.goal}`, content: description, summary: description,
				visibility: edit.secrecy === 'secret' ? 'secret' : 'player_known', importance: Math.max(0.45, Math.min(0.95, edit.pressure / 100)),
				keywords: [String(legacy.ownerName ?? ''), String(legacy.ownerType ?? ''), edit.status, edit.secrecy].filter(Boolean),
				metadata: { ...record(node.metadata), legacyRecord: { ...legacy, ...changes, updatedAt: Date.parse(now) } },
				sourcePatchIds: [...node.sourcePatchIds, patchId], serverVersion, updatedAt: now,
			}).where(and(eq(memoryNodes.storyId, storyId), eq(memoryNodes.id, node.id)));
			edit = { target: 'thread', serverVersion: edit.serverVersion, threadId: recordId, description,
				status: ['resolved', 'foiled', 'abandoned'].includes(edit.status) ? 'closed' : edit.status === 'climaxing' ? 'imminent' : edit.status === 'incubating' ? 'stalled' : 'open',
				significance: edit.pressure >= 80 ? 'critical' : edit.pressure >= 55 ? 'major' : edit.pressure >= 25 ? 'moderate' : 'minor' };
		}
		if (edit.target === 'thread') {
			if (requestedEdit.target === 'thread') {
				const [scheme] = await tx.select({ id: memoryNodes.id }).from(memoryNodes).where(and(eq(memoryNodes.storyId, storyId), eq(memoryNodes.id, `mem_scheme_${edit.threadId}`), sql`${memoryNodes.metadata}->>'sourceType' = 'scheme_import'`));
				if (scheme) throw new Error('This thread belongs to a scheme. Use Edit scheme in Agreements and schemes to keep its goal, stages and status in sync.');
			}
			const [thread] = await tx.select().from(storyThreads).where(and(eq(storyThreads.storyId, storyId), eq(storyThreads.id, edit.threadId))).for('update');
			if (!thread) throw new Error('Thread not found in this story.');
			previous = requestedEdit.target === 'scheme' ? { scheme: previous, thread } : thread;
			const closed = edit.status === 'closed' || edit.status === 'deleted';
			if (closed) closedThreadIds.add(edit.threadId); else closedThreadIds.delete(edit.threadId);
			await tx.update(storyThreads).set({
				description: edit.description, significance: edit.significance,
				sourcePatchIds: [...thread.sourcePatchIds, patchId],
				status: closed ? 'closed' : edit.status,
				closedAt: closed ? now : null,
				closureReason: closed ? `[player:${edit.status}] Closed manually; do not reactivate automatically.` : null,
				serverVersion, updatedAt: now,
			}).where(and(eq(storyThreads.id, edit.threadId), eq(storyThreads.storyId, storyId)));
			// Drop stale derived guidance even for a description edit; the next draft uses the corrected thread.
			for (const key of ['lastFrame', 'pendingFrame']) {
				if (!plotBrain[key]) continue;
				const filtered = removeThreadPressure(plotBrain[key], storyId, edit.threadId);
				plotBrain[key] = filtered.frame;
				if (closed) plotBrain.retiredPlotDirectives = collectRetiredPlotDirectives({ plotCards: filtered.removed }, plotBrain.retiredPlotDirectives);
			}
			if (closed) plotBrain.retiredPlotDirectives = collectRetiredPlotDirectives({ plotCards: [{ logline: thread.description }] }, plotBrain.retiredPlotDirectives);
			eventFilter = sql`${storyEvents.threadIds} ? ${edit.threadId}`;
			// This is the rebuildable plot-ledger projection, not historical narrative evidence.
			await tx.delete(memoryNodes).where(and(eq(memoryNodes.storyId, storyId), eq(memoryNodes.type, 'plot_ledger'), sql`${memoryNodes.threadIds} ? ${edit.threadId}`, sql`coalesce(${memoryNodes.metadata}->>'sourceType', '') != 'scheme_import'`));
		} else if (edit.target === 'agreement') {
			const [agreement] = await tx.select().from(agreements).where(and(eq(agreements.storyId, storyId), eq(agreements.id, edit.recordId))).for('update');
			if (!agreement) throw new Error('Agreement not found in this story.');
			if (agreement.status === 'deleted') throw new Error('Restore the deleted agreement before editing it.');
			previous = agreement;
			const { target: _target, serverVersion: _version, recordId, ...changes } = edit;
			await tx.update(agreements).set({ ...changes, sourcePatchIds: [...agreement.sourcePatchIds, patchId], serverVersion, updatedAt: now }).where(and(eq(agreements.storyId, storyId), eq(agreements.id, recordId)));
			// Unrelated Director events are not cancelled by an agreement edit.
			eventFilter = sql`false`;
			for (const key of ['lastFrame', 'pendingFrame']) {
				const parsed = strategicWorldFrameSchema.safeParse(plotBrain[key]);
				if (!parsed.success) continue;
				let frame: unknown = parsed.data;
				const bindings = frameStoryThreadIds(storyId, parsed.data);
				for (const [index, card] of parsed.data.plotCards.entries()) {
					if (!card.sourceRefs.some(ref => ref.sourceType === 'agreement' && ref.sourceId === recordId)) continue;
					frame = removeThreadPressure(frame, storyId, bindings[index]).frame;
					eventFilter = sql`(${eventFilter} or ${storyEvents.threadIds} ? ${bindings[index]})`;
				}
				plotBrain[key] = frame;
			}
		} else if (edit.target === 'applied' || edit.target === 'pending') {
			const key = edit.target === 'pending' ? 'pendingFrame' : 'lastFrame';
			const stored = record(plotBrain[key]);
			if (stored.id !== edit.frameId || edit.frame.id !== edit.frameId || edit.frame.storyId !== storyId) throw new Error('Director frame changed or belongs to another story. Refresh before saving.');
			if (edit.target === 'pending' && plotBrain.pendingBaseServerVersion !== story.serverVersion) throw new Error('This draft is stale. Draft fresh before editing it.');
			const previous = strategicWorldFrameSchema.parse(stored);
			const editedCards = edit.frame.plotCards;
			const removed = previous.plotCards.filter(card => !editedCards.some(next => next.id === card.id && next.lifecycleStage !== 'resolved'));
			if (edit.target === 'applied') {
				plotBrain.retiredPlotDirectives = collectRetiredPlotDirectives({ plotCards: removed }, plotBrain.retiredPlotDirectives);
				const ids = frameStoryThreadIds(storyId, previous);
				for (const [index, card] of previous.plotCards.entries()) {
					const next = edit.frame.plotCards.find(row => row.id === card.id);
					const closed = !next || next.lifecycleStage === 'resolved';
					if (closed) closedThreadIds.add(ids[index]);
					await tx.update(storyThreads).set(closed ? {
						status: 'closed', closedAt: now, closureReason: next ? '[player:closed] Resolved in Director editor.' : '[player:deleted] Removed in Director editor.', serverVersion, updatedAt: now,
					} : { description: `${next.title}: ${next.logline}`, serverVersion, updatedAt: now }).where(and(
						eq(storyThreads.storyId, storyId), eq(storyThreads.id, ids[index]),
						sql`coalesce(${storyThreads.closureReason}, '') not like '[player:%'`,
					));
				}
			}
			const threadIds = frameStoryThreadIds(storyId, previous);
			plotBrain[key] = { ...edit.frame, plotCards: edit.frame.plotCards.map(card => ({ ...card, storyThreadId: card.storyThreadId || threadIds[previous.plotCards.findIndex(row => row.id === card.id)] })) };
			if (edit.target === 'pending') plotBrain.pendingBaseServerVersion = serverVersion;
			// Applied guidance is edited in place; freshness and retirement are deliberately not reset.
		}
		if (edit.target !== 'pending') {
			const cancelled = await tx.update(storyEvents).set({ status: 'cancelled', serverVersion, updatedAt: now }).where(and(
				eq(storyEvents.storyId, storyId), inArray(storyEvents.status, ['scheduled', 'due']), eventFilter,
			)).returning({ id: storyEvents.id });
			if (cancelled.length) await tx.delete(npcEventLinks).where(and(eq(npcEventLinks.storyId, storyId), inArray(npcEventLinks.eventId, cancelled.map(row => row.id))));
		}
		plotBrain.closedThreadIds = [...closedThreadIds];
		// Checkpoint notes can contain now-invalid obligations; rebuild from current records later.
		delete metadata.sceneCheckpoint;
		await tx.update(stories).set({ metadata: { ...metadata, plotBrain, deletedCommitments }, serverVersion, updatedAt: now }).where(eq(stories.id, storyId));
		await tx.insert(statePatches).values({
			id: patchId, storyId, operations: [{ op: 'replace', path: requestedEdit.target === 'commitment' ? `/${requestedEdit.kind}s/${requestedEdit.recordId}` : requestedEdit.target === 'scheme' || requestedEdit.target === 'agreement' ? `/${requestedEdit.target}s/${requestedEdit.recordId}` : edit.target === 'thread' ? `/threads/${edit.threadId}` : `/plotBrain/${edit.target}`, value: requestedEdit, previous }],
			reason: 'Player edited plot continuity.', status: 'applied', validationWarnings: [], sourceEntryIds: [], sourceEventIds: [], serverVersion, createdAt: now, updatedAt: now,
		});
		await enqueueStoryVaultSyncJob({ storyId, serverVersion, reason: 'manual-plot-edit', payload: { clean: true, index: true } }, tx);
		await enqueueBackendJob({ storyId, type: 'index_canonical_records', dedupeKey: `manual-plot-index-${serverVersion}`, payload: { recordTypes: ['agreements', 'memoryNodes', 'threads'], reason: 'manual_plot_edit' }, maxAttempts: 3 }, tx);
		return { storyId, serverVersion };
	});
}
