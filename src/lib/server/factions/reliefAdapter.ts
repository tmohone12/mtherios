import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { factions, factionResources, storyEvents } from '$lib/server/db/schema';
import { getDb } from '$lib/server/db/client';
import { fingerprint, record, strings, worldDay } from './intentions';
import { negotiationSandboxSchema } from './negotiationPrototype';
import { reliefConfigSchema } from './projectLifecycle';

export const reliefAdapterSchema = z.object({
 version: z.union([z.literal(2),z.literal(3)]), kind: z.literal('relief'), config: reliefConfigSchema,
 state: negotiationSandboxSchema, authoringFingerprint: z.string(), lastReviewSequence: z.number().int().nonnegative(),
}).strict().refine(a => a.state.scope === `persistent-relief-v${a.version}`, 'Unsupported relief execution scope.');
export function reliefAdapter(metadata: unknown) { return reliefAdapterSchema.safeParse(record(metadata).reliefAdapter); }

/** The pool owns physical stock. Each adapter owns only its attributed reservation. */
export function grainPool(resource: Record<string, unknown>) {
 const metadata = record(resource.metadata), raw = metadata.reliefReservations;
 const reservations: Record<string, number> = Object.create(null);
 if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('Invalid project reservation ledger.');
 for (const [key, value] of Object.entries(record(raw))) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid project reservation amount.');
  reservations[key] = Number(value);
 }
 const total = metadata.reservedGrain ?? 0;
 const attributed = Object.values(reservations).reduce((sum, value) => sum + value, 0);
 const other = metadata.unattributedReservedGrain ?? (raw === undefined ? total : 0);
 if (!Number.isSafeInteger(total) || !Number.isSafeInteger(other) || Number(other) < 0 || attributed + Number(other) !== total
  || !Number.isSafeInteger(resource.amount) || Number(resource.amount) < Number(total)) throw new Error('Grain reservations require reconciliation.');
 return { reservations, total: Number(total), other: Number(other), physical: Number(resource.amount) };
}
export function projectInventory<T extends Record<string, unknown>>(resource: T, projectId: string) {
 const pool = grainPool(resource), own = pool.reservations[projectId] ?? 0;
 return { ...resource, amount: pool.physical - (pool.total - own), metadata: { ...record(resource.metadata), reservedGrain: own } };
}
export function settleProjectInventory(resource: Record<string, unknown>, projectId: string, beforeGrain: number, afterGrain: number, afterReserved: number) {
 const pool = grainPool(resource), reservations: Record<string,number> = Object.assign(Object.create(null),pool.reservations);
 if (afterReserved) reservations[projectId] = afterReserved; else delete reservations[projectId];
 const reservedGrain = pool.other + Object.values(reservations).reduce((sum, n) => sum + n, 0);
 const amount = pool.physical + afterGrain - beforeGrain;
 if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(afterReserved) || afterReserved < 0 || amount < reservedGrain) throw new Error('Project settlement exceeds the shared grain pool.');
 return { amount, metadata: { ...record(resource.metadata), reliefReservations: reservations, unattributedReservedGrain: pool.other, reservedGrain } };
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];
/** Explicit inputs reference committed records; this never creates authority or execution evidence. */
export async function initialReliefState(tx: Tx, story: { id: string; currentWorldTime: string | null }, raw: unknown, projectId: string) {
 const config = reliefConfigSchema.parse(raw), day = worldDay(story.currentWorldTime);
 if (day === null) throw new Error('Set canonical world time before creating relief projects.');
 const rows = await tx.select().from(factions).where(and(eq(factions.storyId, story.id), inArray(factions.id, [config.supplierId, config.recipientId])));
 const resources = await tx.select().from(factionResources).where(and(eq(factionResources.storyId, story.id), inArray(factionResources.id, [config.supplierResourceId, config.recipientResourceId]))).orderBy(factionResources.id).for('update');
 const sources = await tx.select().from(storyEvents).where(and(eq(storyEvents.storyId, story.id), eq(storyEvents.status, 'committed'), inArray(storyEvents.id, [config.authoritySourceId, config.routeSourceId])));
 const authority = record(record(sources.find(e => e.id === config.authoritySourceId)?.metadata).tollAuthority);
 const route = record(record(sources.find(e => e.id === config.routeSourceId)?.metadata).deliveryRoute);
 if (authority.factionId !== config.recipientId || authority.maxDays !== config.maxTollDays || route.locationId !== config.locationId || route.blocked !== config.blocked) throw new Error('Select matching committed route and toll-authority records.');
 const party = (id: string, resourceId: string, maxTollDays: number) => {
  const faction = rows.find(f => f.id === id), physical = resources.find(r => r.id === resourceId);
  if (!faction || !physical || physical.factionId !== id || physical.kind !== 'grain' || physical.status !== 'available') throw new Error('Select available grain inventories owned by the participating factions.');
  const resource = projectInventory(physical, projectId);
  return { id, name: faction.name, goals: strings(faction.goals).slice(0, 3).length ? strings(faction.goals).slice(0, 3) : ['Consider relief within existing obligations.'], beliefs: [],
   obligations: maxTollDays ? [{ id: config.authoritySourceId, text: `Authority permits at most ${maxTollDays} days of temporary toll exemption.` }] : [], grain: resource.amount, reservedGrain: 0, maxTollDays };
 };
 const state = negotiationSandboxSchema.parse({ scope: 'persistent-relief-v2', id: `relief_${fingerprint([story.id, projectId]).slice(0, 24)}`, revision: 0, day,
  supplier: party(config.supplierId, config.supplierResourceId, 0), recipient: party(config.recipientId, config.recipientResourceId, config.maxTollDays),
  locationId: config.locationId, deliveryDays: config.deliveryDays, route: { blocked: config.blocked, sourceId: config.routeSourceId }, phase: 'idle', offer: null, agreement: null, events: [], receipts: [] });
 return { state, config };
}
