type JsonRecord = Record<string, unknown>;

export const PLOT_BRAIN_STALE_AFTER_TURNS = 12;
export const PLOT_BRAIN_REFRESH_AFTER_TURNS = 8;

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function finiteTurn(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

export function isPlotBrainFrameFresh(
	plotBrainValue: unknown,
	currentTurn: number,
	staleAfterTurns = PLOT_BRAIN_STALE_AFTER_TURNS,
): boolean {
	const plotBrain = asRecord(plotBrainValue);
	if (plotBrain.active === false) return false;
	const lastFrameTurn = finiteTurn(plotBrain.lastFrameTurn);
	return lastFrameTurn !== null && currentTurn - lastFrameTurn <= staleAfterTurns;
}
