import { json, type RequestHandler } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { backendJobs } from '$lib/server/db/schema';
import { getDb } from '$lib/server/db/client';
import { getBackendJobStats } from '$lib/server/jobs/processor';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const storyId = url.searchParams.get('storyId');
		const limit = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get('limit') ?? '80', 10) || 80));
		const rows = await getDb()
			.select()
			.from(backendJobs)
			.where(storyId ? eq(backendJobs.storyId, storyId) : undefined)
			.orderBy(desc(backendJobs.updatedAt))
			.limit(limit);
		return json({
			stats: await getBackendJobStats(storyId),
			jobs: rows,
		});
	} catch (error) {
		return apiError(error);
	}
};
