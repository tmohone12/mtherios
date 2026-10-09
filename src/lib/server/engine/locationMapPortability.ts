import { z } from 'zod';
import { locationMapAssetExportSchema } from '$lib/contracts/worldDatabase';
import { locationMapBodySchema } from '$lib/contracts/locationMap';
import { readImageAsset } from './imageAssets';

export async function exportLocationMapAssets(projectId: string, gameId: string, snapshots: unknown[]) {
  const ids = new Set<string>();
  for (const value of snapshots) {
    const map = locationMapBodySchema.parse(value);
    if (map.backgroundAssetId) ids.add(map.backgroundAssetId);
  }
  if (ids.size > 500) throw new Error('Too many map backgrounds for one bundle.');
  const result = [];
  for (const assetId of ids) {
    const { asset, bytes } = await readImageAsset({ projectId, gameId, assetId });
    if (asset.visibility !== 'public') throw new Error('Map background is no longer public.');
    result.push({ id: asset.id, visibility: 'public', mediaType: asset.media_type,
      sha256: asset.sha256, bytesBase64: Buffer.from(bytes).toString('base64') });
  }
  return z.array(locationMapAssetExportSchema).max(500).parse(result);
}
