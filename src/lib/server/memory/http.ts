import { json, type RequestEvent } from '@sveltejs/kit';
import { ZodError, type ZodType } from 'zod';
import { BackendNotConfiguredError } from '$lib/server/env';

export async function readJson<T>(event: RequestEvent, schema: ZodType<T>): Promise<T> {
	const body = await event.request.json().catch(() => {
		throw new Error('Request body must be valid JSON.');
	});
	return schema.parse(body);
}

export function apiError(error: unknown) {
	if (error instanceof BackendNotConfiguredError) {
		return json({ error: error.message, code: 'BACKEND_NOT_CONFIGURED' }, { status: 503 });
	}
	if (error instanceof Error && error.name === 'TerminalLlmNotConfiguredError') {
		return json({ error: error.message, code: 'TERMINAL_LLM_NOT_CONFIGURED' }, { status: 503 });
	}
	if (error instanceof ZodError) {
		return json({ error: 'Invalid request payload.', issues: error.issues }, { status: 400 });
	}
	if (error instanceof Error) {
		if (/^Story not found:/i.test(error.message)) {
			return json({ error: error.message }, { status: 404 });
		}
		return json({ error: error.message }, { status: 500 });
	}
	return json({ error: 'Unknown server error.' }, { status: 500 });
}
