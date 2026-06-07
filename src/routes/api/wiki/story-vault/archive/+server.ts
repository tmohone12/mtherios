import { apiError } from '$lib/server/memory/http';
import { executeLegacyEngineCommand } from '$lib/server/engine/routeCompatibility';
import type { RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const storyId = url.searchParams.get('storyId')?.trim() ?? '';
		if (!storyId) throw new Error('storyId is required.');
		const archive = await executeLegacyEngineCommand({
			storyId,
			command: 'wiki.storyVault.archive',
			args: { storyId },
		}) as {
			bytes: Uint8Array;
			filename: string;
			storyId: string;
			status: { serverVersion: number };
			materialized: boolean;
		};
		const body = archive.bytes.buffer.slice(
			archive.bytes.byteOffset,
			archive.bytes.byteOffset + archive.bytes.byteLength,
		) as ArrayBuffer;
		return new Response(body, {
			headers: {
				'Content-Type': 'application/zip',
				'Content-Disposition': `attachment; filename="${archive.filename.replace(/"/g, '')}"`,
				'Content-Length': String(archive.bytes.byteLength),
				'X-Mtherios-Story-Id': archive.storyId,
				'X-Mtherios-Server-Version': String(archive.status.serverVersion),
				'X-Mtherios-Vault-Materialized': archive.materialized ? 'true' : 'false',
			},
		});
	} catch (error) {
		return apiError(error);
	}
};
