import { json, type RequestHandler } from '@sveltejs/kit';
import { runDueBackendJobs, getBackendJobStats } from '$lib/server/jobs/processor';
import { apiError } from '$lib/server/memory/http';

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		const body = await request.json().catch(() => ({})) as Record<string, unknown>;
		const workerId = typeof body.workerId === 'string' && body.workerId.trim()
			? body.workerId.trim()
			: `terminal_${Date.now()}`;
		const limitValue = typeof body.limit === 'number'
			? body.limit
			: Number(url.searchParams.get('limit') ?? '10');
		const limit = Math.max(1, Math.min(100, Math.trunc(Number.isFinite(limitValue) ? limitValue : 10)));
		const storyId = typeof body.storyId === 'string' && body.storyId.trim()
			? body.storyId.trim()
			: url.searchParams.get('storyId');

		const before = await getBackendJobStats(storyId);
		const result = await runDueBackendJobs(workerId, limit, storyId);
		const after = await getBackendJobStats(storyId);
		return json({
			ok: true,
			workerId,
			limit,
			before,
			after,
			...result,
		});
	} catch (error) {
		return apiError(error);
	}
};
