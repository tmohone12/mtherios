import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as appConfig from '$lib/server/app/config';
import type { SourceMount } from '$lib/contracts/sourceFiles';
import { listMountedSources, listSourceFiles, readMountedSource, readSourceFile, readRunSourceFile, saveSourceMount, searchMountedSources, sourceTextRange, validateSourceMountRoot, validateSourcePath } from './sourceFiles';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), readContent: vi.fn(), readCanonicalWorkspace: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('node:fs/promises', async original => {
  const filesystem = await original<typeof import('node:fs/promises')>();
  return { ...filesystem, open: vi.fn(filesystem.open), opendir: vi.fn(filesystem.opendir) };
});
vi.mock('./content', () => ({ readContent: mocks.readContent }));
vi.mock('./canonicalContent', () => ({ readCanonicalWorkspace: mocks.readCanonicalWorkspace }));
const roots: string[] = [];
const authority = { role: 'gm' as const, projectId: 'project', gameId: 'game', branchId: 'branch', povCharacter: 'Mara' };
async function fixture(): Promise<SourceMount> {
  const root = await realpath(await mkdtemp(path.join(process.cwd(), 'source-files-test-')));
  roots.push(root);
  return { id: 'mount', project_id: 'project', name: 'References', root_path: root, revision: 1, roles: ['gm', 'assistant'] };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(filesystem.open).mockReset(); vi.mocked(filesystem.opendir).mockReset(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(path.join(process.cwd(), 'source-files-test-'))) throw new Error('Unexpected temporary test path.');
    await rm(root, { recursive: true, force: true });
  }
});

describe('bounded read-only source folders', () => {
  it('rejects Windows traversal, absolute, UNC, device, stream and secret paths on every host', () => {
    for (const invalid of ['../secret.md', 'docs/../rule.md', 'C:\\docs\\rule.md', '\\\\server\\share\\rule.md', '\\\\?\\C:\\docs', 'rule.md:secret', '.env', 'node_modules/readme.md', 'keys/api_key.json', 'NUL.txt', 'rule.md.']) {
      expect(() => validateSourcePath(invalid), invalid).toThrow();
    }
    expect(validateSourcePath('docs\\bridge.md')).toBe('docs/bridge.md');
  });
  it('registers only a specific local folder and blocks a root disk', async () => {
    const mount = await fixture();
    expect(await validateSourceMountRoot(mount.root_path)).toBe(mount.root_path);
    await expect(validateSourceMountRoot(path.parse(mount.root_path).root)).rejects.toMatchObject({ code: 'SOURCE_PATH_DENIED' });
    await expect(validateSourceMountRoot('\\\\server\\share')).rejects.toMatchObject({ code: 'SOURCE_PATH_DENIED' });
  });
  it('lists safe formats and navigates stable pages without exposing credentials or runtime names', async () => {
    const mount = await fixture();
    for (const name of ['bridge.md', 'rules.json', 'secret.txt', 'cover.png', '.env']) await writeFile(path.join(mount.root_path, name), 'evidence');
    await mkdir(path.join(mount.root_path, 'node_modules'));
    await mkdir(path.join(mount.root_path, 'history'));
    const first = await listMountedSources(mount, { sourceKind: 'mounted', limit: 1 });
    expect(first.items[0]).toMatchObject({ name: 'bridge.md', sourceRef: 'mount:mount:bridge.md' });
    const second = await listMountedSources(mount, { sourceKind: 'mounted', limit: 5, cursor: first.nextCursor! });
    expect(second.items.map(value => value.name)).toEqual(['history', 'rules.json']);
    await writeFile(path.join(mount.root_path, 'new.md'), 'new');
    await expect(listMountedSources(mount, { sourceKind: 'mounted', cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'SOURCE_CURSOR_STALE' });
  });
  it('reads complete line ranges with hash-bound continuation and rejects a changed source', async () => {
    const mount = await fixture();
    await writeFile(path.join(mount.root_path, 'bridge.md'), 'First promise\r\nSecond promise\r\nCity rule');
    const first = await readMountedSource(mount, 'bridge.md', { sourceRef: 'mount:mount:bridge.md', lineCount: 2 });
    expect(first).toMatchObject({ text: 'First promise\nSecond promise', startLine: 1, endLine: 2, totalLines: 3, truncated: true });
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    const next = await readMountedSource(mount, 'bridge.md', first.nextRead);
    expect(next).toMatchObject({ text: 'City rule', startLine: 3, truncated: false, nextRead: null });
    await writeFile(path.join(mount.root_path, 'bridge.md'), 'Changed promise');
    await expect(readMountedSource(mount, 'bridge.md', first.nextRead)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });
  it('rejects symlinks and Windows junctions that leave the selected folder', async () => {
    const mount = await fixture(), outside = await fixture();
    await writeFile(path.join(outside.root_path, 'secret.md'), 'must never read');
    await symlink(outside.root_path, path.join(mount.root_path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const listing = await listMountedSources(mount, { sourceKind: 'mounted' });
    expect(listing.items).toEqual([]);
    await expect(readMountedSource(mount, 'linked/secret.md', { sourceRef: 'mount:mount:linked%2Fsecret.md' })).rejects.toMatchObject({ code: 'SOURCE_PATH_DENIED' });
  });
  it('rejects an opened outside file even if the authorized path has already been restored', async () => {
    const mount = await fixture(), outside = await fixture();
    await writeFile(path.join(mount.root_path, 'rule.md'), 'allowed text');
    await writeFile(path.join(outside.root_path, 'rule.md'), 'outside text');
    const { open: actualOpen } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(filesystem.open).mockImplementation((_path, flags) => actualOpen(path.join(outside.root_path, 'rule.md'), flags));
    await expect(readMountedSource(mount, 'rule.md', { sourceRef: 'mount:mount:rule.md' })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  });
  it('does not expose outside directory names from a stale directory handle', async () => {
    const mount = await fixture(), outside = await fixture();
    await writeFile(path.join(outside.root_path, 'outside-sentinel.md'), 'outside text');
    const { opendir: actualOpen } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(filesystem.opendir).mockImplementation((_path, options) => actualOpen(outside.root_path, options));
    await expect(listMountedSources(mount, { sourceKind: 'mounted' })).rejects.toThrow();
  });
  it('reports binary, credentials and oversized source failures accurately', async () => {
    const mount = await fixture();
    await writeFile(path.join(mount.root_path, 'binary.txt'), Buffer.from([255, 0, 1]));
    await writeFile(path.join(mount.root_path, 'config.json'), '{"apiKey":"private-key"}');
    await writeFile(path.join(mount.root_path, 'large.md'), 'x'.repeat(1024 * 1024 + 1));
    for (const [name, code] of [['binary.txt', 'SOURCE_UNSUPPORTED'], ['config.json', 'SOURCE_DENIED'], ['large.md', 'SOURCE_TOO_LARGE']]) {
      await expect(readMountedSource(mount, name, { sourceRef: `mount:mount:${name}` })).rejects.toMatchObject({ code });
    }
    await expect(readMountedSource(mount, '../outside.md', { sourceRef: 'mount:mount:outside' })).rejects.toMatchObject({ code: 'SOURCE_PATH_DENIED' });
  });
  it('excludes the configured runtime tree even when its folder has an ordinary name', async () => {
    const mount = await fixture();
    const runtime = path.join(mount.root_path, 'processed');
    await mkdir(runtime);
    await writeFile(path.join(runtime, 'state.json'), '{"runtime":"private"}');
    await writeFile(path.join(mount.root_path, 'rules.md'), 'canonical references');
    vi.spyOn(appConfig, 'getMtheriosAppConfig').mockReturnValue({ ...appConfig.getMtheriosAppConfig(), dataRoot: runtime, vaultRoot: path.join(runtime, 'vaults') });
    expect((await listMountedSources(mount, { sourceKind: 'mounted' })).items.map(value => value.name)).toEqual(['rules.md']);
    await expect(readMountedSource(mount, 'processed/state.json', { sourceRef: 'mount:mount:processed%2Fstate.json' })).rejects.toMatchObject({ code: 'SOURCE_PATH_DENIED' });
    await expect(validateSourceMountRoot(runtime)).rejects.toMatchObject({ code: 'SOURCE_PATH_DENIED' });
  });
  it('searches literally, traverses subfolders, and continues within a file without repeating hits', async () => {
    const mount = await fixture();
    await mkdir(path.join(mount.root_path, 'history'));
    await writeFile(path.join(mount.root_path, 'history', 'bridge.md'), 'Promise [a+b]\nLater promise [a+b]\nNothing');
    const first = await searchMountedSources(mount, { sourceKind: 'mounted', query: '[a+b]', limit: 1 });
    expect(first.items[0]).toMatchObject({ sourceRef: 'mount:mount:history%2Fbridge.md', startLine: 1 });
    const second = await searchMountedSources(mount, { sourceKind: 'mounted', query: '[a+b]', limit: 1, cursor: first.nextCursor! });
    expect(second.items[0]).toMatchObject({ startLine: 2 });
    const final = await searchMountedSources(mount, { sourceKind: 'mounted', query: '[a+b]', limit: 1, cursor: second.nextCursor! });
    expect(final).toMatchObject({ items: [], nextCursor: null });
  });
  it('keeps an empty bounded search page resumable when a later file matches', async () => {
    const mount = await fixture();
    for (let index = 0; index < 101; index++) await writeFile(path.join(mount.root_path, `${String(index).padStart(3, '0')}.md`), index === 100 ? 'bridge promise' : 'empty');
    const first = await searchMountedSources(mount, { sourceKind: 'mounted', query: 'promise' });
    expect(first).toMatchObject({ items: [], scanned: 100, truncated: true });
    const next = await searchMountedSources(mount, { sourceKind: 'mounted', query: 'promise', cursor: first.nextCursor! });
    expect(next.items[0]).toMatchObject({ path: '100.md' });
  }, 15000);
  it('rejects a file changed between search pages instead of continuing at a shifted line', async () => {
    const mount = await fixture();
    await writeFile(path.join(mount.root_path, 'bridge.md'), 'promise\npromise');
    const first = await searchMountedSources(mount, { sourceKind: 'mounted', query: 'promise', limit: 1 });
    await writeFile(path.join(mount.root_path, 'bridge.md'), 'inserted\npromise\npromise');
    await expect(searchMountedSources(mount, { sourceKind: 'mounted', query: 'promise', limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'SOURCE_CURSOR_STALE' });
  });
  it('never clips a long line while claiming it was a complete range', () => {
    expect(() => sourceTextRange('x'.repeat(12001), { sourceRef: 'content:id', startLine: 1, lineCount: 1 }, {})).toThrow();
    const range = sourceTextRange(['x'.repeat(7000), 'y'.repeat(7000)].join('\n'), { sourceRef: 'content:id', startLine: 1, lineCount: 2 }, {});
    expect(range).toMatchObject({ endLine: 1, truncated: true, nextRead: { startLine: 2 } });
  });
});

describe('server-bound source scope and revisions', () => {
  it('denies batch exploration before touching persistence', async () => {
    await expect(listSourceFiles({ ...authority, role: 'batch' }, {})).rejects.toMatchObject({ code: 'SOURCE_DENIED' });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
  it('locks the project and rejects a stale mount revision before saving', async () => {
    const mount = await fixture();
    const execute = vi.fn().mockResolvedValueOnce([{ id: 'project' }]).mockResolvedValueOnce([{ id: 'mount', revision: 3 }]);
    mocks.getDb.mockReturnValue({ transaction: (callback: (tx: unknown) => unknown) => callback({ execute }) });
    await expect(saveSourceMount({ projectId: 'project', id: 'mount', expectedRevision: 2, name: 'References', path: mount.root_path })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(new PgDialect().sqlToQuery(execute.mock.calls[0][0]).sql).toContain('for update');
  });
  it('filters project/game/branch/POV/visibility before listing document names', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{ id: 'project' }]).mockResolvedValueOnce([{ id: 'game' }]).mockResolvedValueOnce([]);
    mocks.getDb.mockReturnValue({ execute });
    await listSourceFiles(authority, { sourceKind: 'content' });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[2][0]);
    expect(query.sql).toContain('i.deleted_at is null');
    expect(query.sql).toContain('i.branch_id is null');
    expect(query.sql).toContain('i.pov_character is null');
    expect(query.params).toEqual(expect.arrayContaining(['project', 'game', 'branch', 'mara']));
  });
  it('returns logical child folders and stable document refs from the already-filtered catalog', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{ id: 'project' }]).mockResolvedValueOnce([{ id: 'game' }]).mockResolvedValueOnce([
      { entry: { directory: true, folder: 'Rules', title: 'Rules' } },
      { entry: { id: 'promise', title: 'Bridge promise', folder: '', slug: 'bridge', revision: 2, type_revision: 1, extension: 'md', visibility: 'public', data: null } },
    ]);
    mocks.getDb.mockReturnValue({ execute });
    const result = await listSourceFiles(authority, { sourceKind: 'content' });
    expect(result.items).toEqual([
      { kind: 'directory', path: 'Rules', name: 'Rules', readOnly: true },
      { kind: 'file', sourceRef: 'content:promise', path: 'bridge.md', name: 'Bridge promise', revision: '2:1', visibility: 'public' },
    ]);
    expect(new PgDialect().sqlToQuery(execute.mock.calls[2][0]).sql).toContain('with sources as');
  });
  it('rechecks actual read visibility, branch and POV through the canonical content reader', async () => {
    mocks.getDb.mockReturnValue({ execute: vi.fn().mockResolvedValue([{ id: 'project' }]) });
    const item = { id: 'rule', project_id: 'project', game_id: 'game', title: 'City rule', description: '', data: { rule: 'Promise' }, revision: 2, type_revision: 1, visibility: 'gm', branch_id: 'branch', pov_character: 'Mara' };
    mocks.readContent.mockResolvedValue({ items: [item] });
    const result = await readSourceFile(authority, { sourceRef: 'content:rule' });
    expect(result).toMatchObject({ sourceRef: 'content:rule', revision: '2:1', visibility: 'gm' });
    await expect(readSourceFile({ ...authority, branchId: 'other' }, { sourceRef: 'content:rule' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(readSourceFile({ ...authority, role: 'research' }, { sourceRef: 'content:rule' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    mocks.readContent.mockResolvedValue({ items: [{ ...item, game_id: 'foreign' }] });
    await expect(readSourceFile(authority, { sourceRef: 'content:rule' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });
  it('denies foreign mounts and roles even for a correctly encoded source ref', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{ id: 'project' }]).mockResolvedValueOnce([{ id: 'game' }]).mockResolvedValueOnce([]);
    mocks.getDb.mockReturnValue({ execute });
    await expect(readSourceFile(authority, { sourceRef: 'mount:foreign:rule.md' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect(new PgDialect().sqlToQuery(execute.mock.calls[2][0]).params).toEqual(['project', 'foreign']);
  });
  it('opens only an observed range using its original server-bound scope and revision', async () => {
    mocks.getDb.mockReturnValue({ execute: vi.fn().mockResolvedValue([{ id: 'project' }]) });
    const item = { id: 'rule', project_id: 'project', game_id: 'game', title: 'City rule', description: 'The original rule', data: {}, revision: 2, type_revision: 1, visibility: 'public', branch_id: 'branch', pov_character: 'Mara' };
    mocks.readContent.mockResolvedValue({ items: [item] });
    const result = await readSourceFile(authority, { sourceRef: 'content:rule', startLine: 2, lineCount: 1 });
    const execute = vi.fn().mockResolvedValueOnce([{ role: 'gm', project_id: 'project', game_id: 'game', result }]).mockResolvedValue([{ id: 'project' }]);
    mocks.getDb.mockReturnValue({ execute });
    const inspected = await readRunSourceFile({ projectId: 'project', gameId: 'game', runId: 'run', sourceRef: 'content:rule' });
    expect(inspected).toMatchObject({ text: 'The original rule', startLine: 2, endLine: 2, sourceScope: { branchId: 'branch', povCharacter: 'Mara' } });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.params).toEqual(expect.arrayContaining(['run', 'project', 'game', 'content:rule']));
    expect(query.sql).toContain("c.status='completed'");
    expect(query.sql).toContain("c.result->>'visibility' in ('public','player_known')");
    execute.mockResolvedValueOnce([{ role: 'gm', project_id: 'project', game_id: 'game', result }]);
    await expect(readRunSourceFile({ projectId: 'project', gameId: 'game', runId: 'run', sourceRef: 'content:rule', startLine: 1, lineCount: 3 })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
  });
  it('does not let the viewer select a role or open an unobserved file', async () => {
    mocks.getDb.mockReturnValue({ execute: vi.fn().mockResolvedValue([]) });
    await expect(readRunSourceFile({ projectId: 'project', runId: 'run', sourceRef: 'content:unread' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(readRunSourceFile({ projectId: 'project', runId: 'run', sourceRef: 'content:unread', role: 'gm' })).rejects.toThrow();
  });
});
