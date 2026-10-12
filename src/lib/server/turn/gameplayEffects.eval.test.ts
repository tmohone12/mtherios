import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '$lib/server/db/client';
import { resolveServiceGeneration } from '$lib/server/engine/llmSettings';
import { generateServerTextWithMetrics } from './provider';
import { buildStateExtractionResponseSchema, DEFAULT_STATE_EXTRACTION_SYSTEM, parseRepairedStateExtraction } from './orchestrator';
import { buildStateExtractionPrompt, type GameplayItemRecord } from './promptPacket';
import { characterResourceKey, normalizeEffectText } from '$lib/contracts/gameplayEffects';

/**
 * Model-output eval for gameplay effects: sends fixed scenes to the configured Classifier role and
 * counts missed, invented, wrong-target, wrong-amount and duplicate effects. It makes paid provider
 * requests, so it runs only with MTHERIOS_GAMEPLAY_EFFECTS_EVAL=1 and a DATABASE_URL whose model
 * settings name the Classifier (settings are only read). It reports; it does not gate.
 */
const enabled = process.env.MTHERIOS_GAMEPLAY_EFFECTS_EVAL === '1';
const evaluation = enabled ? describe : describe.skip;
afterAll(async () => { if (enabled) await closeDb(); });

const mira = { id: 'entity_mira', name: 'Mira', state: { relationship: 'self', playerSheet: { hitPoints: { current: 14, max: 18 } },
	conditions: [{ id: 'cond_poison', name: 'poisoned', severity: 'moderate', detail: null, sourceEntryId: 'n0', updatedEntryId: 'n0' },
		{ id: 'cond_arm', name: 'broken left arm', severity: 'severe', detail: null, sourceEntryId: 'n0', updatedEntryId: 'n0' }] }, metadata: {} };
const bram = { id: 'entity_bram', name: 'Bram', state: { playerSheet: { hitPoints: { current: 20, max: 20 } } }, metadata: {} };
const items: GameplayItemRecord[] = [
	{ id: 'item_potion', name: 'Healing Potion', state: { ownerId: 'entity_mira', quantity: 2 } },
	{ id: 'item_rope', name: 'Rope', state: { ownerId: 'entity_mira', quantity: 3 } },
	{ id: 'item_ration', name: 'Ration', state: { ownerId: 'entity_mira', quantity: 1 } },
	{ id: 'item_cloak', name: 'Grey Cloak', state: { ownerId: 'entity_mira', quantity: 1, equipped: false } },
];

interface Expected { op: string; target: string; subject: string; amount?: number }
const cases: Array<{ id: string; player: string; narration: string; expected: Expected[] }> = [
	{ id: 'damage', player: 'I cross the bridge.', narration: 'An arrow hisses from the cliff. The arrow strikes Mira in the thigh for 7 damage, and she stumbles.', expected: [{ op: 'resource_delta', target: 'entity_mira', subject: 'hp', amount: -7 }] },
	{ id: 'miss', player: 'I duck.', narration: 'The ogre swings its club at Mira and misses by a hand\'s breadth. Splinters fly from the wall behind her.', expected: [] },
	{ id: 'hypothetical', player: 'I study the trap.', narration: 'Mira sees the pressure plate in time. Had she stepped on it, the spikes would have cost her ten hit points or more.', expected: [] },
	{ id: 'potion', player: 'I drink a potion.', narration: 'Mira uncorks a healing potion and drains it. Warmth floods her limbs; she regains 6 hit points.', expected: [
		{ op: 'item_consume', target: 'entity_mira', subject: 'healing potion', amount: 1 }, { op: 'resource_delta', target: 'entity_mira', subject: 'hp', amount: 6 }] },
	{ id: 'qualitative', player: 'I help Bram with the cart.', narration: 'The axle gives way. The cart lurches onto Bram, and his right leg snaps beneath it. He screams.', expected: [{ op: 'condition_add', target: 'entity_bram', subject: 'condition' }] },
	{ id: 'transfer', player: 'I give Bram rope.', narration: 'Mira uncoils two lengths of rope from her pack and hands them to Bram, keeping the last for herself.', expected: [{ op: 'item_transfer', target: 'entity_mira', subject: 'rope', amount: 2 }] },
	{ id: 'offer', player: 'I look at the ring.', narration: 'The merchant offers Mira a silver ring for ten crowns. She turns it over, then hands it back with a shake of her head.', expected: [] },
	{ id: 'clothing', player: 'I change cloaks.', narration: 'Mira shrugs off her torn coat and pulls on her grey cloak, careful of her splinted arm.', expected: [{ op: 'item_equip', target: 'entity_mira', subject: 'grey cloak' }] },
	{ id: 'remembered', player: 'I touch the scar.', narration: 'Mira traces the old scar on her wrist and remembers the wolf that bit her last winter, the blood on the snow.', expected: [] },
	{ id: 'cure-one', player: 'I take the antidote.', narration: 'The antidote burns going down, but within minutes the poison fades from Mira\'s blood. Her arm still throbs in its splint.', expected: [{ op: 'condition_remove', target: 'entity_mira', subject: 'poisoned' }] },
	{ id: 'last-ration', player: 'I eat.', narration: 'Mira eats her last ration by the fire, chewing slowly.', expected: [{ op: 'item_consume', target: 'entity_mira', subject: 'ration', amount: 1 }] },
	{ id: 'mid-narration', player: 'I fight on.', narration: `${'Steel rings across the yard as the skirmish surges back and forth. '.repeat(70)}In the press a goblin's knife slips under Mira's guard for 4 damage. ${'Smoke rolls over the broken wagons and the shouting goes on. '.repeat(70)}`,
		expected: [{ op: 'resource_delta', target: 'entity_mira', subject: 'hp', amount: -4 }] },
];

function targetOf(effect: Record<string, unknown>): string {
	const id = typeof effect.entityId === 'string' ? effect.entityId : '';
	const name = normalizeEffectText(String(effect.target ?? ''));
	if (id) return id;
	if (['player', 'mira', 'you'].includes(name)) return 'entity_mira';
	if (name === 'bram') return 'entity_bram';
	return name;
}

function subjectOf(effect: Record<string, unknown>): string {
	if (String(effect.op).startsWith('resource_')) return characterResourceKey(String(effect.resource));
	if (String(effect.op).startsWith('condition_')) return effect.op === 'condition_add' ? 'condition' : normalizeEffectText(String(effect.condition ?? effect.conditionId ?? '')).replace(/^cond poison$/, 'poisoned');
	return normalizeEffectText(String(effect.item ?? effect.itemId ?? '')).replace(/^item /, '');
}

function amountOf(effect: Record<string, unknown>): number | undefined {
	if (typeof effect.delta === 'number') return effect.delta;
	if (typeof effect.quantity === 'number') return effect.quantity;
	return undefined;
}

evaluation('gameplay effect extraction (model output)', () => {
	it('scores the configured Classifier on fixed scenes', async () => {
		const classifier = await resolveServiceGeneration('classifier');
		if (!classifier.profile) throw new Error(`Classifier is not configured: ${classifier.missingReason ?? 'no profile'}`);
		const schema = buildStateExtractionResponseSchema();
		const totals = { expected: 0, matched: 0, missed: 0, invented: 0, wrongTarget: 0, wrongAmount: 0, duplicate: 0, nonOccurredListed: 0 };
		const rows: string[] = [];
		for (const scene of cases) {
			const result = await generateServerTextWithMetrics({ profile: classifier.profile, model: classifier.generation.model, temperature: classifier.generation.temperature,
				maxTokens: classifier.generation.maxTokens, reasoningEffort: classifier.generation.reasoningEffort ?? 'off', system: DEFAULT_STATE_EXTRACTION_SYSTEM,
				prompt: buildStateExtractionPrompt(scene.player, scene.narration, schema.schema, [mira, bram], [], [], [], {}, [], items), responseSchema: schema });
			const effects = parseRepairedStateExtraction(result.text).update.effects.map(effect => effect as unknown as Record<string, unknown>);
			const occurred = effects.filter(effect => (effect.modality ?? 'occurred') === 'occurred');
			totals.nonOccurredListed += effects.length - occurred.length;
			const used = new Set<number>();
			const keys = occurred.map(effect => `${effect.op}|${targetOf(effect)}|${subjectOf(effect)}`);
			totals.duplicate += keys.length - new Set(keys).size;
			let missed = 0, wrongTarget = 0, wrongAmount = 0;
			for (const expected of scene.expected) {
				totals.expected += 1;
				const exact = occurred.findIndex((effect, index) => !used.has(index) && effect.op === expected.op && targetOf(effect) === expected.target && subjectOf(effect).includes(expected.subject));
				if (exact >= 0) {
					used.add(exact);
					totals.matched += 1;
					if (expected.amount !== undefined && amountOf(occurred[exact]) !== expected.amount) wrongAmount += 1;
					continue;
				}
				const sameKind = occurred.findIndex((effect, index) => !used.has(index) && effect.op === expected.op && subjectOf(effect).includes(expected.subject));
				if (sameKind >= 0) { used.add(sameKind); wrongTarget += 1; } else missed += 1;
			}
			const invented = occurred.length - used.size;
			totals.missed += missed; totals.wrongTarget += wrongTarget; totals.wrongAmount += wrongAmount; totals.invented += invented;
			rows.push(`${scene.id.padEnd(14)} expected=${scene.expected.length} got=${occurred.length} missed=${missed} invented=${invented} wrongTarget=${wrongTarget} wrongAmount=${wrongAmount}`);
		}
		console.log([`Classifier ${classifier.generation.model ?? classifier.profile.name ?? 'configured profile'}`, ...rows, JSON.stringify(totals)].join('\n'));
		expect(totals.expected).toBeGreaterThan(0);
	}, 600_000);
});
