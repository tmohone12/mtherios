// Source-guarded adoption of existing Veil lore. No new setting claims or entity merges.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { databaseUrl } from './db-env.mjs';

const storyId = 'story_52d7c651-0b16-4b91-890d-e7f226f7926b';
const cityId = 'veil_scratch_asoiaf_entity_asoiaf_volantis_0189';
const manseId = 'entity_cd230b5e-9c11-4c86-aa0c-064e9088b850';
const baseUrl = process.env.LOCATION_LORE_BASE_URL ?? 'http://127.0.0.1:5174';
const baseline = JSON.parse(fs.readFileSync('docs/evidence/location-lore-pilot-prewrite-2026-09-07.json', 'utf8'));
const receiptFile = 'docs/evidence/location-lore-pilot-adoption-2026-09-07.json';
const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : { storyId, baselineVersion: baseline.story.server_version, applied: [] };
const apply = process.argv.includes('--apply');
const sql = postgres(databaseUrl(), { max: 1, prepare: false });
const command = async (command, args) => {
	const response = await fetch(`${baseUrl}/api/engine/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storyId, command, args }) });
	const body = await response.json();
	assert.equal(body.status, 'succeeded', body.error ?? 'Engine command failed');
	return body.result;
};
const log = (operation, result) => {
	receipt.applied.push({ operation, ...result, recordedAt: new Date().toISOString() });
	fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
};
const save = async (locationId, change, operation) => {
	if (receipt.applied.some(item => item.operation === operation)) return;
	const current = await command('world.location.get', { locationId });
	const result = await command('world.location.save', { locationId, expectedVersion: current.storyVersion, ...change });
	log(operation, result);
};
try {
	const [city] = await sql`select id,description,state from entities where story_id=${storyId} and id=${cityId}`;
	assert.equal(city.description, baseline.places.find(place => place.id === cityId).description, 'City overview changed since audit; revalidate the pilot.');
	const [latest] = await sql`select id,position from story_entries where story_id=${storyId} order by position desc limit 1`;
	assert.equal(latest.id, 'narration_711e2d27-46d7-4d88-a739-987b38433d5c', 'The transcript advanced; revalidate scene scope.');
	const parentEdits = [
		[manseId, cityId, 'site'],
		['entity_aeaa7184-68ce-4d21-89cd-854a2cf9db2b', manseId, 'site'],
		['entity_b815d12f-b8b7-4f31-bebf-5c3d452eea3f', manseId, 'room'],
	];
	const places = await sql`select id,name,description,source_entry_ids from entities where story_id=${storyId} and id in ${sql(parentEdits.map(row => row[0]))}`;
	assert.equal(places.length, 3);
	for (const place of places) assert.ok(place.source_entry_ids.length, `Missing source evidence for ${place.id}`);
	const categories = ['identity', 'geography', 'identity', 'history', 'economy', 'economy', 'custom', 'custom'];
	const paragraphs = city.description.split(/\n\s*\n/);
	const section = heading => { const index = paragraphs.indexOf(heading); assert.ok(index >= 0, `Missing section ${heading}`); return paragraphs[index + 1]; };
	const operationalLore = [
		['Volantis: established government', 'governance', 'campaign', 'core', section('Volantis in Veil — current government')],
		['Volantis: daily life and commerce', 'economy', 'foundation', 'core', section('The city in daily life')],
		['Volantis: Black Walls and Old Blood', 'custom', 'foundation', 'core', section('The Black Walls and the Old Blood')],
		['Volantis: labor, religion and the streets', 'religion', 'foundation', 'situational', section('Slavery, faith, and the streets')],
	];
	console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', storyId, parentEdits, legacyFacts: 8, operationalLore: operationalLore.map(row => row[0]), previouslyApplied: receipt.applied.length }));
	if (!apply) process.exitCode = 0;
	else {
		await save(cityId, { locationKind: 'city', reason: 'Location-lore pilot: classify the existing canonical Volantis city.' }, 'classify-city');
		for (const [locationId, parentLocationId, locationKind] of parentEdits) {
			const place = places.find(place => place.id === locationId);
			await save(locationId, { parentLocationId, locationKind,
				reason: `Source-backed physical containment from existing location ${locationId}; entries ${place.source_entry_ids.join(', ')}. Volantis is the nearest established containing entity where the district identity remains unresolved.` }, `parent:${locationId}`);
		}
		for (let index = 0; index < 8; index++) {
			const original = baseline.facts.find(fact => fact.id === `veil_scratch_asoiaf_fact_awoiaf_volantis_0${index + 1}`);
			assert.ok(original);
			await save(cityId, { lore: { id: original.id, title: original.title, statement: original.statement, validFromTurn: 0,
				locationLore: { version: 1, category: categories[index], scope: 'descendants', origin: 'foundation', salience: 'situational', exceptionToFactIds: [] } },
				reason: `Assign inherited scope to existing setting fact ${original.id}; retain the original statement, legacy type and import provenance.` }, `scope:${original.id}`);
		}
		const current = await command('world.location.get', { locationId: cityId });
		for (const [title, category, origin, salience, statement] of operationalLore) {
			assert.ok(city.description.includes(statement));
			if (current.ownFacts.some(fact => fact.title === title && fact.status === 'active') && !receipt.applied.some(item => item.operation === `overview:${title}`)) throw new Error(`An existing rule already uses ${title}; inspect before adding.`);
			await save(cityId, { lore: { title, statement, validFromTurn: baseline.story.current_turn,
				locationLore: { version: 1, category, scope: 'descendants', origin, salience, exceptionToFactIds: [] } },
				reason: `Adopt this unchanged paragraph from canonical entities/${cityId}, description section ${title}. Source overview and references are preserved in docs/evidence/location-lore-pilot-prewrite-2026-09-07.json. The structured validity begins at adoption because the earlier effective campaign turn is not independently established.` }, `overview:${title}`);
		}
		const after = await command('world.location.get', { locationId: cityId });
		receipt.finalVersion = after.storyVersion;
		receipt.currentLoreCount = after.context.facts.length;
		receipt.childIds = after.children.map(child => child.id);
		fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
		console.log(JSON.stringify({ version: after.storyVersion, currentLoreCount: after.context.facts.length, appliedOperations: receipt.applied.length }));
	}
} finally { await sql.end({ timeout: 1 }); }
