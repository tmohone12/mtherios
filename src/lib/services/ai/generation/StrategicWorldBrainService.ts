/**
 * StrategicWorldBrainService - rare, expensive arc-level strategic planner.
 *
 * It sets faction/scheme/plot pressure for the next arc, while the cheaper
 * WorldSimulationService executes immediate visible moves inside that frame.
 */

import { BaseAIService } from '../BaseAIService';
import { strategicWorldFrameSchema } from '../sdk/schemas/strategicWorldBrain';
import { createLogger } from '../core/config';
import type { StrategicWorldFrame } from '$lib/types';
import {
	buildStrategicWorldBrainSystemPrompt,
	buildStrategicWorldBrainUserPrompt,
	type StrategicWorldBrainInput,
} from '../context/strategicWorldBrainInput';
import { finalizeStrategicWorldFrame } from './strategicWorldFrame';

const log = createLogger('StrategicWorldBrain');

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

		return finalizeStrategicWorldFrame(input, result as unknown as StrategicWorldFrame);
	}
}
