import { z } from 'zod';
import type { RequestHandler } from './$types';
import { readImageAsset } from '$lib/server/engine/imageAssets';
import { MutationError } from '$lib/server/engine/mutationSafety';

const scopeSchema = z.object({ projectId: z.string().min(1).max(200), gameId: z.string().min(1).max(200).optional() }).strict();

/** The local author UI uses a same-origin POST; private bytes never receive a public image URL. */
export const POST: RequestHandler = async ({ params, request, url }) => {
  if (request.headers.get('origin') !== url.origin ||
      !['same-origin', 'none', null].includes(request.headers.get('sec-fetch-site')))
    return new Response('Same-origin author access required.', { status: 403 });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || params.assetId.length > 200)
    return new Response('Invalid image preview request.', { status: 400 });
  const parsed = scopeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response('Invalid image scope.', { status: 400 });
  try {
    const { asset, bytes } = await readImageAsset({ ...parsed.data, assetId: params.assetId });
    return new Response(Buffer.from(bytes), {
      headers: {
        'Content-Type': asset.media_type,
        'Content-Length': String(asset.byte_size),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof MutationError) return new Response('Image not found.', { status: 404 });
    throw error;
  }
};
