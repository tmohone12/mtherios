import { json, type RequestHandler } from '@sveltejs/kit';
import { reindexStoryRequestSchema } from '$lib/contracts/engine';
import { enqueueBackendJob } from '$lib/server/jobs/outbox';
import { runBackendJobNow } from '$lib/server/jobs/processor';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, reindexStoryRequestSchema);
		const jobId = await enqueueBackendJob({
			storyId: request.storyId,
			type: 'index_canonical_records',
			dedupeKey: `manual-canonical-index-${request.storyId}-${request.recordTypes.join('-') || 'all'}-${request.recreate ? 'recreate' : 'update'}`,
			payload: {
				recordTypes: request.recordTypes,
				recreate: request.recreate,
				provider: request.provider,
				model: request.model,
				reason: 'manual_reindex_api',
			},
			maxAttempts: 3,
		});
		const job = request.runNow ? await runBackendJobNow(jobId, `manual_reindex_${Date.now()}`) : null;
		return json({ ok: job ? job.completed : true, storyId: request.storyId, jobId, job });
	} catch (error) {
		return apiError(error);
	}
};
