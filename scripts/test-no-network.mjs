// Set directly before test imports so vi.unstubAllGlobals restores this guard.
globalThis.fetch = async () => { throw new Error('Real network access forbidden in candidate validation'); };
