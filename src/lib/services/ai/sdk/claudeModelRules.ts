/**
 * What a Claude model accepts, from its ID (claude-opus-5-5, claude-haiku-4-5-20251001, ...).
 * Adaptive thinking arrived with 4.6; from 4.7 sampling parameters and fixed thinking budgets
 * are rejected, and `xhigh` effort exists; from 5 (and on Fable/Mythos) leaving `thinking` out
 * still thinks, and Opus 5.5 / Sonnet 5.5 / Fable reject disabling it.
 */
export function anthropicModelRules(model: string): { adaptive: boolean; sampling: boolean; xhigh: boolean; thinksByDefault: boolean } {
	const match = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2})(?!\d))?/i.exec(model);
	if (!match) return { adaptive: false, sampling: true, xhigh: false, thinksByDefault: false };
	const frontier = ['fable', 'mythos'].includes(match[1].toLowerCase());
	const version = Number(match[2]) + Number(match[3] ?? 0) / 10;
	return { adaptive: frontier || version >= 4.6, sampling: !frontier && version < 4.7, xhigh: frontier || version >= 4.7, thinksByDefault: frontier || version >= 5 };
}
