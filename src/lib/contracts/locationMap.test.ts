import { describe, expect, it } from 'vitest';
import { emptyLocationMap, locationMapBodySchema } from './locationMap';

describe('location map document', () => {
  it('keeps coordinates bounded and rejects degenerate or overlarge polygons', () => {
    const map = emptyLocationMap();
    map.regions.push({ id: 'r', kind: 'region', label: 'R', layerId: 'base', order: 0, visibility: 'public',
      points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.2, y: 0.4 }], fill: '#ffffff', stroke: '#000000', locationId: null });
    expect(locationMapBodySchema.safeParse(map).success).toBe(true);
    map.regions[0].points[2].y = 0.1;
    expect(locationMapBodySchema.safeParse(map).success).toBe(false);
    map.regions[0].points[2].y = 1.1;
    expect(locationMapBodySchema.safeParse(map).success).toBe(false);
  });
  it('requires unique stable object IDs and valid layer membership', () => {
    const map = emptyLocationMap();
    map.pins.push({ id: 'same', kind: 'pin', label: 'A', layerId: 'base', order: 0, visibility: 'public', point: { x: 0.2, y: 0.3 }, color: '#000000', locationId: null });
    map.tokens.push({ id: 'same', kind: 'token', label: 'B', layerId: 'base', order: 1, visibility: 'gm', point: { x: 0.5, y: 0.5 }, color: '#ffffff', entityId: null });
    expect(locationMapBodySchema.safeParse(map).success).toBe(false);
    map.tokens[0].id = 'other'; map.tokens[0].layerId = 'missing';
    expect(locationMapBodySchema.safeParse(map).success).toBe(false);
  });
});
