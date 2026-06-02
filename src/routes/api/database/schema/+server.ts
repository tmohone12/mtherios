import { json, type RequestHandler } from '@sveltejs/kit';
import { TERMINAL_WORLD_DATABASE_SCHEMA } from '$lib/server/db/worldDatabaseSchema';

export const GET: RequestHandler = async () => {
	return json(TERMINAL_WORLD_DATABASE_SCHEMA);
};
