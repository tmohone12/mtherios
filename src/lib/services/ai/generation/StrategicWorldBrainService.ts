/**
 * StrategicWorldBrainService - rare, expensive arc-level strategic planner.
 *
 * It sets faction/scheme/plot pressure for the next arc, while the cheaper
 * WorldSimulationService executes immediate visible moves inside that frame.
 */

import { BaseAIService } from '../BaseAIService';
import { strategicWorldFrameSchema } from '../sdk/schemas/strategicWorldBrain';
import { createLogger } from '../core/config';
import { uuid } from '$lib/utils/uuid';
import type { StrategicWorldFrame } from '$lib/types';
import {
	buildStrategicWorldBrainSystemPrompt,
	buildStrategicWorldBrainUserPrompt,
	frameChapterRange,
	type StrategicWorldBrainInput,
} from '../context/strategicWorldBrainInput';

const log = createLogger('StrategicWorldBrain');

function compactCard(value: string, fallback: string): string {
	const text = (value || fallback).replace(/\s+\n/g, '\n').trim();
	if (text.length <= 4200) return text;
	return `${text.slice(0, 4197).trimEnd()}...`;
}

function fallbackCard(frame: Pick<StrategicWorldFrame, 'publicSummary' | 'worldMood' | 'mainPlots' | 'strategicClocks'>): string {
	const plots = frame.mainPlots.slice(0, 3).map(plot => `- ${plot.title}: ${plot.summary}`).join('\n');
	const clocks = frame.strategicClocks.slice(0, 3).map(clock => `- ${clock.name}: ${clock.currentPhase}`).join('\n');
	return [
		'STRATEGIC WORLD PRESSURE:',
		frame.publicSummary,
		`Political temperature: ${frame.worldMood.politicalTemperature}.`,
		plots ? `Key plot pressure:\n${plots}` : '',
		clocks ? `Strategic clocks:\n${clocks}` : '',
		'Use as background pressure only. Do not reveal hidden plans without scene evidence or player investigation.',
	].filter(Boolean).join('\n');
}

export class StrategicWorldBrainService extends BaseAIService {
	constructor() {
		super('strategicWorldBrain');
	}

	async plan(input: StrategicWorldBrainInput): Promise<StrategicWorldFrame> {
		log('plan', {
			trigger: input.trigger,
			arc: input.currentArc?.arcNumber,
			factions: input.factions.length,
			schemes: input.activeSchemes.length,
			threads: input.storyThreads.length,
		});

		const result = await this.generateStructured(
			strategicWorldFrameSchema,
			buildStrategicWorldBrainSystemPrompt(),
			buildStrategicWorldBrainUserPrompt(input),
		);

		const chapterRange = frameChapterRange(input);
		const parsedFrame = result as unknown as StrategicWorldFrame;
		const frame: StrategicWorldFrame = {
			...parsedFrame,
			id: result.id || uuid(),
			storyId: input.story.id,
			arcId: input.currentArc?.id ?? result.arcId ?? null,
			arcNumber: input.currentArc?.arcNumber ?? result.arcNumber,
			trigger: input.trigger,
			chapterRange: result.chapterRange.from || result.chapterRange.to ? result.chapterRange : chapterRange,
			createdAt: Date.now(),
			factionOperations: result.factionOperations.map((operation, index) => ({
				...operation,
				id: operation.id || `${result.arcNumber || input.currentArc?.arcNumber || 0}-op-${index + 1}-${uuid().slice(0, 8)}`,
			})),
			narratorPromptCard: compactCard(result.narratorPromptCard, fallbackCard(parsedFrame)),
			fastWorldSimInstructions: compactCard(
				result.fastWorldSimInstructions,
				result.narratorPromptCard || fallbackCard(parsedFrame),
			),
		};

		return frame;
	}
}
