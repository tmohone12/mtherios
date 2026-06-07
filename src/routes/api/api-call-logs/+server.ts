import { json, type RequestHandler } from '@sveltejs/kit';
import { apiCallLogCreateSchema } from '$lib/contracts/engine';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

function positiveInteger(value: string | null, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const storyId = url.searchParams.get('storyId')?.trim() || null;
		return json(await executeLegacyEngineCommand({
			storyId: storyId ?? '__app__',
			command: 'apiCallLogs.list',
			args: {
				status: url.searchParams.get('status') || null,
				serviceId: url.searchParams.get('serviceId') || null,
				limit: positiveInteger(url.searchParams.get('limit'), 100),
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, apiCallLogCreateSchema);
		return json(await executeLegacyEngineCommand({
			storyId: request.storyId ?? '__app__',
			command: 'apiCallLogs.record',
			args: request,
		}));
	} catch (error) {
		return apiError(error);
	}
};
