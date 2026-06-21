import { describe, expect, it } from 'vitest';
import { projectionReconciliationPlan } from './backendProjectionSync';

describe('backend projection sync', () => {
	it('deletes stale local rows only when the backend projection has complete coverage', () => {
		const localRows = [
			{ id: 'chapter_1' },
			{ id: 'chapter_2' },
			{ id: 'chapter_old' },
		];
		const projectedRows = [
			{ id: 'chapter_1' },
			{ id: 'chapter_2' },
		];

		expect(projectionReconciliationPlan(localRows, projectedRows, 2)).toEqual({
			upserts: projectedRows,
			deleteIds: ['chapter_old'],
			hasFullCoverage: true,
		});
		expect(projectionReconciliationPlan(localRows, projectedRows, 50)).toEqual({
			upserts: projectedRows,
			deleteIds: [],
			hasFullCoverage: false,
		});
	});
});
