export function buildWarStrategicDoctrineBlock(heading = 'WAR DOCTRINE'): string {
	return `${heading}

War is not background decoration and not a random battle generator. Treat armed conflict as a living strategic system made of causes, objectives, logistics, morale, information, leadership, terrain, weather, legitimacy, civilian pressure, schemes, rumors, debts, alliances, betrayals, and irreversible consequences.

Core rules:
- War has a reason. For each side distinguish public justification, true objective, minimum acceptable outcome, and unacceptable loss.
- Model fronts, theaters, strongpoints, soft targets, political centers, and hidden fronts. Do not resolve a war through one dramatic battle unless the story has earned it.
- Logistics matter: food, water, ammunition, medicine, mounts, ships, roads, fuel, reagents, pay, season, terrain, disease, distance, weather, morale, desertion, discipline, and supply lines.
- War is political. Military action changes legitimacy, alliances, vassals, neutral powers, player reputation, claims, oaths, treaties, debts, hostages, marriages, succession rights, and religious authority.
- Battles are inflection points, not default events. Most war movement should be scouts, closures, refugees, rising prices, recruiters, desertion, arguments, sabotage, failed envoys, rumors, occupations, and local powers choosing sides.
- Fog of war is mandatory. Separate what is true, what commanders believe, what civilians believe, what the player has evidence for, what rumors claim, what propaganda says, and what hidden schemes cause.
- Schemes are the operational layer of war. Faction goals define why a faction fights; schemes define how they try to win; story threads define how the war becomes player-facing plot; world events record what actually happened.
- War creates plots and subplots: survival, rebellion, succession, occupation, alliance negotiation, defection, prisoner exchange, sabotage mysteries, profiteering, espionage, refugees, trials, reparations, and revenge.
- Player agency remains intact. The world may move without the player, but decisive outcomes involving the player's direct agency must not be assumed off-screen.
- Consequences persist: graves, debts, trauma, shortages, veterans, widows, ruined roads, changed borders, collaborators, revenge movements, trials, memorials, illegitimate rulers, and unresolved grievances.
- Escalation should be gradual unless canon, a major scheme, player action, or catastrophe justifies a shock.
- Outcomes should be partial and uneven: tactical victory with strategic loss, captured city with hostile population, treaty with secret war continuing, crushed rebellion becoming insurgency.

When strategic output involves war, connect movement to faction goals, active schemes, strategic clocks, story threads or subplots, rumors or propaganda, world events, resource changes, territory or travel changes, player-facing pressure, and hidden information boundaries.

If proposing canon changes, cite evidence from chapters, arcs, events, schemes, or recent entries. If it is only a possible plan or hidden intent, keep it as a scheme, strategic clock, factionOperation, or prompt pressure instead of hard canon.

If war is active or plausible, include a warPressureCard with current phase, main factions and war aims, fronts or theaters, important schemes, visible signs, hidden facts, next escalation if ignored, and player intervention points.`;
}

export function buildWarExecutionRulesBlock(heading = 'WAR EXECUTION RULES'): string {
	return `${heading}

Use the latest strategic frame, faction goals, active schemes, chapters, and arcs to advance war pressure conservatively.

- Do not invent a new war plan if an active strategic war frame exists.
- Choose 1-3 immediate war movements at most.
- Prefer visible local consequences: patrols, scouts, recruiters, refugees, shortages, rising prices, closed roads, deserters, rumors, coded letters, fortification work, troop movement, tense councils, failed diplomacy, or sabotage aftermath.
- Advance schemes only when their triggers are plausible.
- Do not complete a siege, battle, rebellion, invasion, or treaty off-screen unless its clock, scheme progress, prior chapters, and current arc justify completion.
- Respect fog of war. Expose hidden strategy only through plausible signs, rumors, investigation hooks, captured evidence, NPC testimony, scouts, letters, visions, or direct observation.
- When outputting war movement, include which faction moved, which goal or scheme it serves, what changed visibly, what remains hidden, what the player could do about it, and what durable record may need updating.`;
}

export function buildWarNarrationRulesBlock(heading = '### War Narration Rules'): string {
	return `${heading}

When war pressure is active, let it shape the scene without turning every scene into a battle.

Show war through grounded details: tired guards, ration lines, empty markets, wounded travelers, propaganda, nervous merchants, checkpoints, missing relatives, recruiters, burned farms, coded letters, whispered casualty numbers, loyalty arguments, prayers, omens, songs, or memorials.

Do not reveal hidden war plans unless the player has earned that knowledge. Do not decide the player's allegiance, courage, fear, strategy, or moral judgment. Do not resolve major battles or campaigns casually in narration.

War should create pressure, choices, costs, and consequences. It should not remove player agency.`;
}

export function buildWarNarrationRulesCompactBlock(): string {
	return 'War pressure: show local costs (patrols, ration lines, refugees, prices, closed roads, rumors). Fog of war holds; never decide player allegiance/courage or casually resolve major campaigns.';
}

export function buildWarMemoryContinuityBlock(): string {
	return 'For war continuity, preserve war aims, public justifications, hidden objectives, fronts/theaters, logistics, morale, fog-of-war beliefs, civilian costs, resource changes, territorial pressure, schemes, rumors, treaties, and partial consequences. Do not flatten war into a single battle result.';
}

export function buildWarExtractionRulesBlock(): string {
	return 'War state changes must be recorded durably: faction goals/resources/relations, schemes or scheme triggers, rumors/propaganda, world events, agreements/treaties/oaths/hostages, territory/travel pressure, location damage or occupation, character status, player reputation/ledger, refugees, shortages, and trade disruption.';
}

export function buildWarSchemeRulesBlock(): string {
	return 'When war is present, schemes are the operational layer: secure supply roads, bribe commanders, starve cities, provoke treaty breaches, finance rebels, sabotage fleets, split coalitions, hide sponsors, or turn refugees into leverage. Do not create a war scheme unless it has an owner, target, trigger, visible signs, counterplay, and consequences.';
}
