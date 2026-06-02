import { json, type RequestHandler } from '@sveltejs/kit';
import { listWorldRecordTypes, listWorldRecords } from '$lib/server/engine/worldRecords';
import { apiError } from '$lib/server/memory/http';

function positiveInteger(value: string | null, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		if (!params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const type = url.searchParams.get('type') ?? 'entities';
		return json({
			types: listWorldRecordTypes(),
			...(await listWorldRecords(params.id, {
				type,
				q: url.searchParams.get('q') ?? '',
				cursor: url.searchParams.get('cursor'),
				limit: positiveInteger(url.searchParams.get('limit'), 50),
			})),
		});
	} catch (error) {
		return apiError(error);
	}
};
