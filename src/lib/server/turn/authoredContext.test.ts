import { describe, expect, it } from 'vitest';
import { compileAuthoredGmContext } from './authoredContext';

const scope = { projectId: 'project', projectRevision: 1, gameId: 'game', branchId: null, povCharacter: null };
const row = (id: string, mode: 'pinned' | 'partial' | 'searchable') => ({
	id, kind: 'rules', title: `${mode} title`, description: `${mode} description`,
	data: { secret: `${mode}_BODY` }, mode, item_revision: 4, type_revision: 2,
	source_revision: null, branch_id: null, pov_character: null,
});

describe('authored GM context', () => {
	it('keeps Searchable out of preload and Partial free of authored body', () => {
		const result = compileAuthoredGmContext([
			row('content:pinned', 'pinned'), row('content:partial', 'partial'), row('content:search', 'searchable'),
		], scope);
		expect(result.records.map(record => record.id)).toEqual(['content:pinned@4', 'content:partial@4']);
		expect(result.records[0].text).toContain('pinned_BODY');
		expect(result.records[1].text).toContain('partial description');
		expect(result.records[1].text).not.toContain('partial_BODY');
		expect(JSON.stringify(result.records)).not.toContain('searchable_BODY');
	});

	it('changes freshness when a shared type or project revision changes', () => {
		const before = compileAuthoredGmContext([row('content:one', 'searchable')], scope).fingerprint;
		expect(compileAuthoredGmContext([{ ...row('content:one', 'searchable'), type_revision: 3 }], scope).fingerprint).not.toBe(before);
		expect(compileAuthoredGmContext([row('content:one', 'searchable')], { ...scope, projectRevision: 2 }).fingerprint).not.toBe(before);
	});
});
