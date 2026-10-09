# Performance repair plan — 2026-09-20

Preserve lore coverage, chronological source accounts, canon validation, and the current model choices. Do not replay turns or retry historical jobs as a benchmark.

1. Save the current four generation settings; patch narration reasoning to medium and classifier/memory/arc reasoning to low. Verify the saved values through the settings API.
2. In both immediate and deferred extraction, recover exhausted output with a bounded larger allowance and low reasoning. Ordinary schema repairs keep the configured allowance. Validate the complete repaired output before any canonical write.
3. Deduplicate identical summary fallback configurations and disable nested transport retries there; the existing ordered fallback chain owns recovery. Keep every source account mandatory.
4. Load vault files in bounded parallel batches, preserving sorted page order, link resolution, and fresh reads. Benchmark against the same full story vault. Avoid a new scene-cache layer that could miss newly relevant lore.
5. Run targeted tests, Svelte/TypeScript checks, and build. Restart only after checking live work. Verify runtime identity, health, effective settings, and read-only preparation. Distinguish local timing improvements from unmeasured future provider latency.

Baseline from the current runtime log: 83 narration calls, median 25.6s; lore preparation 2.8s; database context 78ms. Recent 300 API calls included 87 failures among 110 state extraction attempts. These are operation/attempt timings, not total turn latency or unique failed turns.

## Completed and verified

- Saved narration reasoning at medium; classifier, memory, and arc condensation at low. Existing models and context/lore budgets were retained. Classifier output allowance increased from 4,096 to 8,192 after a real scene still exhausted the smaller limit at low reasoning. Previous values are in `.codex-run/speed-settings-before.json`.
- Both extraction paths now enlarge a truncated repair's allowance (up to 16,384, without lowering an already larger configured limit) and use low reasoning. Complete schema validation remains required before applying state.
- Summary generation and readable rewrites skip identical endpoint/model/reasoning/temperature fallback configurations and avoid nested transport retries. Full source-account validation remains unchanged.
- Vault loading reads sixteen files concurrently, preserving page order and fresh file contents. On the same 1,960-page story vault, three-run median fell from 1,198ms to 315ms (74% reduction). This measures vault loading, not total turn speed.
- 140 focused Vitest tests and one filesystem integration test passed. Svelte/TypeScript check: zero errors and warnings. Production build passed; restarted runtime PID 39068 returned HTTP 200.
- A synthetic classifier probe returned valid output on its first request in 16,977ms. A previously failing real source pair returned valid output on its first request in 28,854ms using 8,073 tokens. Neither probe applied any canonical updates. Evidence: `.codex-run/speed-provider-probe.json` and `.codex-run/speed-provider-real-source-probe.json`.
- Live read-only preparation succeeded: 4,023ms immediately after restart and 1,277ms on a repeated preview. Cold lore preparation still needs further profiling; the isolated file-load gain is not proof that every complete lore request is faster.
- One ordinary user turn after the reasoning change had first text at 19,223ms, compared with 39,863ms and 71,559ms on the preceding two turns. Different prompts and provider conditions prevent treating this as a controlled speedup or a narrative-quality qualification.

Historical failed jobs were not manually replayed. Provider reliability and summary latency across a larger sample remain to be assessed during normal use; this pass does not claim to have eliminated every extraction or summary failure.
