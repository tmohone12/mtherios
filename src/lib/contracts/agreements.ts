export const CURRENT_AGREEMENT_STATUSES = ['active', 'contested'] as const;
export const AGREEMENT_STATUSES = [...CURRENT_AGREEMENT_STATUSES, 'broken', 'fulfilled', 'expired', 'annulled', 'superseded'] as const;
export type AgreementStatus = typeof AGREEMENT_STATUSES[number];

export function isCurrentAgreement(agreement: { status: string }): boolean {
	return agreement.status === 'active' || agreement.status === 'contested';
}

export const AGREEMENT_ACTION_STATUS = {
	break: 'broken', fulfill: 'fulfilled', expire: 'expired', annul: 'annulled', supersede: 'superseded',
} as const;

export function agreementPartiesKey(parties: string[]): string {
	return JSON.stringify([...new Set(parties.map(party => party.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')))].sort());
}

/** An explicit ID never falls back to a different record; name matching must be unique. */
export function resolveAgreementTarget<T extends { id: string; storyId: string; status: string; category: string; parties: string[] }>(
	rows: T[], storyId: string, change: { id?: string | null; parties?: string[]; category?: string },
): T | undefined {
	const scoped = rows.filter(row => row.storyId === storyId);
	if (change.id) return scoped.find(row => row.id === change.id);
	if (!change.category || !change.parties?.length) return undefined;
	const key = agreementPartiesKey(change.parties);
	const matches = scoped.filter(row => isCurrentAgreement(row) && row.category === change.category && agreementPartiesKey(row.parties) === key);
	return matches.length === 1 ? matches[0] : undefined;
}
