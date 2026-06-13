import { turnResponseSchema, type TurnRequest, type TurnResponse } from '$lib/contracts/memory';
import type { EngineCommandRequest } from '$lib/contracts/engine';
import { executeEngineCommand, type EngineCommandHandlers } from './command';

export function buildTurnSubmitCommandRequest(request: TurnRequest): EngineCommandRequest {
	return {
		storyId: request.storyId,
		command: 'turn.submit',
		clientCommandId: request.clientTurnId,
		args: request,
	};
}

export async function executeTurnSubmitCommand(
	request: TurnRequest,
	handlers: EngineCommandHandlers = {},
): Promise<TurnResponse> {
	const response = await executeEngineCommand(buildTurnSubmitCommandRequest(request), handlers);
	if (response.status !== 'succeeded') {
		throw new Error(response.error || 'Engine turn command failed.');
	}
	return turnResponseSchema.parse(response.result);
}
