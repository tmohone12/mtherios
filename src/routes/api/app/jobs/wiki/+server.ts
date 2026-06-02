import { json, type RequestHandler } from '@sveltejs/kit';
import { enqueueBackendJob } from '$lib/server/jobs/outbox';
import { getBackendJobStats, runBackendJobNow } from '$lib/server/jobs/processor';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { apiError } from '$lib/server/memory/http';
import { listStoryVaultFreshnessItems } from '$lib/server/wiki/storyVault';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json().catch(() => ({})) as Record<string, unknown>;
		const runBulk = body.all === true || body.storyId === '*' || body.storyId === 'all';
		const storyId = typeof body.storyId === 'string' ? body.storyId.trim() : '';
		if (!storyId && !runBulk) throw new Error('storyId is required.');

		const workerId = typeof body.workerId === 'string' && body.workerId.trim()
			? body.workerId.trim()
			: `manual_wiki_${Date.now()}`;
		if (runBulk) {
			const runNow = body.runNow === true;
			const items = await listStoryVaultFreshnessItems(getMtheriosAppConfig(), readLimit(body.limit, 500));
			const selected = items.filter((item) =>
				body.includeFresh === true ||
				!item.vaultFresh ||
				(body.index === true && !item.indexFresh) ||
				(body.lint === true && !item.lintFresh)
			);
			const before = await getBackendJobStats();
			const jobs = [];
			for (const item of selected) {
				const jobId = await enqueueBackendJob({
					storyId: item.storyId,
					type: 'sync_story_vault',
					dedupeKey: `manual-wiki-${item.storyId}-${item.serverVersion}-${body.index === true ? 'index' : 'sync'}-${body.lint === true ? 'lint' : 'nolint'}`,
					payload: wikiJobPayload(body, 'manual_bulk_api'),
					maxAttempts: 3,
				});
				const job = runNow ? await runBackendJobNow(jobId, workerId) : null;
				jobs.push({
					storyId: item.storyId,
					storyTitle: item.storyTitle,
					jobId,
					job,
				});
			}
			const after = await getBackendJobStats();

			return json({
				ok: jobs.every((row) => !row.job || row.job.completed),
				mode: 'bulk',
				workerId,
				selected: selected.length,
				queued: jobs.length,
				runNow,
				before,
				after,
				jobs,
			});
		}

		const runNow = body.runNow !== false;
		const before = await getBackendJobStats(storyId);
		const jobId = await enqueueBackendJob({
			storyId,
			type: 'sync_story_vault',
			payload: wikiJobPayload(body, 'manual_api'),
			maxAttempts: 3,
		});
		const job = runNow ? await runBackendJobNow(jobId, workerId) : null;
		const after = await getBackendJobStats(storyId);

		return json({
			ok: job ? job.completed : true,
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

function wikiJobPayload(body: Record<string, unknown>, reason: string): Record<string, unknown> {
	return {
		index: body.index === true,
		recreate: body.recreate === true,
		dryRun: body.dryRun === true,
		clean: body.clean !== false,
		lint: body.lint === true,
		thinChars: typeof body.thinChars === 'number' ? body.thinChars : null,
		orphanLayer: body.orphanLayer === 'all' ? 'all' : 'derived',
		provider: typeof body.provider === 'string' ? body.provider : null,
		model: typeof body.model === 'string' ? body.model : null,
		reason,
	};
}

function readLimit(value: unknown, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(1000, Math.trunc(value)));
}
