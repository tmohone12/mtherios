import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFollowupPlan, sanitizeChapterMemoryText, sanitizeChapterPromiseLabels } from './repair-veil-live-lore-followup.mjs';

test('sanitizes every stale Chapter 20 deadline label', () => {
	assert.deepEqual(sanitizeChapterPromiseLabels([
		'Morning marriage rite and bow ceremony',
		'Armor polishing before dawn',
		'Morning ceremony preparations',
	]), [
		'Marriage rite and bow ceremony, date not fixed',
		'Armor polishing before ceremony, date not fixed',
		'Ceremony preparations, date not fixed',
	]);
	assert.equal(
		sanitizeChapterMemoryText('Armor polishing before dawn. The order of the morning is undecided.'),
		'Armor polishing before ceremony, date not fixed. the order of the ceremony is undecided.',
	);
});

test('requires v1 and produces a versioned idempotent follow-up plan', () => {
	const snapshot = {
		story: { title: 'Veil', server_version: 1008, metadata: { loreIntegrityRepairs: { veil_lore_integrity_v1: { applied: true } } } },
		chapter: { promises_debts_oaths: ['Morning ceremony preparations'], metadata: {}, server_version: 1008 },
		memory: { content: 'Armor polishing before dawn', summary: 'The order of the morning', metadata: {}, server_version: 1008 },
	};
	const plan = buildFollowupPlan(snapshot, '2026-09-01T00:00:00.000Z');
	assert.equal(plan.alreadyApplied, false);
	assert.equal(plan.newVersion, 1009);
	assert.doesNotMatch(JSON.stringify(plan), /Morning ceremony preparations|Armor polishing before dawn|the order of the morning/i);
	const repeated = buildFollowupPlan({
		...snapshot,
		story: { ...snapshot.story, metadata: { loreIntegrityRepairs: { veil_lore_integrity_v1: { applied: true }, veil_lore_integrity_v2: { applied: true } } } },
	}, '2026-09-01T00:00:00.000Z');
	assert.equal(repeated.alreadyApplied, true);
});
