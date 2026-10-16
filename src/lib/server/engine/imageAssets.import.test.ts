import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { beforeEach, expect, test, vi } from 'vitest';
import { importImageAsset } from './imageAssets';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/app/config', () => ({ getMtheriosAppConfig: () => ({ dataRoot: '/unused-image-import-test' }) }));

beforeEach(() => vi.clearAllMocks());

function imageInput(bytes: Buffer) {
  return { projectId: 'project', gameId: 'game', mediaType: 'image/jpeg' as const,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytesBase64: bytes.toString('base64'),
    visibility: 'public' as const, createdKeys: [] as string[] };
}

test('imports a multi-megabyte portrait without overflowing validation and retains its bytes', async () => {
  const bytes = Buffer.alloc(6_000_001);
  bytes.set([0xff, 0xd8, 0xff]);
  const input = imageInput(bytes);
  const tx = { execute: vi.fn(async () => []) };
  const assetId = await importImageAsset(tx as any, input);
  expect(assetId).toMatch(/^[0-9a-f-]{36}$/);
  expect(writeFile).toHaveBeenCalledOnce();
  const [file, savedBytes, options] = vi.mocked(writeFile).mock.calls[0];
  expect(file).toEqual(expect.stringContaining(assetId));
  expect((savedBytes as Buffer).length).toBe(bytes.length);
  expect(createHash('sha256').update(savedBytes as Buffer).digest('hex')).toBe(input.sha256);
  expect(options).toEqual({ flag: 'wx' });
  expect(input.createdKeys).toEqual([`${assetId}.jpg`]);
  expect(tx.execute).toHaveBeenCalledOnce();
});

test.each(['/9j/2Q', '/9j/2Q===', '/9j/2Q==\n', '/9j/2Q==!', '_9j_2Q==', '/9j/2R=='])(
  'rejects noncanonical base64 %j before writing an asset', async bytesBase64 => {
    const input = { ...imageInput(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), bytesBase64 };
    const tx = { execute: vi.fn(async () => []) };
    await expect(importImageAsset(tx as any, input)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(tx.execute).not.toHaveBeenCalled();
    expect(input.createdKeys).toEqual([]);
  },
);

test('retains digest and media validation before writing imported assets', async () => {
  for (const changes of [{ sha256: '0'.repeat(64) }, { mediaType: 'image/png' as const }]) {
    const input = { ...imageInput(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), ...changes };
    const tx = { execute: vi.fn(async () => []) };
    await expect(importImageAsset(tx as any, input)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(tx.execute).not.toHaveBeenCalled();
  }
});
