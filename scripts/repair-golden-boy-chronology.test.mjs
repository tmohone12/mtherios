import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPlan } from './repair-golden-boy-chronology.mjs';

// This one-off repair is checked against its archived, immutable input; it
// never connects to the database or applies writes during verification.
test('restored chronology repair preserves source transcript and current actors', async () => {
	const snapshot = JSON.parse(await readFile(new URL('../data/repairs/golden_boy_restored_chronology_20260919-v3234.json', import.meta.url), 'utf8'));
	const before = JSON.stringify(snapshot);
	const plan = buildPlan(snapshot);
	assert.equal(JSON.stringify(snapshot), before);
	assert.equal(plan.removed.story_entries.size, 0);
	const sources = new Set(snapshot.story_entries.map(e => e.id));
	for (const chapter of snapshot.chapters) {
		assert.equal(plan.removed.chapters.has(chapter.id), chapter.source_entry_ids.some(id => !sources.has(id)));
	}
	for (const name of ['Aer', 'Gaelyx']) {
		const entity = snapshot.entities.find(e => e.name === name);
		assert(plan.removed.entities.has(entity.id), `${name} is from the discarded future`);
	}
	for (const name of ['Aurion Balaerys', 'Vermillion Zhen Lian', 'Balaerys Heir']) {
		assert(snapshot.entities.some(e => e.name === name && !plan.removed.entities.has(e.id)), `Preserve ${name}`);
	}
	assert.equal(plan.counts.chapters, 56);
	assert.equal(plan.counts.story_events, 1577);
	assert.equal(plan.transcriptHash, '928e542323d9d5723da062b9ffbf43bc329bbe213e5adad86be3e7041e87a28e');
});
