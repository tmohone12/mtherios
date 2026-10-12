import { z } from 'zod';

/**
 * Gameplay effects: the typed consequences a turn's narration establishes (damage, healing,
 * conditions, item use and movement). The classifier extracts them with evidence; the server
 * adjudicates and applies them (see server/turn/gameplayEffects.ts). HP lives in a character's
 * `state.playerSheet.hitPoints`, other character resources in `state.playerSheet.resources`,
 * conditions in `state.conditions`, items as item entities with `ownerId`/`quantity`/`equipped`,
 * and campaign resources in `stories.metadata.meters`.
 */

export const GAMEPLAY_EFFECT_STATUSES = ['applied', 'already_applied', 'rejected', 'unresolved', 'no_change'] as const;
export type GameplayEffectStatus = typeof GAMEPLAY_EFFECT_STATUSES[number];

/** Only `occurred` is a consequence; the rest are reported so they are seen and not applied. */
export const EFFECT_MODALITIES = ['occurred', 'attempted', 'hypothetical', 'remembered', 'offered', 'rumored', 'threatened', 'planned'] as const;
export const CONDITION_SEVERITIES = ['minor', 'moderate', 'severe', 'critical'] as const;

const source = z.object({
	/** The narration entry the quote comes from; omitted means this turn's narration. */
	entryId: z.string().trim().min(1).max(160).optional(),
	/** A verbatim span of the narration that establishes the consequence. */
	quote: z.string().trim().min(8).max(800),
}).strict();

const mechanics = z.object({
	/** The roll or arithmetic stated in the narration, e.g. "1d8+2 = 7". */
	roll: z.string().trim().min(1).max(200).optional(),
	/** The rule or effect cited, e.g. "healing potion restores 2d4+2". */
	rule: z.string().trim().min(1).max(200).optional(),
}).strict();

const reference = {
	/** Canonical character id; preferred over `target`. */
	entityId: z.string().trim().min(1).max(160).optional(),
	/** Canonical character name or alias; "player" means the player character. */
	target: z.string().trim().min(1).max(160).optional(),
	modality: z.enum(EFFECT_MODALITIES).optional().default('occurred'),
	mechanics: mechanics.optional(),
	note: z.string().trim().min(1).max(240).optional(),
	source,
};
const resourceName = z.string().trim().min(1).max(60);
const itemReference = {
	itemId: z.string().trim().min(1).max(160).optional(),
	item: z.string().trim().min(1).max(160),
};
const conditionReference = {
	conditionId: z.string().trim().min(1).max(160).optional(),
	condition: z.string().trim().min(2).max(120).optional(),
};

const resourceDelta = z.object({ op: z.literal('resource_delta'), ...reference,
	scope: z.enum(['character', 'campaign']).optional().default('character'), resource: resourceName,
	delta: z.number().int().min(-9999).max(9999).refine(value => value !== 0, 'delta must be nonzero') }).strict();
const resourceSet = z.object({ op: z.literal('resource_set'), ...reference,
	scope: z.enum(['character', 'campaign']).optional().default('character'), resource: resourceName,
	value: z.number().int().min(0).max(99_999).optional(), max: z.number().int().min(1).max(99_999).optional(),
	toMax: z.boolean().optional() }).strict()
	.refine(effect => effect.value !== undefined || effect.max !== undefined || effect.toMax === true, 'resource_set needs value, max or toMax');
const conditionAdd = z.object({ op: z.literal('condition_add'), ...reference, condition: z.string().trim().min(2).max(120),
	severity: z.enum(CONDITION_SEVERITIES).optional(), detail: z.string().trim().min(1).max(300).optional() }).strict();
const conditionUpdate = z.object({ op: z.literal('condition_update'), ...reference, ...conditionReference,
	severity: z.enum(CONDITION_SEVERITIES).optional(), detail: z.string().trim().min(1).max(300).optional() }).strict()
	.refine(effect => effect.conditionId || effect.condition, 'condition_update needs conditionId or condition');
const conditionRemove = z.object({ op: z.literal('condition_remove'), ...reference, ...conditionReference }).strict()
	.refine(effect => effect.conditionId || effect.condition, 'condition_remove needs conditionId or condition');
const itemAcquire = z.object({ op: z.literal('item_acquire'), ...reference, ...itemReference,
	/** Omit when the narration does not state a count; the server records it as unknown. */
	quantity: z.number().int().min(1).max(99_999).optional(), description: z.string().trim().min(1).max(400).optional() }).strict();
const itemConsume = z.object({ op: z.literal('item_consume'), ...reference, ...itemReference,
	quantity: z.number().int().min(1).max(99_999).optional().default(1),
	how: z.enum(['consumed', 'spent', 'destroyed', 'lost']).optional().default('consumed') }).strict();
const itemTransfer = z.object({ op: z.literal('item_transfer'), ...reference, ...itemReference,
	toEntityId: z.string().trim().min(1).max(160).optional(), to: z.string().trim().min(1).max(160).optional(),
	/** Omit to move the whole stack. */
	quantity: z.number().int().min(1).max(99_999).optional() }).strict()
	.refine(effect => effect.toEntityId || effect.to, 'item_transfer needs toEntityId or to');
const itemEquip = z.object({ op: z.literal('item_equip'), ...reference, ...itemReference }).strict();
const itemUnequip = z.object({ op: z.literal('item_unequip'), ...reference, ...itemReference }).strict();

export const gameplayEffectSchema = z.union([resourceDelta, resourceSet, conditionAdd, conditionUpdate, conditionRemove,
	itemAcquire, itemConsume, itemTransfer, itemEquip, itemUnequip]);
export type GameplayEffect = z.infer<typeof gameplayEffectSchema>;
export type GameplayEffectOp = GameplayEffect['op'];
export const GAMEPLAY_EFFECT_LIMIT = 24;

export interface GameplayEffectReceipt {
	effectId: string;
	effectKey: string;
	op: GameplayEffectOp | 'meter_change';
	status: GameplayEffectStatus;
	targetKind: 'character' | 'item' | 'campaign' | null;
	targetId: string | null;
	targetName: string | null;
	subject: string | null;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
	revision: number | null;
	reason: string | null;
}

export function normalizeEffectText(value: string): string {
	return value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Whitespace, curly quotes and dash variants differ between model quotes and stored prose. */
export function quoteInSource(quote: string, sourceText: string): boolean {
	const clean = (value: string) => value.replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, '"')
		.replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/\s+/g, ' ').trim().toLowerCase();
	const needle = clean(quote);
	return needle.length >= 8 && clean(sourceText).includes(needle);
}

const HP_NAMES = new Set(['hp', 'hit points', 'hitpoints', 'hit point', 'health', 'health points', 'life']);
/** `hp` for hit points; otherwise a stable resource key such as `mana` or `stamina`. */
export function characterResourceKey(resource: string): string {
	const normalized = normalizeEffectText(resource);
	return HP_NAMES.has(normalized) ? 'hp' : normalized.replace(/\s+/g, '_');
}

export interface CampaignMeter { name: string; value: number; max: number; visible: boolean }

export function readCampaignMeters(metadata: unknown): CampaignMeter[] {
	const meters = asRecord(metadata).meters;
	if (!Array.isArray(meters)) return [];
	return meters.flatMap((raw) => {
		const meter = asRecord(raw);
		const name = typeof meter.name === 'string' ? meter.name.trim() : '';
		const value = Number(meter.value), max = Number(meter.max);
		if (!name || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return [];
		return [{ name, value: Math.trunc(value), max: Math.trunc(max), visible: meter.visible !== false }];
	});
}

export interface CharacterCondition {
	id: string;
	name: string;
	severity: typeof CONDITION_SEVERITIES[number] | null;
	detail: string | null;
	sourceEntryId: string;
	updatedEntryId: string;
}

export function readCharacterConditions(state: unknown): CharacterCondition[] {
	const conditions = asRecord(state).conditions;
	if (!Array.isArray(conditions)) return [];
	return conditions.flatMap((raw) => {
		const condition = asRecord(raw);
		if (typeof condition.id !== 'string' || typeof condition.name !== 'string' || !condition.name.trim()) return [];
		const severity = CONDITION_SEVERITIES.find(value => value === condition.severity) ?? null;
		return [{ id: condition.id, name: condition.name.trim(), severity, detail: typeof condition.detail === 'string' ? condition.detail : null,
			sourceEntryId: String(condition.sourceEntryId ?? ''), updatedEntryId: String(condition.updatedEntryId ?? condition.sourceEntryId ?? '') }];
	});
}

/** A character's sheet: state first, then the metadata copies older saves used. */
export function readCharacterSheet(state: unknown, metadata: unknown): Record<string, unknown> | null {
	const meta = asRecord(metadata);
	for (const source of [asRecord(state), meta, asRecord(meta.originalMetadata)]) {
		const sheet = source.playerSheet;
		if (sheet && typeof sheet === 'object' && !Array.isArray(sheet)) return sheet as Record<string, unknown>;
	}
	return null;
}

export interface ResourcePool { current: number; max: number | null }

/** Stored hit points or resource, or null when the sheet never established it (no invented baseline). */
export function readCharacterResource(sheet: Record<string, unknown> | null, key: string): ResourcePool | null {
	if (!sheet) return null;
	const raw = key === 'hp' ? asRecord(sheet.hitPoints) : asRecord(asRecord(sheet.resources)[key]);
	const current = Number(raw.current);
	if (!Number.isFinite(current)) return null;
	const max = raw.max === null || raw.max === undefined ? null : Number(raw.max);
	return { current: Math.trunc(current), max: max !== null && Number.isFinite(max) && max > 0 ? Math.trunc(max) : null };
}

export interface ItemHolding { ownerId: string | null; quantity: number | null; equipped: boolean }

function legacyCarried(state: Record<string, unknown>): boolean {
	return state.ownerId === undefined && (state.inInventory === true || state.location === 'inventory' || state.currentLocation === 'inventory');
}

/**
 * Who holds an item record and how many. A legacy record without `ownerId` that was marked as
 * carried is the player's (pass the player character's id); a held legacy record without any
 * count is one item, as it has always been shown. `quantity: null` is an unknown amount.
 */
export function readItemHolding(state: unknown, playerId: string | null): ItemHolding {
	const record = asRecord(state);
	const ownerId = typeof record.ownerId === 'string' && record.ownerId ? record.ownerId : legacyCarried(record) ? playerId : null;
	const quantity = typeof record.quantity === 'number' && Number.isFinite(record.quantity) ? Math.max(0, Math.trunc(record.quantity))
		: record.quantity === null ? null : ownerId !== null ? 1 : null;
	return { ownerId, quantity, equipped: record.equipped === true };
}

/** An item record nobody holds (lying somewhere), as opposed to a carried legacy record. */
export function isUnplacedItem(state: unknown): boolean {
	const record = asRecord(state);
	return !(typeof record.ownerId === 'string' && record.ownerId) && !legacyCarried(record);
}

/** The player character marker set used across saves and imports. */
export function isPlayerCharacterRecord(row: { state?: unknown; metadata?: unknown }): boolean {
	const state = asRecord(row.state), metadata = asRecord(row.metadata), relationship = asRecord(state.relationship);
	const original = asRecord(metadata.originalMetadata);
	return state.relationship === 'self' || ['self', 'player_character'].includes(String(relationship.status)) || state.isProtagonist === true
		|| state.currentDisposition === 'self' || ['self', 'player_character'].includes(String(metadata.relationship ?? original.relationship))
		|| typeof state.playerPrompt === 'string' || typeof metadata.playerPrompt === 'string';
}

/**
 * Keys that carry mechanical state but belong in `effects`. A value under these keys inside
 * characters, items or lorebook state_overrides is removed and reported instead of silently
 * stripped, so a misplaced change is visible.
 */
const MECHANICAL_KEYS = new Set(['hp', 'hit_points', 'hitpoints', 'hitPoints', 'health', 'current_hp', 'currentHp', 'max_hp', 'maxHp',
	'damage', 'healing', 'injuries', 'injury', 'wounds', 'conditions', 'condition', 'playerSheet', 'player_sheet', 'mana', 'stamina',
	'inventory', 'owner', 'ownerId', 'owner_id', 'holder']);

export function removeMisplacedMechanics(rawUpdate: unknown): string[] {
	const update = asRecord(rawUpdate);
	const warnings: string[] = [];
	const scrub = (record: Record<string, unknown>, path: string) => {
		for (const key of Object.keys(record)) {
			if (!MECHANICAL_KEYS.has(key)) continue;
			delete record[key];
			warnings.push(`${path}.${key}`);
		}
	};
	for (const [field, list] of [['characters', update.characters], ['items', update.items], ['lorebook_entries', update.lorebook_entries]] as const) {
		if (!Array.isArray(list)) continue;
		list.forEach((item, index) => {
			if (!item || typeof item !== 'object' || Array.isArray(item)) return;
			const record = item as Record<string, unknown>;
			if (field === 'characters') scrub(record, `${field}[${index}]`);
			if (field === 'items') for (const key of ['owner', 'ownerId', 'owner_id', 'holder', 'hp', 'health']) {
				if (key in record) { delete record[key]; warnings.push(`${field}[${index}].${key}`); }
			}
			if (field === 'lorebook_entries' && record.state_overrides && typeof record.state_overrides === 'object' && !Array.isArray(record.state_overrides))
				scrub(record.state_overrides as Record<string, unknown>, `${field}[${index}].state_overrides`);
		});
	}
	if (Array.isArray(update.meter_changes)) {
		update.meter_changes = update.meter_changes.filter((meter, index) => {
			const name = typeof asRecord(meter).name === 'string' ? characterResourceKey(String(asRecord(meter).name)) : '';
			if (name !== 'hp') return true;
			warnings.push(`meter_changes[${index}] (${String(asRecord(meter).name)})`);
			return false;
		});
	}
	return warnings.length
		? [`Mechanical changes outside effects were not applied (HP, conditions and items change only through effects): ${warnings.slice(0, 12).join(', ')}`]
		: [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** One line per effect for the turn receipt shown in the story view. */
export const gameplayEffectSummarySchema = z.object({
	op: z.string(),
	status: z.enum(GAMEPLAY_EFFECT_STATUSES),
	target: z.string().nullable(),
	summary: z.string().max(400),
}).strict();
export type GameplayEffectSummary = z.infer<typeof gameplayEffectSummarySchema>;

export function summarizeGameplayEffect(receipt: GameplayEffectReceipt): GameplayEffectSummary {
	const target = receipt.targetName ?? null;
	const before = asRecord(receipt.before), after = asRecord(receipt.after);
	const pool = (value: Record<string, unknown>) => value.current === undefined ? '?' : `${value.current}${value.max === null || value.max === undefined ? '' : `/${value.max}`}`;
	const count = (value: Record<string, unknown>) => value.quantity === null || value.quantity === undefined ? '?' : `×${value.quantity}`;
	const subject = (receipt.subject ?? '').replace(/^(resource|condition|meter):/, '');
	const label = subject === 'hp' ? 'HP' : subject.replace(/_/g, ' ');
	let summary: string;
	if (receipt.status !== 'applied') summary = `${receipt.op.replace(/_/g, ' ')}${target ? ` (${target})` : ''}: ${receipt.reason ?? receipt.status.replace('_', ' ')}`;
	else if (receipt.targetKind === 'campaign') summary = `${target} ${before.value ?? '—'} → ${after.value}/${after.max}`;
	else if (receipt.op.startsWith('resource_')) summary = `${target} ${label} ${receipt.before ? pool(before) : 'unset'} → ${pool(after)}`;
	else if (receipt.op === 'condition_add') summary = `${target}: ${label} added`;
	else if (receipt.op === 'condition_update') summary = `${target}: ${label} updated`;
	else if (receipt.op === 'condition_remove') summary = `${target}: ${label} resolved`;
	else if (receipt.op === 'item_equip' || receipt.op === 'item_unequip') summary = `${target} ${receipt.op === 'item_equip' ? 'equipped' : 'unequipped'}`;
	else summary = `${target} ${receipt.before ? count(before) : 'new'} → ${count(after)}`;
	if (receipt.status === 'applied' && receipt.reason) summary += ` (${receipt.reason})`;
	return { op: receipt.op, status: receipt.status, target, summary: summary.slice(0, 400) };
}
