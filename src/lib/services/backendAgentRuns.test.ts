import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentHistoryNarrationEntries, cancelBackendAgentRun, currentBackendAgentRun, getBackendAgentRun, getBackendAgentHistory, openBackendAgentRunStream, readBackendAgentSource, requestBackendSceneImage, respondBackendAgentRun, startBackendAgentRun, visibleRollPortrait } from './backendAgentRuns';
import { postEngineCommand } from './backendMemory';
import type { Character, StoryEntry } from '$lib/types';

vi.mock('./backendMemory', () => ({ postEngineCommand: vi.fn() }));
beforeEach(() => vi.mocked(postEngineCommand).mockReset());
afterEach(() => vi.unstubAllGlobals());

describe('visible durable agent execution', () => {
  const snapshot = { id: 'run', gameId: 'game', clientTurnId: 'turn', status: 'running', error: null, result: null, interactions: [], rolls: [],
    projectId: 'project', activity: [{ seq: '4', event_type: 'tool.completed', data: { tool: 'read', status: 'completed' } }],
    continuation: { runtime: 'pi-v1', budget: { modelRequests: 2, unknownUsage: true }, receipts: [{ index: 2, model: 'configured', inputTokens: 1500, reservedOutputTokens: 4096, requestHash: 'hash' }] } };

  it('returns from start/respond while work continues and exposes cancellation through the same owner', async () => {
    vi.mocked(postEngineCommand).mockResolvedValue(snapshot);
    const turn = { storyId: 'game', clientTurnId: 'turn', playerText: 'Explore the bridge.', localVersion: 0 };
    const started = await startBackendAgentRun(turn);
    expect(postEngineCommand).toHaveBeenLastCalledWith('game', 'agent.run.start', { turn: expect.objectContaining(turn), wait: false }, 'turn');
    expect(started.activity[0].seq).toBe(4);
    expect(started.continuation?.budget).toMatchObject({ modelRequests: 2, unknownUsage: true });
    await respondBackendAgentRun('game', 'run', 'question', 1, { optionId: 'yes' });
    expect(postEngineCommand).toHaveBeenLastCalledWith('game', 'agent.run.respond', { runId: 'run', interactionId: 'question', expectedRevision: 1, response: { optionId: 'yes' }, wait: false });
    await cancelBackendAgentRun('game', 'run');
    expect(postEngineCommand).toHaveBeenLastCalledWith('game', 'agent.run.cancel', { runId: 'run' });
  });

  it('opens exactly the completed source range with its originating run and saved hash/revision', async () => {
    const observed = { callId: 'read', runId: 'run', sourceRef: 'content:bridge', path: 'rules/bridge.note', revision: '2:1', sha256: 'a'.repeat(64), startLine: 10, endLine: 12, truncated: true };
    vi.mocked(postEngineCommand).mockResolvedValue({ ...observed, text: 'The bridge promise binds the keeper.' });
    const result = await readBackendAgentSource('project', 'game', observed);
    expect(result.text).toContain('bridge promise');
    expect(postEngineCommand).toHaveBeenLastCalledWith('game', 'source.file.read', { projectId: 'project', gameId: 'game', runId: 'run', sourceRef: observed.sourceRef,
      startLine: 10, lineCount: 3, expectedHash: observed.sha256, expectedRevision: '2:1' });
  });

  it('restores and refreshes the latest completed legacy run after Pi rollback', async () => {
    vi.mocked(postEngineCommand).mockResolvedValue({ ...snapshot, status: 'completed',
      continuation: { runtime: 'legacy', budget: null, receipts: [] } });
    const restored = await currentBackendAgentRun('game');
    expect(restored).toMatchObject({ id: 'run', status: 'completed', continuation: { runtime: 'legacy', budget: null, receipts: [] } });
    expect(postEngineCommand).toHaveBeenLastCalledWith('game', 'agent.run.current', {});
    expect(await getBackendAgentRun('game', restored!.id)).toEqual(restored);
    expect(postEngineCommand).toHaveBeenLastCalledWith('game', 'agent.run.status', { runId: 'run' });
  });

  it('reconnects the run event stream from a persisted cursor and ignores malformed events', () => {
    const listeners = new Map<string, (event: Event) => void>();
    const stream = { addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener), close: vi.fn() };
    const factory = vi.fn(function () { return stream; });
    vi.stubGlobal('EventSource', factory);
    const onActivity = vi.fn(), onRefresh = vi.fn();
    const subscription = openBackendAgentRunStream('game', 'run', 41, onActivity, onRefresh);
    expect(factory).toHaveBeenCalledWith('/api/engine/run-stream?storyId=game&runId=run&after=41');
    listeners.get('tool.completed')?.(new MessageEvent('tool.completed', { lastEventId: '42', data: '{"tool":"read","status":"completed"}' }));
    expect(onActivity).toHaveBeenLastCalledWith({ seq: 42, event_type: 'tool.completed', data: { tool: 'read', status: 'completed' } });
    listeners.get('interaction.pending')?.(new MessageEvent('interaction.pending', { lastEventId: '43', data: '{"interactionId":"question"}' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    listeners.get('provider.requested')?.(new MessageEvent('provider.requested', { lastEventId: 'invalid', data: '{bad' }));
    expect(onActivity).toHaveBeenCalledTimes(2);
    subscription.close();
    expect(stream.close).toHaveBeenCalledTimes(1);
  });
});

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
