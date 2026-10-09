# Memory retrieval benchmark

Run from the repository root with Docker running and the existing `pgvector/pgvector:pg16` image available:

```powershell
npm run bench:memory
# Optional: 1 through 20 measured repetitions per case (default 5)
npm run bench:memory -- 10
# Explicitly opt into paid API calls for the same synthetic fixture:
npm run bench:memory -- 3 --model text-embedding-3-large --max-cost-usd 0.50
```

The command creates a uniquely labeled, disposable PostgreSQL container on a random localhost port, runs the repository migrations, and seeds synthetic records. It never accepts or uses your live database URL. The database is held in temporary container storage and removed in `finally`, including on ordinary errors. A forcibly terminated process may leave its uniquely named `mtherios-memory-bench-*` container behind.

No server, workers, saved setting changes, or new dependencies. The default run makes no paid model calls. Vite resolves the real TypeScript modules and process-local environment; SQL candidate selection, embedding, ranking, visibility filtering, and packet rendering are the actual application implementations. Fixtures call those modules directly, not the HTTP route.

The explicit `--model text-embedding-3-large` option adds a semantic experiment after the two baselines. It uses only `OPENAI_API_KEY` or `OPENROUTER_API_KEY` from the process environment after the existing env-file loader runs; saved application credentials are not used. It requires an explicit positive `--max-cost-usd` run-wide cap. Model access and provider permissions must already allow the request. This runner does not change them.

The semantic experiment requests 3,072 dimensions, the model's full default output size per [official OpenAI documentation](https://developers.openai.com/api/docs/guides/embeddings). It replaces **all synthetic memory vectors** before querying, so models/dimensions are never mixed within a run. Corpus and query calls are charged against the declared cap; missing or malformed `usage.cost` aborts before another provider request, and the runner stops before the next request after cumulative reported spend exceeds the cap. No live story text is sent. The requested model, dimensions, returned model/usage, and post-timing vector-only top-five neighbors are recorded. Provider latency includes response telemetry parsing; it is not directly comparable to purely local compute time.

## What is measured

September 17 additions: three required regressions cover relevance ordering before candidate caps, a correction without shared query words, and a two-hop correction chain. These add 96 synthetic records (90 crowded-search distractors, one target, five revision records). The runner exits nonzero if a required answer is absent, a forbidden record appears, or its packet exceeds budget. Earlier reports and corpus counts below describe their recorded versions, not this expanded fixture.

- 32 fixed regression cases: 27 positive recall cases and 5 exclusion-only cases. Gold facts and query variants are in `fixture.mjs`; they were authored before the first run.
- 105 separate held-out cases cover durable promises, aliases, callbacks, recurring NPC facts, corrections, relationships, history, long passages, and exclusions. They are authored in `heldout.mjs` and scored separately so tuning against the regression fixture cannot inflate the generalization result.
- The current synthetic corpus has 274 memory records (including 240 distractors and 21 held-out records), 400 transcript entries, three events, one NPC belief, and two stories.
- Exact wording, paraphrases, low-importance archive retrieval, both sides of the 200-entry transcript boundary, corrections, secret visibility, control-text exclusion, and small/long packet handling.
- `local-hash-768` versus embeddings disabled, plus an opt-in local-hash hybrid-rank comparison, using the same corpus. This is the saved provider configuration at the time of the baseline, not a dynamic reading of your saved settings. The hybrid comparison is benchmark-only unless `MTHERIOS_MEMORY_RANKING_MODE=hybrid` is explicitly set; it does not change saved settings.
- Recall@1/5/10 uses the production top-32 ranking trace. MRR is truncated at 32. Packet recall requires the gold node to be selected; answer recall additionally requires its answer substring in the rendered packet. Exclusion-only cases do not inflate recall.
- Latency includes database retrieval, query embedding, ranking, and rendering. One warm-up per query is excluded, then queries run serially in rotating order. Container setup, migration, seeding, and module loading are excluded. Hash runs before text-only; this is not a concurrency/load test or a precise causal estimate of vector overhead.
- Token-budget compliance uses the application's character/4 estimate, not a model tokenizer.

Raw JSON reports include queries, gold answers, individual timings, packets, traces, group scores, fixture/source hashes, and Git HEAD. They also declare the measurement boundary explicitly: candidate recall and packet answer retention are measured per mode, while downstream narrator use is `not_measured` until a fixed, provider-backed generation run has an explicit spend cap. HEAD alone does not describe the dirty working tree. Retrieval warnings, missing vector signals, accidental vectors in the text-only baseline, and unstable selections fail the run. Low recall is reported without modifying the algorithm or failing the command.

This does **not** benchmark extraction quality, canon updates, chapter/arc summaries, Qdrant/wiki retrieval, full narrator prompt assembly, or whether an LLM uses the retrieved facts. In particular, GM-visible secrets are intentionally allowed; narrator/NPC secret leakage requires a separate generation benchmark. The repository's separate replay harness records prompt inclusion and observed narration detectors; its latest deterministic report is `evals/replay/results/2026-09-07T13-05-38-462Z.json`. This small synthetic set is a diagnostic baseline, not a general campaign-memory accuracy claim.

## First baseline: 2026-09-04

| Metric | Local hash | Text only |
| --- | ---: | ---: |
| Gold node ranked first / selected | 24/27 (88.9%) | 24/27 (88.9%) |
| Answer retained in prompt packet | 23/27 (85.2%) | 23/27 (85.2%) |
| Exact-wording recall | 6/6 | 6/6 |
| Paraphrase recall | 5/6 | 5/6 |
| Recent transcript / inside boundary | 2/2 | 2/2 |
| Old transcript / outside boundary | 0/2 | 0/2 |
| Correction cases | 2/2 | 2/2 |
| Visibility cases | 7/7 | 7/7 |
| Forbidden-result / budget violations | 0 / 0 | 0 / 0 |
| Warm latency p50 | 36.2 ms | 28.7 ms |
| Warm latency p95 | 44.1 ms | 34.2 ms |

Raw first run: `results/2026-09-04T19-27-45-362Z.json` (320 measured calls plus 64 warm-ups; source hashes were added to the runner afterward).

Repeat run: `results/2026-09-04T19-29-59-489Z.json` reproduced every recall score and zero violations. Hash latency p50/p95: 33.6/39.3 ms; text-only: 25.9/28.4 ms. Both disposable containers were removed. The existing retrieval, ranking, and embedding test files also passed (28 tests).

### Failure evidence and next improvements

1. **Old transcript evidence is unreachable through this retrieval path.** `transcript_old` and `window_outside` missed facts at positions 20 and 199. Positions 200 and 350 worked. Retrieval fetches only the latest 200 transcript entries before matching. Matching but incorrect newer evidence ranked first in both failures. Durable extracted memory can preserve old facts, but these transcript-only fixtures deliberately have no such projection. Next: bounded full-history search with source links, not a larger prompt window.
2. **Meaning without shared words is weak.** “When can we flee the monastery through the submerged passage?” did not retrieve the abbey escape tunnel fact. Hash ranked it 32nd, text-only outside the trace. The implementation hashes word/bigram features; it is not a trained semantic embedding model. Next: compare a semantic embedding provider on the unchanged fixture before changing provider defaults.
3. **Retrieval success can hide packet failure.** The vault document ranked first, but its combination appeared after the 1,200-character body cutoff and never reached the packet. Next: query-aware excerpts for durable memory, with answer-retention checks.

Production behavior was not changed by this benchmark.

## Held-out suite: 2026-09-07

Report: `results/2026-09-07T04-08-39-747Z.json`.

The offline run used one warm-up and one measured round over all 137 cases. The 32-case regression suite stayed unchanged and retained zero forbidden-result or budget violations. Held-out correction records now carry the same explicit supersession metadata used by production retrieval, while historical queries opt into historical evidence. Both baselines retained zero scope, correction, visibility, and budget violations.

| Metric | Local hash | Text only | Local hash hybrid |
| --- | ---: | ---: | ---: |
| Regression answer recall | 26/27 (96.3%) | 26/27 (96.3%) | 26/27 (96.3%) |
| Held-out answer recall | 78/90 (86.7%) | 77/90 (85.6%) | 79/90 (87.8%) |
| Held-out gold node selected | 82/90 (91.1%) | 81/90 (90.0%) | 83/90 (92.2%) |
| Held-out forbidden-result violations | 0 | 0 | 0 |
| Held-out warm latency p50 | 29.0 ms | 23.0 ms | 20.1 ms |
| Held-out warm latency p95 | 34.6 ms | 27.2 ms | 22.7 ms |

No provider API calls were made. The disposable database was removed after the run, and the live database was not used.

The hybrid fusion increases keyword contribution and reduces raw vector contribution. It improves held-out answer retention by 1.1 percentage points over the default local-hash ranking, but it remains below the plan's proposed 10-point improvement or 95% target. The production default therefore remains unchanged.

## Semantic attempt: 2026-09-04

`npm run bench:memory -- 3 --model text-embedding-3-large` reproduced the hash/text-only recall baseline, then failed on the first semantic corpus batch. OpenRouter returned HTTP 404: "No allowed providers are available for the selected model." Its response identified `azure` and `openai` as available providers for this model, neither allowed by the account's current provider settings. That historical command predates the required spend-cap flag.

That first attempt produced no semantic score, ran no query-embedding trials, and removed its disposable database. The account allow-list and live memory configuration were not changed by the runner. The user-requested retry subsequently succeeded, as recorded below.

## Successful semantic retry: 2026-09-04

Report: `results/2026-09-04T19-46-06-173Z.json`.

The unchanged command completed 132 successful API calls through OpenRouter. Every response identified `text-embedding-3-large`; every corpus/query vector was validated at 3,072 dimensions. The fixture and all three retrieval/ranking/embedding source hashes match the prior baseline. Each mode used one warm-up plus three measured passes over all 32 cases. No retrieval fallbacks, selection instability, forbidden-result violations, or token-budget failures occurred.

| Metric | Local hash | Text only | text-embedding-3-large |
| --- | ---: | ---: | ---: |
| Answer retained in prompt packet | 23/27 (85.2%) | 23/27 (85.2%) | 23/27 (85.2%) |
| Gold node selected | 24/27 (88.9%) | 24/27 (88.9%) | 24/27 (88.9%) |
| Paraphrase answers retained | 5/6 | 5/6 | 5/6 |
| Warm latency p50 | 26.1 ms | 21.3 ms | 401.4 ms |
| Warm latency p95 | 28.9 ms | 24.0 ms | 718.9 ms |

OpenRouter reported 8,173 input tokens and $0.00106249 total cost for this successful run, including corpus embedding and warm-ups. This is response-reported cost, not an invoice reconciliation. Network/API latency is included for the semantic model; local-only timings have no network component.

### What the semantic model exposed

All six paraphrases had the correct memory as their **first vector-only neighbor**. In particular, “flee the monastery through the submerged passage” correctly matched the abbey tunnel at cosine distance 0.419; the next neighbor was the caravan route at 0.658. But the tunnel then fell outside the final top-32 ranking trace and was absent from the packet.

The current retrieval code orders candidates by cosine distance, then replaces that distance with a rank-based score: `0.95 - index * 0.006`. Ranking multiplies this by 2.5, so first and second vector matches get almost identical bonuses (2.375 versus 2.36), despite the large semantic gap. The final trace shows the recent caravan route winning with 5.852 total points, including a 1.09 recency bonus; even a routine distractor scored 4.892. This supports a ranking diagnosis: merely changing the embedding provider is insufficient under the current scoring policy.

Next experiment: preserve semantic match strength or test an explicit hybrid-rank fusion, then rerun the unchanged fixture. Do not treat this six-paraphrase result as broad semantic-search accuracy. Old transcript exclusion and answer-tail clipping are still separate failures. Production ranking, saved embedding settings, and live stories remain unchanged; the disposable database was removed.

## Implemented retrieval improvements: 2026-09-05

Report: `results/2026-09-06T01-51-12-327Z.json` (September 5 local time). The unchanged fixture ran five measured repetitions per case after full-history search, relevant passage selection and vector-strength ranking changes.

| Metric | Local hash | Text only |
| --- | ---: | ---: |
| Answers retained in prompt packet | 26/27 (96.3%) | 26/27 (96.3%) |
| Old transcript / outside boundary | 2/2 | 2/2 |
| Forbidden-result / budget violations | 0 / 0 | 0 / 0 |
| Warm latency p50 | 44.475 ms | 34.783 ms |
| Warm latency p95 | 65.721 ms | 46.582 ms |

The three structural misses now pass, including the answer beyond the old body cutoff. Secret, noncanonical and paired OOC entries are filtered before the full-history candidate cap. Independent restored-campaign regressions verify stemming and distractor-heavy visibility cases. The overall token budget and saved provider settings remain unchanged.

The tunnel paraphrase remains the sole answer miss in these nonsemantic modes. A ranking regression preserves the previously observed strong vector match, but a fresh paid semantic run was not performed; no new semantic recall score is claimed. See the implementation results document for separate restored-campaign query timings and release evidence.
