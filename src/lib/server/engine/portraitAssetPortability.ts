import { z } from 'zod';
import { locationMapAssetExportSchema } from '$lib/contracts/worldDatabase';
import { readImageAsset } from './imageAssets';

type Scope = { projectId: string; gameId: string };

export function portraitAssetUrl(assetId: string, scope: Scope): string {
  return `/api/assets/${assetId}?projectId=${encodeURIComponent(scope.projectId)}&gameId=${encodeURIComponent(scope.gameId)}`;
}

function scopedAssetId(value: unknown, scope: Scope): string | null {
  if (typeof value !== 'string') return null;
  const match = /^\/api\/assets\/([0-9a-f-]{36})\?/.exec(value);
  return match && value === portraitAssetUrl(match[1], scope) ? match[1] : null;
}

/** Only exact, locally generated scoped asset URLs are portable portrait references. */
export function collectPortraitAssetIds(values: unknown[], scope: Scope): Set<string> {
  const result = new Set<string>();
  const visit = (value: unknown): void => {
    const assetId = scopedAssetId(value, scope);
    if (assetId) { result.add(assetId); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
      for (const child of Object.values(value)) visit(child);
  };
  for (const value of values) visit(value);
  return result;
}

export function remapPortraitAssetUrls<T>(value: T, source: Scope, destination: Scope, assetIds: ReadonlyMap<string, string>): T {
  const visit = (entry: unknown): unknown => {
    const assetId = scopedAssetId(entry, source);
    if (assetId) {
      const importedId = assetIds.get(assetId);
      if (!importedId) throw new Error(`Portrait asset ${assetId} is missing from the bundle or moved game.`);
      return portraitAssetUrl(importedId, destination);
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && typeof entry === 'object' && Object.getPrototypeOf(entry) === Object.prototype)
      return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, visit(child)]));
    return entry;
  };
  return visit(value) as T;
}

export async function exportPortraitAssets(scope: Scope, values: unknown[]) {
  const ids = collectPortraitAssetIds(values, scope);
  if (ids.size > 500) throw new Error('Too many portrait assets for one bundle.');
  const result = [];
  for (const assetId of ids) {
    const { asset, bytes } = await readImageAsset({ ...scope, assetId });
    if (asset.visibility !== 'public') throw new Error('Portrait asset is no longer public.');
    result.push({ id: asset.id, visibility: 'public', mediaType: asset.media_type,
      sha256: asset.sha256, bytesBase64: Buffer.from(bytes).toString('base64') });
  }
  return z.array(locationMapAssetExportSchema).max(500).parse(result);
}
