# Gameplay effects: HP, conditions and items — 2026-10-11

Status: implemented on branch `feat/gameplay-effects`, based on `a8a3b32`. Not merged or deployed. This is a dated working record; [ARCHITECTURE.md](../ARCHITECTURE.md#gameplay-effects-hp-conditions-and-items) owns the current description.

## Why

Narrated damage, healing, injuries and item use did not reliably become canonical state. Checked against the code at `a8a3b32`, every audit finding still applied:

- **HP was invisible.** Extraction had no HP field; the GM prompt showed ability scores but never `hitPoints`; the classifier never saw current HP.
- **Meters were reported but never applied.** `meter_changes` counted as operations (a patch marked `applied`), but nothing wrote them, and every story projection returned `meters: null`.
- **Mechanical values vanished silently.** Nested schemas strip unknown keys, so `characters[].hp` or `injuries` disappeared without a warning; injuries lived only inside the free-text `presentation`, so a change of clothes erased them; `state_overrides` could write anything.
- **Inventory was wrong in the browser and on the server.** Quantity 0 showed as 1, carried (`inInventory`) items showed as equipped, the browser read `currentLocation` while the server wrote `location`; there was no owner or transfer; an item named like another kind of record overwrote that record's state.
- **Late extraction dropped item changes** (the stale-turn filter removed quantity and equipped) and kept presentation.
- **Extraction did not see the whole scene.** Narration was cut to 6,000 characters (head and tail) with whitespace collapsed; quote checks differed between fields; roll results reached the classifier only as an encoded marker.
- **The turn/job lifecycle could lose or misorder state.** The extraction job was queued after the turn's other work, so a stop in between left narration with no extraction; multi-turn batches failed together and had no per-turn evidence; a retried (compact recovery) attempt got no repair or salvage; the next turn did not wait for a held or backing-off extraction and nothing told the GM.

## Where the state lives

| State | Location | Written by |
| --- | --- | --- |
| HP | character `state.playerSheet.hitPoints` `{current, max}` | `resource_delta` / `resource_set` (resource `hp`) |
| Other character resources | `state.playerSheet.resources.<key>` `{current, max \| null}` | same, named resource |
| Conditions | `state.conditions[]` `{id, name, severity, detail, sourceEntryId, updatedEntryId}`; resolved ones in `state.resolvedConditions` (last 12) | `condition_add` / `condition_update` / `condition_remove` |
| Items | item entity `state.ownerId`, `state.quantity` (`null` unknown, `0` none left), `state.equipped` | `item_acquire` / `item_consume` / `item_transfer` / `item_equip` / `item_unequip` |
| Campaign resources | `stories.metadata.meters[]` `{name, value, max, visible}` | `resource_*` with `scope: "campaign"`, legacy `meter_changes` |
| Receipts | `gameplay_effects` (migration 0058) | every proposed effect |

Each changed entity carries `state.mechanicsRevision`; the story carries `metadata.metersRevision`. There is no Health meter, and `state_overrides` never carries health.

## How narration becomes a persisted effect

1. **Gate.** Damage, healing, item-use and roll words always send the turn to the Classifier; the GM's inline memory footer is not accepted for such turns because it carries no effects ([orchestrator.ts](../src/lib/server/turn/orchestrator.ts) `GAMEPLAY_SIGNAL_PATTERN`).
2. **Extraction.** The prompt ([promptPacket.ts](../src/lib/server/turn/promptPacket.ts)) carries the whole narration with roll markers rendered as `[Roll: …]` lines, the `GAMEPLAY EFFECTS` instruction (report what the text states; the server computes; only `occurred` is a consequence), and `CURRENT GAMEPLAY STATE`: the player and scene characters with ids, HP, resources, condition ids and held items, unheld items the scene names, and campaign meters.
3. **Contract.** [gameplayEffects.ts (contract)](../src/lib/contracts/gameplayEffects.ts): ten strict operations, each with `source.quote` (verbatim narration), optional `mechanics.roll`/`rule`, a `modality`, and `entityId`/`target` (`"player"` allowed). Mechanical values in `characters`, `items`, `state_overrides` or an HP-named meter are removed and reported; the patch becomes `needs_repair`.
4. **Adjudication and application.** [gameplayEffects.ts (server)](../src/lib/server/turn/gameplayEffects.ts), inside `applyValidatedTurnUpdate` and the turn's transaction: canonical-source and quote check, modality, target resolution by id/exact name/alias (owner-aware for items), parallel-POV protection for the player character, ordering check, arithmetic and clamping, baseline check, write, receipt.
5. **Projection.** The turn receipt lists one line per effect ("Mira HP 18/18 → 11/18"); the World sheet shows conditions and counts (`0` as "none left", unknown counts without a number, "Held by …" for other holders); story projections return `meters`; the GM prompt shows `[Hit Points]`, `[Inventory]` and conditions, and HP/conditions for other characters.

## Retries, failures and ordering

- **Duplicates.** An applied effect is unique per (story, `effect_key`), where the key covers the passage, operation, target, subject, amount and quote. A retried extraction reports `already_applied`; a different reading of a passage whose effects were already applied is `rejected` ("already settled"). The job-level apply receipt still prevents a retried job from re-applying anything else.
- **Stops.** A deferred extraction is saved with its narration (held 30 minutes) and released when the turn finishes. A turn that stops in between leaves a held job, never an unextracted narration.
- **Next-turn boundary.** Before a turn or agent run reads context (`settleStoryForTurn`), memory jobs settle, then held or backing-off extractions for earlier turns become due and run. Anything still pending or failed for the latest five narrations becomes a state notice for the GM (`[State notice]`) and a turn warning for the player.
- **Ordering.** An effect from an earlier passage that reaches a target (HP, a condition, a stack, a meter) already changed by a later passage is `unresolved` instead of being applied out of order.
- **No invented baselines.** A character without recorded HP (or HP maximum), an unknown item count, or an unknown meter leaves the effect `unresolved`; 0 HP is a value, not death.
- **Browser saves.** A wiki or sheet save made from an older projection keeps the player's other edits but not its stale HP, resources or conditions; a save from the current projection that changes HP is an explicit edit and the next revision.
- **Compact recovery.** A retried extraction attempt now gets the same repair and salvage as a first attempt.

## Removed or redirected

- Removed the multi-turn extraction batch (`prepareBatchTurnMemory`, `batchTurnMemory.ts` and its test, the per-batch accounting test): each turn is extracted by its own request with its own state packet and receipts.
- Removed the 6,000-character narration excerpt from extraction and repair prompts.
- `items[].quantity` / `equipped` apply only when the item record is new; existing items change through effects (a warning names the ignored field). The stale-turn filter still drops them; effects pass through it and are ordered by the receipts instead.
- `meter_changes` go through the effects applier; an HP-named meter is rejected.
- The extraction instruction no longer puts injuries in `presentation`.
- An entity upsert that resolves to a record of another type is queued for review instead of overwriting it.

## Verification

Schema and unit tests (no database): [gameplayEffects.test.ts (contract)](../src/lib/contracts/gameplayEffects.test.ts), [gameplayExtraction.test.ts](../src/lib/server/turn/gameplayExtraction.test.ts), additions to [outbox.test.ts](../src/lib/server/jobs/outbox.test.ts) and [classifierContext.test.ts](../src/lib/server/turn/classifierContext.test.ts). Full suite: 2,397 passed, 0 failed, 315 skipped (the database and eval suites skip without their environment). `svelte-check`: 0 errors, 0 warnings.

Database integration ([gameplayEffects.integration.test.ts](../src/lib/server/turn/gameplayEffects.integration.test.ts), disposable `mythengine_effects_test_20261011`): 16 passed. With the other disposable-database suites (World Clock, summary checkpoints, chapter windows, chapter commit): 30 passed. The requested cases map as follows:

| Requested case | Covered by |
| --- | --- |
| 18 HP → 11 with receipt, UI and next turn | "18 HP takes 7 damage …" (canonical, receipt, `getCampaignProjection` + sheet view, GM prompt `[Hit Points]: 11/18`, classifier packet) |
| Retry; restart | "a retried extraction … a restarted re-extraction is refused"; job-level receipt (existing); boundary test |
| Healing limits; 0 HP | "healing stops at the maximum …" |
| Qualitative injury; clothing keeps injuries; resolving one condition | "a qualitative injury is a condition only …" |
| Final item → 0 | "the last potion goes to 0 (not 1) …" |
| Atomic transfer | "a transfer moves part of a stack atomically …" |
| Unequip vs legacy flags | "unequipping a legacy carried item …" |
| Mid-narration capture | "captures a consequence quoted from the middle …"; classifierContext test |
| Back-to-back turns; delayed injury vs later healing | "back-to-back turns apply in order …" |
| Nested-field validation failure | "a misplaced nested HP value is reported …"; contract test |
| Attempted / hypothetical / remembered / OOC / non-canon | "attempted, hypothetical, unquoted, OOC and non-canon …" |
| Branch / POV | "a parallel-POV scene cannot change the player character …" |
| Meter not reported applied | "a meter is reported applied only when it changed …" |
| Source edit invalidates | "an edited source invalidates evidence …" (the deferred job's fingerprint check also skips an edited pair) |

Runtime check: the worktree build on port 5199 with a disposable database (`mythengine_effects_runtime_20261011`, dropped afterwards), provider keys stripped and a local fake endpoint for GameMaster and Classifier; no paid provider was called.

- Turn 1 (arrow, 7 damage): the GM request showed `[Hit Points]: 18/18` and the potion; the held job was released when the turn ended; HP 11/18, the wound recorded, receipt "Mira HP 18/18 → 11/18".
- Next turn: the GM request showed `11/18` and the wound.
- Potion turn: "Healing Potion ×1 → ×0", "Mira HP 11/18 → 16/18"; the next GM request listed no potion.
- A turn left as if the process stopped after saving its narration (held job, never released): the next turn ran it first, and its GM request showed the reduced HP. The first attempt at this exposed that the agent-run path waited for memory jobs but not for the release; both paths now share `settleStoryForTurn`.
- The browser's `campaign.bootstrap` returned the same HP, condition and `quantity: 0`.

Model-output eval: [gameplayEffects.eval.test.ts](../src/lib/server/turn/gameplayEffects.eval.test.ts) scores 12 fixed scenes (damage, miss, hypothetical, potion, qualitative injury, transfer, offer, clothing, memory, curing one condition, last ration, mid-narration damage) for missed, invented, wrong-target, wrong-amount and duplicate effects. It makes paid Classifier requests, so it was **not run**. Run it with:

```bash
MTHERIOS_GAMEPLAY_EFFECTS_EVAL=1 npx vitest run src/lib/server/turn/gameplayEffects.eval.test.ts
```

## Limitations

- How well the live Classifier (Gemini Flash via OpenRouter) follows the effects contract is unmeasured until the eval runs. Server checks catch unquoted, non-occurred, unknown-target and out-of-order effects, not a quoted amount the model misreads.
- The first reading of a passage settles it: if an extraction applied only some of a passage's effects, a later different reading cannot add the rest (it is reported as rejected).
- Existing campaigns are not re-extracted, so older damage, potions and items stay as they were; characters without a saved sheet show "HP not recorded" until a narration states a value or the player sets it.
- NPC HP exists only once established (a stated value or a sheet). There is no death or unconsciousness rule; 0 HP is reported.
- An item record that is nobody's and shares a name with a held stack can be claimed by a pickup of that name.
- Effects are recorded only from narration of the turn's own entry; GM tool calls and authoring edits still write state through their own commands.
