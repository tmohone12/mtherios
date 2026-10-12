/**
 * How the browser shows an item record. Server item state: `ownerId`, `quantity` (null is an
 * unknown amount, 0 is none left), `equipped`, `location`. Carrying (`inInventory`) is not wearing:
 * only `equipped` marks equipment.
 */
export interface ItemProjection {
	quantity: number;
	quantityKnown: boolean;
	equipped: boolean;
	location: string;
	ownerId: string | null;
	mechanicsRevision: number;
}

export function projectItemState(value: unknown): ItemProjection {
	const state = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const ownerId = typeof state.ownerId === 'string' && state.ownerId ? state.ownerId : null;
	const stored = typeof state.quantity === 'number' && Number.isFinite(state.quantity) ? Math.max(0, Math.trunc(state.quantity)) : null;
	const text = (key: string) => typeof state[key] === 'string' ? state[key] as string : null;
	return {
		quantity: stored ?? 1,
		quantityKnown: state.quantity !== null,
		equipped: state.equipped === true,
		location: text('location') ?? text('currentLocation') ?? (ownerId || state.inInventory === true ? 'inventory' : ''),
		ownerId,
		mechanicsRevision: typeof state.mechanicsRevision === 'number' ? state.mechanicsRevision : 0,
	};
}
