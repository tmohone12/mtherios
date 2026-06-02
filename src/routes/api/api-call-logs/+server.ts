import { json, type RequestHandler } from '@sveltejs/kit';
import { apiCallLogCreateSchema } from '$lib/contracts/engine';
import { listApiCallLogs, recordApiCallLog } from '$lib/server/engine/apiCallLogs';
import { apiError, readJson } from '$lib/server/memory/http';

function positiveInteger(value: string | null, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const logs = await listApiCallLogs({
			storyId: url.searchParams.get('storyId'),
			status: url.searchParams.get('status'),
			serviceId: url.searchParams.get('serviceId'),
			limit: positiveInteger(url.searchParams.get('limit'), 100),
		});
		return json({ logs });
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, apiCallLogCreateSchema);
		const log = await recordApiCallLog(request);
		return json({ logged: Boolean(log), log });
	} catch (error) {
		return apiError(error);
	}
};
