import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Async stores that belong to one request or agent run (its provider hooks and budget, its
 * caller identity). Work that outlives the request, such as turn jobs, starts outside all of
 * them so it never charges, checkpoints or authenticates as the run that queued it.
 */
const stores = new Set<AsyncLocalStorage<unknown>>();

export function requestScope<T>(): AsyncLocalStorage<T> {
	const store = new AsyncLocalStorage<T>();
	stores.add(store as AsyncLocalStorage<unknown>);
	return store;
}

/** Runs `work` (and everything it starts) with every request store empty. */
export function outsideRequestScopes<T>(work: () => T): T {
	return [...stores].reduce<() => T>((next, store) => () => store.exit(next), work)();
}
