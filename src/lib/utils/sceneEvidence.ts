/** Keep the scene body and ending even when a decorative header is longer than the budget. */
export function sceneEvidenceExcerpt(content: string, max = 800): string {
	const clean = content.replace(/\s+/g, ' ').trim();
	if (clean.length <= max) return clean;
	const header = clean.match(/^\[[^\]]*\b(?:Time|Location|Weather)\b[^\]]*\]\s*/i)?.[0] ?? '';
	const body = clean.slice(header.length);
	const clip = (text: string, budget: number) => text.length <= budget ? text : `${text.slice(0, budget - 3).trimEnd()}...`;
	const anchor = header ? clip(header.trim(), Math.min(160, Math.floor(max / 4))) + ' ' : '';
	const budget = max - anchor.length;
	if (body.length <= budget) return anchor + body;
	const head = Math.floor((budget - 5) / 2);
	return `${anchor}${body.slice(0, head)} ... ${body.slice(-(budget - head - 5))}`;
}
