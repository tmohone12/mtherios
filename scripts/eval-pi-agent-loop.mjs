import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { sql } from 'drizzle-orm';
import { fixture } from '../evals/replay/court-intrigue.mjs';

// Called only by eval-turns after it verifies its own disposable database.
export async function runPiAgentLoop({ root, db, schema, load }) {
  const sourceRoot = await mkdtemp(resolve(root, 'pi-replay-sources-'));
  const previousFetch = globalThis.fetch;
  let installedLegacyRecall = false;
  try {
    const projectId = 'replay_pi_project', storyId = 'replay_pi_agent';
    await db.insert(schema.shelves).values({ id: projectId, name: 'Disposable Pi project', slug: projectId,
      settings: { agentTools: { schemaVersion: 1, revision: 1, overrides: { gmPiRuntime: true } } } });
    await db.insert(schema.llmServiceSettings).values({ serviceId: 'activeRecall', providerType: 'openai',
      baseUrl: 'http://replay.invalid/v1', model: 'replay-pi-forbidden-active-recall', apiKeyRef: 'REPLAY_API_KEY',
      contextBudget: 12000, maxTokens: 900, temperature: 0, enabled: true });
    installedLegacyRecall = true;
    const { getAgentSettings } = await load('engine/agentSettings');
    const piSettings = await getAgentSettings({ projectId });
    assert.equal(piSettings.effective.gmAdaptiveResearch, true, 'Pi fixture did not inherit the saved legacy research opt-in');
    assert.equal(piSettings.sources.gmAdaptiveResearch, 'legacy');
    const data = fixture(storyId);
    data.entities.find(entity => entity.id === data.ids.mara).visibility = 'secret';
    await db.insert(schema.stories).values({ ...data.story, shelfId: projectId });
    await db.insert(schema.entities).values(data.entities);
    const factionStoryId = 'replay_pi_source_scope';
    await db.insert(schema.stories).values({ id: factionStoryId, shelfId: projectId, title: 'Disposable faction visibility catalog' });
    await db.insert(schema.entities).values({ id: 'replay_pi_secret_identity', storyId: factionStoryId, type: 'faction', name: 'Secret identity', visibility: 'secret' });
    await db.insert(schema.factions).values([
      { id: 'replay_pi_public_faction', storyId: factionStoryId, name: 'Public courier guild', metadata: { visibility: 'player_known' } },
      { id: 'replay_pi_private_faction', storyId: factionStoryId, name: 'PRIVATE_FACTION_SENTINEL', metadata: {} },
      { id: 'replay_pi_secret_link', storyId: factionStoryId, name: 'SECRET_LINK_SENTINEL', entityId: 'replay_pi_secret_identity', metadata: { visibility: 'player_known' } },
    ]);
    await db.insert(schema.storyEntries).values(data.entries);
    await db.insert(schema.storyEvents).values(data.events);
    const sources = await load('engine/sourceFiles');
    await writeFile(resolve(sourceRoot, 'city-rule.md'), '# Current city rule\nA sealed letter may be delivered unopened.\n');
    const { mount } = await sources.saveSourceMount({ projectId, expectedRevision: 0, name: 'Synthetic city rules', path: sourceRoot, roles: ['gm'] });
    const mountedRef = `mount:${mount.id}:city-rule.md`;
    const typeId = 'replay_pi_notes';
    await db.insert(schema.contentTypes).values({ id: typeId, projectId, key: 'replay_notes', extension: 'md', name: 'Replay notes',
      definition: { fields: { notes: { kind: 'longtext' } }, defaults: { notes: '' }, layout: [], gmContextMode: 'searchable' } });
    const contentBase = { projectId, gameId: storyId, typeId, visibility: 'public', gmContextMode: 'searchable' };
    await db.insert(schema.contentItems).values([
      { ...contentBase, id: 'replay_pi_promise', title: 'Courier promise', folder: 'History', slug: 'promise', data: { notes: `Mara promised to deliver the sealed letter unopened. Verify the current rule in ${mountedRef}.` } },
      { ...contentBase, id: 'replay_pi_branch', title: 'UNSEEN_BRANCH_SENTINEL', folder: 'Forbidden', slug: 'other-branch', branchId: 'other-branch', data: { notes: 'UNSEEN_BRANCH_SENTINEL' } },
      { ...contentBase, id: 'replay_pi_pov', title: 'UNSEEN_POV_SENTINEL', folder: 'Forbidden', slug: 'other-pov', povCharacter: 'another player', data: { notes: 'UNSEEN_POV_SENTINEL' } },
      { ...contentBase, id: 'replay_pi_gm', title: 'PRIVATE_DOC_SENTINEL', folder: 'Private', slug: 'private', visibility: 'gm', data: { notes: 'PRIVATE_DOC_SENTINEL' } },
    ]);
    const authority = { role: 'gm', projectId, gameId: storyId };
    const rootListing = await sources.listSourceFiles(authority, { sourceKind: 'content' });
    assert(rootListing.items.some(item => item.kind === 'directory' && item.path === 'History'), 'Content tree CTE did not produce the immediate child folder');
    assert(!JSON.stringify(rootListing).includes('Forbidden'), 'Branch/POV names escaped the filtered catalog');
    const nested = await sources.listSourceFiles(authority, { sourceKind: 'content', path: 'History' });
    assert(nested.items.some(item => item.sourceRef === 'content:replay_pi_promise'), 'Nested folder CTE lost its source');
    const promise = await sources.readSourceFile(authority, { sourceRef: 'content:replay_pi_promise' });
    assert(promise.text.includes(mountedRef) && /^[a-f0-9]{64}$/.test(promise.sha256), 'Canonical content reader lost text or hash');
    const found = await sources.searchSourceFiles(authority, { sourceKind: 'content', query: 'deliver' });
    assert(found.items.some(item => item.sourceRef === promise.sourceRef && item.sha256 === promise.sha256), 'Logical search and read disagree on source hash');
    const research = { ...authority, role: 'research' };
    assert(!JSON.stringify(await sources.listSourceFiles(research, { sourceKind: 'content' })).includes('Private'), 'Research listed a GM folder');
    assert.deepEqual((await sources.listSourceFiles(research, { sourceKind: 'mounts' })).items, [], 'Research listed a GM-only mount');
    await assert.rejects(sources.readSourceFile(research, { sourceRef: mountedRef }), error => error.code === 'SCOPE_DENIED');
    const canonical = await sources.searchSourceFiles(authority, { sourceKind: 'canonical', query: 'Mara' });
    assert(canonical.items.some(item => item.sourceRef === `canonical:characters:${data.ids.mara}`), 'Canonical catalog joins did not find the scoped character');
    const character = await sources.readSourceFile(authority, { sourceRef: `canonical:characters:${data.ids.mara}` });
    assert(character.text.includes('Mara') && character.visibility === 'secret', 'Canonical reader lost its record or visibility');
    await assert.rejects(sources.readSourceFile(research, { sourceRef: character.sourceRef }), error => error.code === 'SCOPE_DENIED');
    const factionResearch = { ...research, gameId: factionStoryId };
    const canonicalTree = await sources.listSourceFiles(factionResearch, { sourceKind: 'canonical' });
    assert(canonicalTree.items.some(item => item.sourceRef === 'canonical:factions:replay_pi_public_faction'), 'Canonical CTE did not expose an explicitly visible faction');
    assert(!JSON.stringify(canonicalTree).includes('PRIVATE_FACTION_SENTINEL') && !JSON.stringify(canonicalTree).includes('SECRET_LINK_SENTINEL'), 'Faction visibility or linked entity guard failed before listing');
    assert.equal((await sources.readSourceFile(factionResearch, { sourceRef: 'canonical:factions:replay_pi_public_faction' })).visibility, 'player_known');
    await assert.rejects(sources.readSourceFile(factionResearch, { sourceRef: 'canonical:factions:replay_pi_secret_link' }), error => error.code === 'SCOPE_DENIED');
    const mountedListing = await sources.listSourceFiles(authority, { sourceKind: 'mounted', mountId: mount.id });
    assert(mountedListing.items.some(item => item.sourceRef === mountedRef), 'Persisted mount grant did not reach the bounded file listing');
    const mountedSearch = await sources.searchSourceFiles(authority, { sourceKind: 'mounted', mountId: mount.id, query: 'unopened' });
    assert(mountedSearch.items.some(item => item.sourceRef === mountedRef && item.startLine === 2), 'Mounted search lost its actual line range');

    const requests = [], resultsById = new Map();
    const decisions = [
      { id: 'list_root', name: 'list', args: { kind: 'source', sourceKind: 'content' } },
      { id: 'list_history', name: 'list', args: { kind: 'source', sourceKind: 'content', path: 'History' } },
      { id: 'read_promise', name: 'read', args: { kind: 'source', sourceRef: promise.sourceRef } },
      { id: 'read_rule', name: 'read', args: { kind: 'source', sourceRef: mountedRef } },
    ];
    let investigationRequests = 0;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      assert.equal(url, 'http://replay.invalid/v1/chat/completions', 'Pi replay attempted an external provider');
      const body = JSON.parse(init.body);
      assert(['replay-narrative', 'replay-classifier'].includes(body.model), 'Pi replay used an unexpected provider model');
      requests.push(body);
      let message = { role: 'assistant', content: body.response_format ? JSON.stringify(data.extraction) : data.narration };
      if (body.tools?.length) {
        for (const entry of body.messages) if (entry.role === 'tool') resultsById.set(entry.tool_call_id, entry.content);
        const index = investigationRequests++;
        if (index === 1) assert(resultsById.get('list_root')?.includes('History'), 'Second lookup did not receive the first native result');
        if (index === 2) assert(resultsById.get('list_history')?.includes(promise.sourceRef), 'Read did not receive the discovered document reference');
        if (index === 3) assert(resultsById.get('read_promise')?.includes(mountedRef), 'Mounted read did not receive its reference from the document');
        if (index === 4) assert(resultsById.get('read_rule')?.includes('A sealed letter may be delivered unopened'), 'Final decision lost the fourth native tool result');
        assert(index <= decisions.length, 'Pi replay exceeded its bounded investigation');
        const decision = decisions[index];
        message = decision ? { role: 'assistant', content: '', tool_calls: [{ id: decision.id, type: 'function', function: { name: decision.name, arguments: JSON.stringify(decision.args) } }] }
          : { role: 'assistant', content: 'The promise is verified. Continue the public scene.' };
      }
      return Response.json({ id: `pi_fake_${requests.length}`, model: body.model, choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
    };
    const { startAgentRun } = await load('engine/agentRuns');
    const turn = { storyId, clientTurnId: 'pi_native_turn', playerText: 'Find the courier promise and verify its current rule before I hand Mara the sealed letter.', actionType: 'do', localVersion: 0,
      clientContext: { deferStateExtraction: false, contextBudget: 12000, chapterThreshold: 200, postChapterBuffer: 100 } };
    const completed = await startAgentRun({ turn }, storyId);
    const [run] = await db.execute(sql`select * from agent_runs where id=${completed.id}`);
    assert.equal(completed.status, 'completed', `Pi run failed: ${completed.error}; receipts=${JSON.stringify(run.continuation.receipts.map(receipt => ({ stage: receipt.stage, model: receipt.model, index: receipt.index, status: receipt.status })))}; requests=${JSON.stringify(requests.map(request => ({ model: request.model, native: Boolean(request.tools?.length), classifier: Boolean(request.response_format) })))}`);
    assert.equal(investigationRequests, 5, 'Pi did not perform all four dependent lookups');
    assert.equal(run.continuation.runtime, 'pi-v1');
    assert.equal(run.continuation.state.budget.toolCalls, 4);
    assert.equal(run.continuation.state.messages.filter(message => message.role === 'tool').length, 4);
    const calls = await db.execute(sql`select * from agent_tool_calls where run_id=${completed.id}`);
    assert.equal(calls.filter(call => call.status === 'completed').length, 4, 'Source receipts did not persist');
    const mountedReceipt = calls.find(call => call.call_id === 'read_rule').result;
    const promiseReceipt = calls.find(call => call.call_id === 'read_promise').result;
    const viewed = await sources.readRunSourceFile({ projectId, gameId: storyId, runId: completed.id, sourceRef: promise.sourceRef, expectedHash: promiseReceipt.sha256, expectedRevision: promiseReceipt.revision });
    assert.equal(viewed.text, promiseReceipt.text, 'Viewer did not reproduce its authorized observed range');
    await assert.rejects(sources.readRunSourceFile({ projectId, gameId: storyId, runId: completed.id, sourceRef: mountedRef }), error => error.code === 'SCOPE_DENIED');
    await assert.rejects(sources.readRunSourceFile({ projectId, gameId: storyId, runId: completed.id, sourceRef: character.sourceRef }), error => error.code === 'SCOPE_DENIED');
    const before = requests.length;
    assert.equal((await startAgentRun({ turn }, storyId)).id, completed.id, 'Duplicate client turn produced another run');
    assert.equal(requests.length, before, 'Duplicate completed run dispatched a provider request');
    const narrator = requests.filter(request => request.model === 'replay-narrative' && !request.tools?.length);
    assert.equal(narrator.length, 1, 'Final narration should have exactly one provider request');
    assert(!requests.some(request => request.model === 'replay-pi-forbidden-active-recall'), 'Pi dispatched the saved legacy Active Recall profile');
    assert(!requests.some(request => request.messages.some(message => String(message.content).includes('bounded, read-only recall planner'))), 'Pi repeated the direct adaptive recall scheduler');
    assert(!JSON.stringify(narrator).includes('A sealed letter may be delivered unopened'), 'GM-only mounted text escaped into the public narrator context');
    const [count] = await db.execute(sql`select count(*)::int as count from story_entries where story_id=${storyId} and metadata->>'clientTurnId'=${turn.clientTurnId} and type='narration'`);
    assert.equal(count.count, 1, 'Canonical admission duplicated the narration');
    console.log('PASS pi-agent-loop-001: real SQL source tree/search/read, four dependent native lookups, durable receipts, guarded viewer and one canonical turn');
    return { id: 'pi-agent-loop-001', passed: true, runtime: run.continuation.runtime, toolCalls: calls.length,
      modelRequests: run.continuation.state.budget.modelRequests, nativeResults: resultsById.size, narrationEntries: count.count,
      legacyActiveRecallRequests: 0, sourceHash: mountedReceipt.sha256, sourceRange: [mountedReceipt.startLine, mountedReceipt.endLine] };
  } finally {
    globalThis.fetch = previousFetch;
    if (installedLegacyRecall) await db.execute(sql`delete from llm_service_settings where service_id='activeRecall' and model='replay-pi-forbidden-active-recall'`);
    const checked = resolve(sourceRoot);
    assert(checked.startsWith(`${resolve(root)}${sep}`) && basename(checked).startsWith('pi-replay-sources-'), 'Refusing cleanup outside the owned fixture folder');
    await rm(checked, { recursive: true, force: true });
  }
}
