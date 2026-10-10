/**
 * Recovery tooling only. Limits approved once for replacing one held, uncertain
 * chapter-only attempt; retained manifests and runner receipts carry these exact
 * values, so validation keeps accepting them. The live chapter worker and the
 * runner's ordinary dispatch never read this module.
 */
export type HeldChapterReplacementLimits = { calls: 4; inputTokens: 153697; outputTokens: 48000; usd: 0.043 };
export const HELD_CHAPTER_REPLACEMENT_LIMITS: Readonly<HeldChapterReplacementLimits> = Object.freeze({ calls: 4, inputTokens: 153697, outputTokens: 48000, usd: 0.043 });
/** The aggregate runner approval the replacement was authorized under. */
export const HELD_CHAPTER_REPLACEMENT_AGGREGATE = Object.freeze({ totalUsd: 0.31, maxChapters: 10, minIntervalMinutes: 60 });
/** The original attempt's allocation stays counted; the replacement adds only the increment. */
export const HELD_CHAPTER_REPLACEMENT_ALLOCATION = Object.freeze({ originalUsd: 0.033, incrementUsd: 0.010 });
