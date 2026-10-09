import { describe, expect, it } from 'vitest';
import { assertAssistantReplySupported, assistantToolDefinitions, assistantToolSchema } from './assistantTools';

describe('Assistant tool arguments', () => {
  it('keeps batch scope server-owned and separates plan from dispatch', () => {
    const plan = { tool: 'subagent', callId: 'batch-plan', args: { action: 'plan', typeId: 'gear', expectedTypeRevision: 1,
      objective: 'Update the catalog notes for every Gear item.', instructions: 'Keep other fields exactly as they are.',
      allowedFields: ['notes'], maxTargets: 100 } };
    expect(assistantToolSchema.parse(plan)).toMatchObject(plan);
    expect(() => assistantToolSchema.parse({ ...plan, args: { ...plan.args, projectId: 'other' } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...plan, args: { ...plan.args, maxTargets: 501 } })).toThrow();
    expect(assistantToolSchema.parse({ tool: 'subagent', callId: 'batch-dispatch', args: { action: 'dispatch', batchId: 'batch-id' } })).toBeTruthy();
    expect(() => assistantToolSchema.parse({ tool: 'subagent', callId: 'batch-dispatch',
      args: { action: 'dispatch', batchId: 'batch-id', typeId: 'other' } })).toThrow();
  });
  it('requires current item and type revisions for partial updates', () => {
    const call = { tool: 'update', callId: 'one', args: { id: 'item', expectedRevision: 2, expectedTypeRevision: 3, changes: { data: { notes: 'Revised' } } } };
    expect(assistantToolSchema.parse(call)).toMatchObject(call);
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, expectedRevision: undefined } })).toThrow();
  });
  it('binds folder operations to the run scope and a reviewed tree snapshot', () => {
    const preview = { tool: 'folder', callId: 'folder-preview', args: { action: 'previewMove', from: 'Checks', to: 'Filed' } };
    expect(assistantToolSchema.parse(preview)).toMatchObject(preview);
    expect(assistantToolSchema.parse({ tool: 'folder', callId: 'folder-list', args: { action: 'list' } }).args).toMatchObject({ action: 'list', offset: 0, limit: 50 });
    expect(() => assistantToolSchema.parse({ ...preview, args: { ...preview.args, projectId: 'other' } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...preview, args: { ...preview.args, expectedSnapshot: 'forged' } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...preview, args: { action: 'move', from: 'Checks', to: 'Filed' } })).toThrow();
    expect(assistantToolSchema.parse({ ...preview, args: { action: 'move', from: 'Checks', to: 'Filed', expectedSnapshot: 'a'.repeat(64) } })).toBeTruthy();
    expect(() => assistantToolSchema.parse({ ...preview, args: { action: 'archive', path: 'Checks' } })).toThrow();
  });

  it('rejects provider-supplied scope and arbitrary write fields', () => {
    const call = { tool: 'write', callId: 'one', args: { typeId: 'type', expectedTypeRevision: 1, title: 'Test', slug: 'test', data: { notes: 'A' } } };
    expect(assistantToolSchema.parse(call)).toMatchObject(call);
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, projectId: 'other' } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, id: 'existing' } })).toThrow();
  });

  it('keeps type saves project-bound and blocks unreviewed layout clear flags', () => {
    const call = { tool: 'saveType', callId: 'type-one', args: { key: 'notes', extension: 'note', name: 'Notes', definition: { fields: { text: { kind: 'longtext' } }, layout: [{ title: 'Notes', fields: ['text'] }], defaults: { text: '' }, gmContextMode: 'searchable' } } };
    expect(assistantToolSchema.parse(call)).toMatchObject(call);
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, projectId: 'other' } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, confirmedClear: true } })).toThrow();
    const definition = (assistantToolDefinitions.saveType.parameters.properties as Record<string, any>).definition;
    expect(definition.properties.layout.items.properties.fields).toMatchObject({ type: 'array' });
  });

  it('rejects a claimed copy with no applied receipt from this run', () => {
    expect(() => assertAssistantReplySupported('Copy this document', 'The document has been successfully created. **New Item ID:** `invented`', [])).toThrow('without an applied tool receipt');
    expect(() => assertAssistantReplySupported('Copy this document', 'The document has been successfully created.', [{ result: { applied: true, itemId: 'new', afterRevision: 1 } }])).not.toThrow();
    expect(() => assertAssistantReplySupported('What happened recently?', 'The document was created earlier.', [])).not.toThrow();
  });

  it('only claims a generated image with a completed asset receipt', () => {
    const call = { tool: 'generateImage', callId: 'image-one', args: { prompt: 'A moonlit keep' } };
    expect(assistantToolSchema.parse(call)).toMatchObject(call);
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, projectId: 'other' } })).toThrow();
    expect(() => assertAssistantReplySupported('Generate an image', 'The image is ready.', [{ result: { status: 'queued', jobId: 'job-one' } }])).toThrow('completed image receipt');
    expect(() => assertAssistantReplySupported('Generate an image', 'The image is ready.', [{ tool: 'generateImage', result: { status: 'complete', imageResult: { assetId: 'asset' } } }])).not.toThrow();
    expect(() => assertAssistantReplySupported('Generate an image', 'Image job job-one is queued.', [{ result: { status: 'queued', jobId: 'job-one' } }])).not.toThrow();
  });

  it('bounds persisted questions and keeps their scope server-owned', () => {
    const call = { tool: 'askUserQuestion', callId: 'question-one', args: { prompt: 'Choose a folder', options: [{ id: 'blue', label: 'Blue' }, { id: 'green', label: 'Green' }], allowCustom: false } };
    expect(assistantToolSchema.parse(call)).toMatchObject(call);
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, projectId: 'other' } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, options: [] } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, options: Array.from({ length: 9 }, (_, index) => ({ id: String(index), label: String(index) })) } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, prompt: 'x'.repeat(1001) } })).toThrow();
  });

  it('requires exact revisions for a restore proposal and never accepts approval from the model', () => {
    const call = { tool: 'revert', callId: 'restore-one', args: { targetKind: 'item', id: 'item-one', targetRevision: 1, expectedRevision: 2 } };
    expect(assistantToolSchema.parse(call)).toMatchObject(call);
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, expectedRevision: undefined } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, confirmed: true } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, expectedSnapshot: 'forged' } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, projectId: 'other' } })).toThrow();
  });

  it('allows only a revisioned proposal for clearing a type layout', () => {
    const call = { tool: 'clearLayout', callId: 'clear-one', args: { id: 'type-one', expectedRevision: 2 } };
    expect(assistantToolSchema.parse(call)).toMatchObject(call);
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, confirmedClear: true } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, definition: { layout: [] } } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, projectId: 'other' } })).toThrow();
    expect(() => assistantToolSchema.parse({ ...call, args: { ...call.args, expectedRevision: undefined } })).toThrow();
  });
});
