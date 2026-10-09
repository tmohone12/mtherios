import { describe, expect, it } from 'vitest';
import { foldAssistantDigest, parseAssistantDigest } from './assistantContextDigest';

const message = (id: string, content: string, sourceRefs: unknown[] = []) => ({
  id, role: 'assistant', content, source_refs: sourceRefs, created_at: new Date(Date.UTC(2026, 8, 23, 0, 0, Number(id))),
});

describe('Assistant conversation compaction', () => {
  it('keeps short excerpts, source revisions and applied tool receipts without retaining full bodies', () => {
    const body = `Document notes ${'private detail '.repeat(100)}`;
    const first = foldAssistantDigest(parseAssistantDigest(''), [], [message('01', body, [{ kind: 'content', id: 'item-one', revision: 2 }])], [
      { run_id: 'run-one', call_id: 'write-one', tool: 'write', result: { applied: true, itemId: 'item-one', afterRevision: 3, changedFields: ['data.notes'] } },
    ]);
    expect(first.digest.foldedCount).toBe(1);
    expect(first.digest.messages[0].excerpt.length).toBeLessThanOrEqual(140);
    expect(JSON.stringify(first.digest)).not.toContain('private detail private detail private detail private detail private detail private detail private detail private detail private detail private detail');
    expect(first.digest.receipts).toMatchObject([{ runId: 'run-one', callId: 'write-one', itemId: 'item-one', afterRevision: 3 }]);
    expect(first.sources).toEqual([{ kind: 'content', id: 'item-one', revision: 3 }]);
    expect(parseAssistantDigest(JSON.stringify(first.digest)).through).toEqual({ createdAt: '2026-09-23T00:00:01.000Z', id: '01' });
  });

  it('retains answered questions and declines but never treats a read as an applied edit', () => {
    const folded = foldAssistantDigest(parseAssistantDigest(''), [], [message('02', 'Prior reply')], [
      { run_id: 'run', call_id: 'read', tool: 'read', result: { id: 'item' } },
      { run_id: 'run', call_id: 'question', tool: 'askUserQuestion', result: { prompt: 'Which?', answer: { optionId: 'blue' } } },
      { run_id: 'run', call_id: 'restore', tool: 'revert', result: { declined: true, targetKind: 'item', id: 'item', currentRevision: 4 } },
    ]);
    expect(folded.digest.receipts).toMatchObject([
      { tool: 'askUserQuestion', answer: 'blue' },
      { tool: 'revert', itemId: 'item', decision: 'declined' },
    ]);
    expect(folded.sources).toEqual([]);
  });

  it('retains folder destinations from applied receipts without copying the whole tree into context', () => {
    const folded = foldAssistantDigest(parseAssistantDigest(''), [], [message('03', 'Folders organized')], [
      { run_id: 'run', call_id: 'preview', tool: 'folder', result: { applied: false, operation: 'copy', from: 'Source', to: 'Copied' } },
      { run_id: 'run', call_id: 'copy', tool: 'folder', result: { applied: true, operation: 'copy', from: 'Source', to: 'Copied', sample: [{ id: 'document' }] } },
    ]);
    expect(folded.digest.receipts).toEqual([{ runId: 'run', callId: 'copy', tool: 'folder', operation: 'copy', from: 'Source', to: 'Copied' }]);
  });

  it('keeps the precise database cursor and ignores an overlapping message and receipt', () => {
    const older = { ...message('01', 'First message'), cursor_at: '2026-09-23 00:00:01.123456+00' };
    const receipt = { run_id: 'run', call_id: 'edit', tool: 'update', result: { applied: true, itemId: 'item', afterRevision: 2 } };
    const first = foldAssistantDigest(parseAssistantDigest(''), [], [older], [receipt]);
    const second = foldAssistantDigest(first.digest, first.sources, [older], [receipt]);
    expect(second.digest.through).toEqual({ createdAt: older.cursor_at, id: '01' });
    expect(second.digest.foldedCount).toBe(1);
    expect(second.digest.messages).toHaveLength(1);
    expect(second.digest.receipts).toHaveLength(1);
  });

  it('bounds repeated folds while advancing the historical cursor', () => {
    let digest = parseAssistantDigest('');
    let sources: Array<{ kind: string; id: string; revision: number }> = [];
    for (let index = 0; index < 60; index += 1) {
      const folded = foldAssistantDigest(digest, sources, [message(String(index + 1), `Older message ${index} ${'x'.repeat(500)}`, [{ kind: 'content', id: `item-${index}`, revision: index + 1 }])], []);
      digest = folded.digest;
      sources = folded.sources as typeof sources;
    }
    expect(digest.foldedCount).toBe(60);
    expect(digest.through).toEqual({ createdAt: '2026-09-23T00:01:00.000Z', id: '60' });
    expect(digest.messages).toHaveLength(24);
    expect(JSON.stringify(digest).length).toBeLessThanOrEqual(12_000);
    expect(sources).toHaveLength(60);
  });
});
