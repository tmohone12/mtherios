import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '$lib/server/db/client';
import { upsertBackendEntityFromEntry } from '$lib/server/memory/canonical';
import { automaticCharacterUpdate } from '$lib/contracts/automaticCharacterUpdate';
import { applyChapterScribeCharacterContextProposals, reviewPatchProposal } from './canonRepair';

const enabled = process.env.MYTHENGINE_IDENTITY_INTEGRATION === '1';
const integration = enabled ? test : test.skip;
let shelf: string, story: string, otherStory: string, actor: string, source: string;
const origin = { bio: 'Su Lan is a first-rank Yi Tish courtesan from Yin.', nationality: 'Yi Tish', occupation: 'courtesan', appearance: 'Yi Tish physical features.', playerSheet: { hitPoints: { current: 8, max: 8 } }, eventMemory: { did: ['Kept the old oath.'] } };
async function current() { const [row] = await getDb().execute(sql`select * from entities where id=${actor}`); return row; }
async function update(patch: Record<string, unknown>, ids = [source]) {
	const row = await current();
	const result = await upsertBackendEntityFromEntry(story, { id: actor, name: row.name, type: 'character', metadata: { automaticCharacterUpdate: automaticCharacterUpdate({ ...row.state as object, description: row.description }, { ...row.state as object, description: row.description, ...patch }, ids) } });
	if (!('identityReviewProposalId' in result)) throw Error('Expected automatic delta owner');
	return result;
}
async function review(proposalId: string, notes?: string) { return reviewPatchProposal({ storyId: story, proposalId, decision: 'approved', reviewer: 'human', notes }); }
beforeEach(async () => {
	if (!enabled) return;
	const url = new URL(process.env.DATABASE_URL!);
	if (url.hostname !== '127.0.0.1' || !['/mythengine_identity_candidate_20261006','/mythengine_summary_repair_recovery_20261006_aggregate'].includes(url.pathname)) throw Error('Identity fixture database required');
	const suffix = randomUUID(); shelf = `identity_${suffix}`; story = `story_${suffix}`; otherStory = `other_${suffix}`; actor = `entity_${suffix}`; source = `narration_${suffix}`;
	await getDb().execute(sql`insert into shelves(id,name,slug) values(${shelf},'Identity fixture',${shelf})`);
	await getDb().execute(sql`insert into stories(id,shelf_id,title) values(${story},${shelf},'Disposable courtesan story'),(${otherStory},${shelf},'Unrelated campaign')`);
	await getDb().execute(sql`insert into entities(id,story_id,type,name,description,state,metadata,server_version) values(${actor},${story},'character','Su Lan',${origin.bio},${JSON.stringify(origin)}::jsonb,'{"authored":true}'::jsonb,0)`);
	await getDb().execute(sql`insert into story_entries(id,story_id,type,content,position) values(${source},${story},'narration','Su Lan suspects the envoy is accusing her of being a Lengii spy. She tends the injured rider and now wears a blue cloak.',1)`);
});
afterEach(async () => { if (enabled) await getDb().execute(sql`delete from shelves where id=${shelf}`); });
afterAll(async () => { if (enabled) await closeDb(); });

integration('retains authored origin, queues unsupported spy inference, adds scene details and preserves unrelated fields', async () => {
	const result = await update({ bio: 'Su Lan is a Lengii spy.', nationality: 'Lengii', occupation: 'spy', currentAction: 'tending the injured rider', presentation: 'blue cloak' });
	const row = await current();
	expect(row.state).toMatchObject({ ...origin, currentAction: 'tending the injured rider', presentation: 'blue cloak' });
	expect(row.description).toBe(origin.bio);
	const [proposal] = await getDb().execute(sql`select * from patch_proposals where id=${result.identityReviewProposalId}`);
	expect(proposal.status).toBe('needs_review');
	expect((proposal.metadata as any).identityConflicts).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'bio', previous: origin.bio, proposed: 'Su Lan is a Lengii spy.', sources: [] })]));
	await expect(review(String(proposal.id))).rejects.toThrow('retcon:');
	await review(String(proposal.id), 'retcon: I explicitly replace the origin for this disposable fixture.');
	expect((await current()).state).toMatchObject({ nationality: 'Lengii', occupation: 'spy', currentAction: 'tending the injured rider', playerSheet: origin.playerSheet });
	const [saved] = await getDb().execute(sql`select * from patch_proposals where id=${proposal.id}`);
	expect(saved.status).toBe('applied'); expect((saved.metadata as any).reviewNotes).toContain('retcon:');
});

integration('explicit original revelation remains reviewable and can be approved without erasing earlier history', async () => {
	const bio = origin.bio + ' Su Lan learned court music as a child.';
	await getDb().execute(sql`update story_entries set content=${bio} where id=${source}`);
	const result = await update({ bio });
	expect((await current()).state).toMatchObject(origin);
	await review(String(result.identityReviewProposalId), 'Reviewed the actor-specific original passage; retain courtesan origin and add the established music training.');
	expect((await current()).state).toMatchObject({ ...origin, bio, background: bio });
});

integration('description-only changes are reviewable; rumors kept in a knowledge patch cannot rewrite identity', async () => {
	const description = origin.bio + ' Su Lan trained in court music.';
	await getDb().execute(sql`update story_entries set content=${description} where id=${source}`);
	const result = await update({ description });
	expect((await current()).description).toBe(origin.bio);
	await review(String(result.identityReviewProposalId), 'Reviewed original court music passage.');
	expect((await current()).description).toBe(description); expect((await current()).state).toMatchObject(origin);
	await getDb().execute(sql`update story_entries set content='The envoy accuses: Su Lan is a Lengii spy. Su Lan rejects this accusation.' where id=${source}`);
	const rumor = await update({ knownFacts: ['Su Lan is a Lengii spy.'] });
	expect((await current()).state).not.toHaveProperty('knownFacts');
	const [proposal] = await getDb().execute(sql`select metadata from patch_proposals where id=${rumor.identityReviewProposalId}`);
	expect((proposal.metadata as any).identityConflicts[0].sources[0].quote).toContain('accuses');
});

integration('a supported scene recap cannot erase the biography when approved as an addition', async () => {
	const bio = 'Su Lan tends the injured rider.';
	await getDb().execute(sql`update story_entries set content=${bio} where id=${source}`);
	const result = await update({ bio });
	await expect(review(String(result.identityReviewProposalId), 'Approved this new scene detail.')).rejects.toThrow('Preserve the established biography');
	expect((await current()).state).toMatchObject(origin);
	await review(String(result.identityReviewProposalId), 'retcon: I explicitly replace this disposable fixture biography.');
	expect((await current()).state).toMatchObject({ ...origin, bio, background: bio });
});

integration('rejects stale snapshots, evidence loss, wrong story/entity/name and excluded summaries', async () => {
	const row = await current();
	const stale = automaticCharacterUpdate({ ...row.state as object }, { ...row.state as object, currentAction: 'old action' }, [source]);
	await update({ currentAction: 'new action' });
	await expect(upsertBackendEntityFromEntry(story, { id: actor, name: 'Su Lan', type: 'character', metadata: { automaticCharacterUpdate: stale } })).rejects.toThrow('changed');
	await expect(upsertBackendEntityFromEntry(otherStory, { id: actor, name: 'Su Lan', type: 'character', metadata: { automaticCharacterUpdate: stale } })).rejects.toThrow('same story');
	await expect(upsertBackendEntityFromEntry(story, { id: actor, name: 'Namesake', type: 'character', metadata: { automaticCharacterUpdate: stale } })).rejects.toThrow('canonical name');
	const result = await update({ bio: 'Su Lan is a Lengii spy.' });
	await getDb().execute(sql`update story_entries set content='Changed after the proposal.' where id=${source}`);
	await expect(review(String(result.identityReviewProposalId), 'retcon: Reviewed.')).rejects.toThrow('evidence changed');
	await getDb().execute(sql`update story_entries set type='chapter_summary' where id=${source}`);
	await expect(update({ currentAction: 'summary inference' })).rejects.toThrow('not summaries');
	await getDb().execute(sql`delete from story_entries where id=${source}`);
	await expect(review(String(result.identityReviewProposalId), 'retcon: Reviewed.')).rejects.toThrow('evidence changed');
	expect((await current()).state).toMatchObject({ ...origin, currentAction: 'new action' });
});

integration('concurrent deltas cannot overwrite each other; repeated identity and empty outputs do not duplicate proposals', async () => {
	const row = await current(), baseline = row.state as Record<string, unknown>;
	const write = (action: string) => upsertBackendEntityFromEntry(story, { id: actor, name: 'Su Lan', type: 'character', metadata: { automaticCharacterUpdate: automaticCharacterUpdate(baseline, { ...baseline, currentAction: action }, [source]) } });
	const results = await Promise.allSettled([write('one'), write('two')]);
	expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
	expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
	const first = await update({ bio: 'Su Lan is a Lengii spy.' });
	const repeated = await update({ bio: 'Su Lan is a Lengii spy.' });
	expect(repeated.identityReviewProposalId).toBe(first.identityReviewProposalId); expect(repeated.serverVersion).toBe(first.serverVersion);
	const [count] = await getDb().execute(sql`select count(*)::int as count from patch_proposals where story_id=${story}`); expect(count.count).toBe(1);
	await update({}); expect((await current()).server_version).toBe(first.serverVersion);
	await update({ bio: '', appearance: null, nationality: [] }); expect((await current()).state).toMatchObject(origin);
});

integration('chapter auto-apply holds identity, applies event memory, and rejects stale approval and lost sources', async () => {
	const id = `chapter_${randomUUID()}`;
	await getDb().execute(sql`insert into patch_proposals(id,story_id,proposal_type,target_table,target_record_id,proposed_by,operations,source_entry_ids,metadata,status,reason,suggestion) values(${id},${story},'character_context_update','entities',${actor},'chapter_scribe',${JSON.stringify([{ op: 'replace', path: `/characters/${actor}/state`, value: { bio: 'Su Lan is a Lengii spy.', eventMemory: { did: ['Tended the injured rider.'] } } }])}::jsonb,${JSON.stringify([source])}::jsonb,'{"characterUpdateBaseVersion":0,"sourceType":"chapter_character_context"}'::jsonb,'pending','Disposable chapter evidence','Review original evidence')`);
	const result = await applyChapterScribeCharacterContextProposals({ storyId: story, proposalIds: [id] });
	expect(result.appliedCount).toBe(1);
	expect((await current()).state).toMatchObject({ bio: origin.bio, eventMemory: { did: ['Kept the old oath.', 'Tended the injured rider.'] }, playerSheet: origin.playerSheet });
	const [proposal] = await getDb().execute(sql`select * from patch_proposals where id=${id}`); expect(proposal.status).toBe('needs_review');
	await update({ currentAction: 'later action' });
	await expect(review(id, 'retcon: Explicit fixture decision.')).rejects.toThrow('character changed');
	const [calls] = await getDb().execute(sql`select count(*)::int as count from api_call_logs where story_id=${story}`); expect(calls.count).toBe(0);
});
