export function parseArgs(argv) {
	const flags = {};
	const positional = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}

		const eq = arg.indexOf('=');
		if (eq !== -1) {
			flags[arg.slice(2, eq)] = arg.slice(eq + 1);
			continue;
		}

		const key = arg.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith('--')) {
			flags[key] = true;
		} else {
			flags[key] = next;
			i++;
		}
	}

	return { flags, positional };
}

export function readIntFlag(flags, key, fallback) {
	const value = flags[key];
	if (value == null || value === true) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number.`);
	return parsed;
}

export function requireVaultAndRest(positional, usage) {
	const vault = positional[0];
	if (!vault) {
		console.error(usage);
		process.exit(1);
	}
	return [vault, positional.slice(1)];
}

export function printResult(result, flags) {
	if (flags.json) console.log(JSON.stringify(result, null, 2));
	else console.log(result);
}
