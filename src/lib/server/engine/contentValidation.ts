import { contentDefinitionSchema, type ContentDefinition, type ContentField } from '$lib/contracts/content';
import { assertSafeJson, MutationError } from './mutationSafety';

const fail = (message: string): never => { throw new MutationError('INVALID_CONTENT', message); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validateContentDefinition(raw: unknown): ContentDefinition {
  assertSafeJson(raw);
  const definition = contentDefinitionSchema.parse(raw);
  let count = 0;
  function fields(schema: Record<string, ContentField>, depth: number) {
    if (depth > 8) fail('Schemas may nest at most eight levels.');
    for (const [key, field] of Object.entries(schema)) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key)) fail(`Invalid field key: ${key}`);
      visit(field, depth);
    }
  }
  function visit(field: ContentField, depth: number) {
    if (++count > 200 || depth > 8) fail('Schema exceeds the field or nesting limit.');
    if (field.fields) fields(field.fields, depth + 1);
    if (field.items) visit(field.items, depth + 1);
  }
  fields(definition.fields, 0);
  const seen = new Set<string>();
  for (const section of definition.layout) for (const key of section.fields) {
    if (!Object.hasOwn(definition.fields, key) || seen.has(key)) fail(`Layout field missing or repeated: ${key}`);
    seen.add(key);
  }
  if (validateContentData(definition, definition.defaults, true).length) fail('Set document references on individual items, not in type defaults.');
  return definition;
}

export function validateContentData(definition: ContentDefinition, data: unknown, partial = false): string[] {
  assertSafeJson(data);
  if (JSON.stringify(data).length > 250000) fail('A document may contain at most 250,000 characters of structured data.');
  const refs: string[] = [];
  function fields(schema: Record<string, ContentField>, value: unknown, path: string) {
    if (!object(value)) fail(`${path} must be an object.`);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) if (!Object.hasOwn(schema, key)) fail(`Unknown field: ${path}.${key}`);
    for (const [key, field] of Object.entries(schema)) {
      if (!Object.hasOwn(record, key)) { if (field.required && !partial) fail(`Required field: ${path}.${key}`); continue; }
      check(field, record[key], `${path}.${key}`);
    }
  }
  function check(field: ContentField, value: unknown, path: string) {
    switch (field.kind) {
      case 'text': case 'longtext': if (typeof value !== 'string') fail(`${path} must be text.`); break;
      case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number.`); break;
      case 'boolean': if (typeof value !== 'boolean') fail(`${path} must be true or false.`); break;
      case 'enum': if (typeof value !== 'string' || !field.options?.includes(value)) fail(`${path} is not an allowed choice.`); break;
      case 'object': fields(field.fields!, value, path); break;
      case 'array': if (!Array.isArray(value) || value.length > 2000) fail(`${path} must be an array of at most 2,000 items.`); (value as unknown[]).forEach((entry, index) => check(field.items!, entry, `${path}[${index}]`)); break;
      case 'reference': if (!object(value) || Object.keys(value).length !== 1 || typeof value.itemId !== 'string' || !value.itemId || value.itemId.length > 200) fail(`${path} must contain only an itemId.`); refs.push((value as { itemId: string }).itemId); break;
    }
  }
  fields(definition.fields, data, 'data');
  return [...new Set(refs)];
}

export function validateContentFolder(folder: string): string {
  if (folder && folder.split('/').some(part => !/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,79}$/u.test(part))) fail('Use folder names separated by /; traversal, empty segments and filesystem paths are not allowed.');
  return folder;
}
