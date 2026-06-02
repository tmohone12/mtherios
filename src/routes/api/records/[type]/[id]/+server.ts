import { json, type RequestHandler } from '@sveltejs/kit';
import { recordPatchRequestSchema } from '$lib/contracts/engine';
import { getWorldRecord, patchWorldRecord } from '$lib/server/engine/worldRecords';
import { apiError, readJson } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ params }) => {
	try {
		if (!params.type || !params.id) return json({ error: 'Missing record type or id.' }, { status: 400 });
		return json(await getWorldRecord(params.type, params.id));
	} catch (error) {
		return apiError(error);
	}
};

export const PATCH: RequestHandler = async (event) => {
	try {
		const { params } = event;
		if (!params.type || !params.id) return json({ error: 'Missing record type or id.' }, { status: 400 });
		const request = await readJson(event, recordPatchRequestSchema);
		return json(await patchWorldRecord(params.type, params.id, request));
	} catch (error) {
		return apiError(error);
	}
};
