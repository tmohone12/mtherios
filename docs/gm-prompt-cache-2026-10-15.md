# GM prompt cache verification — 2026-10-15

The saved browser GM receipts after the previous deployment reported zero cached tokens. Comparing consecutive serialized requests showed two avoidable prefix changes: searched wiki pages appeared inside the system message, and the configured 20-turn rolling dialogue window removed its oldest exchange on each new turn. Gemini was also excluded from the dialogue cache breakpoint.

The shared preparation path now keeps current-chapter dialogue append-only, retains two complete exchanges across a chapter handoff, and leaves searched wiki results in the changing user-message tail. Checkpoint refreshes do not compact this dialogue. The database's initial 200-entry read expands when it cannot cover the chapter. Explicit cache breakpoints include preceding dialogue on Gemini as well as other supported transports. Accepted history, authored reference and source/visibility boundaries remain intact; full-request capacity checks still apply.

## Provider evidence

Read-only diagnostics used the saved GM model, `google/gemini-4-argon` through OpenRouter. They did not submit a turn, execute tools, or change campaign state. The final pair called the current source implementation of `generateServerTextWithMetrics`, using retained campaign history and dialogue. Between calls, the diagnostic appended one user/assistant exchange and changed the searched-context snapshot and latest user message.

| Source transport request | Input tokens | Cached input tokens | Provider cost (USD) | OpenRouter receipt |
| --- | ---: | ---: | ---: | --- |
| Initial diagnostic | 37,753 | 25,745 | 0.026374095 | `gen-1792049839-R62tmUoxZJkaXc1zf2Fs` |
| Appended exchange + changed search | 37,779 | 35,704 | 0.007653096 | `gen-1792049842-RDXBrPvSZKCB1uvewq84` |

The second request reused 94.5% of its input. The first request was partially warm from earlier diagnostics, so these are observed receipts, not a cold-cache benchmark or a guarantee across provider expiry/routing changes. Two preceding direct transport probes separately recorded 0 then 35,670 cached tokens out of 37,719 input tokens. All four diagnostic calls together reported $0.116398161.

## Verification scope

Focused tests cover unchanged system/history with refreshed wiki search, append-only dialogue past 20 turns despite a checkpoint refresh and a smaller legacy budget, expansion past the initial database tail, native tool continuations, provider cache boundaries, and existing prompt/canon behavior. Type checks and the production build are required before restarting the application. These diagnostics establish real provider cache reads without replaying a campaign turn.
