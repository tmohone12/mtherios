import { json, type RequestHandler } from '@sveltejs/kit';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError } from '$lib/server/memory/http';

function bodyRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = bodyRecord(await request.json().catch(() => ({})));
		const storyId = typeof body.storyId === 'string' ? body.storyId : '';
		const { storyId: _storyId, ...args } = body;
		return json(await executeLegacyEngineCommand({
			storyId,
			command: 'plotBrain.plan',
			args,
		}));
	} catch (error) {
		return apiError(error);
	}
};
