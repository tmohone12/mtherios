export function buildNpcKnowledgeBlock(heading = '### NPC Knowledge, Rumor, and Ignorance'): string {
	return `${heading}

NPCs are not readers of the story file. They are bodies in the world with limited sight, limited hearing, bad memories, pride, fear, servants, spies, prejudice, and incomplete reports.

Before any NPC references a fact about Aurion Balaerys, another NPC, a faction, a secret, a private conversation, a hidden power, a journey, an injury, a bargain, a letter, or an off-screen event, silently pass this test:

**How does this NPC know?**

Valid knowledge sources:
- They personally witnessed it.
- They personally heard it.
- Someone told them, and that someone plausibly knew.
- They received a raven, letter, account book, confession, temple report, guard report, spy report, sailor's tale, market rumor, servant's gossip, or official decree.
- They found physical evidence: blood, ash, disturbed dust, missing coin, a broken seal, a torn cloak, a dead guard, scorch marks, footprints, changed patrols, a missing item.
- They can infer it from public consequences, but the inference may be wrong.
- Enough time has passed for news to travel by plausible means.

Invalid knowledge sources:
- The fact exists in the lorebook.
- The player revealed it to someone else privately.
- Another NPC knows it but never shared it.
- The narrator knows it.
- It would make the scene more convenient.
- The NPC is clever, noble, magical, old, or important.
- The NPC "senses" the truth without an established supernatural method.

If no valid source exists, the NPC must remain ignorant, suspicious without proof, mistaken, late, partially informed, or confidently wrong.

When an NPC uses off-screen knowledge, the narration must show or imply the source:
- "A kitchen girl told half the hall by breakfast."
- "The raven came with a broken seal and three different hands on the margin."
- "The guard captain keeps looking at the blood on Aurion's sleeve."
- "The merchant has heard the harbor version, which has already grown teeth."
- "The septon knows only the sin, not the reason."
- "The old woman has guessed the shape of it, but guessed wrong."

Knowledge decays through distance:
- Same room: direct knowledge.
- Same household: servant gossip within hours.
- Same city: rumor within a day, distorted by class and faction.
- Same region: ravens, riders, merchants, and priests carry partial news.
- Across seas or war zones: delayed, contradictory, expensive, and often wrong.

Never let NPCs share one group mind. Each NPC keeps a separate belief-state shaped by station, access, loyalty, fear, education, faction, and bias.`;
}

export function buildNpcBeliefStateBlock(heading = '### NPC Belief-State Discipline'): string {
	return `${heading}

For every active scene, track each present NPC separately:

- What they know for certain.
- What they suspect.
- What they want.
- What they fear losing.
- What they are pretending not to know.
- What they are wrong about.
- What they cannot safely say in public.
- Whom they distrust in the room.
- Whom they are performing for.

NPCs must not speak from total knowledge. They speak from their own belief-state.

A clever NPC may ask dangerous questions, set traps, test contradictions, or notice physical evidence. Cleverness does not grant secret facts. A paranoid NPC may suspect the truth for the wrong reason. A foolish NPC may miss what is plain. A proud NPC may refuse evidence that humiliates them. A frightened NPC may accept a lie because it lets them survive the hour.

When multiple NPCs hear the same statement, they may interpret it differently:
- A lord hears insult.
- A servant hears opportunity.
- A mother hears danger.
- A priest hears sin.
- A merchant hears price.
- A soldier hears orders.
- A spy hears leverage.`;
}
