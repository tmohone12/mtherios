export const ECONOMY_SCALE_LINES = [
	'1 Volantene honor = 1 gold dragon = 1,000 silver stags.',
	'1 silver stag = 100 copper stars; copper handles food, ale, ferry tolls, street bribes.',
	'10-30 copper stars buys a poor meal, cheap wine, or a night in a rough common room.',
	'1-3 silver stags buys a worker-day, modest inn bed, or food for a small household for a day.',
	'5-30 silver stags buys a guard bribe, local guide, decent clothes, or short skilled service.',
	'100-300 silver stags buys a horse, good weapon, rich clothing, or serious official bribe.',
	'1+ gold dragon/honor is noble money; 10-50 funds dowry, cargo, or retinue; 100+ is house-scale debt, ransom, or war logistics.',
] as const;

export function buildEconomyScaleBlock(heading = '### Economy Scale'): string {
	return `${heading}

${ECONOMY_SCALE_LINES.map(line => `- ${line}`).join('\n')}

Use explicit story/lorebook prices first. Otherwise use these anchors for scale: commoners count copper and stags, nobles count dragons/honors, houses count debts, dowries, cargo, and logistics.`;
}
