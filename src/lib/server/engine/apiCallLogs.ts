import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { apiCallLogs } from '$lib/server/db/schema';
import { apiCallLogCreateSchema, type ApiCallLogCreate } from '$lib/contracts/engine';

function id(prefix = 'api_call'): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function cleanText(value: string | null | undefined, max = 500): string | null {
	const text = value?.trim();
	if (!text) return null;
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function redactEndpoint(endpoint: string | null | undefined): string | null {
	const text = cleanText(endpoint, 500);
	if (!text) return null;
	try {
		const url = new URL(text);
		url.username = '';
		url.password = '';
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		return text.replace(/[?].*$/, '').slice(0, 500);
	}
}

function optionalInt(value: number | null | undefined): number | null {
	return Number.isFinite(value) ? Math.trunc(value as number) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeApiCallLog(row: typeof apiCallLogs.$inferSelect) {
	const metadata = asRecord(row.metadata);
	return {
		...row,
		clientTurnId: optionalString(metadata.clientTurnId),
		statusCode: optionalNumber(metadata.statusCode),
		errorMessage: row.error,
	};
}

export async function recordApiCallLog(input: ApiCallLogCreate): Promise<Record<string, unknown> | null> {
	const parsed = apiCallLogCreateSchema.parse(input);
	try {
		const [row] = await getDb().insert(apiCallLogs).values({
			id: id(),
			storyId: parsed.storyId ?? null,
			serviceId: cleanText(parsed.serviceId, 120),
			operation: cleanText(parsed.operation, 180) ?? 'unknown',
			providerType: cleanText(parsed.providerType, 120),
			providerName: cleanText(parsed.providerName, 180),
			profileId: cleanText(parsed.profileId, 180),
			model: cleanText(parsed.model, 180),
			endpoint: redactEndpoint(parsed.endpoint),
			status: parsed.status,
			durationMs: Math.max(0, Math.trunc(parsed.durationMs)),
			requestTokens: optionalInt(parsed.requestTokens),
			responseTokens: optionalInt(parsed.responseTokens),
			totalTokens: optionalInt(parsed.totalTokens),
			promptChars: optionalInt(parsed.promptChars),
			responseChars: optionalInt(parsed.responseChars),
			error: cleanText(parsed.error, 2000),
			metadata: parsed.metadata,
		}).returning();
		return row as Record<string, unknown>;
	} catch (error) {
		console.warn('[api-call-log] failed to persist log:', error);
		return null;
	}
}

export async function listApiCallLogs(options: {
	storyId?: string | null;
	limit?: number;
	status?: string | null;
	serviceId?: string | null;
} = {}) {
	const filters = [];
	if (options.storyId) filters.push(eq(apiCallLogs.storyId, options.storyId));
	if (options.status) filters.push(eq(apiCallLogs.status, options.status));
	if (options.serviceId) filters.push(eq(apiCallLogs.serviceId, options.serviceId));
	const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));
	return getDb()
		.select()
		.from(apiCallLogs)
		.where(filters.length ? and(...filters) : undefined)
		.orderBy(desc(apiCallLogs.createdAt))
		.limit(limit)
		.then((rows) => rows.map(normalizeApiCallLog));
}
