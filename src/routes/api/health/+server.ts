import { json, type RequestHandler } from '@sveltejs/kit';
import { executeEngineCommand } from '$lib/server/engine/command';
import { apiError } from '$lib/server/memory/http';

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export const GET: RequestHandler = async () => {
	try {
		const response = await executeEngineCommand({
			storyId: '__app__',
			command: 'app.health',
			args: {},
		});
		if (response.status === 'failed') throw new Error(response.error ?? 'Backend health command failed.');
		const body = asRecord(response.result);
		return json(body, { status: body.configured === false ? 503 : 200 });
	} catch (error) {
		return apiError(error);
	}
};
