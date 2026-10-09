import { hasStrategicPlotContent, strategicWorldFrameSchema } from '$lib/services/ai/sdk/schemas/strategicWorldBrain';
import { hasResolvedStrategicFrameActivation } from '$lib/services/ai/context/strategicFramePromptCard';
import {
	isPlotBrainFrameFresh,
	PLOT_BRAIN_REFRESH_AFTER_TURNS,
	PLOT_BRAIN_STALE_AFTER_TURNS,
} from '$lib/services/ai/context/plotBrainFreshness';

export {
	isPlotBrainFrameFresh,
	PLOT_BRAIN_REFRESH_AFTER_TURNS,
	PLOT_BRAIN_STALE_AFTER_TURNS,
} from '$lib/services/ai/context/plotBrainFreshness';

type JsonRecord = Record<string, unknown>;

export interface PlotBrainLifecycleState {
	hasFrame: boolean;
	hasPendingFrame: boolean;
	hasStoredPendingFrame: boolean;
	active: boolean;
	fresh: boolean;
	quiet: boolean;
	quietUntilTurn: number | null;
	lastFrameTurn: number | null;
	shouldPlan: boolean;
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function finiteTurn(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

export function plotBrainLifecycleState(
	metadataValue: unknown,
	currentTurn: number,
	staleAfterTurns = PLOT_BRAIN_STALE_AFTER_TURNS,
	serverVersion?: number,
): PlotBrainLifecycleState {
	const metadata = asRecord(metadataValue);
	const plotBrain = asRecord(metadata.plotBrain);
	const frameValue = plotBrain.lastFrame ?? metadata.strategicWorldFrame;
	const hasFrame = hasStrategicPlotContent(frameValue);
	const parsedFrame = strategicWorldFrameSchema.safeParse(frameValue);
	const activationDeclared = Array.isArray(asRecord(asRecord(frameValue).activationPlan).activateNow);
	const hasValidActivation = parsedFrame.success
		&& (!activationDeclared
			? parsedFrame.data.plotCards.length > 0
			: hasResolvedStrategicFrameActivation(parsedFrame.data));
	const pendingFrameStored = Boolean(plotBrain.pendingFrameId)
		|| Object.keys(asRecord(plotBrain.pendingFrame)).length > 0;
	const pendingBaseServerVersion = finiteTurn(plotBrain.pendingBaseServerVersion);
	const hasPendingFrame = pendingFrameStored
		&& (serverVersion === undefined || pendingBaseServerVersion === serverVersion);
	const active = plotBrain.active !== false && hasValidActivation;
	const lastFrameTurn = finiteTurn(plotBrain.lastFrameTurn);
	const quietUntilTurn = finiteTurn(plotBrain.quietUntilTurn);
	const quiet = plotBrain.active === false
		&& quietUntilTurn !== null
		&& currentTurn <= quietUntilTurn;
	const hardFresh = hasFrame && isPlotBrainFrameFresh(plotBrain, currentTurn, staleAfterTurns);
	const refreshAfterTurns = Math.min(PLOT_BRAIN_REFRESH_AFTER_TURNS, Math.max(0, staleAfterTurns - 1));
	const fresh = hardFresh
		&& (plotBrain.active === false || hasValidActivation)
		&& plotBrain.needsDevelopment !== true
		&& lastFrameTurn !== null
		&& currentTurn - lastFrameTurn <= refreshAfterTurns;
	return {
		hasFrame,
		hasPendingFrame,
		hasStoredPendingFrame: pendingFrameStored,
		active,
		fresh,
		quiet,
		quietUntilTurn,
		lastFrameTurn,
		shouldPlan: !fresh && !hasPendingFrame && !quiet,
	};
}

export function playerRequestsPlotRetirement(text: string): boolean {
	const normalized = text.normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
	if (!normalized) return false;
	const plotTarget = '(?:plot(?:line)?|story[ -]?line|story thread|plot director(?: plan| thread| pressure)?)';
	const specifier = '(?:this|that|the(?: current)?|current)?';
	return [
		new RegExp(`\\b(?:stop|drop|retire|abandon|sideline|ditch|scrap|remove|ignore|end)\\s+${specifier}\\s*${plotTarget}s?\\b`, 'i'),
		new RegExp(`\\b(?:do not|don't|dont)\\s+(?:continue|use|push|follow)\\s+${specifier}\\s*${plotTarget}s?\\b`, 'i'),
		new RegExp(`\\b(?:i am|i'm|im)\\s+not interested in\\s+${specifier}\\s*${plotTarget}s?\\b`, 'i'),
		new RegExp(`\\b(?:this|that|the current)\\s+${plotTarget}\\s+(?:is lame|is not working|isn't working|needs to stop)\\b`, 'i'),
		/\b(?:skip|drop|ditch|scrap)\s+(?:the\s+)?[\p{L}\p{N}' -]{1,40}\s+(?:nonsense|business|thread|arc|plot|storyline)\b/iu,
		/\b(?:this|that|the current)\s+(?:bit|business|thread|arc|plot|storyline|nonsense)\s+(?:is\s+)?(?:done|finished|over|going in circles)\b/i,
		/\b(?:stop|quit)\s+(?:bringing|circling|looping|repeating|pushing)\b/i,
	].some(pattern => pattern.test(normalized));
}

export function collectRetiredPlotDirectives(frameValue: unknown, existingValue: unknown = []): string[] {
	const frame = asRecord(frameValue);
	const values = Array.isArray(existingValue)
		? existingValue.filter((value): value is string => typeof value === 'string')
		: [];
	for (const collection of [frame.mainPlots, frame.subplots, frame.plotCards]) {
		if (!Array.isArray(collection)) continue;
		for (const item of collection) {
			const record = asRecord(item);
			for (const candidate of [record.title, record.name, record.logline]) {
				if (typeof candidate === 'string' && candidate.trim()) values.push(candidate.trim().slice(0, 320));
			}
		}
	}
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = value.toLocaleLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).slice(-16);
}
