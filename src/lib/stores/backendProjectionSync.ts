export interface ProjectionRecord {
	id: string;
}

export interface ProjectionReconciliationPlan<T extends ProjectionRecord> {
	upserts: T[];
	deleteIds: string[];
	hasFullCoverage: boolean;
}

export function projectionReconciliationPlan<T extends ProjectionRecord>(
	localRows: ProjectionRecord[],
	projectedRows: T[],
	totalCount: number | null | undefined,
): ProjectionReconciliationPlan<T> {
	const count = typeof totalCount === 'number' && Number.isFinite(totalCount)
		? Math.max(0, Math.trunc(totalCount))
		: projectedRows.length;
	const hasFullCoverage = projectedRows.length >= count;
	const projectedIds = new Set(projectedRows.map((row) => row.id).filter(Boolean));
	return {
		upserts: projectedRows,
		deleteIds: hasFullCoverage
			? localRows.map((row) => row.id).filter((id) => id && !projectedIds.has(id))
			: [],
		hasFullCoverage,
	};
}
