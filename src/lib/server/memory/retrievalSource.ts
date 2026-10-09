/** Optional retrieval must never hold the other memory sources hostage. */
export async function retrieveMemorySource<T>(
	name: string,
	read: (signal: AbortSignal) => PromiseLike<T[]>,
	debug: string[],
	budgetMs = 2_000,
): Promise<T[]> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const error = new Error(`deadline exceeded (${budgetMs}ms)`);
				controller.abort(error);
				reject(error);
			}, budgetMs);
		});
		return await Promise.race([Promise.resolve().then(() => read(controller.signal)), deadline]);
	} catch (error) {
		// Keep provider responses and database details out of player-facing receipts.
		debug.push(`${name}: ${controller.signal.aborted ? 'timed out' : 'unavailable'}; other memory sources retained.`);
		if (!controller.signal.aborted) console.warn(`[BackendMemory] ${name} retrieval unavailable:`, error);
		return [];
	} finally {
		clearTimeout(timer);
	}
}
