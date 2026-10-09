import type { RequestHandler } from './$types';
import { readImageAsset } from '$lib/server/engine/imageAssets';
import { MutationError } from '$lib/server/engine/mutationSafety';

export const GET: RequestHandler = async ({ params, url }) => {
  const projectId = url.searchParams.get('projectId') ?? '';
  const gameId = url.searchParams.get('gameId') ?? undefined;
  if (!projectId || projectId.length > 200 || (gameId && gameId.length > 200) || params.assetId.length > 200)
    return new Response('Invalid image scope.', { status: 400 });
  try {
    const { asset, bytes } = await readImageAsset({ projectId, gameId, assetId: params.assetId });
    if (asset.visibility !== 'public') return new Response('Image not found.', { status: 404 });
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
