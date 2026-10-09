import { describe, expect, it } from 'vitest';
import { recordPatchRequestSchema } from '$lib/contracts/engine';
import { assertExpectedRevision, mergeJsonUpdate, validateRecordField } from './mutationSafety';

describe('canonical mutation safety', () => {
	it('requires the loaded revision and reports a structured stale-write conflict', () => {
		const record = { server_version: 12 };
		expect(() => assertExpectedRevision(record, { updates: {}, reason: 'test' })).toThrow(expect.objectContaining({ code: 'REVISION_REQUIRED' }));
		expect(() => assertExpectedRevision(record, { updates: {}, reason: 'test', expectedVersion: 11 })).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT', details: { expected: 11, actual: 12 } }));
		expect(() => assertExpectedRevision(record, { updates: {}, reason: 'test', expectedVersion: 12 })).not.toThrow();
		expect(() => assertExpectedRevision({ updated_at: 'new' }, { updates: {}, reason: 'test', expectedUpdatedAt: 'old' }, false)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
	});
	it('merges nested edits without losing siblings and retains explicit clears', () => {
		const before = { bio: 'Original', stats: { hp: 12, ac: 16 }, buffs: ['Ward'] };
		expect(mergeJsonUpdate(before, { stats: { hp: 10 }, buffs: [] })).toEqual({ bio: 'Original', stats: { hp: 10, ac: 16 }, buffs: [] });
		expect(before.stats.hp).toBe(12);
		expect(mergeJsonUpdate(before, { bio: null })).toEqual({ ...before, bio: null });
		expect(() => mergeJsonUpdate(before, JSON.parse('{"stats":{"__proto__":{"polluted":true}}}'))).toThrow('Unsupported structured key');
	});
	it('rejects invalid field shapes and caller-supplied authority', () => {
		expect(() => validateRecordField('entities', 'state', [], true)).toThrow('Invalid value');
		expect(() => validateRecordField('entities', 'source_entry_ids', [4], true)).toThrow('Invalid value');
		expect(() => validateRecordField('events', 'occurred_turn', 0.5, false)).toThrow('Invalid value');
		expect(() => validateRecordField('relationships', 'bidirectional', 'yes', false)).toThrow('Invalid value');
		expect(() => recordPatchRequestSchema.parse({ updates: {}, actor: { role: 'human' } })).toThrow();
	});
});
