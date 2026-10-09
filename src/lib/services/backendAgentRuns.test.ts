import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentHistoryNarrationEntries, getBackendAgentHistory, requestBackendSceneImage, visibleRollPortrait } from './backendAgentRuns';
import { postEngineCommand } from './backendMemory';
import type { Character, StoryEntry } from '$lib/types';

vi.mock('./backendMemory', () => ({ postEngineCommand: vi.fn() }));
beforeEach(() => vi.mocked(postEngineCommand).mockReset());

const portrait = 'data:image/png;base64,YQ==';
const character = (id: string, visibility: string, image = portrait): Character => ({
  id, storyId: 'fixture', name: id, description: null, relationship: null, traits: [],
  visualDescriptors: {} as Character['visualDescriptors'], portrait: image,
  status: 'active', branchId: null, metadata: { canonicalVisibility: visibility },
});

describe('agent history pagination', () => {
  it('loads interaction cards for every loaded turn beyond the old 500-turn window', async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `turn-${index}`);
    vi.mocked(postEngineCommand).mockImplementation(async (_storyId, _command, args) => ({
      interactions: ((args?.clientTurnIds ?? []) as string[]).map(client_turn_id => ({
        client_turn_id, kind: 'question', prompt: 'Choice', options: [{ id: 'a', label: 'A' }], response: { optionId: 'a' },
      })),
      rolls: [],
    }));
    const result = await getBackendAgentHistory('game', ids);
    expect(result.interactions.map(item => item.client_turn_id)).toEqual(ids);
    const calls = vi.mocked(postEngineCommand).mock.calls;
    expect(calls).toHaveLength(6);
    expect(calls.every(([storyId, command, args]) => storyId === 'game' && command === 'agent.run.history' && (args.clientTurnIds as string[]).length <= 100)).toBe(true);
  });
});

it('attaches turn history to imported narration with remapped entry IDs', () => {
  const entry = (id: string, clientTurnId?: string): StoryEntry => ({
    id, storyId: 'fixture', type: 'narration', content: 'A castle appears.', parentId: null,
    position: 2, createdAt: 0, branchId: null,
    metadata: clientTurnId ? { clientTurnId } as StoryEntry['metadata'] : null,
  });
  expect([...agentHistoryNarrationEntries([entry('import_new_id', 'turn_one'), entry('narration_turn_two')])]).toEqual([
    ['turn_one', 'import_new_id'], ['turn_two', 'narration_turn_two'],
  ]);
});

it('receives a completed scene image from one API call with its saved turn origin', async () => {
  vi.mocked(postEngineCommand).mockResolvedValue({ status: 'complete', jobId: 'job_1', styleRevision: 2, imageResult: { assetId: 'asset_1', url: '/api/assets/asset_1' } });
  const input = { projectId: 'project_1', gameId: 'game_1', clientTurnId: 'turn_1', callId: 'manual_1' };
  expect(await requestBackendSceneImage(input)).toMatchObject({ status: 'complete', imageResult: { url: '/api/assets/asset_1' } });
  expect(postEngineCommand).toHaveBeenCalledWith('game_1', 'image.scene.request', input);
});

describe('visible roll portrait', () => {
  it('uses only the resolved same-game visible character image', () => {
    const characters = [character('known', 'player_known'), character('secret', 'secret')];
    expect(visibleRollPortrait(characters, 'known')).toBe(portrait);
    expect(visibleRollPortrait(characters, 'secret')).toBeNull();
    expect(visibleRollPortrait(characters, 'foreign')).toBeNull();
  });

  it('rejects unsupported image sources', () => {
    expect(visibleRollPortrait([character('svg', 'public', 'data:image/svg+xml;base64,YQ==')], 'svg')).toBeNull();
    expect(visibleRollPortrait([character('remote', 'public', 'https://example.com/portrait.png')], 'remote')).toBeNull();
  });
});
