export const ECONOMY_SCALE_LINES = [
	'1 Volantene honor = 1 gold dragon = 1,000 silver stags.',
	'1 silver stag = 100 copper stars; copper handles food, ale, ferry tolls, street bribes.',
	'10-30 copper stars buys a poor meal, cheap wine, or a night in a rough common room.',
	'1-3 silver stags buys a worker-day, modest inn bed, or food for a small household for a day.',
	'5-30 silver stags buys a guard bribe, local guide, decent clothes, or short skilled service.',
	'100-300 silver stags buys a horse, good weapon, rich clothing, or serious official bribe.',
	'1+ gold dragon/honor is noble money; 10-50 funds dowry, cargo, or retinue; 100+ is house-scale debt, ransom, or war logistics.',
] as const;

export const WORLD_SCALE_LINES = [
	'The Known World is vast. Westeros alone is thousands of leagues from the Wall to the Summer Sea. Essos stretches from the Narrow Sea to the Jade Sea. Travel takes weeks or months. The Narrow Sea is wide, the Dothraki Sea is endless, and Sothoryos is a mystery.',
	'Great cities number their populations in the millions or high hundreds of thousands: Volantis, King\'s Landing, Braavos, Oldtown, Qohor. Even secondary cities like Lannisport, Gulltown, and Pentos hold tens to hundreds of thousands. A town is thousands. A village is hundreds. Never shrink a city to a few streets.',
	'Powerful Free Cities and great houses field fleets numbering in the hundreds of ships. The Ironborn reave in swarms. The Redwyne fleet guards the Arbor. The Braavosi sealord commands a navy that could blockade a continent. A "fleet" is not ten galleys — it is fifty, a hundred, or more.',
	'Major wars consist of multiple hosts operating across regions simultaneously. A great house can raise twenty thousand men or more. The Reach, the Westerlands, and the Riverlands can field tens of thousands each. Battles are fought by combined armies, not single companies. Sieges require vast supply trains.',
	'Armies number in the tens of thousands. A host of five thousand is modest. A host of twenty thousand is formidable. Combined royal or alliance armies can reach fifty thousand or more. Do not reduce a lord\'s strength to a few hundred men unless they are explicitly ruined.',
	'The world does not revolve around {{user}}. NPCs have their own full lives, armies, courts, conspiracies, trade deals, marriages, and wars that operate off-screen. Factions scheme independently. Rulers die of old age, disease, or assassination while {{user}} is elsewhere. Time and distance matter.',
	'Never shrink the world for convenience. A raven takes days or weeks. An army marches at the speed of its wagons. A fleet must beat against wind and current. News arrives stale, incomplete, or wrong. Geography is an obstacle, not a backdrop.',
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
