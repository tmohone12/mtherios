import { describe, expect, it } from 'vitest';
import { observedAssistantSources } from './assistantSources';

describe('Assistant source observations', () => {
  it('retains exact read ranges and hashes even when more lines remain, and refuses search-only citations', () => {
    const sourceRef = 'mount:selected:lore%2Fpromise.md';
    const read = { sourceRef, text: 'The bridge oath binds only the elected keeper.', startLine: 30, endLine: 31, sha256: 'a'.repeat(64), revision: '1:hash', truncated: true };
    const reply = `“The bridge oath binds only the elected keeper.” [source:${sourceRef}]`;
    expect(observedAssistantSources(reply, [], [{ tool: 'read', result: read }])).toEqual([
      { kind: 'file', id: sourceRef, sourceRef, startLine: 30, endLine: 31, sha256: read.sha256, revision: '1:hash' },
    ]);
    expect(() => observedAssistantSources(reply, [], [{ tool: 'search', result: { items: [read] } }])).toThrow('lacks an exact observed quote');
    expect(observedAssistantSources(reply, [], [{ tool: 'read', result: read }, { tool: 'read', result: { ...read, startLine: 80, endLine: 81, text: 'Another source range follows below.' } }])).toHaveLength(1);
  });
  it('links only cited sources actually delivered by current context or tool results', () => {
    const context = [{ kind: 'content', id: 'visible', revision: 2, description: 'The blue door is locked.' }, { kind: 'story_entry', id: 'scene', revision: 9, text: 'Rain falls over the clearing.' }];
    const observations = [
      { tool: 'list', result: { items: [{ id: 'listed', revision: 3, title: 'The old copper lantern' }] } },
      { tool: 'read', result: { id: 'type', revision: 4, name: 'Archive document type', definition: {} } },
      { tool: 'write', result: { applied: true, itemId: 'created', afterRevision: 1 } },
      { tool: 'read', result: { excerpt: '{"id":"truncated","revision":7}', truncated: true } },
    ];
    expect(observedAssistantSources('“The blue door is locked.” [source:visible] “Rain falls over the clearing.” [source:scene] “The old copper lantern” [source:listed] “Archive document type” [source:type] Created created; truncated invented', context, observations)).toEqual([
      { kind: 'content', id: 'visible', revision: 2 },
      { kind: 'story_entry', id: 'scene', revision: 9 },
      { kind: 'content', id: 'listed', revision: 3 },
      { kind: 'content_type', id: 'type', revision: 4 },
      { kind: 'content', id: 'created', revision: 1 },
    ]);
  });

  it('excludes malformed, absent and non-applied sources', () => {
    expect(observedAssistantSources('draft stale', [{ kind: 'content', id: 'stale', revision: null }], [
      { tool: 'write', result: { applied: false, itemId: 'draft', afterRevision: 1 } },
    ])).toEqual([]);
  });

  it('shows one source when a verified readback citation and applied receipt identify the same revision', () => {
    const observations = [
      { tool: 'update', result: { applied: true, itemId: 'promise', afterRevision: 2 } },
      { tool: 'read', result: { id: 'promise', type_id: 'notes', revision: 2, data: { notes: 'The sealed letter may be delivered unopened.' } } },
    ];
    expect(observedAssistantSources('Successfully updated promise. “The sealed letter may be delivered unopened.” [source:promise]', [], observations)).toEqual([
      { kind: 'content', id: 'promise', revision: 2 },
    ]);
  });

  it('rejects fabricated or unquoted factual citations and leaves bare mentions unlinked', () => {
    const context = [{ kind: 'story_entry', id: 'scene', revision: 9, text: 'Rain falls over the clearing.' }];
    expect(observedAssistantSources('The scene mentions rain.', context, [])).toEqual([]);
    expect(() => observedAssistantSources('“Snow covers the clearing.” [source:scene]', context, [])).toThrow('lacks an exact observed quote');
    expect(() => observedAssistantSources('Rain falls [source:scene]', context, [])).toThrow('lacks an exact observed quote');
    expect(() => observedAssistantSources('“Rain falls over the clearing.” [source:invented]', context, [])).toThrow('lacks an exact observed quote');
  });

  it('accepts a provider-style exact sentence followed by its source ID', () => {
    const context = [{ kind: 'story_entry', id: 'narration_1', revision: 1, text: 'The copper lantern cast a green circle on the stone floor.' }];
    expect(observedAssistantSources('The light was green.\n\n**Exact sentence:** "The copper lantern cast a green circle on the stone floor."\n\n**Source ID:** `narration_1`', context, [])).toEqual([
      { kind: 'story_entry', id: 'narration_1', revision: 1 },
    ]);
  });
});
