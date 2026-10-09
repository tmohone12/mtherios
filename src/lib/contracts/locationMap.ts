import { z } from 'zod';

const id = z.string().trim().min(1).max(200);
const label = z.string().trim().min(1).max(160);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const mapPointSchema = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }).strict();
const shared = { id, label, layerId: id, order: z.number().int().min(0).max(10000), visibility: z.enum(['public', 'gm']) };
export const mapLayerSchema = z.object({ id, label, order: z.number().int().min(0).max(10000), visible: z.boolean() }).strict();
export const mapRegionSchema = z.object({ ...shared, kind: z.literal('region'), points: z.array(mapPointSchema).min(3).max(100),
  fill: color, stroke: color, locationId: id.nullable() }).strict();
export const mapPinSchema = z.object({ ...shared, kind: z.literal('pin'), point: mapPointSchema,
  color, locationId: id.nullable() }).strict();
export const mapTokenSchema = z.object({ ...shared, kind: z.literal('token'), point: mapPointSchema,
  color, entityId: id.nullable() }).strict();
export const locationMapBodySchema = z.object({ version: z.literal(1), width: z.number().int().min(256).max(8192),
  height: z.number().int().min(256).max(8192), backgroundAssetId: id.nullable(),
  layers: z.array(mapLayerSchema).min(1).max(30), regions: z.array(mapRegionSchema).max(200),
  pins: z.array(mapPinSchema).max(300), tokens: z.array(mapTokenSchema).max(300),
}).strict().superRefine((map, ctx) => {
  const layers = new Set<string>();
  for (const layer of map.layers) {
    if (layers.has(layer.id)) ctx.addIssue({ code: 'custom', message: 'Map layer IDs must be unique.' });
    layers.add(layer.id);
  }
  const objects = new Set<string>();
  for (const object of [...map.regions, ...map.pins, ...map.tokens]) {
    if (objects.has(object.id)) ctx.addIssue({ code: 'custom', message: 'Map object IDs must be unique.' });
    if (!layers.has(object.layerId)) ctx.addIssue({ code: 'custom', message: 'Every map object must belong to a layer.' });
    objects.add(object.id);
  }
  if (objects.size > 500) ctx.addIssue({ code: 'custom', message: 'A map can contain at most 500 objects.' });
  for (const region of map.regions) {
    const area = region.points.reduce((sum, point, index) => {
      const next = region.points[(index + 1) % region.points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0);
    if (Math.abs(area) < 0.000001) ctx.addIssue({ code: 'custom', message: 'A map region needs a nonzero area.' });
  }
});
export const emptyLocationMap = (): z.infer<typeof locationMapBodySchema> => ({
  version: 1, width: 1000, height: 1000, backgroundAssetId: null,
  layers: [{ id: 'base', label: 'Base', order: 0, visible: true }], regions: [], pins: [], tokens: [],
});
export const locationMapGetSchema = z.object({ locationId: id }).strict();
export const locationMapSaveSchema = locationMapGetSchema.extend({ expectedRevision: z.number().int().min(0),
  map: locationMapBodySchema, reason: z.string().trim().min(1).max(2000).default('Edit location map.') }).strict();
export type LocationMapBody = z.infer<typeof locationMapBodySchema>;
