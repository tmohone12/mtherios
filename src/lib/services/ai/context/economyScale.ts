export const ECONOMY_SCALE_LINES = [
	'1 Volantene honor = 1 gold dragon = 1,000 silver stags.',
	'1 silver stag = 100 copper stars; copper handles food, ale, ferry tolls, street bribes.',
	'10-30 copper stars buys a poor meal, cheap wine, or a night in a rough common room.',
	'1-3 silver stags buys a worker-day, modest inn bed, or food for a small household for a day.',
	'5-30 silver stags buys a guard bribe, local guide, decent clothes, or short skilled service.',
	'100-300 silver stags buys a horse, good weapon, rich clothing, or serious official bribe.',
	'1+ gold dragon/honor is noble money; 10-50 funds dowry/cargo/retinue; 100+ is local-house debt; great houses count wealth in millions of gold dragons.',
	'Iron Bank lending scale reaches roughly 83 million honors/assets; Volantis Forty Families sit just behind Braavos-scale fortunes; Yi Ti gold palaces and imperial trade dwarf western wealth.',
] as const;

export const WORLD_SCALE_LINES = [
	'The Known World is vast: Westeros spans thousands of leagues; Essos runs to the Jade Sea; travel takes weeks or months.',
	'Great cities hold millions or high hundreds of thousands; secondary cities hold tens to hundreds of thousands; towns are thousands, villages hundreds.',
	'Grand Yi Ti cities can dwarf Westerosi and Free City expectations in age, splendor, roads, bureaucracy, and stored wealth.',
	'Powerful Free Cities and great houses field fleets in the hundreds; a massive fleet is 200+ ships, not ten galleys.',
	'Major wars use multiple regional hosts, tens of thousands of soldiers, siege trains, wagons, ravens, debts, and supply lines.',
	'The world does not revolve around {{user}}. NPCs have full lives, armies, courts, conspiracies, trade deals, marriages, and wars off-screen.',
	'Never shrink the world for convenience. News arrives stale, armies march at wagon speed, and geography is an obstacle, not a backdrop.',
] as const;

export function buildEconomyScaleBlock(heading = '### Economy Scale'): string {
	return `${heading}

${ECONOMY_SCALE_LINES.map(line => `- ${line}`).join('\n')}

Use explicit story/lorebook prices first. Otherwise use these anchors for scale: commoners count copper and stags, nobles count dragons/honors, houses count debts, dowries, cargo, and logistics.`;
}

export function buildWorldScaleBlock(heading = '### World Scale'): string {
	return `${heading}

${WORLD_SCALE_LINES.map(line => `- ${line}`).join('\n')}

Enforce this scale every turn. When a city appears, feel its crowds. When a fleet sails, feel its mass. When war breaks, feel its multiple hosts. When {{user}} travels, feel the distance.`;
}
