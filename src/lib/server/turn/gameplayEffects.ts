import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import {
	characterResourceKey,
	isPlayerCharacterRecord,
	isUnplacedItem,
	normalizeEffectText,
	quoteInSource,
	readCampaignMeters,
	readCharacterConditions,
	readCharacterResource,
	readCharacterSheet,
	readItemHolding,
	type CampaignMeter,
	type CharacterCondition,
	type GameplayEffect,
	type GameplayEffectReceipt,
	type GameplayEffectStatus,
} from '$lib/contracts/gameplayEffects';
import type { getDb } from '$lib/server/db/client';
import { entities, entityAliases, gameplayEffects, stories } from '$lib/server/db/schema';
import type { WorldStateUpdate } from '$lib/services/ai/tools/schemas';

/**
 * The one place gameplay consequences change canonical state. Extraction proposes typed effects
 * with evidence; this module adjudicates them against the stored state (the server does the
 * arithmetic and clamping), applies them inside the turn's transaction and writes a receipt for
 * every effect: applied, already applied (same passage re-extracted), rejected, unresolved (no
 * baseline, unknown target, or a later turn already changed the target) or no change.
 */

type Db = Pick<ReturnType<typeof getDb>, 'insert' | 'select' | 'update'>;
type EntityRow = typeof entities.$inferSelect;

export interface GameplayEffectSource {
	id: string;
	position: number;
	content: string;
	/** False for OOC, non-canon or missing narration: nothing in it is a consequence. */
	canonical: boolean;
	/** False for a parallel-POV scene: it cannot change the player character. */
	primaryScene: boolean;
}

export interface ApplyGameplayEffectsInput {
	storyId: string;
	runId: string;
	source: GameplayEffectSource;
	effects: GameplayEffect[];
	meterChanges?: WorldStateUpdate['meter_changes'];
	serverVersion: number;
	now: string;
}

const PLAYER_REFERENCES = new Set(['player', 'the player', 'you', 'protagonist', 'player character', 'pc', 'self']);
const RESOLVED_CONDITION_HISTORY = 12;

export function gameplayEffectKey(storyId: string, sourceEntryId: string, effect: Record<string, unknown>): string {
	const text = (value: unknown) => typeof value === 'string' ? normalizeEffectText(value) : value ?? null;
	const source = effect.source && typeof effect.source === 'object' ? effect.source as Record<string, unknown> : {};
	return createHash('sha256').update(JSON.stringify([storyId, sourceEntryId, effect.op, text(effect.entityId ?? effect.target),
		text(effect.scope), text(effect.resource), text(effect.conditionId ?? effect.condition), text(effect.itemId ?? effect.item),
		text(effect.toEntityId ?? effect.to), effect.delta ?? null, effect.value ?? null, effect.max ?? null, effect.toMax ?? null,
		effect.quantity ?? null, text(source.quote ?? effect.reason)])).digest('hex').slice(0, 32);
}

export function hasGameplayEffects(update: Pick<WorldStateUpdate, 'effects' | 'meter_changes'>): boolean {
	return (update.effects?.length ?? 0) > 0 || (update.meter_changes?.length ?? 0) > 0;
}

export async function applyGameplayEffects(db: Db, input: ApplyGameplayEffectsInput): Promise<{ receipts: GameplayEffectReceipt[]; warnings: string[] }> {
	const receipts: GameplayEffectReceipt[] = [];
	const warnings: string[] = [];
	const proposals: Array<{ effect: Record<string, unknown>; legacyMeter: boolean }> = [
		...input.effects.map(effect => ({ effect: effect as unknown as Record<string, unknown>, legacyMeter: false })),
		...(input.meterChanges ?? []).map(meter => ({ legacyMeter: true, effect: {
			op: 'meter_change', scope: 'campaign', resource: meter.name, delta: meter.delta, initial: meter.initial, max: meter.max,
			visible: meter.visible, reason: meter.reason ?? null } as Record<string, unknown> })),
	];
	if (!proposals.length) return { receipts, warnings };

	// Applied keys from an earlier run settle the passage: a different reading of it cannot add more.
	const settled = await db.select({ effectKey: gameplayEffects.effectKey, runId: gameplayEffects.runId, id: gameplayEffects.id,
		after: gameplayEffects.after, revision: gameplayEffects.revision }).from(gameplayEffects)
		.where(and(eq(gameplayEffects.storyId, input.storyId), eq(gameplayEffects.sourceEntryId, input.source.id), eq(gameplayEffects.status, 'applied')));
	const earlierRun = settled.find(row => row.runId !== input.runId)?.runId ?? null;
	const seen = new Set<string>();

	for (const [index, { effect, legacyMeter }] of proposals.entries()) {
		const effectKey = gameplayEffectKey(input.storyId, input.source.id, effect);
		const op = String(effect.op) as GameplayEffectReceipt['op'];
		const record = async (outcome: Outcome) => {
			const receipt: GameplayEffectReceipt = { effectId: `effect_${effectKey.slice(0, 24)}_${createHash('sha256').update(`${input.runId}:${index}`).digest('hex').slice(0, 10)}`,
				effectKey, op, status: outcome.status, targetKind: outcome.targetKind ?? null, targetId: outcome.targetId ?? null,
				targetName: outcome.targetName ?? null, subject: outcome.subject ?? null, before: outcome.before ?? null,
				after: outcome.after ?? null, revision: outcome.revision ?? null, reason: outcome.reason ?? null };
			await db.insert(gameplayEffects).values({ id: receipt.effectId, storyId: input.storyId, effectKey, runId: input.runId,
				sourceEntryId: input.source.id, sourcePosition: input.source.position, op, status: receipt.status,
				targetKind: receipt.targetKind, targetId: receipt.targetId, subject: receipt.subject,
				requested: Object.fromEntries(Object.entries(effect).filter(([key]) => key !== 'source')),
				before: receipt.before, after: receipt.after, revision: receipt.revision, reason: receipt.reason,
				evidence: { quote: stringValue(asRecord(effect.source).quote) ?? null, mechanics: effect.mechanics ?? null, legacyMeter },
				metadata: outcome.metadata ?? {}, serverVersion: input.serverVersion, createdAt: input.now }).onConflictDoNothing();
			receipts.push(receipt);
		};

		if (seen.has(effectKey)) { await record({ status: 'already_applied', reason: 'Listed twice in this extraction.' }); continue; }
		seen.add(effectKey);
		const previous = settled.find(row => row.effectKey === effectKey);
		if (previous) {
			await record({ status: 'already_applied', after: previous.after ?? null, revision: previous.revision ?? null,
				reason: `Already applied from this passage (run ${previous.runId}).`, metadata: { appliedEffectId: previous.id } });
			continue;
		}
		const refusal = sourceRefusal(input.source, effect, legacyMeter, earlierRun);
		if (refusal) { await record({ status: 'rejected', reason: refusal }); continue; }
		try {
			await record(await adjudicate(db, input, effect, legacyMeter));
		} catch (error) {
			// A database error has aborted the turn's transaction: nothing more can be written, so it
			// fails the extraction (which retries) instead of being recorded as a rejected effect.
			if (isDatabaseError(error)) throw error;
			await record({ status: 'rejected', reason: `Could not apply: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
	const counts = receipts.reduce<Record<string, number>>((total, receipt) => ({ ...total, [receipt.status]: (total[receipt.status] ?? 0) + 1 }), {});
	if (receipts.some(receipt => receipt.status === 'rejected' || receipt.status === 'unresolved')) {
		warnings.push(`Gameplay effects: ${Object.entries(counts).map(([status, count]) => `${count} ${status.replace('_', ' ')}`).join(', ')}. ${receipts
			.filter(receipt => receipt.status === 'rejected' || receipt.status === 'unresolved').slice(0, 4)
			.map(receipt => `${receipt.op}${receipt.targetName ? ` ${receipt.targetName}` : ''}: ${receipt.reason}`).join('; ')}`);
	}
	return { receipts, warnings };
}

interface Outcome {
	status: GameplayEffectStatus;
	targetKind?: GameplayEffectReceipt['targetKind'];
	targetId?: string | null;
	targetName?: string | null;
	subject?: string | null;
	before?: Record<string, unknown> | null;
	after?: Record<string, unknown> | null;
	revision?: number | null;
	reason?: string | null;
	metadata?: Record<string, unknown>;
}

function sourceRefusal(source: GameplayEffectSource, effect: Record<string, unknown>, legacyMeter: boolean, earlierRun: string | null): string | null {
	if (!source.canonical) return 'The source is not canonical narration (OOC, non-canon or missing); nothing in it is a consequence.';
	if (earlierRun) return `This passage's effects were already settled by an earlier extraction (run ${earlierRun}).`;
	if (legacyMeter) return null;
	const modality = String(effect.modality ?? 'occurred');
	if (modality !== 'occurred') return `Reported as ${modality}, not something that happened; not a consequence.`;
	const evidence = asRecord(effect.source);
	if (typeof evidence.entryId === 'string' && evidence.entryId !== source.id) return `Evidence cites ${evidence.entryId}, not this turn's narration.`;
	if (!quoteInSource(String(evidence.quote ?? ''), source.content)) return 'The evidence quote is not in this turn\'s narration.';
	return null;
}

async function adjudicate(db: Db, input: ApplyGameplayEffectsInput, effect: Record<string, unknown>, legacyMeter: boolean): Promise<Outcome> {
	const op = String(effect.op);
	if (legacyMeter || ((op === 'resource_delta' || op === 'resource_set') && effect.scope === 'campaign'))
		return applyCampaignMeter(db, input, effect, legacyMeter);
	const character = await resolveCharacter(db, input.storyId, effect.entityId, effect.target);
	if ('reason' in character) return { status: 'unresolved', reason: character.reason, targetKind: 'character' };
	const target = character.row;
	if (!input.source.primaryScene && isPlayerCharacter(target)) return { status: 'rejected', targetKind: 'character', targetId: target.id, targetName: target.name,
		reason: 'A parallel-POV scene cannot change the player character.' };
	if (op === 'resource_delta' || op === 'resource_set') return applyCharacterResource(db, input, target, effect);
	if (op.startsWith('condition_')) return applyCondition(db, input, target, effect);
	return applyItem(db, input, target, effect);
}

async function laterChange(db: Db, input: ApplyGameplayEffectsInput, targetId: string, subject: string): Promise<string | null> {
	const [row] = await db.select({ sourceEntryId: gameplayEffects.sourceEntryId }).from(gameplayEffects)
		.where(and(eq(gameplayEffects.storyId, input.storyId), eq(gameplayEffects.targetId, targetId), eq(gameplayEffects.subject, subject),
			eq(gameplayEffects.status, 'applied'), gt(gameplayEffects.sourcePosition, input.source.position))).limit(1);
	return row ? `A later turn (${row.sourceEntryId}) already changed this; not applied out of order.` : null;
}

async function applyCharacterResource(db: Db, input: ApplyGameplayEffectsInput, target: EntityRow, effect: Record<string, unknown>): Promise<Outcome> {
	const key = characterResourceKey(String(effect.resource));
	const subject = `resource:${key}`;
	const base = { targetKind: 'character' as const, targetId: target.id, targetName: target.name, subject };
	const out = await laterChange(db, input, target.id, subject);
	if (out) return { ...base, status: 'unresolved', reason: out };
	const state = asRecord(target.state);
	const sheet = readCharacterSheet(state, target.metadata);
	const stored = readCharacterResource(sheet, key);
	const label = key === 'hp' ? 'HP' : key;
	let next: { current: number; max: number | null };
	if (effect.op === 'resource_delta') {
		if (!stored) return { ...base, status: 'unresolved', reason: `${target.name} has no recorded ${label}; a change needs a stated starting value.` };
		if (key === 'hp' && stored.max === null) return { ...base, status: 'unresolved', reason: `${target.name}'s HP maximum is not recorded.` };
		const raw = stored.current + Number(effect.delta);
		next = { current: Math.max(0, stored.max === null ? raw : Math.min(stored.max, raw)), max: stored.max };
	} else {
		const max = typeof effect.max === 'number' ? effect.max : stored?.max ?? null;
		if (key === 'hp' && max === null) return { ...base, status: 'unresolved', reason: `${target.name}'s HP maximum is not recorded or stated.` };
		const current = effect.toMax === true ? max : typeof effect.value === 'number' ? effect.value : stored?.current ?? null;
		if (current === null) return { ...base, status: 'unresolved', reason: `${target.name} has no recorded ${label} to keep while changing its maximum.` };
		next = { current: Math.max(0, max === null ? current : Math.min(max, current)), max };
	}
	const before = stored ? { current: stored.current, max: stored.max } : null;
	const after = { current: next.current, max: next.max };
	if (before && before.current === after.current && before.max === after.max)
		return { ...base, status: 'no_change', before, after, reason: noChangeReason(effect, stored!, label) };
	const nextSheet = { ...(sheet ?? {}) };
	if (key === 'hp') nextSheet.hitPoints = { current: next.current, max: next.max };
	else nextSheet.resources = { ...asRecord(nextSheet.resources), [key]: { current: next.current, max: next.max } };
	const revision = await writeCharacterState(db, input, target, { ...state, playerSheet: nextSheet });
	const requested = effect.op === 'resource_delta' ? Number(effect.delta) : null;
	const applied = before ? next.current - before.current : null;
	const notes = [requested !== null && applied !== null && applied !== requested ? `requested ${signed(requested)}, applied ${signed(applied)} (limits 0-${next.max ?? 'none'})` : '',
		key === 'hp' && next.current === 0 ? 'reached 0 HP; status unchanged (no death rule applied)' : ''].filter(Boolean).join('; ');
	return { ...base, status: 'applied', before, after, revision, reason: notes || null };
}

function noChangeReason(effect: Record<string, unknown>, stored: { current: number; max: number | null }, label: string): string {
	if (effect.op === 'resource_delta' && Number(effect.delta) > 0) return `${label} is already at its maximum (${stored.current}/${stored.max ?? stored.current}).`;
	if (effect.op === 'resource_delta') return `${label} is already 0.`;
	return `${label} already has this value.`;
}

async function applyCondition(db: Db, input: ApplyGameplayEffectsInput, target: EntityRow, effect: Record<string, unknown>): Promise<Outcome> {
	const state = asRecord(target.state);
	const conditions = readCharacterConditions(state);
	const base = { targetKind: 'character' as const, targetId: target.id, targetName: target.name };
	const requestedName = stringValue(effect.condition);
	const match = findCondition(conditions, stringValue(effect.conditionId), requestedName, effect.op !== 'condition_add');
	const subject = `condition:${normalizeEffectText(match?.name ?? requestedName ?? String(effect.conditionId))}`;
	const out = await laterChange(db, input, target.id, subject);
	if (out) return { ...base, subject, status: 'unresolved', reason: out };
	const view = (list: CharacterCondition[]) => ({ conditions: list.map(condition => ({ id: condition.id, name: condition.name, severity: condition.severity, detail: condition.detail })) });
	let next = conditions;
	if (effect.op === 'condition_add') {
		if (match) {
			const updated = { ...match, severity: (effect.severity as CharacterCondition['severity']) ?? match.severity, detail: stringValue(effect.detail) ?? match.detail, updatedEntryId: input.source.id };
			if (updated.severity === match.severity && updated.detail === match.detail)
				return { ...base, subject, status: 'no_change', before: view(conditions), after: view(conditions), reason: `${target.name} already has ${match.name}.` };
			next = conditions.map(condition => condition.id === match.id ? updated : condition);
		} else {
			const name = requestedName!;
			next = [...conditions, { id: `cond_${createHash('sha256').update(`${target.id}:${normalizeEffectText(name)}:${input.source.id}`).digest('hex').slice(0, 16)}`,
				name, severity: (effect.severity as CharacterCondition['severity']) ?? null, detail: stringValue(effect.detail) ?? null,
				sourceEntryId: input.source.id, updatedEntryId: input.source.id }];
		}
	} else if (!match) {
		return effect.op === 'condition_remove'
			? { ...base, subject, status: 'no_change', before: view(conditions), after: view(conditions), reason: `${target.name} has no recorded condition matching "${requestedName ?? effect.conditionId}".` }
			: { ...base, subject, status: 'unresolved', reason: `${target.name} has no recorded condition matching "${requestedName ?? effect.conditionId}".` };
	} else if (effect.op === 'condition_update') {
		const updated = { ...match, severity: (effect.severity as CharacterCondition['severity']) ?? match.severity, detail: stringValue(effect.detail) ?? match.detail, updatedEntryId: input.source.id };
		if (updated.severity === match.severity && updated.detail === match.detail)
			return { ...base, subject, status: 'no_change', before: view(conditions), after: view(conditions), reason: 'Nothing about the condition changed.' };
		next = conditions.map(condition => condition.id === match.id ? updated : condition);
	} else {
		next = conditions.filter(condition => condition.id !== match.id);
	}
	const removed = conditions.filter(condition => !next.some(kept => kept.id === condition.id));
	const resolved = removed.length
		? [...(Array.isArray(state.resolvedConditions) ? state.resolvedConditions : []), ...removed.map(condition => ({ ...condition, resolvedEntryId: input.source.id }))].slice(-RESOLVED_CONDITION_HISTORY)
		: state.resolvedConditions;
	const revision = await writeCharacterState(db, input, target, { ...state, conditions: next, ...(resolved !== undefined ? { resolvedConditions: resolved } : {}) });
	return { ...base, subject, status: 'applied', before: view(conditions), after: view(next), revision };
}

/** Exact id or name; for updates and removals also one unambiguous containment match ("broken arm" ~ "broken left arm"). */
function findCondition(conditions: CharacterCondition[], id: string | undefined, name: string | undefined, loose: boolean): CharacterCondition | null {
	if (id) { const byId = conditions.find(condition => condition.id === id); if (byId) return byId; }
	if (!name) return null;
	const wanted = normalizeEffectText(name);
	const exact = conditions.filter(condition => normalizeEffectText(condition.name) === wanted);
	if (exact.length === 1) return exact[0];
	if (!loose || exact.length > 1) return null;
	const words = new Set(wanted.split(' '));
	const contains = conditions.filter(condition => {
		const other = normalizeEffectText(condition.name).split(' ');
		return other.every(word => words.has(word)) || [...words].every(word => other.includes(word));
	});
	return contains.length === 1 ? contains[0] : null;
}

async function applyItem(db: Db, input: ApplyGameplayEffectsInput, owner: EntityRow, effect: Record<string, unknown>): Promise<Outcome> {
	const itemName = String(effect.item);
	const stacks = await itemCandidates(db, input.storyId, itemName, stringValue(effect.itemId));
	const ownerIsPlayer = isPlayerCharacter(owner);
	const playerId = ownerIsPlayer ? owner.id : null;
	const owned = stacks.filter(row => itemOwner(row, playerId) === owner.id);
	const base = { targetKind: 'item' as const, subject: 'item' };
	if (effect.op === 'item_acquire') {
		// An unplaced record of this item (lying somewhere, nobody's) is the one picked up.
		const unplaced = stacks.filter(isUnplaced);
		const stack = owned.length === 1 ? owned[0] : !owned.length && unplaced.length === 1 ? unplaced[0] : null;
		if (owned.length > 1) return { ...base, status: 'unresolved', targetName: itemName, reason: `${owner.name} has several "${itemName}" stacks; name the itemId.` };
		const quantity = typeof effect.quantity === 'number' ? effect.quantity : null;
		if (stack) {
			const out = await laterChange(db, input, stack.id, 'item');
			if (out) return { ...base, targetId: stack.id, targetName: stack.name, status: 'unresolved', reason: out };
			const state = asRecord(stack.state);
			const before = itemView(stack, playerId);
			const wasOwned = itemOwner(stack, playerId) === owner.id;
			const stored = itemQuantity(stack, playerId);
			const nextQuantity = !wasOwned ? quantity : stored === null || quantity === null ? null : stored + quantity;
			const revision = await writeItemState(db, input, stack, { ...state, ...heldBy(owner.id, ownerIsPlayer), quantity: nextQuantity },
				stringValue(effect.description));
			return { ...base, targetId: stack.id, targetName: stack.name, status: 'applied', before, after: { ownerId: owner.id, quantity: nextQuantity, equipped: wasOwned && state.equipped === true }, revision,
				reason: nextQuantity === null ? 'Quantity not stated; recorded as unknown.' : null };
		}
		const created = await createItem(db, input, owner, itemName, quantity, stringValue(effect.description) ?? null, ownerIsPlayer);
		return { ...base, targetId: created.id, targetName: itemName, status: 'applied', before: null, after: { ownerId: owner.id, quantity, equipped: false }, revision: 1,
			reason: quantity === null ? 'Quantity not stated; recorded as unknown.' : null };
	}
	if (owned.length !== 1) {
		const elsewhere = stacks.length ? ` (${stacks.length} "${itemName}" record(s) exist but not as one stack held by ${owner.name})` : '';
		return { ...base, targetName: itemName, status: 'unresolved', reason: owned.length > 1 ? `${owner.name} has several "${itemName}" stacks; name the itemId.` : `${owner.name} holds no recorded "${itemName}"${elsewhere}.` };
	}
	const stack = owned[0];
	const state = asRecord(stack.state);
	const ref = { ...base, targetId: stack.id, targetName: stack.name };
	const out = await laterChange(db, input, stack.id, 'item');
	if (out) return { ...ref, status: 'unresolved', reason: out };
	const before = itemView(stack, playerId);
	const stored = itemQuantity(stack, playerId);
	if (effect.op === 'item_equip' || effect.op === 'item_unequip') {
		const equipped = effect.op === 'item_equip';
		if (equipped && stored === 0) return { ...ref, status: 'rejected', before, reason: `${owner.name} has no ${stack.name} left to equip.` };
		if ((state.equipped === true) === equipped) return { ...ref, status: 'no_change', before, after: before, reason: `${stack.name} is already ${equipped ? 'equipped' : 'unequipped'}.` };
		// Unequipping keeps the item carried; legacy inInventory stays true.
		const revision = await writeItemState(db, input, stack, { ...state, ownerId: owner.id, equipped, quantity: stored });
		return { ...ref, status: 'applied', before, after: { ...before, equipped }, revision };
	}
	if (effect.op === 'item_consume') {
		const requested = Number(effect.quantity ?? 1);
		if (stored === null) return { ...ref, status: 'unresolved', before, reason: `${stack.name}'s quantity is unknown; cannot subtract ${requested}.` };
		if (stored === 0) return { ...ref, status: 'no_change', before, after: before, reason: `${owner.name} has no ${stack.name} left.` };
		const nextQuantity = Math.max(0, stored - requested);
		const revision = await writeItemState(db, input, stack, { ...state, ownerId: owner.id, quantity: nextQuantity, equipped: nextQuantity === 0 ? false : state.equipped === true,
			...(nextQuantity === 0 ? { depletedEntryId: input.source.id, depletedHow: effect.how ?? 'consumed' } : {}) });
		return { ...ref, status: 'applied', before, after: { ...before, quantity: nextQuantity, equipped: nextQuantity === 0 ? false : before.equipped }, revision,
			reason: requested > stored ? `narration used ${requested}; only ${stored} recorded` : null };
	}
	// item_transfer: one transaction moves the whole stack or splits it onto the recipient's stack.
	const recipient = await resolveCharacter(db, input.storyId, effect.toEntityId, effect.to);
	if ('reason' in recipient) return { ...ref, status: 'unresolved', before, reason: `Recipient: ${recipient.reason}` };
	if (recipient.row.id === owner.id) return { ...ref, status: 'no_change', before, after: before, reason: 'Giver and recipient are the same character.' };
	if (!input.source.primaryScene && isPlayerCharacter(recipient.row)) return { ...ref, status: 'rejected', before, reason: 'A parallel-POV scene cannot change the player character.' };
	const recipientIsPlayer = isPlayerCharacter(recipient.row);
	const requested = typeof effect.quantity === 'number' ? effect.quantity : stored;
	if (stored === 0) return { ...ref, status: 'rejected', before, reason: `${owner.name} has no ${stack.name} left to give.` };
	if (typeof effect.quantity === 'number' && stored === null) return { ...ref, status: 'unresolved', before, reason: `${stack.name}'s quantity is unknown; cannot move ${effect.quantity}.` };
	const moved = requested === null ? null : Math.min(requested, stored ?? requested);
	const recipientId = recipientIsPlayer ? recipient.row.id : null;
	const recipientStacks = stacks.filter(row => row.id !== stack.id && itemOwner(row, recipientId) === recipient.row.id);
	if (recipientStacks.length > 1) return { ...ref, status: 'unresolved', before, reason: `${recipient.row.name} has several "${stack.name}" stacks.` };
	const whole = moved === null || moved === stored;
	const metadata = { recipientId: recipient.row.id, recipientName: recipient.row.name, moved };
	if (whole && !recipientStacks.length) {
		const revision = await writeItemState(db, input, stack, { ...state, ...heldBy(recipient.row.id, recipientIsPlayer), quantity: stored, equipped: false });
		return { ...ref, status: 'applied', before, after: { ownerId: recipient.row.id, quantity: stored, equipped: false }, revision, metadata };
	}
	const remaining = whole ? 0 : stored! - moved!;
	const revision = await writeItemState(db, input, stack, { ...state, ownerId: owner.id, quantity: remaining, equipped: remaining === 0 ? false : state.equipped === true });
	if (recipientStacks.length) {
		const receiving = recipientStacks[0];
		const receivingQuantity = itemQuantity(receiving, recipientId);
		await writeItemState(db, input, receiving, { ...asRecord(receiving.state), ownerId: recipient.row.id,
			quantity: receivingQuantity === null || moved === null ? null : receivingQuantity + moved });
		return { ...ref, status: 'applied', before, after: { ...before, quantity: remaining }, revision, metadata: { ...metadata, recipientItemId: receiving.id } };
	}
	const created = await createItem(db, input, recipient.row, stack.name, moved, stack.description ?? null, recipientIsPlayer);
	return { ...ref, status: 'applied', before, after: { ...before, quantity: remaining }, revision, metadata: { ...metadata, recipientItemId: created.id } };
}

async function applyCampaignMeter(db: Db, input: ApplyGameplayEffectsInput, effect: Record<string, unknown>, legacyMeter: boolean): Promise<Outcome> {
	const name = String(effect.resource ?? '').trim();
	const subject = `meter:${normalizeEffectText(name)}`;
	const base = { targetKind: 'campaign' as const, targetId: input.storyId, targetName: name, subject };
	if (characterResourceKey(name) === 'hp') return { ...base, status: 'rejected', reason: 'HP belongs to a character sheet, not a campaign meter.' };
	const out = await laterChange(db, input, input.storyId, subject);
	if (out) return { ...base, status: 'unresolved', reason: out };
	const [story] = await db.select({ metadata: stories.metadata }).from(stories).where(eq(stories.id, input.storyId)).limit(1);
	const metadata = asRecord(story?.metadata);
	const meters = readCampaignMeters(metadata);
	const index = meters.findIndex(meter => normalizeEffectText(meter.name) === normalizeEffectText(name));
	const existing = index >= 0 ? meters[index] : null;
	const max = typeof effect.max === 'number' && effect.max > 0 ? Math.trunc(effect.max) : existing?.max ?? null;
	let value: number;
	if (existing) {
		if (effect.op === 'resource_set') value = effect.toMax === true ? existing.max : typeof effect.value === 'number' ? effect.value : existing.value;
		else value = existing.value + Number(effect.delta ?? 0);
	} else {
		const initial = legacyMeter ? effect.initial : effect.op === 'resource_set' ? effect.value : undefined;
		if (typeof initial !== 'number' || max === null) return { ...base, status: 'unresolved', reason: `No campaign meter "${name}" exists; creating one needs a stated value and maximum.` };
		value = initial + (legacyMeter ? Number(effect.delta ?? 0) : 0);
	}
	const after: CampaignMeter = { name: existing?.name ?? name, value: Math.max(0, Math.min(max!, Math.trunc(value))), max: max!,
		visible: typeof effect.visible === 'boolean' ? effect.visible : existing?.visible ?? true };
	const before = existing ? { ...existing } : null;
	if (existing && existing.value === after.value && existing.max === after.max && existing.visible === after.visible)
		return { ...base, status: 'no_change', before, after: { ...after }, reason: `${name} stays at ${after.value}/${after.max}.` };
	const next = existing ? meters.map((meter, at) => at === index ? after : meter) : [...meters, after];
	const revision = Math.trunc(Number(metadata.metersRevision ?? 0)) + 1;
	await db.update(stories).set({
		metadata: sql`jsonb_set(jsonb_set(coalesce(${stories.metadata}, '{}'::jsonb), '{meters}', ${JSON.stringify(next)}::jsonb), '{metersRevision}', ${String(revision)}::jsonb)`,
		serverVersion: input.serverVersion, updatedAt: input.now,
	}).where(eq(stories.id, input.storyId));
	return { ...base, status: 'applied', before, after: { ...after }, revision, reason: legacyMeter ? stringValue(effect.reason) ?? null : null };
}

async function resolveCharacter(db: Db, storyId: string, entityId: unknown, target: unknown): Promise<{ row: EntityRow } | { reason: string }> {
	const usable = and(eq(entities.storyId, storyId), eq(entities.type, 'character'), ne(entities.status, 'deleted'), sql`${entities.metadata}->>'mergedInto' is null`);
	if (typeof entityId === 'string' && entityId.trim()) {
		const [row] = await db.select().from(entities).where(and(usable, eq(entities.id, entityId.trim()))).for('update').limit(1);
		if (row) return { row };
		if (typeof target !== 'string') return { reason: `No character with id ${entityId}.` };
	}
	const name = typeof target === 'string' ? target.trim() : '';
	if (!name) return { reason: 'No target character named.' };
	if (PLAYER_REFERENCES.has(normalizeName(name))) {
		const [row] = await db.select().from(entities).where(and(usable, or(
			sql`${entities.state}->>'relationship' = 'self'`, sql`${entities.state}->'relationship'->>'status' in ('self','player_character')`,
			sql`${entities.state}->>'isProtagonist' = 'true'`, sql`${entities.state}->>'currentDisposition' = 'self'`,
			sql`${entities.metadata}->>'relationship' in ('self','player_character')`, sql`${entities.state}->>'playerPrompt' is not null`, sql`${entities.metadata}->>'playerPrompt' is not null`,
		))).orderBy(asc(entities.createdAt)).for('update').limit(1);
		return row ? { row } : { reason: 'This story has no player character.' };
	}
	const byName = await db.select().from(entities).where(and(usable, sql`lower(${entities.name}) = lower(${name})`)).for('update').limit(3);
	if (byName.length === 1) return { row: byName[0] };
	if (byName.length > 1) return { reason: `"${name}" names several characters; use the entityId.` };
	const aliases = await db.select({ entityId: entityAliases.entityId }).from(entityAliases)
		.where(and(eq(entityAliases.storyId, storyId), eq(entityAliases.normalizedAlias, normalizeName(name)))).limit(10);
	const ids = [...new Set(aliases.map(alias => alias.entityId))];
	if (!ids.length) return { reason: `No character named "${name}".` };
	const rows = await db.select().from(entities).where(and(usable, inArray(entities.id, ids))).for('update').limit(3);
	return rows.length === 1 ? { row: rows[0] } : { reason: rows.length ? `"${name}" matches several characters; use the entityId.` : `No character named "${name}".` };
}

async function itemCandidates(db: Db, storyId: string, name: string, itemId?: string): Promise<EntityRow[]> {
	const usable = and(eq(entities.storyId, storyId), eq(entities.type, 'item'), ne(entities.status, 'deleted'), sql`${entities.metadata}->>'mergedInto' is null`);
	if (itemId) {
		const [row] = await db.select().from(entities).where(and(usable, eq(entities.id, itemId))).for('update').limit(1);
		if (row) return [row];
	}
	const aliases = await db.select({ entityId: entityAliases.entityId }).from(entityAliases)
		.where(and(eq(entityAliases.storyId, storyId), eq(entityAliases.normalizedAlias, normalizeName(name)))).limit(40);
	const ids = [...new Set(aliases.map(alias => alias.entityId))];
	return db.select().from(entities).where(and(usable, ids.length ? or(sql`lower(${entities.name}) = lower(${name})`, inArray(entities.id, ids)) : sql`lower(${entities.name}) = lower(${name})`))
		.orderBy(asc(entities.createdAt)).for('update').limit(40);
}

/** A held item is no longer lying anywhere; the legacy carried flags follow the player's inventory. */
function heldBy(ownerId: string, isPlayer: boolean): Record<string, unknown> {
	return { ownerId, inInventory: isPlayer, location: null, currentLocation: isPlayer ? 'inventory' : null };
}

function itemOwner(row: EntityRow, playerId: string | null): string | null {
	return readItemHolding(row.state, playerId).ownerId;
}

function isUnplaced(row: EntityRow): boolean {
	return isUnplacedItem(row.state);
}

function itemQuantity(row: EntityRow, playerId: string | null): number | null {
	return readItemHolding(row.state, playerId).quantity;
}

function itemView(row: EntityRow, playerId: string | null): Record<string, unknown> {
	return { ...readItemHolding(row.state, playerId) };
}

async function createItem(db: Db, input: ApplyGameplayEffectsInput, owner: EntityRow, name: string, quantity: number | null, description: string | null, ownerIsPlayer: boolean): Promise<{ id: string }> {
	const id = `entity_item_${createHash('sha256').update(`${input.storyId}:${input.source.id}:${owner.id}:${normalizeEffectText(name)}`).digest('hex').slice(0, 20)}`;
	await db.insert(entities).values({ id, storyId: input.storyId, type: 'item', name, description, status: 'active', visibility: 'player_known',
		state: { type: 'item', ownerId: owner.id, quantity, equipped: false, inInventory: ownerIsPlayer, mechanicsRevision: 1, acquiredEntryId: input.source.id },
		metadata: { sourceType: 'gameplay_effect' }, sourceEntryIds: [input.source.id], sourceEventIds: [], sourcePatchIds: [],
		serverVersion: input.serverVersion, createdAt: input.now, updatedAt: input.now });
	await db.insert(entityAliases).values({ id: `alias_${id}`, storyId: input.storyId, entityId: id, alias: name, normalizedAlias: normalizeName(name),
		sourceEntryIds: [input.source.id], serverVersion: input.serverVersion, createdAt: input.now, updatedAt: input.now }).onConflictDoNothing();
	return { id };
}

async function writeCharacterState(db: Db, input: ApplyGameplayEffectsInput, row: EntityRow, state: Record<string, unknown>): Promise<number> {
	const revision = Math.trunc(Number(asRecord(row.state).mechanicsRevision ?? 0)) + 1;
	const next = { ...state, mechanicsRevision: revision };
	await db.update(entities).set({ state: next, sourceEntryIds: [...new Set([...(row.sourceEntryIds ?? []), input.source.id])],
		serverVersion: input.serverVersion, updatedAt: input.now }).where(and(eq(entities.storyId, input.storyId), eq(entities.id, row.id)));
	row.state = next;
	return revision;
}

async function writeItemState(db: Db, input: ApplyGameplayEffectsInput, row: EntityRow, state: Record<string, unknown>, description?: string): Promise<number> {
	const revision = Math.trunc(Number(asRecord(row.state).mechanicsRevision ?? 0)) + 1;
	const next = { ...state, mechanicsRevision: revision };
	await db.update(entities).set({ state: next, ...(description && !row.description ? { description } : {}),
		sourceEntryIds: [...new Set([...(row.sourceEntryIds ?? []), input.source.id])], serverVersion: input.serverVersion, updatedAt: input.now })
		.where(and(eq(entities.storyId, input.storyId), eq(entities.id, row.id)));
	row.state = next;
	return revision;
}

export function isPlayerCharacter(row: Pick<EntityRow, 'state' | 'metadata'>): boolean {
	return isPlayerCharacterRecord(row);
}

function normalizeName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A Postgres error (SQLSTATE code), directly or wrapped by the query builder. */
export function isDatabaseError(error: unknown): boolean {
	for (let current = error, depth = 0; current && typeof current === 'object' && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
		const value = current as { code?: unknown; name?: unknown };
		if (value.name === 'PostgresError' || (typeof value.code === 'string' && /^[0-9A-Z]{5}$/.test(value.code))) return true;
	}
	return false;
}

function signed(value: number): string {
	return value > 0 ? `+${value}` : String(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
