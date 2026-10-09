import { expect, it } from 'vitest';
import { agentRunHash } from './agentRunHash';

it('keeps a reserved tool argument identity across PostgreSQL JSONB key reordering', () => {
  const proposed = { tool: 'update', args: { id: 'item', changes: { description: 'new', data: { b: 2, a: 1 } }, expectedRevision: 3 } };
  const stored = { args: { changes: { data: { a: 1, b: 2 }, description: 'new' }, expectedRevision: 3, id: 'item' }, tool: 'update' };
  expect(agentRunHash(proposed)).toBe(agentRunHash(stored));
  expect(agentRunHash(proposed)).not.toBe(agentRunHash({ ...stored, args: { ...stored.args, expectedRevision: 4 } }));
});
