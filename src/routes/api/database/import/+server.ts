import { json, type RequestHandler } from '@sveltejs/kit';
import { worldDatabaseImportRequestSchema } from '$lib/contracts/worldDatabase';
import { importWorldDatabaseBundle } from '$lib/server/db/worldDatabaseImport';
import { apiError, readJson } from '$lib/server/memory/http';

export const POST: RequestHandler = async (event) => {
	try {
		const request = await readJson(event, worldDatabaseImportRequestSchema);
		return json(await importWorldDatabaseBundle(request));
	} catch (error) {
		return apiError(error);
	}
};
