import { json, type RequestHandler } from '@sveltejs/kit';
import { enqueueBackendJob } from '$lib/server/jobs/outbox';
import { getBackendJobStats, runBackendJobNow } from '$lib/server/jobs/processor';
import { apiError } from '$lib/server/memory/http';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({})) as Record<string, unknown>;
		const storyId = typeof body.storyId === 'string' && body.storyId.trim()
			? body.storyId.trim()
			: '';
		if (!storyId) throw new Error('storyId is required.');

		const requestedAt = new Date().toISOString();
		const workerId = typeof body.workerId === 'string' && body.workerId.trim()
			? body.workerId.trim()
			: `manual_world_sim_${Date.now()}`;
		const force = body.force !== false;
		const before = await getBackendJobStats(storyId);
		const jobId = await enqueueBackendJob({
			storyId,
			type: 'evaluate_world_sim_tick',
			payload: {
				force,
				manual: true,
				requestedAt,
				clientVersion: typeof body.localVersion === 'number' ? body.localVersion : null,
			},
			metadata: {
				source: 'frontend_manual_world_sim',
				requestedAt,
			},
			maxAttempts: 2,
		});
		const job = await runBackendJobNow(jobId, workerId);
		const after = await getBackendJobStats(storyId);

		return json({
			ok: job.completed,
			storyId,
			jobId,
			workerId,
			before,
			after,
			job,
		});
	} catch (error) {
		return apiError(error);
	}
};
