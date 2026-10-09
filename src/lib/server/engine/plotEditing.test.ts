import { describe, expect, it } from 'vitest';
import { plotEditSchema, isDeletedThread } from '$lib/contracts/plotEditing';
import { strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
import { closeThreadPressure, removeThreadPressure } from './plotEditing';
import { frameStoryThreadIds } from '$lib/server/plotBrain/reconciler';
import { storedStrategicFrameForStory, buildStrategicNarratorBlock } from '$lib/services/ai/context/strategicFramePromptCard';
import type { StrategicWorldFrame } from '$lib/types';

function frame() {
	return strategicWorldFrameSchema.parse({ id: 'frame', storyId: 'story',
		plotCards: [
			{ id: 'old', title: 'Old pressure', logline: 'An obsolete blockade.', storyThreadId: 'thread_old', lifecycleStage: 'simmer' },
			{ id: 'new', title: 'New pressure', logline: 'A new negotiation.', storyThreadId: 'thread_new', lifecycleStage: 'simmer' },
		], activationPlan: { activateNow: ['old', 'new'] },
	});
}

describe('manual plot controls', () => {
	it('deletes or restores a commitment without requiring its possibly-invalid contents', () => {
		for (const kind of ['agreement', 'scheme']) for (const action of ['delete', 'restore']) expect(plotEditSchema.safeParse({ target: 'commitment', kind, action, recordId: 'a', serverVersion: 1 }).success).toBe(true);
		expect(plotEditSchema.safeParse({ target: 'commitment', kind: 'agreement', action: 'purge', recordId: 'a', serverVersion: 1 }).success).toBe(false);
	});
	it('suppresses future Director cards referencing a deleted agreement', () => {
		const source = frame(); source.plotCards[0].sourceRefs = [{ sourceType: 'agreement', sourceId: 'bad-agreement', label: 'Incorrect agreement' }];
		const stored = storedStrategicFrameForStory('story', { deletedCommitments: { 'agreement:bad-agreement': { status: 'active' } }, plotBrain: { lastFrame: source, lastFrameId: source.id } });
		expect(stored?.plotCards.map(card => card.id)).toEqual(['new']);
	});
	it('validates agreement arrays and scheme bounds before canonical writes', () => {
		const agreement = { target: 'agreement', serverVersion: 1, recordId: 'a', terms: 'Pay the captain.', parties: ['Ada', 'Captain'], category: 'debt', status: 'fulfilled', secrecy: 'known', consequences: [] };
		expect(plotEditSchema.safeParse(agreement).success).toBe(true);
		for (const fields of [{ parties: 'Ada' }, { consequences: 'None' }, { status: 'closed' }, { terms: '' }]) expect(plotEditSchema.safeParse({ ...agreement, ...fields }).success).toBe(false);
		const scheme = { target: 'scheme', serverVersion: 1, recordId: 's', goal: 'Reach the harbor.', trigger: '', status: 'resolved', secrecy: 'secret', pressure: 50, currentStageIndex: 0, stages: [{ index: 0, label: 'Land', hook: 'Arrive.', condition: 'time', conditionPayload: { day: 3 }, completed: false, completedAt: null }] };
		expect(plotEditSchema.safeParse(scheme).success).toBe(true);
		for (const fields of [{ pressure: 101 }, { currentStageIndex: -1 }, { stages: [] }, { stages: 'Land' }]) expect(plotEditSchema.safeParse({ ...scheme, ...fields }).success).toBe(false);
	});
	it('validates explicit scope, version, status and nonempty descriptions', () => {
		const edit = { target: 'thread', serverVersion: 3, threadId: 't', description: 'Current pressure.', status: 'closed', significance: 'major' };
		expect(plotEditSchema.safeParse(edit).success).toBe(true);
		for (const change of [{ serverVersion: 0 }, { description: ' ' }, { status: 'invented' }, { threadId: '' }]) expect(plotEditSchema.safeParse({ ...edit, ...change }).success).toBe(false);
		expect(isDeletedThread('[player:deleted] Removed.')).toBe(true);
		expect(isDeletedThread('[player:closed] Done.')).toBe(false);
	});
	it('removes only linked pressure, including activation aliases', () => {
		const source = frame();
		source.activationPlan.activateNow = ['Old pressure', 'new'];
		const result = removeThreadPressure(source, 'story', 'thread_old');
		expect(result.removed.map(card => card.id)).toEqual(['old']);
		const edited = strategicWorldFrameSchema.parse(result.frame);
		expect(edited.plotCards.map(card => card.id)).toEqual(['new']);
		expect(edited.activationPlan.activateNow).toEqual(['new']);
		expect(buildStrategicNarratorBlock(edited as StrategicWorldFrame)).not.toContain('obsolete blockade');
		expect(source.plotCards).toHaveLength(2);
	});
	it('recognizes generated thread IDs and repeated bindings without losing card alignment', () => {
		const source = frame(); source.plotCards[0].storyThreadId = null;
		const id = frameStoryThreadIds('story', source)[0];
		expect(removeThreadPressure(source, 'story', id).removed).toHaveLength(1);
		source.plotCards[0].storyThreadId = 'shared'; source.plotCards[1].storyThreadId = 'shared';
		expect(removeThreadPressure(source, 'story', 'shared').removed).toHaveLength(2);
	});
	it('defensively suppresses manually closed pressure in subsequent frames', () => {
		const stored = storedStrategicFrameForStory('story', { plotBrain: { lastFrame: frame(), lastFrameId: 'frame', closedThreadIds: ['thread_old'] } });
		expect(stored?.plotCards.map(card => card.id)).toEqual(['new']);
		expect(buildStrategicNarratorBlock(stored)).toContain('new negotiation');
		expect(buildStrategicNarratorBlock(stored)).not.toContain('obsolete blockade');
	});
	it('suppresses chapter-closed pressure in applied and pending frames without touching other cards', () => {
		const result = closeThreadPressure({ lastFrame: frame(), pendingFrame: frame(), closedThreadIds: [] }, 'story', ['thread_old']);
		for (const key of ['lastFrame', 'pendingFrame'] as const) {
			const stored = strategicWorldFrameSchema.parse(result[key]);
			expect(stored.plotCards.map(card => card.id)).toEqual(['new']);
			expect(stored.activationPlan.activateNow).toEqual(['new']);
		}
		expect(result.closedThreadIds).toEqual(['thread_old']);
		expect(closeThreadPressure(result, 'story', ['thread_old']).closedThreadIds).toEqual(['thread_old']);
	});
});
