import { json, type RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import { apiError, readJson } from '$lib/server/memory/http';

const campaignPageWriteRequestSchema = z.object({
	kind: z.string().min(1),
	name: z.string().min(1),
	title: z.string().nullable().optional(),
	body: z.string().default(''),
	tags: z.array(z.string()).default([]),
	entityIds: z.array(z.string()).default([]),
	factionIds: z.array(z.string()).default([]),
	sourceEntryIds: z.array(z.string()).default([]),
	sourceEventIds: z.array(z.string()).default([]),
	sourcePatchIds: z.array(z.string()).default([]),
	path: z.string().nullable().optional(),
	metadata: z.record(z.string(), z.unknown()).default({}),
	serverVersion: z.number().int().positive().optional(),
});

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		if (!params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const kind = url.searchParams.get('kind');
		if (!kind) return json({ error: 'Missing page kind.' }, { status: 400 });
		return json(await executeLegacyEngineCommand({
			storyId: params.id,
			command: 'campaign.page.read',
			args: {
			kind,
			name: url.searchParams.get('name'),
				path: url.searchParams.get('path'),
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		if (!event.params.id) return json({ error: 'Missing story id.' }, { status: 400 });
		const input = await readJson(event, campaignPageWriteRequestSchema);
		return json(await executeLegacyEngineCommand({
			storyId: event.params.id,
			command: 'campaign.page.write',
			args: {
				...input,
				path: input.path ?? null,
			},
		}));
	} catch (error) {
		return apiError(error);
	}
};

export const PATCH = POST;
