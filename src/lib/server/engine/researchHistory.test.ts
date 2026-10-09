import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), getWorldRecord: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: () => ({ execute: mocks.execute }) }));
vi.mock('./worldRecords', () => ({ getWorldRecord: mocks.getWorldRecord }));
import { currentPublicResearchRevision, publicResearchReceipt } from './researchHistory';

const scope = { projectId: 'project-one', gameId: 'game-one' };
const entry = { kind: 'entry' as const, sourceId: 'entry-one', revision: '2026-09-23T00:00:00.000Z', statement: 'The gate opens at dawn.' };

describe('saved Research presentation', () => {
  it('shows only quotations whose scoped public source still has the recorded revision', async () => {
    const result = await publicResearchReceipt({ mode: 'local_extract', status: 'answered', question: 'When?', statements: [entry,
      { ...entry, sourceId: 'entry-two', statement: 'The gate opens at noon.' }] }, scope,
    async (_scope, source) => source.sourceId === 'entry-one' ? entry.revision : null);
    expect(result).toMatchObject({ status: 'answered', statements: [entry], sourceUnavailable: true });
    expect(await publicResearchReceipt({ mode: 'provider_synthesis', status: 'answered', question: 'When?', statements: [entry] }, scope,
      async () => entry.revision)).toBeNull();
  });

  it('redacts an entry after a current accepted correction supersedes it', async () => {
    mocks.execute.mockReset()
      .mockResolvedValueOnce([{ updated_at: new Date(entry.revision), metadata: {}, content: entry.statement }])
      .mockResolvedValueOnce([{ metadata: {}, body: 'The gate opens at noon.' }]);
    expect(await currentPublicResearchRevision(scope, entry)).toBeNull();
  });

  it('rejects a changed quotation or a now-hidden entry before returning its source ID', async () => {
    mocks.execute.mockReset().mockResolvedValueOnce([{ updated_at: new Date(entry.revision), metadata: {}, content: 'Different text.' }]);
    expect(await currentPublicResearchRevision(scope, entry)).toBeNull();
    mocks.execute.mockReset().mockResolvedValueOnce([{ updated_at: new Date(entry.revision), metadata: { visibility: 'gm' }, content: entry.statement }]);
    expect(await currentPublicResearchRevision(scope, entry)).toBeNull();
  });
});
