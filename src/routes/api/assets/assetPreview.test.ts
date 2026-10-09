import { beforeEach, expect, test, vi } from 'vitest';
import { MutationError } from '$lib/server/engine/mutationSafety';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('$lib/server/engine/imageAssets', () => ({ readImageAsset: mocks.read }));

import { POST } from './[assetId]/preview/+server';

function event(origin: string, scope: unknown = { projectId: 'project_1', gameId: 'game_1' }) {
  return { params: { assetId: 'asset_1' }, url: new URL('http://127.0.0.1:5174/api/assets/asset_1/preview'),
    request: new Request('http://127.0.0.1:5174/api/assets/asset_1/preview', {
      method: 'POST', headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(scope),
    }) } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ asset: { media_type: 'image/png', byte_size: 3, visibility: 'gm' }, bytes: Buffer.from([1, 2, 3]) });
});

test('same-origin author preview returns scoped private bytes without public caching', async () => {
  const response = await POST(event('http://127.0.0.1:5174'));
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(mocks.read).toHaveBeenCalledWith({ projectId: 'project_1', gameId: 'game_1', assetId: 'asset_1' });
});

test('cross-origin and mismatched project or game requests cannot preview private bytes', async () => {
  expect((await POST(event('https://other.example'))).status).toBe(403);
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.read.mockRejectedValueOnce(new MutationError('SCOPE_DENIED', 'Wrong game.'));
  expect((await POST(event('http://127.0.0.1:5174', { projectId: 'project_1', gameId: 'other_game' }))).status).toBe(404);
});
