import { describe, expect, it } from 'vitest';
import { compactAgentRuntimeMessages } from './agentRuntime';
import { memoryRecallEvidence } from './memoryRecallEvidence';
import { countTokens } from '$lib/utils/tokens';
import type { ServerGenerationMessage } from '$lib/server/turn/provider';

// Sanitized shape from the failed 23:17 run: 5 nodes, 32 trace rows, huge raw source lists.
// Evidence is synthetic; no private campaign text is stored in the fixture.
export function oversizedMemoryRecall() {
  const node = (id: string) => ({ id, storyId: 'fixture-game', visibility: 'secret', updatedAt: '2026-10-03T23:17:00Z',
    summary: 'Inspection-only unabridged summary '.repeat(300), sourceEntryIds: ['entry-letter'],
    sourceEventIds: ['event-report'], sourcePatchIds: [] as string[], metadata: { sourcePosition: 142, sourceHash: 'source-hash' } });
  return { storyId: 'fixture-game', query: 'Read the known letter', packet: '[memory-letter] "The escort leaves at dawn." This is a report, not established truth.',
    tokenEstimate: 24, renderedItems: [{ id: 'memory-letter', text: '"The escort leaves at dawn."' }],
    nodes: [node('memory-letter'), ...Array.from({ length: 4 }, (_, i) => node('memory-'+i))],
    retrievalTrace: Array.from({ length: 32 }, (_, i) => ({ id: 'excluded-'+i, included: false,
      sourceEntryIds: Array.from({ length: 200 }, (_, j) => `private_source_${i}_${j}_not_selected`), title: 'PRIVATE excluded trace' })),
    retrievalDebug: ['Inspection diagnostic'] };
}

describe('model-facing memory evidence, full durable receipt retained', () => {
  it('projects even the most recent oversized result without losing its quote, source or call pairing', () => {
    const raw = oversizedMemoryRecall();
    const history: ServerGenerationMessage[] = [{ role: 'user', content: 'Read the letter.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'recall-1', name: 'recall', arguments: { command: 'memory.retrieve', args: { query: 'letter' } } }] },
      { role: 'tool', toolName: 'recall', toolCallId: 'recall-1', content: JSON.stringify(raw) }];
    const before = structuredClone(history);
    expect(countTokens(JSON.stringify(history))).toBeGreaterThan(40000);
    const result = compactAgentRuntimeMessages(history, 6000);
    expect(result.fits).toBe(true);
    expect(history).toEqual(before);
    expect(result.messages[1]).toEqual(history[1]);
    const message = result.messages[2];
    expect(message.role).toBe('tool');
    const projected = JSON.parse(message.content);
    expect(projected.packet).toBe(raw.packet);
    expect(projected.partial).toBe(false);
    expect(projected.sourceRefs).toEqual([expect.objectContaining({ nodeId: 'memory-letter', sourceEntryIds: ['entry-letter'],
      sourceEventIds: ['event-report'], sourcePosition: 142, sourceHash: 'source-hash', visibility: 'secret' })]);
    expect(message.content).not.toContain('PRIVATE');
    expect(message.content).not.toContain('private_source');
    expect(result.omitted).toEqual([{ index: 2, sourceRefs: projected.sourceRefs }]);
  });

  it('retains exact uncertainty, contradiction and belief-owner attribution in selected evidence', () => {
    const raw = oversizedMemoryRecall();
    raw.packet = '[report-a] Alice reports "Bridge open."\n[report-b] Bob reports "Bridge closed." Both reports are unverified.';
    raw.nodes[0].metadata = { ...raw.nodes[0].metadata, believerEntityId: 'actor-alice' } as any;
    const evidence = memoryRecallEvidence(raw)!;
    expect(JSON.parse(evidence.content).packet).toBe(raw.packet);
    expect(evidence.sourceRefs[0].beliefOwnerEntityId).toBe('actor-alice');
    expect(evidence.content).not.toContain('excluded-');
  });

  it('marks over-budget evidence as partial and supplies an actionable transcript reread handle', () => {
    const raw = oversizedMemoryRecall(); raw.packet = '"Do not infer the rest of this quote." '.repeat(8000);
    const evidence = memoryRecallEvidence(raw)!;
    expect(countTokens(evidence.content)).toBeLessThanOrEqual(4096);
    expect(JSON.parse(evidence.content).partial).toBe(true);
    expect(evidence.content).toContain('type: transcript, recordId: sourceEntryId');
    expect(evidence.sourceRefs[0].sourceEntryIds).toEqual(['entry-letter']);
  });

  it('does not reinterpret unrelated, missing, error or malformed receipts', () => {
    for (const raw of [null, { status: 'unavailable', error: 'Missing position' }, { nodes: [], packet: 'not a memory contract' }])
      expect(memoryRecallEvidence(raw)).toBeNull();
    const raw = JSON.stringify(oversizedMemoryRecall());
    const result = compactAgentRuntimeMessages([{ role: 'tool', toolName: 'read', toolCallId: 'unrelated', content: raw }], 200000);
    expect(result.messages[0].content).toBe(raw);
  });

  it('keeps the fallback within allowance even for malformed enormous identifiers', () => {
    const raw = oversizedMemoryRecall();
    raw.storyId = 'unbounded story'.repeat(8000);
    raw.nodes[0].sourceEntryIds = Array.from({length: 8}, () => '龍'.repeat(240));
    raw.nodes[0].sourceEventIds = Array.from({length: 8}, () => '龍'.repeat(240));
    raw.nodes[0].sourcePatchIds = Array.from({length: 8}, () => '龍'.repeat(240));
    const projected = memoryRecallEvidence(raw)!;
    expect(countTokens(projected.content)).toBeLessThanOrEqual(4096);
    expect(JSON.parse(projected.content).partial).toBe(true);
    expect(projected.sourceRefs[0].sourceEntryIds).toEqual(['龍'.repeat(240)]);
  });
});
