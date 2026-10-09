import { describe, expect, it } from 'vitest';
import { contentTypeSaveSchema, contentUpdateSchema, gearExample } from '$lib/contracts/content';
import { validateContentData, validateContentDefinition, validateContentFolder } from './contentValidation';
import { mergeJsonUpdate } from './mutationSafety';

describe('custom content validation', () => {
  it('preserves omitted patch fields while retaining explicit clears',()=>{
    const request={projectId:'p',id:'i',expectedRevision:1,expectedTypeRevision:1};
    expect(contentUpdateSchema.parse({...request,changes:{data:{notes:'Updated'}}}).changes).toEqual({data:{notes:'Updated'}});
    expect(contentUpdateSchema.parse({...request,changes:{folder:'',description:'',gmContextMode:null,visibility:'public'}}).changes).toEqual({folder:'',description:'',gmContextMode:null,visibility:'public'});
  });
  it('validates nested gear without dropping unedited fields', () => {
    const definition = validateContentDefinition(gearExample);
    const updated = mergeJsonUpdate({ materials: ['iron'], stats: { weight: 2, durable: true }, notes: 'Keep' }, { stats: { weight: 3 } });
    expect(validateContentData(definition, updated)).toEqual([]);
    expect(updated).toEqual({ materials: ['iron'], stats: { weight: 3, durable: true }, notes: 'Keep' });
    expect(() => validateContentData(definition, { ...definition.defaults, stats: { weight: 'wrong' } })).toThrow('finite number');
    expect(() => validateContentData(definition, { ...definition.defaults, surprise: true })).toThrow('Unknown field');
  });
  it('enforces required fields, enumerations and typed references', () => {
    const definition = validateContentDefinition({ fields: { rule: { kind: 'reference', required: true }, choice: { kind: 'enum', options: ['yes', 'no'] } } });
    expect(() => validateContentData(definition, {})).toThrow('Required field');
    expect(validateContentData(definition, { rule: { itemId: 'rules' }, choice: 'yes' })).toEqual(['rules']);
    expect(() => validateContentData(definition, { rule: { itemId: 'rules', gameId: 'foreign' } })).toThrow('only an itemId');
    expect(() => validateContentData(definition, { rule: { itemId: 'rules' }, choice: 'perhaps' })).toThrow('allowed choice');
  });
  it('rejects executable layout data, unknown fields and malformed schema definitions', () => {
    expect(() => validateContentDefinition({ fields: {}, layout: [{ title: 'Bad', fields: [], html: '<script />' }] })).toThrow();
    expect(() => validateContentDefinition({ fields: { choice: { kind: 'enum' } } })).toThrow();
    expect(() => validateContentDefinition({ fields: { thing: { kind: 'array' } } })).toThrow();
    expect(() => validateContentDefinition({ fields: { title: { kind: 'text' } }, layout: [{ title: 'Bad', fields: ['missing'] }] })).toThrow('Layout field');
    expect(() => validateContentDefinition(JSON.parse('{"fields":{"__proto__":{"kind":"text"}}}'))).toThrow('Unsupported');
  });
  it('rejects excessive depth and oversized values', () => {
    let field: Record<string, unknown> = { kind: 'text' };
    for (let i = 0; i < 12; i++) field = { kind: 'object', fields: { child: field } };
    expect(() => validateContentDefinition({ fields: { root: field } })).toThrow();
    expect(() => validateContentData(gearExample, { notes: 'x'.repeat(250001) })).toThrow('250,000');
  });
  it('treats folders as logical paths, rejecting OS paths and traversal', () => {
    for (const value of ['', 'Rules/Core', '世界/Places']) expect(validateContentFolder(value)).toBe(value);
    for (const value of ['../private', 'a//b', '/absolute', 'C:\\secret', 'a/../b', 'a/']) expect(() => validateContentFolder(value)).toThrow();
  });
  it('rejects client authority and requires both revisions on partial updates', () => {
    expect(contentUpdateSchema.safeParse({ projectId: 'p', id: 'i', changes: {} }).success).toBe(false);
    expect(contentTypeSaveSchema.safeParse({ projectId: 'p', key: 'gear', extension: 'gear', name: 'Gear', definition: gearExample, role: 'gm' }).success).toBe(false);
  });
});
