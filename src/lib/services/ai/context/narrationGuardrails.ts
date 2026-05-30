export function buildPlayerActionBoundaryBlock(heading = '### Player Action Boundary - No Forced Transitions'): string {
	return `${heading}

Second-person narration may describe only:
- the immediate sensory facts Aurion's body registers;
- the visible results of actions the player explicitly commanded;
- consequences caused by the world or NPCs.

Do not invent new Aurion actions to reach a better scene.

Forbidden unless the player explicitly commanded it:
- "You leave..."
- "You enter..."
- "You cross the room..."
- "You take up the quill..."
- "You write..."
- "You sit..."
- "You open the door..."
- "You turn away..."
- "You decide..."
- "You remember..."
- "You realize..."
- "You know..."

If the next dramatic beat is in another room, do not move Aurion there. Instead introduce a reason he might choose to go:
- a knock at the door,
- a summons,
- a sound through the wall,
- a servant waiting with a message,
- a visible object,
- an NPC asking whether he wants to proceed.

Plot momentum is advisory. It never overrides player location, player action, or player choice.`;
}

export function buildObservableNpcRuleBlock(heading = '### Observable NPC Rule'): string {
	return `${heading}

Do not narrate NPC thoughts, private realizations, private intentions, or inner conclusions.

Avoid phrases like:
- "she realizes"
- "he knows"
- "she understands"
- "he remembers"
- "her mind turns"
- "he decides"
- "she feels"
- "he recognizes"
- "she will never see him the same way"
- "he wonders"
- "she thinks"

Replace them with visible behavior, speech, hesitation, posture, silence, practical action, or evidence.

Bad:
"Saela realizes Aurion is becoming something monstrous."

Better:
"Saela's fingers stop on the key-ring. When she resumes, the iron teeth click twice before she finds the right key."

Bad:
"Vessia knows the letter could destroy them."

Better:
"Vessia does not touch the parchment. She sets Baelor's cradle-cloth over it first, as if even the blank page might cut."`;
}

export function buildNoAbstractPoliticalSummaryBlock(heading = '### No Abstract Political Summary Without Evidence'): string {
	return `${heading}

Do not explain political danger in clean narrator summary when an object, witness, servant, document, ledger, seal, rumor, debt, guard, or bodily reaction can carry it.

Before writing a sentence like:
- "This was dangerous."
- "This could start a war."
- "She understood the implications."
- "The bank would become an enemy."
- "The house was at risk."

Convert it into something concrete:
- a broken seal,
- a clerk's marginal note,
- a trembling servant,
- a guard posted where none stood before,
- a ledger with a missing column,
- a raven waiting hooded in its cage,
- a wife refusing to touch the parchment,
- an old debt-marker,
- a name scraped out and rewritten,
- ink drying too quickly near the fire.

Politics should be visible as pressure on bodies, rooms, documents, servants, coin, doors, and silence.`;
}

export function buildNarrationGuardrailsCompactBlock(heading = 'Player agency and observability override'): string {
	return `${heading}: Plot momentum is advisory, not a command queue; it is not permission to move Aurion. Never narrate Aurion entering, leaving, writing, deciding, remembering, realizing, knowing, opening, or turning unless commanded. Player-dependent beats become invitations, messages, sounds, objects, documents, delays, rumors, or NPC questions. Do not narrate NPC thoughts; show belief through behavior, speech, silence, or evidence.`;
}
