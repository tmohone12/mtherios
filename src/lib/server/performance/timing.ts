export type TimingMetadata = Record<string, unknown>;

export interface TimingEntry {
	phase: string;
	durationMs: number;
	metadata?: TimingMetadata;
}

export interface StructuredTimingLog extends TimingEntry {
	event: 'mtherios.generation.timing';
	pipeline: string;
	timestamp: string;
}

export interface TimingRecorderOptions {
	pipeline: string;
	metadata?: TimingMetadata;
	log?: (entry: StructuredTimingLog) => void;
	now?: () => number;
}

export interface TimingRecorder {
	readonly timings: TimingEntry[];
	record(phase: string, durationMs: number, metadata?: TimingMetadata): TimingEntry;
	time<T>(phase: string, metadata: TimingMetadata | undefined, fn: () => Promise<T>): Promise<T>;
	timeSync<T>(phase: string, metadata: TimingMetadata | undefined, fn: () => T): T;
}

const REDACTED = '[redacted]';
const SAFE_SIZE_KEY_PATTERN = /^(prompt|system|message|content|response|input|output)(chars|bytes|tokens)$/i;
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|bearer|password|secret|credential|access[_-]?token|refresh[_-]?token)/i;
const PROMPT_KEY_PATTERN = /(prompt|system|messages|content|narration|playertext|private)/i;

function shouldRedactKey(key: string): boolean {
	if (SAFE_SIZE_KEY_PATTERN.test(key)) return false;
	return SECRET_KEY_PATTERN.test(key) || PROMPT_KEY_PATTERN.test(key);
}

function truncateSafeString(value: string): string {
	return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

export function sanitizeTimingMetadata(metadata: TimingMetadata | undefined): TimingMetadata | undefined {
	if (!metadata) return undefined;
	const sanitizeValue = (value: unknown, key = ''): unknown => {
		if (key && shouldRedactKey(key)) return REDACTED;
		if (value == null) return value;
		if (typeof value === 'string') return truncateSafeString(value);
		if (typeof value === 'number' || typeof value === 'boolean') return value;
		if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item));
		if (typeof value === 'object') {
			const record = value as Record<string, unknown>;
			return Object.fromEntries(
				Object.entries(record).map(([childKey, childValue]) => [
					childKey,
					sanitizeValue(childValue, childKey),
				]),
			);
		}
		return String(value);
	};
	return Object.fromEntries(
		Object.entries(metadata).map(([key, value]) => [key, sanitizeValue(value, key)]),
	);
}

function defaultNow(): number {
	return globalThis.performance?.now?.() ?? Date.now();
}

function timingEnabled(): boolean {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
	return env?.MTHERIOS_GENERATION_TIMING !== 'off';
}

function defaultLog(entry: StructuredTimingLog): void {
	if (!timingEnabled()) return;
	console.log(JSON.stringify(entry));
}

export function createTimingRecorder(options: TimingRecorderOptions): TimingRecorder {
	const now = options.now ?? defaultNow;
	const log = options.log ?? defaultLog;
	const baseMetadata = sanitizeTimingMetadata(options.metadata);
	const timings: TimingEntry[] = [];

	const record = (phase: string, durationMs: number, metadata?: TimingMetadata): TimingEntry => {
		const entry: TimingEntry = {
			phase,
			durationMs: Math.max(0, Math.round(durationMs)),
			metadata: sanitizeTimingMetadata({ ...(baseMetadata ?? {}), ...(metadata ?? {}) }),
		};
		timings.push(entry);
		log({
			event: 'mtherios.generation.timing',
			pipeline: options.pipeline,
			timestamp: new Date().toISOString(),
			...entry,
		});
		return entry;
	};

	return {
		get timings() {
			return timings;
		},
		record,
		async time<T>(phase: string, metadata: TimingMetadata | undefined, fn: () => Promise<T>): Promise<T> {
			const start = now();
			try {
				return await fn();
			} finally {
				record(phase, now() - start, metadata);
			}
		},
		timeSync<T>(phase: string, metadata: TimingMetadata | undefined, fn: () => T): T {
			const start = now();
			try {
				return fn();
			} finally {
				record(phase, now() - start, metadata);
			}
		},
	};
}
