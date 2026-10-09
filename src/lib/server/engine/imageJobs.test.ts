import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), settings: vi.fn(), service: vi.fn(), find: vi.fn(), store: vi.fn(), generate: vi.fn(), select: vi.fn(), record: vi.fn(), recordManual: vi.fn(), patch: vi.fn(), scene: vi.fn(),
}));
vi.mock('$lib/server/db/client', () => ({ getDb: () => ({ execute: mocks.execute }) }));
vi.mock('./agentSettings', () => ({ getAgentSettings: mocks.settings }));
vi.mock('./llmSettings', () => ({ resolveServiceGeneration: mocks.service }));
vi.mock('./imageAssets', () => ({ findImageAssetForJob: mocks.find, storeImageAsset: mocks.store, selectContentCover: mocks.select }));
vi.mock('./imageProvider', () => ({ generateOpenAiImage: mocks.generate }));
vi.mock('./storyImageCards', () => ({ recordStoryImageCard: mocks.record, recordManualStoryImageCard: mocks.recordManual }));
vi.mock('./worldRecords', () => ({ patchWorldRecord: mocks.patch }));
vi.mock('./sceneImagePrompt', async importOriginal => ({ ...await importOriginal<typeof import('./sceneImagePrompt')>(), generateSceneImagePrompt: mocks.scene }));

import { processImageJob, completeDirectImageRequest } from './imageJobs';
import { MutationError } from './mutationSafety';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue([]);
  mocks.settings.mockResolvedValue({ effective: { gmImages: true, assistantImages: true, automaticCovers: false } });
  mocks.service.mockResolvedValue({ profile: { providerType: 'openai', apiKey: 'fixture-key' }, setting: { model: 'gpt-image-1' } });
  mocks.find.mockResolvedValue(null);
  mocks.generate.mockResolvedValue({ bytes: Buffer.from('image'), usage: { total_tokens: 7 } });
  mocks.store.mockImplementation(async (input: { visibility: 'public' | 'gm' }) => ({ id: 'asset_1', visibility: input.visibility }));
});

test('direct API request waits for the provider and returns the completed asset', async () => {
  mocks.execute.mockResolvedValueOnce([{ project_id: 'project_1', story_id: 'game_1', status: 'running',
    payload: { kind: 'gm_chat', execution: 'api', prompt: 'The gate' }, metadata: {} }]).mockResolvedValue([]);
  const result = await completeDirectImageRequest({ jobId: 'direct_image', isNew: true });
  expect(result).toMatchObject({ status: 'complete', imageResult: { assetId: 'asset_1', url: '/api/assets/asset_1?projectId=project_1&gameId=game_1' } });
  expect(mocks.generate).toHaveBeenCalledOnce();
  expect(mocks.execute.mock.invocationCallOrder.at(-1)).toBeGreaterThan(mocks.store.mock.invocationCallOrder[0]);
});

test('duplicate direct requests reuse completion and never call the provider while pending or failed', async () => {
  const imageResult = { assetId: 'saved_asset', url: '/api/assets/saved_asset' };
  mocks.execute.mockResolvedValueOnce([{ status: 'complete', metadata: { imageResult } }]);
  expect(await completeDirectImageRequest({ jobId: 'direct_image', isNew: false })).toMatchObject({ status: 'complete', imageResult });
  mocks.execute.mockResolvedValueOnce([{ status: 'running' }]);
  await expect(completeDirectImageRequest({ jobId: 'direct_image', isNew: false })).rejects.toMatchObject({ code: 'IMAGE_PENDING' });
  mocks.execute.mockResolvedValueOnce([{ status: 'failed', last_error: 'Provider timeout' }]);
  await expect(completeDirectImageRequest({ jobId: 'direct_image', isNew: false })).rejects.toThrow('Provider timeout');
  expect(mocks.generate).not.toHaveBeenCalled();
});

test('direct image provider failures are returned to the API and recorded without requeueing', async () => {
  mocks.execute.mockResolvedValueOnce([{ project_id: 'project_1', story_id: 'game_1', status: 'running',
    payload: { kind: 'gm_chat', execution: 'api', prompt: 'The gate' }, metadata: {} }]).mockResolvedValue([]);
  mocks.generate.mockRejectedValueOnce(new Error('Image provider returned HTTP 402.'));
  await expect(completeDirectImageRequest({ jobId: 'direct_image', isNew: true })).rejects.toThrow('HTTP 402');
  expect(mocks.store).not.toHaveBeenCalled();
  expect(mocks.execute.mock.calls.at(-1)?.[0].queryChunks.flatMap((chunk: { value?: unknown[] }) => chunk.value ?? []).join('')).toContain("status='failed'");
});

test('scene job sends and persists the agent prompt before calling the image provider', async () => {
  mocks.execute.mockResolvedValue([{ id: 'turn_1' }]);
  mocks.scene.mockResolvedValue({ prompt: 'Everyone beneath the lanterns, including the copper dragon.', participantIds: ['dragon'], model: 'scene-model', usage: { totalTokens: 100 } });
  const payload = { kind: 'manual_scene', prompt: 'Awaiting prompt', sceneStyle: 'Watercolor',
    sceneContext: { narration: 'Ember lands beside the gate.', location: null, characters: [{ id: 'dragon', name: 'Ember', state: { bio: 'Copper dragon' } }] },
    browserOrigin: { clientTurnId: 'turn_1', callId: 'call_1' } };
  await processImageJob({ id: 'scene_job', projectId: 'project_1', storyId: 'game_1', payload });
  expect(mocks.scene).toHaveBeenCalledWith(expect.objectContaining({ narration: payload.sceneContext.narration }), 'Watercolor');
  expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Everyone beneath the lanterns, including the copper dragon.' }));
  expect(mocks.execute.mock.invocationCallOrder[1]).toBeLessThan(mocks.generate.mock.invocationCallOrder[0]);
  mocks.scene.mockClear();
  await processImageJob({ id: 'scene_job', projectId: 'project_1', storyId: 'game_1', payload: { ...payload, scenePromptPrepared: true, prompt: 'Saved compiled scene' } });
  expect(mocks.scene).not.toHaveBeenCalled();
});

test('invalid scene-agent output fails before image-provider spend', async () => {
  mocks.execute.mockResolvedValue([{ id: 'turn_1' }]);
  mocks.scene.mockRejectedValueOnce(new Error('Scene image agent omitted a participant acting in the saved scene.'));
  await expect(processImageJob({ id: 'bad_scene_job', projectId: 'project_1', storyId: 'game_1', payload: {
    kind: 'manual_scene', prompt: 'Awaiting prompt', sceneContext: { narration: 'Ember lands.', location: null, characters: [] },
    browserOrigin: { clientTurnId: 'turn_1', callId: 'call_1' },
  } })).rejects.toThrow('omitted');
  expect(mocks.generate).not.toHaveBeenCalled();
});

test('a player-requested GM chat image is public and returns a scoped render URL', async () => {
  const result = await processImageJob({ id: 'job_1', projectId: 'project_1', storyId: 'game_1', payload: { kind: 'gm_chat', prompt: 'The castle', styleRevision: 0, model: 'gpt-image-1', origin: { role: 'gm', runId: 'run_1', callId: 'call_1' } } });
  expect(mocks.store).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project_1', gameId: 'game_1', visibility: 'public', originJobId: 'job_1' }));
  expect(result).toMatchObject({ assetId: 'asset_1', url: '/api/assets/asset_1?projectId=project_1&gameId=game_1' });
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ gameId: 'game_1', assetId: 'asset_1', tool: 'generateImage' }));
});

test('Assistant chat images stay private without an author preview route', async () => {
  const result = await processImageJob({ id: 'job_2', projectId: 'project_1', storyId: null, payload: { kind: 'assistant_chat', prompt: 'A private design', styleRevision: 0, model: 'gpt-image-1', origin: { role: 'assistant', runId: 'run_2', callId: 'call_2', conversationId: 'conversation_1' } } });
  expect(mocks.store).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project_1', visibility: 'gm', originJobId: 'job_2' }));
  expect(result).not.toHaveProperty('url');
  expect(mocks.record).not.toHaveBeenCalled();
});

test('NanoGPT jobs pass the configured spend cap to the provider', async () => {
  const priorImageCostCap = process.env.MYTHENGINE_IMAGE_MAX_COST_USD;
  process.env.MYTHENGINE_IMAGE_MAX_COST_USD = '0.05';
  try {
    mocks.service.mockResolvedValue({ profile: { providerType: 'nanogpt', apiKey: 'fixture-key', baseUrl: 'https://nano-gpt.com/api/v1' }, setting: { model: 'z-image-base' } });
    await processImageJob({ id: 'job_3', projectId: 'project_1', storyId: null, payload: { kind: 'assistant_chat', prompt: 'A private design', styleRevision: 0, model: 'z-image-base' } });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ provider: 'nanogpt', maxCostUsd: 0.05, model: 'z-image-base' }));
  } finally {
    if (priorImageCostCap === undefined) delete process.env.MYTHENGINE_IMAGE_MAX_COST_USD;
    else process.env.MYTHENGINE_IMAGE_MAX_COST_USD = priorImageCostCap;
  }
});

test('provider failure leaves an automatic cover unchanged and stores no asset', async () => {
  mocks.settings.mockResolvedValue({ effective: { gmImages: false, assistantImages: false, automaticCovers: true } });
  mocks.execute.mockResolvedValueOnce([{ visibility: 'public', cover_revision: 0 }]);
  mocks.generate.mockRejectedValueOnce(new Error('Image provider returned HTTP 402.'));
  await expect(processImageJob({ id: 'job_failed_cover', projectId: 'project_1', storyId: null, payload: {
    kind: 'automatic_cover', itemId: 'item_1', expectedCoverRevision: 0, prompt: 'A lighthouse', model: 'gpt-image-1',
  } })).rejects.toThrow('HTTP 402');
  expect(mocks.store).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
});

test('a concurrent cover edit leaves the generated asset unattached', async () => {
  mocks.settings.mockResolvedValue({ effective: { gmImages: false, assistantImages: false, automaticCovers: true } });
  mocks.execute.mockResolvedValueOnce([{ visibility: 'public', cover_revision: 0 }]);
  mocks.select.mockRejectedValueOnce(new MutationError('REVISION_CONFLICT', 'The cover changed.'));
  const result = await processImageJob({ id: 'job_late_cover', projectId: 'project_1', storyId: null, payload: {
    kind: 'automatic_cover', itemId: 'item_1', expectedCoverRevision: 0, prompt: 'A lighthouse', model: 'gpt-image-1',
  } });
  expect(mocks.store).toHaveBeenCalledWith(expect.objectContaining({ originJobId: 'job_late_cover' }));
  expect(result).toMatchObject({ assetId: 'asset_1', applied: false, reason: 'cover_changed' });
});

test('replaying a cover job after attachment reuses its asset and does not select twice', async () => {
  mocks.settings.mockResolvedValue({ effective: { gmImages: false, assistantImages: false, automaticCovers: true } });
  mocks.find.mockResolvedValue({ id: 'asset_1', visibility: 'public' });
  mocks.execute.mockResolvedValueOnce([{ visibility: 'public', cover_revision: 1, cover_asset_id: 'asset_1' }]);
  const result = await processImageJob({ id: 'job_replayed_cover', projectId: 'project_1', storyId: null, payload: {
    kind: 'automatic_cover', itemId: 'item_1', expectedCoverRevision: 0, prompt: 'A lighthouse', model: 'gpt-image-1',
  } });
  expect(result).toMatchObject({ assetId: 'asset_1', applied: true });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.store).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
});

test('replaying a cover job does not overwrite a later different cover', async () => {
  mocks.settings.mockResolvedValue({ effective: { gmImages: false, assistantImages: false, automaticCovers: true } });
  mocks.find.mockResolvedValue({ id: 'asset_1', visibility: 'public' });
  mocks.execute.mockResolvedValueOnce([{ visibility: 'public', cover_revision: 2, cover_asset_id: 'asset_2' }]);
  const result = await processImageJob({ id: 'job_old_cover', projectId: 'project_1', storyId: null, payload: {
    kind: 'automatic_cover', itemId: 'item_1', expectedCoverRevision: 0, prompt: 'A lighthouse', model: 'gpt-image-1',
  } });
  expect(result).toEqual({ applied: false, reason: 'cover_changed' });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
});

test('manual scene jobs never spend after their originating turn is removed', async () => {
  const result = await processImageJob({ id: 'job_4', projectId: 'project_1', storyId: 'game_1', payload: {
    kind: 'manual_scene', prompt: 'A vanished turn', browserOrigin: { clientTurnId: 'turn_1', callId: 'manual_1' },
  } });
  expect(result).toEqual({ applied: false, reason: 'turn_unavailable' });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.store).not.toHaveBeenCalled();
});

test('manual scene jobs save a public card on the originating turn', async () => {
  mocks.execute.mockResolvedValueOnce([{ id: 'turn_1' }]).mockResolvedValue([]);
  await processImageJob({ id: 'job_5', projectId: 'project_1', storyId: 'game_1', payload: {
    kind: 'manual_scene', prompt: 'The castle', browserOrigin: { clientTurnId: 'turn_1', callId: 'manual_2' },
  } });
  expect(mocks.store).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'public', originJobId: 'job_5' }));
  expect(mocks.recordManual).toHaveBeenCalledWith(expect.objectContaining({ clientTurnId: 'turn_1', callId: 'manual_2', assetId: 'asset_1' }));
});

test('portrait jobs reject a changed character before provider spend', async () => {
  mocks.execute.mockResolvedValueOnce([{ server_version: 8, visibility: 'public' }]);
  await expect(processImageJob({ id: 'job_portrait_stale', projectId: 'project_1', storyId: 'game_1', payload: {
    kind: 'character_portrait', prompt: 'Saved portrait', characterId: 'character_1', expectedEntityVersion: 7,
  } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.store).not.toHaveBeenCalled();
});

test('portrait completion patches canonical state at the captured revision', async () => {
  mocks.execute.mockResolvedValueOnce([{ server_version: 7, visibility: 'player_known' }]).mockResolvedValue([]);
  const result = await processImageJob({ id: 'job_portrait', projectId: 'project_1', storyId: 'game_1', payload: {
    kind: 'character_portrait', prompt: 'Saved portrait', characterId: 'character_1', expectedEntityVersion: 7,
  } });
  const url = '/api/assets/asset_1?projectId=project_1&gameId=game_1';
  expect(mocks.store).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'public', originJobId: 'job_portrait' }));
  expect(mocks.patch).toHaveBeenCalledWith('game_1', 'characters', 'character_1',
    expect.objectContaining({ updates: { state: { portrait: url } }, expectedVersion: 7 }),
    expect.objectContaining({ role: 'client' }));
  expect(result).toMatchObject({ assetId: 'asset_1', applied: true, url });
});

test('a late portrait asset cannot overwrite a newer character edit', async () => {
  mocks.execute.mockResolvedValueOnce([{ server_version: 7, visibility: 'public' }]).mockResolvedValue([]);
  mocks.patch.mockRejectedValueOnce(new MutationError('REVISION_CONFLICT', 'The character changed.'));
  const result = await processImageJob({ id: 'job_portrait_late', projectId: 'project_1', storyId: 'game_1', payload: {
    kind: 'character_portrait', prompt: 'Saved portrait', characterId: 'character_1', expectedEntityVersion: 7,
  } });
  expect(result).toMatchObject({ assetId: 'asset_1', applied: false, reason: 'character_changed' });
});

test('replaying an applied portrait job does not patch or generate twice', async () => {
  mocks.find.mockResolvedValue({ id: 'asset_1', visibility: 'public' });
  const url = '/api/assets/asset_1?projectId=project_1&gameId=game_1';
  mocks.execute.mockResolvedValueOnce([{ server_version: 8, visibility: 'public', state: { portrait: url } }]);
  const result = await processImageJob({ id: 'job_replayed_portrait', projectId: 'project_1', storyId: 'game_1', payload: {
    kind: 'character_portrait', prompt: 'Saved portrait', characterId: 'character_1', expectedEntityVersion: 7,
  } });
  expect(result).toMatchObject({ assetId: 'asset_1', applied: true, url });
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.store).not.toHaveBeenCalled();
  expect(mocks.patch).not.toHaveBeenCalled();
});
