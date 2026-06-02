const DEFAULT_GENERATION_CONCURRENCY = 4;
const MIN_GENERATION_CONCURRENCY = 1;
const MAX_GENERATION_CONCURRENCY = 12;

function readEnv(name: string): string | undefined {
	return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

export function readGenerationConcurrency(fallback = DEFAULT_GENERATION_CONCURRENCY): number {
	const parsed = Number.parseInt(readEnv('MTHERIOS_GENERATION_CONCURRENCY') ?? '', 10);
	const raw = Number.isFinite(parsed) ? parsed : fallback;
	return Math.min(MAX_GENERATION_CONCURRENCY, Math.max(MIN_GENERATION_CONCURRENCY, Math.trunc(raw)));
}

export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const limit = Math.min(
		items.length,
		Math.max(MIN_GENERATION_CONCURRENCY, Math.trunc(Number.isFinite(concurrency) ? concurrency : 1)),
	);
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	const workers = Array.from({ length: limit }, async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await mapper(items[index], index);
		}
	});

	await Promise.all(workers);
	return results;
}
