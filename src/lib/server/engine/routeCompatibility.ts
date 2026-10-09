import { MutationError } from './mutationSafety';
import { executeEngineCommand } from './command';
import type { EngineCommandRequest } from '$lib/contracts/engine';

export async function executeLegacyEngineCommand(request: EngineCommandRequest): Promise<unknown> {
	const response = await executeEngineCommand(request);
	if (response.status === 'failed') {
		if (response.errorDetails) throw new MutationError(response.errorDetails.code, response.error ?? 'Mutation failed.', response.errorDetails.details);
		throw new Error(response.error ?? `Engine command failed: ${request.command}`);
	}
	return response.result;
}
