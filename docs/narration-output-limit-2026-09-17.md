# Narration output cap repair

The latest inspected live narration (2026-09-17 21:36:50 UTC) used `google/gemini-3.8-flash` through OpenRouter, reported `finish_reason: length`, 4,103 completion tokens, and 3,345 reasoning tokens. The saved narrative maxTokens was 4,096. This is provider output exhaustion, not evidence of a browser display cutoff.

## Change

- Main narration and roll continuations now request provider-managed output limits. OpenAI-compatible request bodies omit `max_tokens`; a stale saved narrative cap cannot restore it.
- The server still preserves the complete returned text and provider completion/total/reasoning usage. Reasoning is a component of the completion total, not an extra amount to add twice.
- Output-limit warnings use provider finish reasons rather than comparing unlimited narration against the old saved cap. Metrics record a null app cap.
- Removed the narrator prompt's fixed 80–220-word target. Input-context budgets, background extraction limits, and native Anthropic's required `max_tokens` remain distinct.
- No claim of unlimited model capacity: provider defaults, model ceilings, timeouts, and context windows still apply. [OpenRouter chat request reference](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)

## Verification and activation

Provider and orchestrator tests: 75 passed, including new long streamed/non-streamed responses, complete text retention, omitted output-limit fields, and usage trailers beyond 4,096 tokens. Type checks passed with zero errors/warnings. Production build completed; final prompt-change rebuild is recorded in the task output. Character-context and receipt tests passed. The broader prompt harness has three chapter/arc-memory failures; all three also reproduced with the original completion instruction, confirming they are not introduced by the word-limit removal. See `output/narration-prompt-baseline.log` and `output/narration-prompt-tests.log`.

The live process remained PID 42800. The prior restart attempt was blocked by tool policy; it was not retried through another mechanism. Stop the existing app through local process controls and run `npm run app:start` from the project directory to activate the build. No live narration was submitted or existing campaign text rewritten by this repair.
